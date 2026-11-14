// Destination: apps/api/src/routes/users.ts
//
// Super User only. Passwords work like Translatus: a Super User never sets
// or sees one. A new user gets a welcome email with a one-time link (choose
// a password, then connect the authenticator app); "Send password link"
// emails a new-password link; "Reset authenticator" is for a lost phone. See
// lib/userLinks.ts and lib/twoStep.ts.
import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.ts';
import { requireAuth, requireRole } from '../middleware/auth.ts';
import { openLinks, TwoStepError } from '../lib/twoStep.ts';
import { resetAndEmail, sendPasswordLink, sendWelcome } from '../lib/userLinks.ts';

const router = Router();

router.use(requireAuth, requireRole('SUPER_USER'));

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;

// Never select passwordHash or the authenticator key back out to the client.
const SAFE_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  brokerId: true,
  restrictedDivisionId: true,
  active: true,
  lastLoginAt: true,
  totpOnAt: true,       // two-step sign-in set up
  totpNeedsLink: true,  // reset, waiting for the emailed link
  totpLockedUntil: true,
  createdAt: true,
  updatedAt: true,
} as const;

const actorOf = (req: Request) => ({ id: req.user!.id, name: req.user!.name });

function sendError(res: Response, err: unknown, fallback: string) {
  if (err instanceof TwoStepError) return res.status(err.status).json({ error: err.message });
  console.error(fallback, err);
  return res.status(500).json({ error: fallback });
}

// GET /api/users?brokerId=5&role=BROKER_USER
// Each user also gets hasPassword (false = never finished the welcome email)
// and pendingLink (an unused link a Super User sent, to copy if the email
// didn't arrive).
router.get('/', async (req: Request, res: Response) => {
  const { brokerId, role } = req.query;
  try {
    const [users, links] = await Promise.all([
      prisma.user.findMany({
        where: {
          ...(brokerId ? { brokerId: Number(brokerId) } : {}),
          ...(role ? { role: String(role) as 'SUPER_USER' | 'BROKER_USER' } : {}),
        },
        select: { ...SAFE_SELECT, passwordHash: true },
        orderBy: { id: 'asc' },
      }),
      openLinks(),
    ]);
    res.json(users.map(({ passwordHash, ...u }) => ({ ...u, hasPassword: !!passwordHash, pendingLink: links.get(u.id) ?? null })));
  } catch (err) {
    sendError(res, err, 'Failed to list users');
  }
});

// POST /api/users
// Body: { email, name, role, brokerId?, restrictedDivisionId? } - no password:
// they choose one from the welcome email. Responds with the user plus
// { emailed, url, expiresAt } for the welcome link.
router.post('/', async (req: Request, res: Response) => {
  const { name, role, brokerId, restrictedDivisionId } = req.body ?? {};
  const email = String(req.body?.email ?? '').trim().toLowerCase();

  if (!email || !name || !role) {
    return res.status(400).json({ error: 'email, name, and role are required' });
  }
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (role !== 'SUPER_USER' && role !== 'BROKER_USER') {
    return res.status(400).json({ error: 'role must be SUPER_USER or BROKER_USER' });
  }
  if (role === 'BROKER_USER' && !brokerId) {
    return res.status(400).json({ error: 'brokerId is required for a Broker User' });
  }
  if (role === 'SUPER_USER' && restrictedDivisionId) {
    return res.status(400).json({ error: 'A Super User cannot be division-restricted' });
  }

  try {
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: null,
        name: String(name).trim(),
        role,
        brokerId: role === 'BROKER_USER' ? Number(brokerId) : null,
        restrictedDivisionId: role === 'BROKER_USER' && restrictedDivisionId ? Number(restrictedDivisionId) : null,
      },
      select: SAFE_SELECT,
    });
    const link = await sendWelcome(actorOf(req), user.id);
    res.status(201).json({ ...user, emailed: link.emailed, url: link.url, expiresAt: link.expiresAt });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return res.status(409).json({ error: `${email} already has an account.` });
    }
    sendError(res, err, 'Failed to create user');
  }
});

// PATCH /api/users/:id
// Supports: name, email, active (deactivate/reactivate), restrictedDivisionId.
// Passwords are not set here: use "Send password link" (POST /:id/send-link).
router.patch('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { name, email, active, restrictedDivisionId } = req.body ?? {};

  if (req.body?.password !== undefined) {
    return res.status(400).json({ error: 'Passwords are chosen by the person. Use "Send password link" instead.' });
  }

  try {
    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (email !== undefined) {
      const e = String(email).trim().toLowerCase();
      if (!EMAIL_RE.test(e)) return res.status(400).json({ error: 'Enter a valid email address.' });
      data.email = e;
    }
    if (active !== undefined) {
      if (id === req.user!.id && !active) return res.status(400).json({ error: "You can't turn off your own account." });
      data.active = Boolean(active);
      // Turning someone off signs them out everywhere.
      if (!active) data.sessionVersion = { increment: 1 };
    }

    if (restrictedDivisionId !== undefined) {
      const target = await prisma.user.findUnique({ where: { id }, select: { role: true } });
      if (target?.role === 'SUPER_USER' && restrictedDivisionId !== null) {
        return res.status(400).json({ error: 'A Super User cannot be division-restricted' });
      }
      data.restrictedDivisionId = restrictedDivisionId === null ? null : Number(restrictedDivisionId);
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const user = await prisma.user.update({ where: { id }, data, select: SAFE_SELECT });
    res.json(user);
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }
    sendError(res, err, 'Failed to update user');
  }
});

// POST /api/users/:id/send-link
// Someone who never finished gets the welcome link again; otherwise a
// new-password link (24 hours). Their authenticator doesn't change.
router.post('/:id/send-link', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user' });
  try {
    res.json(await sendPasswordLink(actorOf(req), id));
  } catch (err) {
    sendError(res, err, 'Failed to send the link');
  }
});

// POST /api/users/:id/reset-authenticator
// Lost or new phone: clears their authenticator, signs them out everywhere and
// emails a one-time link to connect a new phone (password first). You can't
// reset your own: another Super User has to (or, as a last resort, the server
// command `pnpm two-step:reset <email>`).
router.post('/:id/reset-authenticator', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user' });
  try {
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, active: true } });
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (!target.active) return res.status(400).json({ error: 'Turn this user back on (Active) first.' });
    res.json(await resetAndEmail(actorOf(req), id));
  } catch (err) {
    sendError(res, err, 'Failed to reset authenticator');
  }
});

export default router;
