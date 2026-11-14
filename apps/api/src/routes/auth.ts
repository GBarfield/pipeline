// Destination: apps/api/src/routes/auth.ts
//
// Sign-in, in two steps (see lib/twoStep.ts):
//   POST /api/auth/login          { email, password } -> { next: 'code' | 'setup' }
//                                 sets the pending cookie, NOT a session
//   GET  /api/auth/two-step       what the pending step needs: { purpose, email }
//                                 plus { qrSvg, uri, key } when setting up
//   POST /api/auth/two-step       { code } -> the signed-in user, sets the session
//   GET  /api/auth/link?token=    an emailed link: { kind, email, name, expiresAt }
//   POST /api/auth/link           welcome / password link: { token, password, confirm }
//                                 authenticator link:      { token, password }
//                                 -> { next: 'code' | 'setup' }
//   POST /api/auth/forgot         { email } -> always { ok: true } (never says if the email exists)
//   POST /api/auth/password       signed in: { current, password, confirm } (change my own password)
//   POST /api/auth/logout
//   GET  /api/auth/me
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma.ts';
import { hashPassword, verifyPassword, SESSION_COOKIE } from '../lib/auth.ts';
import { requireAuth } from '../middleware/auth.ts';
import {
  afterPassword, checkCode, checkPassword, clearPending, enrollmentKey, findLink, PENDING_COOKIE, readPending, startSession,
  TwoStepError, useAuthenticatorLink, usePasswordLink,
} from '../lib/twoStep.ts';
import { forgotPassword } from '../lib/userLinks.ts';

const router = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const codeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false });
const forgotLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

// Per-email brake on password guessing, as in Translatus: 5 failures per 15 minutes.
const failures = new Map<string, { count: number; until: number }>();
const WINDOW_MS = 15 * 60_000;
// Compared against when the email is unknown, so response time doesn't reveal which emails exist.
const DUMMY_HASH = '$2b$12$6kRFQZLlpK0Q0lG4WMp75.orAVpvvqqw8qu52T2cwwjNAApzdoOR6';

function sendError(res: Response, err: unknown, fallback: string) {
  if (err instanceof TwoStepError) {
    if (err.restart) clearPending(res);
    return res.status(err.status).json({ error: err.message, restart: err.restart });
  }
  console.error(fallback, err);
  return res.status(500).json({ error: fallback });
}

// POST /api/auth/login
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const now = Date.now();
  const rec = failures.get(email);
  if (rec && rec.until > now && rec.count >= 5) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    // No password yet (never finished the welcome email): still compare against the dummy, so it takes the same time.
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH).catch(() => false) && !!user?.passwordHash;
    if (!user || !ok || !user.active) {
      const r = rec && rec.until > now ? rec : { count: 0, until: now + WINDOW_MS };
      r.count++;
      failures.set(email, r);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    failures.delete(email);

    const next = await afterPassword(res, user.id);
    if (next.next === 'needs-link') {
      return res.status(403).json({
        error: 'Your authenticator app was reset. Open the email from PipeLine called "Set up your authenticator app for PipeLine again" and click its link. If the link has expired, ask a Super User to reset it again.',
      });
    }
    res.json(next);
  } catch (err) {
    sendError(res, err, 'Login failed');
  }
});

// GET /api/auth/two-step
router.get('/two-step', async (req: Request, res: Response) => {
  try {
    const p = await readPending(req.cookies?.[PENDING_COOKIE]);
    if (!p) {
      clearPending(res);
      return res.status(401).json({ error: 'That took too long, so we stopped for your safety. Sign in again.', restart: true });
    }
    if (p.purpose === 'verify') return res.json({ purpose: p.purpose, email: p.email });
    const k = await enrollmentKey(p);
    res.json({ purpose: p.purpose, email: p.email, name: p.name, qrSvg: k.qrSvg, uri: k.uri, key: k.grouped });
  } catch (err) {
    sendError(res, err, 'Could not load the sign-in step');
  }
});

// POST /api/auth/two-step
router.post('/two-step', codeLimiter, async (req: Request, res: Response) => {
  try {
    const p = await readPending(req.cookies?.[PENDING_COOKIE]);
    if (!p) {
      clearPending(res);
      return res.status(401).json({ error: 'That took too long, so we stopped for your safety. Sign in again.', restart: true });
    }
    const user = await checkCode(res, p, String(req.body?.code ?? ''));
    res.json({ ...user, enrolled: p.purpose === 'enroll' });
  } catch (err) {
    sendError(res, err, 'Sign-in failed');
  }
});

// GET /api/auth/link?token=
router.get('/link', async (req: Request, res: Response) => {
  try {
    const link = await findLink(String(req.query.token ?? ''));
    if (!link) return res.status(404).json({ error: "This link doesn't work anymore. It may have expired, or it was already used." });
    res.json({ kind: link.kind, email: link.email, name: link.name, expiresAt: link.expiresAt });
  } catch (err) {
    sendError(res, err, 'Could not read the link');
  }
});

// POST /api/auth/link
router.post('/link', loginLimiter, async (req: Request, res: Response) => {
  const token = String(req.body?.token ?? '');
  const password = String(req.body?.password ?? '');
  try {
    const kind = (await findLink(token))?.kind;
    if (!kind) return res.status(404).json({ error: 'This link has expired or was already used.' });
    const link = kind === 'authenticator'
      ? await useAuthenticatorLink(token, password)
      : await usePasswordLink(token, password, String(req.body?.confirm ?? ''));
    console.log(`[account-links] user ${link.userId} used a ${kind} link`);
    const next = await afterPassword(res, link.userId, { fromLink: true });
    if (next.next === 'needs-link') return res.status(403).json({ error: 'Sign in again.' });
    res.json({ ...next, passwordSet: kind !== 'authenticator' });
  } catch (err) {
    sendError(res, err, 'Could not use the link');
  }
});

// POST /api/auth/forgot  { email }
router.post('/forgot', forgotLimiter, async (req: Request, res: Response) => {
  const email = String(req.body?.email ?? '');
  try {
    if (email.trim()) await forgotPassword(email);
  } catch (err) {
    console.error('[account-links] forgot password failed:', err);
  }
  // Always the same answer, so this can't be used to find out who has an account.
  res.json({ ok: true });
});

// POST /api/auth/password  { current, password, confirm } - change my own password.
// Signs out every other session (this one gets a fresh cookie).
router.post('/password', requireAuth, async (req: Request, res: Response) => {
  const current = String(req.body?.current ?? '');
  const password = String(req.body?.password ?? '');
  const confirm = String(req.body?.confirm ?? '');
  try {
    const u = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { passwordHash: true } });
    if (!u?.passwordHash || !(await verifyPassword(current, u.passwordHash).catch(() => false))) {
      return res.status(400).json({ error: "Your current password isn't right." });
    }
    checkPassword(password);
    if (password !== confirm) return res.status(400).json({ error: "The two new passwords don't match." });
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { passwordHash: await hashPassword(password), sessionVersion: { increment: 1 } },
    });
    await prisma.pendingSignIn.deleteMany({ where: { userId: req.user!.id } });
    await startSession(res, req.user!.id);
    console.log(`[account-links] user ${req.user!.id} changed their password`);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err, 'Could not change the password');
  }
});

// POST /api/auth/logout
router.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE);
  clearPending(res);
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req: Request, res: Response) => {
  const u = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { totpOnAt: true } });
  res.json({ ...req.user, twoStepOnAt: u?.totpOnAt ?? null });
});

export default router;
