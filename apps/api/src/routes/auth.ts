// Destination: apps/api/src/routes/auth.ts
//
// Sign-in, in two steps (see lib/twoStep.ts):
//   POST /api/auth/login          { email, password } -> { next: 'code' | 'setup' }
//                                 sets the pending cookie, NOT a session
//   GET  /api/auth/two-step       what the pending step needs: { purpose, email }
//                                 plus { qrSvg, uri, key } when setting up
//   POST /api/auth/two-step       { code } -> the signed-in user, sets the session
//   GET  /api/auth/link?token=    an emailed authenticator link: { kind, email, name }
//   POST /api/auth/link           { token, password } -> { next: 'setup' }
//   POST /api/auth/logout
//   GET  /api/auth/me
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma.ts';
import { verifyPassword, SESSION_COOKIE } from '../lib/auth.ts';
import { requireAuth } from '../middleware/auth.ts';
import {
  afterPassword, checkCode, clearPending, enrollmentKey, findLink, markLinkUsed, PENDING_COOKIE, readPending, TwoStepError,
} from '../lib/twoStep.ts';

const router = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const codeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false });

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
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH).catch(() => false);
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

// POST /api/auth/link  { token, password }
router.post('/link', loginLimiter, async (req: Request, res: Response) => {
  const token = String(req.body?.token ?? '');
  const password = String(req.body?.password ?? '');
  try {
    const link = await findLink(token);
    if (!link || link.kind !== 'authenticator') {
      return res.status(404).json({ error: 'This link has expired or was already used.' });
    }
    const u = await prisma.user.findUnique({ where: { id: link.userId }, select: { passwordHash: true } });
    if (!(await verifyPassword(password, u?.passwordHash ?? DUMMY_HASH).catch(() => false))) {
      return res.status(401).json({ error: "That password isn't right. If you forgot it, ask a Super User to set a new one." });
    }
    await markLinkUsed(token);
    const next = await afterPassword(res, link.userId, { fromLink: true });
    res.json(next);
  } catch (err) {
    sendError(res, err, 'Could not use the link');
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
