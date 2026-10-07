// Destination: apps/api/src/routes/benefitsReconciliation.ts
// Employee-level, exact-match comparison between BenefitsDocumentEntry rows
// (carrier eligibility/enrollment documents) and Election rows (Employee
// Navigator data, loaded nightly by loadElections.ts) for one Group. See
// benefits-document-wide-format-and-dollar-reconciliation-design.md S5 for
// the decided comparison anchor (Election.planMonthlyCost) and the
// exact-match-no-tolerance call.
import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.ts';
import { requireAuth } from '../middleware/auth.ts';
import { canAccessGroup } from '../lib/scope.ts';
import { resolveProductId } from '../lib/productMatch.ts';

const router = Router({ mergeParams: true });

router.use(requireAuth);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// Compares one field when either side reports it. Returns null (nothing to
// compare) when neither side has a value for this field.
function compareField(entryValue: number | null, electionValue: number | null) {
  if (entryValue === null && electionValue === null) return null;
  const delta = round2((entryValue ?? 0) - (electionValue ?? 0));
  return { entryValue, electionValue, delta, status: delta === 0 ? 'matched' : 'mismatch' };
}

// GET /api/groups/:groupId/benefits-reconciliation
router.get('/', async (req: Request, res: Response) => {
  const groupId = Number(req.params.groupId);
  if (!(await canAccessGroup(req.user!, groupId, res))) return;

  try {
    const [entries, elections] = await Promise.all([
      prisma.benefitsDocumentEntry.findMany({
        where: { groupId },
        include: { product: true },
        orderBy: { employeeName: 'asc' },
      }),
      prisma.election.findMany({ where: { groupId }, include: { employee: true } }),
    ]);

    // Election has no productId of its own (free-text plan/benefit) - reuse
    // the exact same resolveProductId() synonym table BenefitsDocumentEntry
    // already trusts, rather than inventing a second substring matcher.
    const electionProductIds = await Promise.all(elections.map((e) => resolveProductId(e.plan || e.benefit || null)));
    const electionsWithProductId = elections.map((e, i) => ({ election: e, productId: electionProductIds[i] }));

    const usedElectionIds = new Set<number>();
    const rows: any[] = [];

    for (const entry of entries) {
      const match = entry.employeeId
        ? electionsWithProductId.find(
            (x) =>
              x.election.employeeId === entry.employeeId &&
              x.productId !== null &&
              x.productId === entry.productId &&
              !usedElectionIds.has(x.election.id)
          )
        : undefined;

      if (!match) {
        rows.push({
          outcome: 'carrier_only',
          employeeName: entry.employeeName,
          employeeId: entry.employeeId,
          carrierName: entry.carrierName,
          productLabel: entry.productLabel,
          product: entry.product?.name ?? null,
          comparisons: {},
        });
        continue;
      }
      usedElectionIds.add(match.election.id);

      const election = match.election;
      const entryEeMonthly = toNumber(entry.employeeMonthlyCost);
      const entryErMonthly = toNumber(entry.employerMonthlyCost);
      const electionEe = toNumber(election.eeMonthlyCost);
      const electionEr = toNumber(election.erMonthlyCost);
      const electionMonthly =
        toNumber(election.planMonthlyCost) ??
        (electionEe !== null || electionEr !== null ? round2((electionEe ?? 0) + (electionEr ?? 0)) : null);

      const comparisons: Record<string, any> = {};

      if (entryEeMonthly !== null || entryErMonthly !== null || electionMonthly !== null) {
        if (entryErMonthly === null && entryEeMonthly !== null && electionMonthly !== null) {
          // Carrier reported only the employee-side cost, no separate
          // employer column - per Gregg's decision this is not a mismatch;
          // the gap is surfaced as an implied employer contribution.
          comparisons.monthlyCost = {
            entryValue: entryEeMonthly,
            electionValue: electionMonthly,
            delta: null,
            status: 'info_implied_employer_contribution',
            impliedEmployerContribution: round2(electionMonthly - entryEeMonthly),
          };
        } else {
          const entryMonthlyTotal = round2((entryEeMonthly ?? 0) + (entryErMonthly ?? 0));
          const cmp = compareField(entryMonthlyTotal, electionMonthly);
          if (cmp) comparisons.monthlyCost = cmp;
        }
      }

      const benefitCmp = compareField(toNumber(entry.benefitAmount), toNumber(election.benefitAmount));
      if (benefitCmp) comparisons.benefitAmount = benefitCmp;

      const payrollCmp = compareField(toNumber(entry.coveredPayrollAmount), toNumber(election.coveredPayrollAmount));
      if (payrollCmp) comparisons.coveredPayrollAmount = payrollCmp;

      const anyMismatch = Object.values(comparisons).some((c: any) => c.status === 'mismatch');

      rows.push({
        outcome: anyMismatch ? 'mismatch' : 'matched',
        employeeName: entry.employeeName ?? election.employee?.displayName ?? election.employee?.fullName ?? null,
        employeeId: entry.employeeId,
        carrierName: entry.carrierName,
        productLabel: entry.productLabel,
        product: entry.product?.name ?? null,
        comparisons,
      });
    }

    // Elections for this group never claimed by a carrier entry.
    for (const { election } of electionsWithProductId) {
      if (usedElectionIds.has(election.id)) continue;
      rows.push({
        outcome: 'en_only',
        employeeName: election.employee?.displayName ?? election.employee?.fullName ?? null,
        employeeId: election.employeeId,
        carrierName: election.carrier,
        productLabel: election.plan ?? election.benefit,
        product: null,
        comparisons: {},
      });
    }

        // Cross-reference carrier-only and EN-only gaps for the same employee AND
    // the same coarse benefit category (life, disability, dental, vision,
    // etc.), inferred from keywords in the plan name. Matching on employee
    // alone (the old logic) dumped every unmatched EN plan into every
    // unmatched carrier plan for that person - e.g. pairing "Basic Life"
    // with "Vision" just because both were leftovers - which is noise, not
    // a real product-name mismatch signal.
    function categorize(label: string | null | undefined): string | null {
      if (!label) return null;
      const l = label.toLowerCase();
      if (l.includes('life') || l.includes('ad&d')) return 'life';
      if (l.includes('disability')) return 'disability';
      if (l.includes('dental')) return 'dental';
      if (l.includes('vision')) return 'vision';
      if (l.includes('accident')) return 'accident';
      if (l.includes('critical illness')) return 'critical_illness';
      if (l.includes('hospital indemnity')) return 'hospital_indemnity';
      if (l.includes('medical') || l.includes('health') || l.includes('buy up') || l.includes('base plan')) return 'medical';
      return null;
    }
    function pushToMap(map: Map<string, any[]>, key: string, value: any) {
      const arr = map.get(key);
      if (arr) arr.push(value);
      else map.set(key, [value]);
    }
    const carrierOnlyByKey = new Map<string, any[]>();
    const enOnlyByKey = new Map<string, any[]>();
    for (const r of rows) {
      if (r.employeeId === null || r.employeeId === undefined) continue;
      const category = categorize(r.product ?? r.productLabel);
      if (!category) continue;
      const key = `${r.employeeId}::${category}`;
      if (r.outcome === 'carrier_only') pushToMap(carrierOnlyByKey, key, r);
      else if (r.outcome === 'en_only') pushToMap(enOnlyByKey, key, r);
    }
    const possibleMismatchEmployeeIds = new Set<number>();
    for (const [key, carrierRows] of carrierOnlyByKey) {
      const enRows = enOnlyByKey.get(key);
      if (!enRows) continue;
      possibleMismatchEmployeeIds.add(Number(key.split('::')[0]));
      for (const r of carrierRows) r.possibleMatches = enRows.map((x) => x.productLabel).filter(Boolean);
      for (const r of enRows) r.possibleMatches = carrierRows.map((x) => x.productLabel).filter(Boolean);
    }
    const possibleProductMismatchEmployees = possibleMismatchEmployeeIds.size;

    const summary = {
      matched: rows.filter((r) => r.outcome === 'matched').length,
      mismatch: rows.filter((r) => r.outcome === 'mismatch').length,
      carrier_only: rows.filter((r) => r.outcome === 'carrier_only').length,
      en_only: rows.filter((r) => r.outcome === 'en_only').length,
      possible_product_mismatch_employees: possibleProductMismatchEmployees,
    };

    res.json({ groupId, summary, rows });
  } catch (err) {
    console.error('Failed to run benefits reconciliation:', err);
    res.status(500).json({ error: 'Failed to run benefits reconciliation' });
  }
});

export default router;