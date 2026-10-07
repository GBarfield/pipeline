// Destination: apps/api/src/routes/deals.ts
import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.ts';
import { requireAuth } from '../middleware/auth.ts';
import { canAccessGroup } from '../lib/scope.ts';

// mergeParams lets this router read :groupId from its parent mount point
// (app.use('/api/groups/:groupId/deals', dealsRouter) in index.ts)
const router = Router({ mergeParams: true });

router.use(requireAuth);
router.use(async (req: Request, res: Response, next) => {
  const groupId = Number(req.params.groupId);
  if (!(await canAccessGroup(req.user!, groupId, res))) return;
  next();
});

// GET /api/groups/:groupId/deals
router.get('/', async (req: Request, res: Response) => {
  const groupId = Number(req.params.groupId);
  const restrictedDivisionId = req.user!.restrictedDivisionId;
  try {
    const deals = await prisma.deal.findMany({
      where: {
        groupId,
        ...(restrictedDivisionId !== null ? { divisionId: restrictedDivisionId } : {}),
      },
      orderBy: { effectiveDate: 'desc' },
    });
    res.json(deals);
  } catch (err) {
    console.error('Failed to list deals:', err);
    res.status(500).json({ error: 'Failed to list deals' });
  }
});

// POST /api/groups/:groupId/deals
// Body: { effectiveDate: string } — name is derived from the year automatically.
router.post('/', async (req: Request, res: Response) => {
  const groupId = Number(req.params.groupId);
  const { effectiveDate } = req.body;

  if (!effectiveDate) {
    return res.status(400).json({ error: 'effectiveDate is required' });
  }

  const year = new Date(effectiveDate).getFullYear();
  if (Number.isNaN(year)) {
    return res.status(400).json({ error: 'effectiveDate is not a valid date' });
  }

      try {
    const marketing = await prisma.division.findUniqueOrThrow({ where: { key: 'MARKETING' } });
    if (req.user!.restrictedDivisionId !== null && req.user!.restrictedDivisionId !== marketing.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const deal = await prisma.deal.create({
      data: {
        groupId,
        divisionId: marketing.id,
        name: `${year} Renewal`,
        effectiveDate: new Date(effectiveDate),
        status: 'open',
      },
    });
    res.status(201).json(deal);
  } catch (err) {
    console.error('Failed to create deal:', err);
    res.status(500).json({ error: 'Failed to create deal' });
  }
});

// PUT /api/groups/:groupId/deals/:id
// Status changes only for now (open/won/lost/archived) — name is derived
// and effectiveDate shouldn't normally change once bids are tied to a deal.
router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }

  try {
    const deal = await prisma.deal.update({
      where: { id },
      data: { status },
    });
    res.json(deal);
  } catch (err) {
    console.error('Failed to update deal:', err);
    res.status(500).json({ error: 'Failed to update deal' });
  }
});

export default router;