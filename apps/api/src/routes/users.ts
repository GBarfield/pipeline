// Destination: apps/api/src/routes/users.ts
import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.ts';
import { hashPassword } from '../lib/auth.ts';
import { requireAuth, requireRole } from '../middleware/auth.ts';
import { resetAuthenticator } from '../lib/twoStep.ts';

const router = Router();

router.use(requireAuth, requireRole('SUPER_USER'));

// Never select passwordHash back out to the client.
const SAFE_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  brokerId: true,
  restrictedDivisionId: true,
  active: true,
  lastLoginAt: true,
  totpOnAt: true,       // two-step sign-in set up (never the key itself)
  totpNeedsLink: true,  // reset, waiting for the emailed link
  totpLockedUntil: true,
  createdAt: true,
  updatedAt: true,
} as const;

// GET /api/users?brokerId=5&role=BROKER_USER
router.get('/', async (req: Request, res: Response) => {
  const { brokerId, role } = req.query;
  try {
    const users = await prisma.user.findMany({
      where: {
        ...(brokerId ? { brokerId: Number(brokerId) } : {}),
        ...(role ? { role: String(role) as 'SUPER_USER' | 'BROKER_USER' } : {}),
      },
      select: SAFE_SELECT,
      orderBy: { id: 'asc' },
    });
    res.json(users);
  } catch (err) {
    console.error('Failed to list users:', err);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// POST /api/users
// Body: { email, password, name, role, brokerId? } - brokerId required when role is BROKER_USER.
router.post('/', async (req: Request, res: Response) => {
  const { email, password, name, role, brokerId, restrictedDivisionId } = req.body;

  if (!email || !password || !name || !role) {
    return res.status(400).json({ error: 'email, password, name, and role are required' });
  }
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
        email: String(email).toLowerCase(),
        passwordHash: await hashPassword(password),
        name,
        role,
        brokerId: role === 'BROKER_USER' ? Number(brokerId) : null,
        restrictedDivisionId: role === 'BROKER_USER' && restrictedDivisionId ? Number(restrictedDivisionId) : null,
      },
      select: SAFE_SELECT,
    });
    res.status(201).json(user);
  } catch (err: any) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }
    console.error('Failed to create user:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// PATCH /api/users/:id
// Supports: name, email, active (deactivate/reactivate), password (reset), restrictedDivisionId.
router.patch('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { name, email, active, password, restrictedDivisionId } = req.body;

  try {
    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (email !== undefined) data.email = String(email).toLowerCase();
    if (active !== undefined) data.active = Boolean(active);
    if (password) data.passwordHash = await hashPassword(password);
    // A new password or deactivation signs the person out everywhere.
    if (password || active === false) data.sessionVersion = { increment: 1 };

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
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }
    console.error('Failed to update user:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// POST /api/users/:id/reset-authenticator
// Lost or new phone: clears their authenticator, signs them out everywhere and
// emails a one-time link to connect a new phone (password first). The link is
// also returned so it can be passed on another way if the email doesn't
// arrive. You can't reset your own: another Super User has to (or, as a last
// resort, the server command `pnpm two-step:reset <email>`).
router.post('/:id/reset-authenticator', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user' });
  if (id === req.user!.id) return res.status(400).json({ error: 'Another Super User has to reset your authenticator.' });
  try {
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, active: true } });
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (!target.active) return res.status(400).json({ error: 'Turn this user back on (Active) first.' });
    const r = await resetAuthenticator(id, { id: req.user!.id, name: req.user!.name });
    res.json(r);
  } catch (err) {
    console.error('Failed to reset authenticator:', err);
    res.status(500).json({ error: 'Failed to reset authenticator' });
  }
});

export default router;