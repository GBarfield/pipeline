import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { requireAuth, requireRole } from '../middleware/auth.ts';

const router = Router();

router.use(requireAuth);

// GET /api/divisions — list active divisions, any authenticated role (needed to populate the dropdown).
router.get('/', async (req, res) => {
  const divisions = await prisma.division.findMany({
    where: { active: true },
    orderBy: { sortOrder: 'asc' },
  });
  res.json(divisions);
});

// GET /api/divisions/current — the app-wide current division, any authenticated role.
router.get('/current', async (req, res) => {
  const setting = await prisma.appSetting.findUnique({
    where: { id: 1 },
    include: { currentDivision: true },
  });
  if (!setting) {
    return res.status(500).json({ error: 'App settings not initialized — run the seed script.' });
  }
  res.json(setting.currentDivision);
});

// PATCH /api/divisions/current — switch the app-wide current division. Super User only.
router.patch('/current', requireRole('SUPER_USER'), async (req, res) => {
  const { divisionId } = req.body as { divisionId?: number };
  if (!divisionId) {
    return res.status(400).json({ error: 'divisionId is required' });
  }

  const division = await prisma.division.findUnique({ where: { id: divisionId } });
  if (!division || !division.active) {
    return res.status(404).json({ error: 'Division not found or inactive' });
  }

  const setting = await prisma.appSetting.upsert({
    where: { id: 1 },
    update: { currentDivisionId: divisionId },
    create: { id: 1, currentDivisionId: divisionId },
    include: { currentDivision: true },
  });

  res.json(setting.currentDivision);
});

export default router;