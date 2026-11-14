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
// - Emailed links (welcome / password / authenticator) are made here; the
//   emails themselves are composed in userLinks.ts.
import type { Response } from 'express';
import QRCode from 'qrcode';
import { prisma } from './prisma.ts';
import { decrypt, encrypt, randomToken, sha256 } from './secretBox.ts';
import { cleanCode, groupKey, matchStep, newSecret, otpauthUri } from './totp.ts';
import { hashPassword, signSessionToken, verifyPassword, SESSION_COOKIE } from './auth.ts';

export const PENDING_COOKIE = 'pipeline_pending';
const PENDING_MINUTES = { verify: 10, enroll: 30 } as const;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
export type LinkKind = 'welcome' | 'password' | 'authenticator';
/** How long each link works. A password link someone asked for themselves is short; one a Super User sends lasts a day. */
export const LINK_HOURS = { welcome: 7 * 24, password: 1, adminPassword: 24, authenticator: 7 * 24 };

/** Same rule as Translatus. */
export function checkPassword(password: string) {
  if (password.length < 12) throw new TwoStepError('Use a password of at least 12 characters.');
  if (password.length > 200) throw new TwoStepError('That password is too long.');
}
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

// --- emailed links ------------------------------------------------------------------

export async function createLink(userId: number, kind: LinkKind, createdById: number | null, hours: number) {
  const token = randomToken();
  // One live link per person: a new one replaces any unused older one.
  await prisma.accountLink.deleteMany({ where: { userId, usedAt: null } });
  const expiresAt = new Date(Date.now() + hours * 3_600_000);
  await prisma.accountLink.create({
    data: {
      tokenHash: sha256(token), userId, kind, createdById, expiresAt,
      // Kept (encrypted) only for links a Super User sent, so the Users page can show it again.
      tokenEnc: createdById !== null ? encrypt(Buffer.from(token, 'utf8')) : null,
    },
  });
  return { token, expiresAt };
}

export interface LinkInfo { userId: number; kind: LinkKind; email: string; name: string; expiresAt: Date; hasTotp: boolean }

export async function findLink(token: string): Promise<LinkInfo | null> {
  if (!token || token.length > 200) return null;
  const l = await prisma.accountLink.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { select: { id: true, email: true, name: true, active: true, totpSecretEnc: true } } },
  });
  if (!l || l.usedAt || l.expiresAt <= new Date() || !l.user.active) return null;
  return { userId: l.userId, kind: l.kind as LinkKind, email: l.user.email, name: l.user.name, expiresAt: l.expiresAt, hasTotp: !!l.user.totpSecretEnc };
}

async function markLinkUsed(token: string) {
  await prisma.accountLink.update({ where: { tokenHash: sha256(token) }, data: { usedAt: new Date(), tokenEnc: null } });
}

/** A welcome or password link: sets the password, ends every session. */
export async function usePasswordLink(token: string, password: string, confirm: string): Promise<LinkInfo> {
  const link = await findLink(token);
  if (!link || link.kind === 'authenticator') throw new TwoStepError('This link has expired or was already used.', 404);
  checkPassword(password);
  if (password !== confirm) throw new TwoStepError("The two passwords don't match. Type the same password in both boxes.");
  await prisma.user.update({ where: { id: link.userId }, data: { passwordHash: await hashPassword(password) } });
  await markLinkUsed(token);
  await signOutEverywhere(link.userId);
  return link;
}

/** An authenticator link: their current password, then a new QR code. */
export async function useAuthenticatorLink(token: string, password: string): Promise<LinkInfo> {
  const link = await findLink(token);
  if (!link || link.kind !== 'authenticator') throw new TwoStepError('This link has expired or was already used.', 404);
  const u = await prisma.user.findUnique({ where: { id: link.userId }, select: { passwordHash: true } });
  if (!u?.passwordHash || !(await verifyPassword(password, u.passwordHash).catch(() => false))) {
    throw new TwoStepError('That password isn\'t right. If you forgot it, use "Forgot your password?" on the sign-in page first, then come back to this email.', 401);
  }
  await markLinkUsed(token);
  return link;
}

/** Unused links a Super User sent, for the Users page ("Copy link" when the email didn't arrive). */
export async function openLinks(): Promise<Map<number, { kind: LinkKind; expiresAt: Date; url: string }>> {
  const rows = await prisma.accountLink.findMany({
    where: { usedAt: null, expiresAt: { gt: new Date() }, createdById: { not: null }, tokenEnc: { not: null } },
    select: { userId: true, kind: true, expiresAt: true, tokenEnc: true },
  });
  return new Map(rows.map((r) => [r.userId, { kind: r.kind as LinkKind, expiresAt: r.expiresAt, url: linkUrl(decrypt(r.tokenEnc!).toString('utf8')) }]));
}

// --- admin: lost phone ----------------------------------------------------------------

/** Clears the authenticator and signs them out. The new one can only be set up from the emailed link (userLinks.resetAndEmail). */
export async function resetAuthenticator(userId: number) {
  const u = await prisma.user.update({
    where: { id: userId },
    data: {
      totpSecretEnc: null, totpNewEnc: null, totpOnAt: null, totpLastStep: null,
      totpFailures: 0, totpLockedUntil: null, totpNeedsLink: true,
    },
    select: { id: true, email: true },
  });
  await signOutEverywhere(userId);
  return u;
}
