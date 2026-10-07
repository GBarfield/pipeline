/**
 * comparison-engine/orchestrator.ts
 * Destination: apps/api/src/lib/comparisonEngine/orchestrator.ts
 *
 * Wires the matcher, tab builder, and xlsx builder to Prisma. Kept separate from
 * routes/comparison.ts so the build/reconcile/export logic can be unit tested without
 * spinning up Express.
 *
 * Depends on one new model in schema.prisma — ComparisonRowMapping (see
 * prisma-schema-additions.prisma). Nothing about the existing Quote model needs to
 * change: productId and source already exist, and productType is read as-is (the
 * rateStructure rename proposed in the design doc's §5 was never applied and isn't
 * needed for this to work).
 *
 * Updated this session: `quote.findMany`'s `where` now also accepts `excluded`, and
 * buildComparison() passes `excluded: false` — soft-deleted Quotes (DELETE /:id sets
 * excluded: true rather than removing the row) were previously still being pulled
 * into the comparison workbook, which is wrong: a removed line item shouldn't show up
 * in the export just because nothing purges the row.
 */

import type {
  QuoteRecord,
  ProductRecord,
  RowMappingRecord,
  ComparisonBuildResult,
  ReconciliationDecision,
} from './types.ts';
import { buildComparisonTabs } from './tabBuilder.ts';
import { buildComparisonWorkbook } from './xlsxBuilder.ts';
import type ExcelJS from 'exceljs';

/**
 * Minimal shape of the Prisma client this module needs — narrower than the full
 * generated client type so it's easy to pass a test double in tests. The real
 * `prisma` singleton (apps/api/src/lib/prisma.ts) satisfies this structurally; no
 * explicit cast to a specific PrismaClient type is required since Prisma 7 in this
 * project generates its client to a custom output path (../generated/prisma per
 * schema.prisma), not the @prisma/client package.
 */
export interface ComparisonPrismaClient {
  quote: {
    findMany: (args: { where: { dealId: number; excluded?: boolean } }) => Promise<QuoteRecord[]>;
  };
  product: {
    findMany: () => Promise<ProductRecord[]>;
  };
  comparisonRowMapping: {
    findMany: (args: { where: { dealId: number } }) => Promise<RowMappingRecord[]>;
    createMany: (args: { data: Omit<RowMappingRecord, 'id' | 'createdAt'>[] }) => Promise<unknown>;
  };
  deal: {
    findUnique: (args: {
      where: { id: number };
      include: { group: true };
    }) => Promise<{ id: number; name: string; group: { company: string } | null } | null>;
  };
}

/**
 * Stage 1 of the "Build Comparison" action (§6.1, §6.4): assemble every tab and
 * surface any near-duplicate benefit/out_of_network labels for review. Nothing is
 * written to the database here — this is a preview.
 */
export async function buildComparison(
  prisma: ComparisonPrismaClient,
  dealId: number,
  /** See tabBuilder.ts's buildComparisonTabs — omit for the combined Final build. */
  sourceFilter?: 'current' | 'proposal'
): Promise<ComparisonBuildResult> {
  const [quotes, products, mappings] = await Promise.all([
    prisma.quote.findMany({ where: { dealId, excluded: false } }),
    prisma.product.findMany(),
    prisma.comparisonRowMapping.findMany({ where: { dealId } }),
  ]);

  const { tabs, reconciliation } = buildComparisonTabs(dealId, quotes, products, mappings, sourceFilter);
  return { dealId, tabs, reconciliation };
}

/**
 * Stage 2: persist the user's reconciliation decisions as remembered mappings so the
 * same near-duplicate doesn't need reconciling again on the next rebuild (§6.4).
 * `keep_separate` decisions are intentionally not persisted — there's nothing to
 * remember about two labels the user said are genuinely different.
 */
export async function applyReconciliation(
  prisma: ComparisonPrismaClient,
  dealId: number,
  productId: number,
  decisions: ReconciliationDecision[],
  candidateLookup: Map<
    string,
    { section: 'benefit' | 'out_of_network'; canonicalLabel: string; aliasLabels: string[] }
  >,
  /**
   * Resolves a rowId to its display label for 'remap' decisions — the row the user
   * picked to merge into isn't necessarily the candidate's own suggested canonical
   * row, so the caller (which has the full tab from the preceding /build call) needs
   * to supply this. Falls back to the candidate's own canonicalLabel if omitted,
   * which is only correct for 'merge' decisions.
   */
  resolveRowLabel?: (rowId: string) => string | undefined
): Promise<void> {
  const rows: Omit<RowMappingRecord, 'id' | 'createdAt'>[] = [];

  for (const decision of decisions) {
    if (decision.action === 'keep_separate') continue;
    const candidate = candidateLookup.get(decision.candidateId);
    if (!candidate) continue;

    const canonicalLabel =
      decision.action === 'remap' && decision.remapToRowId
        ? resolveRowLabel?.(decision.remapToRowId) ?? candidate.canonicalLabel
        : candidate.canonicalLabel;

    for (const alias of candidate.aliasLabels) {
      rows.push({
        dealId,
        productId,
        section: candidate.section,
        canonicalLabel,
        aliasLabel: alias,
        confirmedBy: 'user_confirmed',
      });
    }
  }

  if (rows.length > 0) {
    await prisma.comparisonRowMapping.createMany({ data: rows });
  }
}

/**
 * Stage 3: re-run the build (now benefiting from any newly-persisted mappings) and
 * render the final workbook. Returns a Buffer suitable for an Express file response.
 */
export async function exportComparisonWorkbook(
  prisma: ComparisonPrismaClient,
  dealId: number,
  sourceFilter?: 'current' | 'proposal'
): Promise<{ buffer: Buffer; filename: string; unresolved: number }> {
  const [deal, result] = await Promise.all([
    prisma.deal.findUnique({ where: { id: dealId }, include: { group: true } }),
    buildComparison(prisma, dealId, sourceFilter),
  ]);

  const dealName = deal ? `${deal.group?.company ?? 'Unknown Group'} — ${deal.name}` : undefined;

  const workbook: ExcelJS.Workbook = await buildComparisonWorkbook(result.tabs, { dealName });
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const safeName = (dealName ?? `deal-${dealId}`).replace(/[^a-z0-9]+/gi, '_');
  const date = new Date().toISOString().slice(0, 10);
  const scopeSuffix = sourceFilter === 'current' ? '_current' : sourceFilter === 'proposal' ? '_proposal' : '';
  const filename = `${safeName}${scopeSuffix}_comparison_${date}.xlsx`;

  return { buffer, filename, unresolved: result.reconciliation.length };
}