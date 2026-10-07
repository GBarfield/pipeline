// Destination: apps/api/src/routes/reconciliationFilters.ts
// Saved filter templates + the ad hoc comparison endpoint for the v2
// filtering design. A filter is never required to be saved to run a
// comparison - /compare takes the same criteria directly in the body,
// and saving is purely a convenience for reloading next time. See
// commission-reconciliation-filtering-v2-design.md.
import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.ts';
import { requireAuth } from '../middleware/auth.ts';
import { canAccessGroups } from '../lib/scope.ts';

const router = Router();

router.use(requireAuth);

// --- Saved filter templates -------------------------------------------

// GET /api/reconciliation/filters
router.get('/filters', async (_req: Request, res: Response) => {
  try {
    const filters = await prisma.reconciliationFilter.findMany({ orderBy: { name: 'asc' } });
    res.json(filters);
  } catch (err) {
    console.error('Failed to list reconciliation filters:', err);
    res.status(500).json({ error: 'Failed to list reconciliation filters' });
  }
});

// POST /api/reconciliation/filters
// Body: { name, carrierNames?, productIds?, groupIds? }
router.post('/filters', async (req: Request, res: Response) => {
  const { name, carrierNames, productIds, groupIds } = req.body as {
    name?: string;
    carrierNames?: string[];
    productIds?: number[];
    groupIds?: number[];
  };
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  try {
    const filter = await prisma.reconciliationFilter.create({
      data: {
        name,
        carrierNames: carrierNames ?? [],
        productIds: productIds ?? [],
        groupIds: groupIds ?? [],
      },
    });
    res.status(201).json(filter);
  } catch (err) {
    console.error('Failed to create reconciliation filter:', err);
    res.status(500).json({ error: 'Failed to create reconciliation filter' });
  }
});

// PATCH /api/reconciliation/filters/:id
// Same body shape as POST - loading a template never locks it, so saving
// changes back to the same template is just an edit, not a new resource.
router.patch('/filters/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { name, carrierNames, productIds, groupIds } = req.body as {
    name?: string;
    carrierNames?: string[];
    productIds?: number[];
    groupIds?: number[];
  };

  try {
    const filter = await prisma.reconciliationFilter.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(carrierNames !== undefined ? { carrierNames } : {}),
        ...(productIds !== undefined ? { productIds } : {}),
        ...(groupIds !== undefined ? { groupIds } : {}),
      },
    });
    res.json(filter);
  } catch (err) {
    console.error('Failed to update reconciliation filter:', err);
    res.status(500).json({ error: 'Failed to update reconciliation filter' });
  }
});

// DELETE /api/reconciliation/filters/:id
router.delete('/filters/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  try {
    await prisma.reconciliationFilter.delete({ where: { id } });
    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete reconciliation filter:', err);
    res.status(500).json({ error: 'Failed to delete reconciliation filter' });
  }
});

// --- Comparison ----------------------------------------------------------

// POST /api/reconciliation/compare
// Body: { carrierNames?: string[], productIds?: number[], groupIds?: number[],
//         dateStart: string, dateEnd: string }
// Not tied to a saved filter or a single CommissionPeriod - totals whatever
// slice of census vs. commission-statement data the caller selects, for
// whatever date range the caller specifies. See the v2 design doc for why
// this replaced the old per-period /reconcile.
router.post('/compare', async (req: Request, res: Response) => {
  const { carrierNames, productIds, groupIds, dateStart, dateEnd } = req.body as {
    carrierNames?: string[];
    productIds?: number[];
    groupIds?: number[];
    dateStart?: string;
    dateEnd?: string;
  };

  if (!dateStart || !dateEnd) {
    return res.status(400).json({ error: 'dateStart and dateEnd are required' });
  }

  const requestedGroupIds = groupIds ?? [];
  if (!(await canAccessGroups(req.user!, requestedGroupIds, res))) return;

  // An empty groupIds selection means "no restriction specified" - for a
  // BROKER_USER that must resolve to "my own groups", never "every group
  // in the system", per canAccessGroups' contract.
  let effectiveGroupIds = requestedGroupIds;
  if (requestedGroupIds.length === 0 && req.user!.role !== 'SUPER_USER') {
    const ownGroups = await prisma.group.findMany({
      where: { brokerId: req.user!.brokerId },
      select: { id: true },
    });
    effectiveGroupIds = ownGroups.map((g) => g.id);
  }

  const start = new Date(dateStart);
  const end = new Date(dateEnd);

  try {
    const censusWhere: any = {
      period: {
        periodMonth: { gte: start, lte: end },
        ...(effectiveGroupIds.length ? { groupId: { in: effectiveGroupIds } } : {}),
      },
    };
    if (carrierNames?.length) censusWhere.carrierName = { in: carrierNames };
    if (productIds?.length) censusWhere.productId = { in: productIds };

        const statementWhere: any = {
      // statementPeriodStart/End are now extracted by Bucket when a file
      // has an explicit period column (Step 9), but plenty of carrier
      // statements still won't specify one - a null-dated row is treated
      // as "period unknown, always included" rather than excluded, so a
      // date-range filter never silently hides genuinely relevant rows
      // just because the source file didn't state a period.
      OR: [
        { statementPeriodStart: null },
        {
          AND: [
            { statementPeriodStart: { lte: end } },
            { OR: [{ statementPeriodEnd: null }, { statementPeriodEnd: { gte: start } }] },
          ],
        },
      ],
    };
    if (carrierNames?.length) statementWhere.carrierName = { in: carrierNames };
    if (productIds?.length) statementWhere.productId = { in: productIds };
    if (effectiveGroupIds.length) statementWhere.groupId = { in: effectiveGroupIds };

    const [census, statement] = await Promise.all([
      prisma.censusEntry.findMany({ where: censusWhere, include: { product: true, period: { include: { group: true } } } }),
      prisma.commissionStatementEntry.findMany({ where: statementWhere, include: { product: true, group: true } }),
    ]);

    type Bucket = { carrierName: string; productName: string | null; total: number };
    const censusTotals = new Map<string, Bucket>();
    const statementTotals = new Map<string, Bucket>();
    const keyFor = (carrierName: string, productId: number | null) =>
      `${carrierName.toLowerCase()}::${productId ?? 'unassigned'}`;

    for (const entry of census) {
      const key = keyFor(entry.carrierName, entry.productId);
      const amount = Number(entry.premium);
      const existing = censusTotals.get(key);
      if (existing) existing.total += amount;
      else censusTotals.set(key, { carrierName: entry.carrierName, productName: entry.product?.name ?? entry.productLabel ?? null, total: amount });
    }

    for (const entry of statement) {
      const key = keyFor(entry.carrierName, entry.productId);
      const amount = Number(entry.reportedPremium);
      const existing = statementTotals.get(key);
      if (existing) existing.total += amount;
      else statementTotals.set(key, { carrierName: entry.carrierName, productName: entry.product?.name ?? entry.productLabel ?? null, total: amount });
    }

    const allKeys = new Set([...censusTotals.keys(), ...statementTotals.keys()]);
    const results = Array.from(allKeys).map((key) => {
      const c = censusTotals.get(key);
      const s = statementTotals.get(key);
      const censusTotal = c?.total ?? 0;
      const statementTotal = s?.total ?? 0;
      const difference = Math.round((censusTotal - statementTotal) * 100) / 100;
      return {
        carrierName: (c ?? s)!.carrierName,
        productName: (c ?? s)!.productName,
        censusTotal,
        statementTotal,
        difference,
        status: difference !== 0 ? 'needs_examination' : 'matched',
        onlyOnCensus: !s,
        onlyOnStatement: !c,
      };
    });

    const censusGrandTotal = Math.round(census.reduce((sum, e) => sum + Number(e.premium), 0) * 100) / 100;
    const statementGrandTotal = Math.round(statement.reduce((sum, e) => sum + Number(e.reportedPremium), 0) * 100) / 100;

    res.json({
      filter: { carrierNames: carrierNames ?? [], productIds: productIds ?? [], groupIds: effectiveGroupIds, dateStart, dateEnd },
      censusGrandTotal,
      statementGrandTotal,
      difference: Math.round((censusGrandTotal - statementGrandTotal) * 100) / 100,
      results,
      censusEntries: census,
      statementEntries: statement,
    });
  } catch (err) {
    console.error('Failed to run reconciliation compare:', err);
    res.status(500).json({ error: 'Failed to run reconciliation compare' });
  }
});

export default router;