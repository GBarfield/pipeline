// Destination: apps/api/src/routes/employeeNavigator.ts
// Read-only Employee Navigator dashboard data for the Benefits
// Administration Reconciliation page's bottom panel - Employee/Election
// rows already loaded nightly by loadElections.ts. Not division-gated at
// the data layer: Employee/Election have no divisionId of their own, same
// as Group by design. What makes this a Benefits Administration feature
// is that it's the only division whose menu surfaces it.
import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.ts';
import { requireAuth } from '../middleware/auth.ts';
import { canAccessGroup } from '../lib/scope.ts';

const router = Router({ mergeParams: true });
router.use(requireAuth);

// GET /api/groups/:groupId/employee-navigator
router.get('/', async (req: Request, res: Response) => {
  const groupId = Number(req.params.groupId);
  if (!(await canAccessGroup(req.user!, groupId, res))) return;

  try {
    const employees = await prisma.employee.findMany({
      where: { groupId },
      include: { elections: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
    res.json(employees);
  } catch (err) {
    console.error('Failed to list employee navigator data:', err);
    res.status(500).json({ error: 'Failed to list employee navigator data' });
  }
});

export default router;