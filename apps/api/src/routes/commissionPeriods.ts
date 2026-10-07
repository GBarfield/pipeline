// Destination: apps/api/src/routes/commissionPeriods.ts
import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.ts';
import { requireAuth } from '../middleware/auth.ts';
import { canAccessGroup } from '../lib/scope.ts';

const router = Router({ mergeParams: true });

router.use(requireAuth);
router.use(async (req: Request, res: Response, next) => {
  const groupId = Number(req.params.groupId);
  if (!(await canAccessGroup(req.user!, groupId, res))) return;
  next();
});

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function firstOfMonth(input: string): Date {
  const d = new Date(input);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function defaultLabel(periodMonth: Date): string {
  return `${MONTH_NAMES[periodMonth.getUTCMonth()]} ${periodMonth.getUTCFullYear()}`;
}

// GET /api/groups/:groupId/commission-periods
router.get('/', async (req: Request, res: Response) => {
  const groupId = Number(req.params.groupId);
  const restrictedDivisionId = req.user!.restrictedDivisionId;
  try {
    const periods = await prisma.commissionPeriod.findMany({
      where: {
        groupId,
        ...(restrictedDivisionId !== null ? { divisionId: restrictedDivisionId } : {}),
      },
      orderBy: { periodMonth: 'desc' },
    });
    res.json(periods);
  } catch (err) {
    console.error('Failed to list commission periods:', err);
    res.status(500).json({ error: 'Failed to list commission periods' });
  }
});

// POST /api/groups/:groupId/commission-periods
// Body: { periodMonth: "2026-08-01" (any parseable date within the target month), label?: string }
router.post('/', async (req: Request, res: Response) => {
  const groupId = Number(req.params.groupId);
  const { periodMonth, label } = req.body;

  if (!periodMonth) {
    return res.status(400).json({ error: 'periodMonth is required' });
  }

  const normalized = firstOfMonth(periodMonth);
  if (Number.isNaN(normalized.getTime())) {
    return res.status(400).json({ error: 'periodMonth is not a valid date' });
  }

      try {
    const accounting = await prisma.division.findUniqueOrThrow({ where: { key: 'ACCOUNTING' } });
    if (req.user!.restrictedDivisionId !== null && req.user!.restrictedDivisionId !== accounting.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const period = await prisma.commissionPeriod.create({
      data: {
        groupId,
        divisionId: accounting.id,
        periodMonth: normalized,
        label: label || defaultLabel(normalized),
      },
    });
    res.status(201).json(period);
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return res.status(409).json({ error: 'A commission period already exists for this group and month' });
    }
    console.error('Failed to create commission period:', err);
    res.status(500).json({ error: 'Failed to create commission period' });
  }
});

export default router;