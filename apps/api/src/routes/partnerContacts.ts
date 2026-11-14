// Destination: apps/api/src/routes/partnerContacts.ts
//
// Read-only directory of CarrierContact rows across many Carrier rows at
// once, filtered by the parent's partnerType. Feeds the "Contacts
// Directory" tab on the TPAs & Vendors page. Editing still goes through the
// per-carrier /api/carriers/:carrierId/contacts routes.
//
// GET /api/partner-contacts?type=TPA,VENDOR   (default TPA,VENDOR; ALL = every type)
import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.ts';
import { requireAuth } from '../middleware/auth.ts';

const PARTNER_TYPES = ['CARRIER', 'TPA', 'VENDOR'] as const;
type PartnerTypeName = (typeof PARTNER_TYPES)[number];

const router = Router();
router.use(requireAuth);

router.get('/', async (req: Request, res: Response) => {
  const raw = typeof req.query.type === 'string' ? req.query.type.toUpperCase() : '';
  const requested = raw.split(',').map((t) => t.trim()).filter((t): t is PartnerTypeName => (PARTNER_TYPES as readonly string[]).includes(t));
  const types: PartnerTypeName[] = raw === 'ALL' ? [...PARTNER_TYPES] : requested.length ? requested : ['TPA', 'VENDOR'];
  try {
    const contacts = await prisma.carrierContact.findMany({
      where: { active: true, carrier: { partnerType: { in: types } } },
      include: { carrier: { select: { id: true, name: true, partnerType: true, active: true } } },
      orderBy: [{ carrier: { name: 'asc' } }, { name: 'asc' }],
    });
    res.json(contacts);
  } catch (err) {
    console.error('Failed to list partner contacts:', err);
    res.status(500).json({ error: 'Failed to list partner contacts' });
  }
});

export default router;
