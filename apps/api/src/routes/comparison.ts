// Destination: apps/api/src/routes/comparison.ts
//
// Express routes for the comparison engine, following the same shape as the real
// apps/api/src/routes/quotes.ts: a shared `prisma` singleton imported directly (not
// passed in), `Router({ mergeParams: true })`, `export default router`.
//
// Mounted in apps/api/src/index.ts as a sibling of the existing quotes route:
//   app.use('/api/deals/:dealId/quotes', quotesRouter);
//   app.use('/api/deals/:dealId/comparison', comparisonRouter);
//
// Three endpoints, matching the two-stage build -> reconcile -> export flow from §6.1
// and §6.4 of the design proposal. The engine is intentionally stateless between
// requests: the reconcile step expects the client to send back the same
// ReconciliationCandidate objects it received from /build, paired with the user's
// decision, rather than the server holding an in-memory session. This keeps a page
// refresh mid-reconciliation harmless — worst case, the user re-runs /build.
//
// Updated for the three-button workflow (Current Products / Proposal Worksheets /
// Final Proposal panels each have their own Build Comparison button now): /build and
// /export both accept an optional `source` ('current' | 'proposal') to scope the
// build to just that side, for the two staged preview buttons. Omitted entirely for
// the Final Proposal panel's button, which produces the real combined deliverable —
// current columns first, then proposal columns grouped by carrier — unchanged from
// before.

import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.ts';
import { requireAuth } from '../middleware/auth.ts';
import { canAccessDeal } from '../lib/scope.ts';
import {
  buildComparison,
  applyReconciliation,
  exportComparisonWorkbook,
  type ComparisonPrismaClient,
} from '../lib/comparisonEngine/orchestrator.ts';
import type { ReconciliationCandidate, ReconciliationDecision } from '../lib/comparisonEngine/types.ts';

const router = Router({ mergeParams: true });

router.use(requireAuth);
router.use(async (req: Request, res: Response, next) => {
  const dealId = Number(req.params.dealId);
  if (!(await canAccessDeal(req.user!, dealId, res))) return;
  next();
});
// Structural cast: the generated Prisma client (output path set in schema.prisma,
// not the @prisma/client package) satisfies ComparisonPrismaClient's shape once the
// ComparisonRowMapping model and Deal.group include are in place.
const db = prisma as unknown as ComparisonPrismaClient;

function parseSource(v: unknown): 'current' | 'proposal' | undefined {
  return v === 'current' || v === 'proposal' ? v : undefined;
}

interface ReconcileRequestBody {
  productId: number;
  resolutions: Array<{
    candidate: ReconciliationCandidate;
    decision: ReconciliationDecision;
  }>;
  /** Only needed if any decision has action 'remap' — maps the target rowId the user
   *  picked to its display label (the client has this from the preceding /build
   *  response's tab.rows and should echo it back here). */
  rowLabelsByRowId?: Record<string, string>;
}

// POST /api/deals/:dealId/comparison/build
// Preview: assembles every tab, returns rows + any reconciliation candidates.
// Does not write anything. Optional JSON body { source: 'current' | 'proposal' }
// scopes the build to just that side, for the Current Products / Proposal
// Worksheets panels' own preview buttons — omit for the combined Final build.
router.post('/build', async (req: Request, res: Response) => {
  const dealId = Number(req.params.dealId);
  if (!Number.isInteger(dealId)) {
    return res.status(400).json({ error: 'Invalid dealId' });
  }
  const source = parseSource(req.body?.source);
  try {
    const result = await buildComparison(db, dealId, source);
    res.json(result);
  } catch (err) {
    console.error('Failed to build comparison:', err);
    res.status(500).json({ error: 'Failed to build comparison' });
  }
});

// POST /api/deals/:dealId/comparison/reconcile
// Persists the user's merge/keep-separate/remap decisions as remembered row
// mappings (§6.4) so they don't resurface on the next rebuild.
router.post('/reconcile', async (req: Request, res: Response) => {
  const dealId = Number(req.params.dealId);
  const body = req.body as ReconcileRequestBody;
  if (!Number.isInteger(dealId) || !body?.resolutions?.length) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  try {
    const candidateLookup = new Map<
      string,
      { section: 'benefit' | 'out_of_network'; canonicalLabel: string; aliasLabels: string[] }
    >();
    for (const { candidate } of body.resolutions) {
      candidateLookup.set(candidate.candidateId, {
        section: candidate.section,
        canonicalLabel: candidate.canonicalLabel,
        aliasLabels: candidate.aliasLabels,
      });
    }
    const decisions = body.resolutions.map((r) => r.decision);
    const resolveRowLabel = (rowId: string) => body.rowLabelsByRowId?.[rowId];
    await applyReconciliation(db, dealId, body.productId, decisions, candidateLookup, resolveRowLabel);
    res.json({ ok: true, saved: decisions.filter((d) => d.action !== 'keep_separate').length });
  } catch (err) {
    console.error('Failed to save reconciliation:', err);
    res.status(500).json({ error: 'Failed to save reconciliation' });
  }
});

// GET /api/deals/:dealId/comparison/export
// Final stage: rebuilds (benefiting from any mappings just saved) and streams the
// .xlsx. Optional ?source=current|proposal scopes the export the same way /build's
// body does — used by the Current Products / Proposal Worksheets preview buttons;
// omit for the Final Proposal panel's combined export.
// Returns an `X-Comparison-Unresolved` header if candidates remain outstanding — the
// frontend can warn the user the export may have blank-looking near-duplicate rows
// rather than blocking the download outright (§6.4: "renders blank... rather than
// blocking the export").
router.get('/export', async (req: Request, res: Response) => {
  const dealId = Number(req.params.dealId);
  if (!Number.isInteger(dealId)) {
    return res.status(400).json({ error: 'Invalid dealId' });
  }
  const source = parseSource(req.query.source);
  try {
    const { buffer, filename, unresolved } = await exportComparisonWorkbook(db, dealId, source);
    res.setHeader('X-Comparison-Unresolved', String(unresolved));
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('Failed to export comparison:', err);
    res.status(500).json({ error: 'Failed to export comparison' });
  }
});

export default router;