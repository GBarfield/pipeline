// Destination: apps/api/src/lib/twoStep.ts
//
// Two-step sign-in: a password, then a 6-digit code from an authenticator
// app. Every PipeLine user. Same design as Translatus (C:\translator
// apps/web/lib/two-step.ts), adapted to Prisma and PipeLine's JWT sessions:
//
// - After a right password there is a "pending sign-in" (cookie
//   pipeline_pending, 10 min to type a code / 30 min to set up). It opens
//   nothing but the code or setup step. No session cookie until the code.
// - First sign-in (no authenticator yet): the setup step shows a QR code,
//   generated on the server and shown only after the password, never emailed.
// - A code works once (totpLastStep). 5 wrong codes lock the code step for
//   15 minutes.
// - Lost phone: a Super User resets the authenticator. That signs the person
//   out everywhere (sessionVersion++) and emails a link. After a reset the
//   new phone can only be set up through that link (password first), not
//   with the password alone (totpNeedsLink).
import type { Response } from 'express';
import QRCode from 'qrcode';
import { prisma } from './prisma.ts';
import { decrypt, encrypt, randomToken, sha256 } from './secretBox.ts';
import { cleanCode, groupKey, matchStep, newSecret, otpauthUri } from './totp.ts';
import { signSessionToken, SESSION_COOKIE } from './auth.ts';
import { sendMail } from './mailer.ts';

export const PENDING_COOKIE = 'pipeline_pending';
const PENDING_MINUTES = { verify: 10, enroll: 30 } as const;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
export const LINK_HOURS = { authenticator: 7 * 24 };
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // matches the JWT's 12h

export type Purpose = 'verify' | 'enroll';

export class TwoStepError extends Error {
  status: number;
  restart: boolean;
  constructor(message: string, status = 400, restart = false) {
    super(message);
    this.status = status;
    this.restart = restart;
  }
}

const secure = () => process.env.NODE_ENV === 'production';

export function siteUrl(): string {
  return (process.env.APP_URL?.trim() || 'https://pipeline.benebloc.com').replace(/\/+$/, '');
}
export const linkUrl = (token: string) => `${siteUrl()}/link?token=${encodeURIComponent(token)}`;

// --- sessions -------------------------------------------------------------------

export async function startSession(res: Response, userId: number) {
  const u = await prisma.user.update({
    where: { id: userId },
    data: { lastLoginAt: new Date() },
    select: { id: true, email: true, name: true, role: true, brokerId: true, restrictedDivisionId: true, sessionVersion: true },
  });
  res.cookie(SESSION_COOKIE, signSessionToken(u.id, u.sessionVersion), {
    httpOnly: true, secure: secure(), sameSite: 'lax', maxAge: SESSION_MAX_AGE_MS,
  });
  const { sessionVersion: _sv, ...user } = u;
  return user;
}

/** Ends every session and pending sign-in for this person. */
export async function signOutEverywhere(userId: number) {
  await prisma.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
  await prisma.pendingSignIn.deleteMany({ where: { userId } });
}

// --- between the password and the code ----------------------------------------

export type Next = { next: 'code' | 'setup' } | { next: 'needs-link' };

/** After a right password (or a used authenticator link): the code step, the setup step, or "use the emailed link". */
export async function afterPassword(res: Response, userId: number, opts: { fromLink?: boolean } = {}): Promise<Next> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { totpSecretEnc: true, totpNeedsLink: true } });
  if (!u) throw new TwoStepError('User not found.', 404);
  if (u.totpSecretEnc) { await startPending(res, userId, 'verify'); return { next: 'code' }; }
  if (u.totpNeedsLink && !opts.fromLink) return { next: 'needs-link' };
  await startPending(res, userId, 'enroll');
  return { next: 'setup' };
}

async function startPending(res: Response, userId: number, purpose: Purpose) {
  const token = randomToken();
  const expires = new Date(Date.now() + PENDING_MINUTES[purpose] * 60_000);
  await prisma.pendingSignIn.deleteMany({ where: { OR: [{ userId }, { expiresAt: { lt: new Date() } }] } });
  await prisma.pendingSignIn.create({ data: { tokenHash: sha256(token), userId, purpose, expiresAt: expires } });
  res.cookie(PENDING_COOKIE, token, { httpOnly: true, secure: secure(), sameSite: 'lax', expires, path: '/' });
}

export function clearPending(res: Response) {
  res.clearCookie(PENDING_COOKIE, { path: '/' });
}

export interface Pending { tokenHash: string; userId: number; email: string; name: string; purpose: Purpose }

export async function readPending(cookieToken: string | undefined): Promise<Pending | null> {
  if (!cookieToken || cookieToken.length > 200) return null;
  const p = await prisma.pendingSignIn.findUnique({
    where: { tokenHash: sha256(cookieToken) },
    include: { user: { select: { email: true, name: true, active: true } } },
  });
  if (!p || p.expiresAt <= new Date() || !p.user.active) return null;
  return { tokenHash: p.tokenHash, userId: p.userId, email: p.user.email, name: p.user.name, purpose: p.purpose as Purpose };
}

/** The key being set up: made on first view and kept until confirmed, so a reload shows the same QR code. */
export async function enrollmentKey(p: Pending) {
  const row = await prisma.user.findUnique({ where: { id: p.userId }, select: { totpNewEnc: true } });
  let key = row?.totpNewEnc ? decrypt(row.totpNewEnc).toString('utf8') : null;
  if (!key) {
    key = newSecret();
    await prisma.user.update({ where: { id: p.userId }, data: { totpNewEnc: encrypt(Buffer.from(key, 'utf8')) } });
  }
  const uri = otpauthUri(key, p.email);
  const qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#0f172a', light: '#ffffff' } });
  return { grouped: groupKey(key), uri, qrSvg };
}

/** The 6-digit code, for either purpose. Right: the pending sign-in becomes a session. */
export async function checkCode(res: Response, p: Pending, raw: string) {
  const u = await prisma.user.findUnique({
    where: { id: p.userId },
    select: { totpSecretEnc: true, totpNewEnc: true, totpLastStep: true, totpLockedUntil: true, totpFailures: true },
  });
  if (!u) throw new TwoStepError('Sign in again.', 401, true);
  if (u.totpLockedUntil && u.totpLockedUntil > new Date()) {
    await prisma.pendingSignIn.deleteMany({ where: { tokenHash: p.tokenHash } });
    throw new TwoStepError(`Too many wrong codes. Wait ${LOCK_MINUTES} minutes, then sign in again.`, 429, true);
  }
  const enc = p.purpose === 'verify' ? u.totpSecretEnc : u.totpNewEnc;
  if (!enc) throw new TwoStepError('Sign in again.', 401, true);
  const code = cleanCode(raw ?? '');
  const step = code ? matchStep(decrypt(enc).toString('utf8'), code, Date.now(), u.totpLastStep == null ? null : Number(u.totpLastStep)) : null;

  if (step == null) {
    const failures = u.totpFailures + 1;
    if (failures >= MAX_FAILURES) {
      await prisma.user.update({
        where: { id: p.userId },
        data: { totpFailures: 0, totpLockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) },
      });
      await prisma.pendingSignIn.deleteMany({ where: { tokenHash: p.tokenHash } });
      console.warn(`[two-step] user ${p.userId} locked for ${LOCK_MINUTES} minutes after ${MAX_FAILURES} wrong codes`);
      throw new TwoStepError(`Too many wrong codes. Wait ${LOCK_MINUTES} minutes, then sign in again.`, 429, true);
    }
    await prisma.user.update({ where: { id: p.userId }, data: { totpFailures: failures } });
    throw new TwoStepError(
      code
        ? "That code didn't work. Type the 6-digit number the app shows right now (it changes every 30 seconds)."
        : 'Type the 6 numbers from the app, like 123456.',
    );
  }

  if (p.purpose === 'enroll') {
    await prisma.user.update({
      where: { id: p.userId },
      data: {
        totpSecretEnc: enc, totpNewEnc: null, totpOnAt: new Date(), totpNeedsLink: false,
        totpLastStep: BigInt(step), totpFailures: 0, totpLockedUntil: null,
      },
    });
    console.log(`[two-step] user ${p.userId} turned on two-step sign-in`);
  } else {
    await prisma.user.update({
      where: { id: p.userId },
      data: { totpLastStep: BigInt(step), totpFailures: 0, totpLockedUntil: null },
    });
  }
  await prisma.pendingSignIn.deleteMany({ where: { tokenHash: p.tokenHash } });
  clearPending(res);
  return startSession(res, p.userId);
}

// --- emailed authenticator links ---------------------------------------------------

export async function createLink(userId: number, kind: 'authenticator', createdById: number | null, hours: number) {
  const token = randomToken();
  // One live link per person: a new one replaces any unused older one.
  await prisma.accountLink.deleteMany({ where: { userId, usedAt: null } });
  const expiresAt = new Date(Date.now() + hours * 3_600_000);
  await prisma.accountLink.create({ data: { tokenHash: sha256(token), userId, kind, createdById, expiresAt } });
  return { token, expiresAt };
}

export async function findLink(token: string) {
  if (!token || token.length > 200) return null;
  const l = await prisma.accountLink.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { select: { id: true, email: true, name: true, active: true } } },
  });
  if (!l || l.usedAt || l.expiresAt <= new Date() || !l.user.active) return null;
  return { userId: l.userId, kind: l.kind, email: l.user.email, name: l.user.name, expiresAt: l.expiresAt };
}

export async function markLinkUsed(token: string) {
  await prisma.accountLink.update({ where: { tokenHash: sha256(token) }, data: { usedAt: new Date() } });
}

// --- admin: lost phone ----------------------------------------------------------------

/**
 * Clears the authenticator, signs the person out everywhere and emails them a
 * link to connect a new phone. Returns the link too, so a Super User can pass
 * it on another way if the email doesn't arrive.
 */
export async function resetAuthenticator(userId: number, actor: { id: number; name: string } | null) {
  const u = await prisma.user.update({
    where: { id: userId },
    data: {
      totpSecretEnc: null, totpNewEnc: null, totpOnAt: null, totpLastStep: null,
      totpFailures: 0, totpLockedUntil: null, totpNeedsLink: true,
    },
    select: { id: true, email: true, name: true },
  });
  await signOutEverywhere(userId);
  const { token, expiresAt } = await createLink(userId, 'authenticator', actor?.id ?? null, LINK_HOURS.authenticator);
  const url = linkUrl(token);
  const until = expiresAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
  const first = u.name.split(' ')[0] || 'there';
  const who = actor?.name ?? 'Your administrator';
  let emailed = false;
  try {
    await sendMail({
      to: { name: u.name, email: u.email },
      replyTo: { name: 'PipeLine', email: process.env.RFQ_FROM_EMAIL ?? u.email },
      subject: 'Set up your authenticator app for PipeLine again',
      fromName: 'PipeLine',
      attachments: [],
      body: [
        `Hello ${first},`,
        `${who} reset the authenticator app for your PipeLine account, so you can connect a new phone. You have been signed out.`,
        'Here is how:',
        '1. On your phone, install an authenticator app if you need one (Google Authenticator or Microsoft Authenticator, free in the App Store or Google Play).',
        '2. On a computer, open the link below and type your PipeLine password.',
        '3. Scan the QR code it shows with the app, then type the 6-digit number the app shows.',
        `Set up my authenticator app:\n${url}`,
        `This link works once, until ${until}. If it stops working, ask ${who} to reset your authenticator again.`,
        "Didn't expect this email? Tell your PipeLine administrator.",
        '--\nPipeLine',
      ].join('\n\n'),
    });
    emailed = true;
  } catch (err) {
    console.error(`[two-step] reset email to ${u.email} failed:`, (err as Error).message);
  }
  console.log(`[two-step] authenticator reset for user ${u.id} by ${actor ? `user ${actor.id}` : 'server command'}; emailed=${emailed}`);
  return { email: u.email, emailed, url, expiresAt };
}
