// Destination: apps/api/src/routes/groupContacts.ts
import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.ts';
import { requireAuth } from '../middleware/auth.ts';
import { canAccessGroup } from '../lib/scope.ts';

// mergeParams lets this router read :groupId from its parent mount point
// (app.use('/api/groups/:groupId/contacts', groupContactsRouter) in index.ts)
const router = Router({ mergeParams: true });

router.use(requireAuth);
// Unlike carrierContacts.ts (Carrier is shared, unscoped reference data),
// Group is broker-scoped like everything else under it - a Broker User
// should only see/manage contacts on their own broker's groups. Reuses the
// existing canAccessGroup helper rather than inventing a new check.
router.use(async (req: Request, res: Response, next) => {
  const groupId = Number(req.params.groupId);
  if (!(await canAccessGroup(req.user!, groupId, res))) return;
  next();
});

// GET /api/groups/:groupId/contacts
router.get('/', async (req: Request, res: Response) => {
  const groupId = Number(req.params.groupId);
  try {
    const contacts = await prisma.groupContact.findMany({
      where: { groupId, active: true },
      orderBy: { name: 'asc' },
    });
    res.json(contacts);
  } catch (err) {
    console.error('Failed to list group contacts:', err);
    res.status(500).json({ error: 'Failed to list group contacts' });
  }
});

// POST /api/groups/:groupId/contacts
// Body: { name, title?, email, phone? }
router.post('/', async (req: Request, res: Response) => {
  const groupId = Number(req.params.groupId);
  const { name, title, email, phone } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }

  try {
    const contact = await prisma.groupContact.create({
      data: { groupId, name, title, email, phone },
    });
    res.status(201).json(contact);
  } catch (err) {
    console.error('Failed to create group contact:', err);
    res.status(500).json({ error: 'Failed to create group contact' });
  }
});

// PUT /api/groups/:groupId/contacts/:id
router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { name, title, email, phone, active } = req.body;

  try {
    const contact = await prisma.groupContact.update({
      where: { id },
      data: { name, title, email, phone, active },
    });
    res.json(contact);
  } catch (err) {
    console.error('Failed to update group contact:', err);
    res.status(500).json({ error: 'Failed to update group contact' });
  }
});

// DELETE /api/groups/:groupId/contacts/:id
// Soft-delete (active: false) rather than a hard delete, since an existing
// GroupProposal may reference this contact and shouldn't lose its trail.
router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  try {
    await prisma.groupContact.update({ where: { id }, data: { active: false } });
    res.status(204).send();
  } catch (err) {
    console.error('Failed to remove group contact:', err);
    res.status(500).json({ error: 'Failed to remove group contact' });
  }
});

export default router;