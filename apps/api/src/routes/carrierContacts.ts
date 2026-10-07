// Destination: apps/api/src/routes/carrierContacts.ts
import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.ts';
import { requireAuth } from '../middleware/auth.ts';

// mergeParams lets this router read :carrierId from its parent mount point
// (app.use('/api/carriers/:carrierId/contacts', carrierContactsRouter) in index.ts)
const router = Router({ mergeParams: true });

router.use(requireAuth);

// GET /api/carriers/:carrierId/contacts
router.get('/', async (req: Request, res: Response) => {
  const carrierId = Number(req.params.carrierId);
  try {
    const contacts = await prisma.carrierContact.findMany({
      where: { carrierId, active: true },
      orderBy: { name: 'asc' },
    });
    res.json(contacts);
  } catch (err) {
    console.error('Failed to list carrier contacts:', err);
    res.status(500).json({ error: 'Failed to list carrier contacts' });
  }
});

// POST /api/carriers/:carrierId/contacts
// Body: { name, title?, email, phone? }
// Deliberately open to both roles - the one exception to the Carrier
// catalog's usual Super-User-write-only rule (confirmed with Gregg 2026-09-06).
router.post('/', async (req: Request, res: Response) => {
  const carrierId = Number(req.params.carrierId);
  const { name, title, email, phone } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }

  try {
    const contact = await prisma.carrierContact.create({
      data: { carrierId, name, title, email, phone },
    });
    res.status(201).json(contact);
  } catch (err) {
    console.error('Failed to create carrier contact:', err);
    res.status(500).json({ error: 'Failed to create carrier contact' });
  }
});

// PUT /api/carriers/:carrierId/contacts/:id
router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { name, title, email, phone, active } = req.body;

  try {
    const contact = await prisma.carrierContact.update({
      where: { id },
      data: { name, title, email, phone, active },
    });
    res.json(contact);
  } catch (err) {
    console.error('Failed to update carrier contact:', err);
    res.status(500).json({ error: 'Failed to update carrier contact' });
  }
});

// DELETE /api/carriers/:carrierId/contacts/:id
// Soft-delete (active: false) rather than a hard delete, since an existing
// Rfq may reference this contact and shouldn't lose its trail.
router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  try {
    await prisma.carrierContact.update({ where: { id }, data: { active: false } });
    res.status(204).send();
  } catch (err) {
    console.error('Failed to remove carrier contact:', err);
    res.status(500).json({ error: 'Failed to remove carrier contact' });
  }
});

export default router;