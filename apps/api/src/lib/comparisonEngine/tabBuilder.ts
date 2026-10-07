/**
 * comparison-engine/tabBuilder.ts
 * Destination: apps/api/src/lib/comparisonEngine/tabBuilder.ts
 *
 * Turns a Deal's Quote rows into ComparisonTab objects — one tab per Product that
 * has at least one Quote (current or proposal) for that deal. (The design doc's §6.2
 * says "one workbook per Group" — but Quote is actually scoped by dealId in your
 * schema, with no groupId on it at all, so this operates per-Deal. A Deal is the real
 * unit a round of carrier bids belongs to.)
 *
 * Updated this session for the multi-product classify+extract flow, which creates
 * Quotes with productId: null until a human assigns a catalog Product via the
 * QuoteBucketPanel Product column. The old version of this file grouped strictly by
 * productId and silently dropped (`if (!product) continue`) any quote whose FK didn't
 * resolve — which used to only happen for genuinely orphaned rows, but now happens for
 * every freshly-extracted, not-yet-assigned quote, defeating the "everything on the
 * list feeds the comparison" design promise. Grouping now falls back to a
 * productLabel-based key when productId is null, so unassigned quotes still get their
 * own tab (named after the classifier's guess) instead of vanishing. Once a human
 * assigns the Product, the quote moves into that Product's tab on the next rebuild —
 * no extra code needed, it's just a different groupKey next time buildComparisonTabs runs.
 *
 * Three independent builders, mirroring the Bucket's own xlsx_builder.py split (§6.6 of
 * its reference doc) rather than one polymorphic function:
 *   - buildSimpleTieredTab: rate-tier + core-field rows assemble from fixed keys;
 *     benefits/out_of_network rows go through the RowMatcher (§6.4).
 *   - buildAgeBandedTab: coverage-class fields + age-band grid rows, all fixed-key —
 *     age_banded has no free-text dictionary equivalent, so the matcher never runs here.
 *   - buildFlatRateTab (new this session): Basic Life/AD&D and LTD/STD's flat
 *     rate-per-unit structure — a Basis + Rate-per-Unit pair plus a handful of
 *     fixed-key plan-design fields, modeled on the Bucket's own
 *     build_flat_rate_per_unit layout. Also fixed-key, no matcher.
 *
 * A fourth case not in the design doc or the Bucket at all: productType === "manual"
 * quotes (the no-document Current Products fallback, written by the real
 * apps/api/src/routes/quotes.ts POST /manual handler as { notes, rates }). These have
 * no fixed schema, so they're appended as extra columns to whichever tab the product's
 * structured quotes produce, with their `rates` dict folded into the free-text matcher
 * pass (simple_tiered tabs) or listed as unmatched rows (age_banded/flat_rate tabs —
 * there's no matcher there to fold into). See the "Manual quotes" section in each
 * builder below.
 */

import type {
  QuoteRecord,
  ProductRecord,
  ComparisonTab,
  ComparisonColumn,
  ComparisonRow,
  ReconciliationCandidate,
  RowMappingRecord,
  SimpleTieredData,
  AgeBandedData,
  FlatRateData,
  ManualQuoteData,
  CellValue,
} from './types.ts';
import { RowMatcher } from './rowMatcher.ts';

interface BuildContext {
  candidates: ReconciliationCandidate[];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function buildComparisonTabs(
  dealId: number,
  quotes: QuoteRecord[],
  products: ProductRecord[],
  rememberedMappings: RowMappingRecord[],
  /**
   * Optional scope for the two staged "preview" builds — Current Products and
   * Proposal Worksheets each have their own Build Comparison button, alongside the
   * combined Final Proposal build. Omit (Final build) to include both — current
   * columns first, then proposal columns grouped by carrier, exactly as before.
   */
  sourceFilter?: 'current' | 'proposal'
): { tabs: ComparisonTab[]; reconciliation: ReconciliationCandidate[] } {
  const tabs: ComparisonTab[] = [];
  const allCandidates: ReconciliationCandidate[] = [];

  // Defensive excluded filter — the orchestrator's Prisma query already asks for
  // excluded: false, but filtering again here means this function stays correct even
  // if it's ever called directly with an unfiltered quote list (e.g. from a test).
  const dealQuotes = quotes.filter(
    (q) => q.dealId === dealId && !q.excluded && (!sourceFilter || q.source === sourceFilter)
  );

  // Group by productId when the quote has been assigned to a catalog Product; fall
  // back to a productLabel-based key when it hasn't, so nothing extracted ever
  // silently disappears from the comparison (see file header).
  const groups = new Map<string, QuoteRecord[]>();
  for (const q of dealQuotes) {
    const key =
      q.productId != null ? `p:${q.productId}` : `l:${(q.productLabel ?? '').trim() || 'Unclassified'}`;
    const list = groups.get(key) ?? [];
    list.push(q);
    groups.set(key, list);
  }

  for (const groupQuotes of groups.values()) {
    const productId = groupQuotes[0].productId ?? null;
    const product = productId != null ? products.find((p) => p.id === productId) : undefined;
    // productId was set but the FK didn't resolve (genuinely orphaned) — fall back to
    // the raw label rather than showing a blank tab name.
    const productName = product?.name ?? groupQuotes[0].productLabel ?? 'Unclassified';

    const structuredQuotes = groupQuotes.filter(
      (q) =>
        q.productType === 'simple_tiered' ||
        q.productType === 'age_banded' ||
        q.productType === 'flat_rate_per_unit'
    );
    const manualQuotes = groupQuotes.filter((q) => q.productType === 'manual');

    if (structuredQuotes.length === 0 && manualQuotes.length === 0) continue;

    // A product is expected to be consistently one rate structure in practice
    // (Medical is always simple_tiered, Basic Life/AD&D is always flat_rate_per_unit)
    // — use whichever the majority of *structured* quotes report. If there are no
    // structured quotes at all (manual-only), default to simple_tiered purely to pick
    // a layout.
    let dominantType: 'simple_tiered' | 'age_banded' | 'flat_rate_per_unit' = 'simple_tiered';
    if (structuredQuotes.length > 0) {
      const counts = new Map<string, number>();
      for (const q of structuredQuotes) counts.set(q.productType, (counts.get(q.productType) ?? 0) + 1);
      dominantType = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0] as
        | 'simple_tiered'
        | 'age_banded'
        | 'flat_rate_per_unit';
    }
    const usableStructuredQuotes = structuredQuotes.filter((q) => q.productType === dominantType);

    const ctx: BuildContext = { candidates: [] };
    let tab: ComparisonTab;
    if (dominantType === 'simple_tiered') {
      tab = buildSimpleTieredTab(
        productId,
        productName,
        usableStructuredQuotes,
        manualQuotes,
        rememberedMappings,
        ctx
      );
    } else if (dominantType === 'age_banded') {
      tab = buildAgeBandedTab(productId, productName, usableStructuredQuotes, manualQuotes, ctx);
    } else {
      tab = buildFlatRateTab(productId, productName, usableStructuredQuotes, manualQuotes, ctx);
    }

    tabs.push(tab);
    allCandidates.push(...ctx.candidates);
  }

  return { tabs, reconciliation: allCandidates };
}

// ---------------------------------------------------------------------------
// Plan/product selection (shared by all three builders)
// ---------------------------------------------------------------------------
//
// A carrier document can list a couple dozen plan/product variations in one Quote
// (a 20-option medical proposal was the real case this was built for); the agent
// picks which ones actually belong in the comparison via the "Plans Shown" picker
// in QuoteBucketPanel.tsx, without deleting the rest. See QuoteRecord.planSelection
// in types.ts.

/**
 * Resolves a quote's planSelection (a set of zero-based indices, see
 * QuoteRecord.planSelection in types.ts) against its ACTUAL current plan/product
 * count and returns a Set to filter by, or null if nothing should be filtered (no
 * selection saved, or every saved index is now out of range — e.g. a reprocess
 * shrank the array since the selection was made). Falling back to "show
 * everything" on a stale mismatch is deliberate: silently producing an empty tab
 * would be a much worse failure than temporarily ignoring a filter that no longer
 * lines up. Indexed by position rather than plan_name/product_name specifically to
 * avoid the case where two plans in the same document share an identical name
 * (common with auto-generated combinatorial names) — a name-keyed Set can't tell
 * those apart, which was silently corrupting selections before this.
 */
function resolveSelection(
  quoteId: number,
  itemCount: number,
  selection: QuoteRecord['planSelection']
): Set<number> | null {
  if (!selection?.included || selection.included.length === 0) return null;
  const valid = selection.included.filter((i) => i >= 0 && i < itemCount);
  if (valid.length === 0) {
    console.warn(
      `Quote ${quoteId}: planSelection indices don't match its current plan/product count (${itemCount}) — showing all instead of an empty tab.`
    );
    return null;
  }
  return new Set(valid);
}

// ---------------------------------------------------------------------------
// Manual-quote column helpers (shared by all three builders)
// ---------------------------------------------------------------------------

function buildManualColumns(manualQuotes: QuoteRecord[]): ComparisonColumn[] {
  const columns: ComparisonColumn[] = [];
  for (const q of manualQuotes.filter((q) => q.source === 'current')) {
    columns.push({
      columnId: `manual:${q.id}`,
      kind: 'current',
      quoteId: q.id,
      carrierName: q.carrierName,
      isManualEntry: true,
    });
  }
  const byCarrier = new Map<string, QuoteRecord[]>();
  for (const q of manualQuotes.filter((q) => q.source === 'proposal')) {
    const list = byCarrier.get(q.carrierName) ?? [];
    list.push(q);
    byCarrier.set(q.carrierName, list);
  }
  for (const [carrierName, carrierQuotes] of byCarrier) {
    for (const q of carrierQuotes) {
      columns.push({ columnId: `manual:${q.id}`, kind: 'proposal', carrierName, quoteId: q.id, isManualEntry: true });
    }
  }
  return columns;
}

function manualNoteRow(manualQuotes: QuoteRecord[], manualColumns: ComparisonColumn[]): ComparisonRow | null {
  const values: Record<string, CellValue> = {};
  let any = false;
  for (const col of manualColumns) {
    const quote = manualQuotes.find((q) => q.id === col.quoteId);
    const data = quote?.rawData as ManualQuoteData | undefined;
    if (data?.notes) {
      values[col.columnId] = data.notes;
      any = true;
    }
  }
  return any
    ? { rowId: 'manual_note:notes', label: 'Notes (manual entry)', section: 'manual_note', values, wasMatched: false }
    : null;
}

// ---------------------------------------------------------------------------
// simple_tiered
// ---------------------------------------------------------------------------

const RATE_TIER_LABELS: Record<string, string> = {
  employee_only: 'Employee Only',
  employee_spouse: 'Employee + Spouse',
  employee_children: 'Employee + Child(ren)',
  family: 'Family',
};

// Recognizes common rate-tier abbreviations typed into a manual entry or an
// "add/edit details" supplement (e.g. "EE", "EE+SP") so they land in the SAME fixed
// rate-tier row as the carrier's own employee_only/employee_spouse/... values,
// instead of becoming a standalone free-text row that never lines up with anything
// (the free-text matcher only runs on the benefits/out_of_network sections - rate
// tiers are always fixed-key, so a manually-typed "EE" had nowhere to match before
// this). Normalized the same way as rowMatcher.ts's normalizeLabel: lowercase,
// collapse to letters/digits/+, collapse whitespace - so "EE + SP", "ee+sp", and
// "EE+Spouse" all resolve to the same key.
function normalizeTierLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const RATE_TIER_ALIASES: Record<string, string> = {};
function registerTierAliases(aliases: string[], key: string) {
  for (const alias of aliases) RATE_TIER_ALIASES[normalizeTierLabel(alias)] = key;
}
registerTierAliases(['ee', 'employee', 'employee only', 'ee only', 'single', 'emp only'], 'employee_only');
registerTierAliases(
  ['ee+sp', 'ee sp', 'ee+spouse', 'ee spouse', 'employee + spouse', 'employee spouse', 'ee+sps', 'e+s'],
  'employee_spouse'
);
registerTierAliases(
  [
    'ee+ch', 'ee ch', 'ee+child', 'ee+children', 'ee+child(ren)', 'ee child(ren)',
    'employee + child', 'employee + children', 'employee + child(ren)', 'ee children', 'ee kids', 'e+c',
  ],
  'employee_children'
);
registerTierAliases(['fam', 'family', 'ee+family', 'employee + family'], 'family');

/** Resolves a raw manual/supplement label to a canonical rate-tier key, or null if
 *  it isn't a recognized abbreviation of one. */
function resolveRateTierKey(rawLabel: string): string | null {
  return RATE_TIER_ALIASES[normalizeTierLabel(rawLabel)] ?? null;
}

const CORE_FIELD_LABELS: Record<string, string> = {
  deductible_individual: 'Deductible (Individual)',
  deductible_family: 'Deductible (Family)',
  oop_max_individual: 'Out-of-Pocket Max (Individual)',
  oop_max_family: 'Out-of-Pocket Max (Family)',
  deductible_embedded: 'Deductible Embedded',
  actuarial_value: 'Actuarial Value',
};

function buildSimpleTieredTab(
  productId: number | null,
  productName: string,
  quotes: QuoteRecord[], // structured (simple_tiered) only
  manualQuotes: QuoteRecord[],
  rememberedMappings: RowMappingRecord[],
  ctx: BuildContext
): ComparisonTab {
  const columns: ComparisonColumn[] = [];
  // planKey -> per-column source data, so we can fill values per row later.
  const planByColumn = new Map<string, { quote: QuoteRecord; planIdx: number }>();

  const currentQuotes = quotes.filter((q) => q.source === 'current');
  const proposalQuotes = quotes.filter((q) => q.source === 'proposal');

  for (const q of currentQuotes) {
    const data = q.rawData as SimpleTieredData;
    const selected = resolveSelection(q.id, data.plans.length, q.planSelection);
    data.plans.forEach((plan, planIdx) => {
      if (selected && !selected.has(planIdx)) return;
      const columnId = `structured:${q.id}:${planIdx}`;
      columns.push({ columnId, kind: 'current', quoteId: q.id, planName: plan.plan_name });
      planByColumn.set(columnId, { quote: q, planIdx });
    });
  }

  // Group proposal columns by carrier so each carrier's plans sit adjacent (§6.3).
  const byCarrier = new Map<string, QuoteRecord[]>();
  for (const q of proposalQuotes) {
    const list = byCarrier.get(q.carrierName) ?? [];
    list.push(q);
    byCarrier.set(q.carrierName, list);
  }
  for (const [carrierName, carrierQuotes] of byCarrier) {
    for (const q of carrierQuotes) {
      const data = q.rawData as SimpleTieredData;
      const selected = resolveSelection(q.id, data.plans.length, q.planSelection);
      data.plans.forEach((plan, planIdx) => {
        if (selected && !selected.has(planIdx)) return;
        const columnId = `structured:${q.id}:${planIdx}`;
        columns.push({
          columnId,
          kind: 'proposal',
          carrierName,
          quoteId: q.id,
          planName: plan.plan_name,
        });
        planByColumn.set(columnId, { quote: q, planIdx });
      });
    }
  }

  // Manual-entry columns, appended after the structured ones (see file header).
  const manualColumns = buildManualColumns(manualQuotes);
  columns.push(...manualColumns);

  const rows: ComparisonRow[] = [];

  // --- Manual/supplement entries that match a recognized rate-tier abbreviation
  // ("EE", "EE+SP", ...) are pulled out here so the fixed-key rate-tier rows below
  // can absorb them directly. Anything left over (a real free-text benefit line, or
  // something that just doesn't look like a tier) falls through to the free-text
  // matcher pass further down, unchanged from before. Tracked per source (manual
  // columnId, or structured quote id) so that pass knows which raw labels have
  // already been placed and shouldn't be folded in a second time as a duplicate row.
  const tierContributions: Record<string, Record<string, CellValue>> = {};
  const consumedManualLabels = new Map<string, Set<string>>(); // columnId -> raw labels
  const consumedSupplementLabels = new Map<number, Set<string>>(); // quoteId -> raw labels

  for (const col of manualColumns) {
    const quote = manualQuotes.find((q) => q.id === col.quoteId);
    const manualRates = (quote?.rawData as ManualQuoteData | undefined)?.rates;
    if (!manualRates) continue;
    const consumed = consumedManualLabels.get(col.columnId) ?? new Set<string>();
    for (const [rawLabel, value] of Object.entries(manualRates)) {
      const tierKey = resolveRateTierKey(rawLabel);
      if (!tierKey) continue;
      if (!tierContributions[tierKey]) tierContributions[tierKey] = {};
      tierContributions[tierKey][col.columnId] = value as CellValue;
      consumed.add(rawLabel);
    }
    consumedManualLabels.set(col.columnId, consumed);
  }

  {
    const seenTierSupplementQuoteIds = new Set<number>();
    for (const { quote } of planByColumn.values()) {
      if (seenTierSupplementQuoteIds.has(quote.id)) continue;
      seenTierSupplementQuoteIds.add(quote.id);
      const supplementRates = quote.supplement?.rates;
      if (!supplementRates) continue;
      const columnIds = [...planByColumn.entries()]
        .filter(([, v]) => v.quote.id === quote.id)
        .map(([columnId]) => columnId);
      const consumed = consumedSupplementLabels.get(quote.id) ?? new Set<string>();
      for (const [rawLabel, value] of Object.entries(supplementRates)) {
        const tierKey = resolveRateTierKey(rawLabel);
        if (!tierKey) continue;
        if (!tierContributions[tierKey]) tierContributions[tierKey] = {};
        for (const columnId of columnIds) {
          tierContributions[tierKey][columnId] = value as CellValue;
        }
        consumed.add(rawLabel);
      }
      consumedSupplementLabels.set(quote.id, consumed);
    }
  }

  // --- Fixed-key rows: rate tiers (structured columns, with manual/supplement
  // contributions gathered above layered on top - a human explicitly filling in or
  // correcting a tier wins over what was extracted for that same column). ---
  for (const [key, label] of Object.entries(RATE_TIER_LABELS)) {
    const values: Record<string, CellValue> = {};
    let anyPresent = false;
    for (const [columnId, { quote, planIdx }] of planByColumn) {
      const plan = (quote.rawData as SimpleTieredData).plans[planIdx];
      const v = plan.rates?.[key as keyof typeof plan.rates];
      if (v !== undefined && v !== null) anyPresent = true;
      values[columnId] = v ?? null;
    }
    const contributions = tierContributions[key];
    if (contributions) {
      for (const [columnId, value] of Object.entries(contributions)) {
        values[columnId] = value;
        anyPresent = true;
      }
    }
    if (anyPresent) {
      rows.push({ rowId: `rate_tier:${key}`, label, section: 'rate_tier', values, wasMatched: false });
    }
  }

  // --- Fixed-key rows: core plan fields (structured columns only) ---
  for (const [key, label] of Object.entries(CORE_FIELD_LABELS)) {
    const values: Record<string, CellValue> = {};
    let anyPresent = false;
    for (const [columnId, { quote, planIdx }] of planByColumn) {
      const plan = (quote.rawData as SimpleTieredData).plans[planIdx];
      const v = (plan as unknown as Record<string, CellValue>)[key];
      if (v !== undefined && v !== null) anyPresent = true;
      values[columnId] = v ?? null;
    }
    if (anyPresent) {
      rows.push({ rowId: `core_field:${key}`, label, section: 'core_field', values, wasMatched: false });
    }
  }

  // --- Free-text rows: benefits, out_of_network — the only part that needs matching.
  // Manual quotes' `rates` dict is folded into the "benefits" pass only — there's no
  // reliable way to tell which manual-entered rates are out-of-network specific. ---
  for (const section of ['benefits', 'out_of_network'] as const) {
    const sectionKey = section === 'benefits' ? 'benefit' : 'out_of_network';
    // productId is null for not-yet-assigned groups — pass a sentinel so RowMatcher
    // still works, but remembered mappings (always keyed to a real, positive Product
    // id) simply never match a sentinel, which is the correct behavior: an unassigned
    // group hasn't earned reconciliation memory yet.
    const matcher = new RowMatcher(productId ?? -1, sectionKey, rememberedMappings);
    const rowValues = new Map<string, Record<string, CellValue>>();
    const rowLabels = new Map<string, string>();

    for (const [columnId, { quote, planIdx }] of planByColumn) {
      const plan = (quote.rawData as SimpleTieredData).plans[planIdx];
      const dict = plan[section];
      if (!dict) continue;
      for (const [rawLabel, value] of Object.entries(dict)) {
        const result = matcher.resolve(rawLabel, columnId);
        if (result.candidate) ctx.candidates.push(result.candidate);
        if (!rowValues.has(result.rowId)) {
          rowValues.set(result.rowId, {});
          rowLabels.set(result.rowId, result.canonicalLabel);
        }
        rowValues.get(result.rowId)![columnId] = value;
      }
    }

    if (section === 'benefits') {
      for (const col of manualColumns) {
        const quote = manualQuotes.find((q) => q.id === col.quoteId);
        const rates = (quote?.rawData as ManualQuoteData | undefined)?.rates;
        if (!rates) continue;
        const consumed = consumedManualLabels.get(col.columnId);
        for (const [rawLabel, value] of Object.entries(rates)) {
          if (consumed?.has(rawLabel)) continue; // already placed in a rate-tier row above
          const result = matcher.resolve(rawLabel, col.columnId);
          if (result.candidate) ctx.candidates.push(result.candidate);
          if (!rowValues.has(result.rowId)) {
            rowValues.set(result.rowId, {});
            rowLabels.set(result.rowId, result.canonicalLabel);
          }
          rowValues.get(result.rowId)![col.columnId] = value as CellValue;
        }
      }

      // Fold each structured quote's own supplement (added via the "add/edit
      // details" icon on an already-extracted row) into the SAME column(s) that
      // quote already occupies — fills a gap on an existing line rather than
      // creating a new one. Any supplement notes ride along as one more entry
      // through the same pass, tagged distinctly so it can't collide with a real
      // benefit label. Rate-tier abbreviations were already absorbed above.
      const seenSupplementQuoteIds = new Set<number>();
      for (const { quote } of planByColumn.values()) {
        if (seenSupplementQuoteIds.has(quote.id)) continue;
        seenSupplementQuoteIds.add(quote.id);
        const supplement = quote.supplement;
        if (!supplement) continue;
        const consumed = consumedSupplementLabels.get(quote.id);
        const entries: Array<[string, string | number]> = [];
        if (supplement.rates) {
          for (const [rawLabel, value] of Object.entries(supplement.rates)) {
            if (consumed?.has(rawLabel)) continue; // already placed in a rate-tier row above
            entries.push([rawLabel, value]);
          }
        }
        if (supplement.notes) entries.push(['Notes (added manually)', supplement.notes]);
        if (entries.length === 0) continue;

        const columnIds = [...planByColumn.entries()]
          .filter(([, v]) => v.quote.id === quote.id)
          .map(([columnId]) => columnId);

        for (const [rawLabel, value] of entries) {
          const result = matcher.resolve(rawLabel, columnIds[0]);
          if (result.candidate) ctx.candidates.push(result.candidate);
          if (!rowValues.has(result.rowId)) {
            rowValues.set(result.rowId, {});
            rowLabels.set(result.rowId, result.canonicalLabel);
          }
          for (const columnId of columnIds) {
            rowValues.get(result.rowId)![columnId] = value as CellValue;
          }
        }
      }
    }

    for (const [rowId, values] of rowValues) {
      rows.push({
        rowId: `${sectionKey}:${rowId}`,
        label: rowLabels.get(rowId)!,
        section: sectionKey,
        values,
        wasMatched: true,
      });
    }
  }

  const noteRow = manualNoteRow(manualQuotes, manualColumns);
  if (noteRow) rows.push(noteRow);

  return {
    productId,
    productName,
    productType: 'simple_tiered',
    columns,
    rows,
  };
}

// ---------------------------------------------------------------------------
// age_banded
// ---------------------------------------------------------------------------
//
// No free-text dictionary equivalent here (§6.4: "no equivalent free-text dictionary
// on this side"), so every structured row is a fixed-key row — the matcher never runs.
// Manual quotes (rare for age-banded products, but the schema allows them) get their
// `rates` dict listed as individual unmatched rows, since there's no matcher-based
// alignment machinery in this builder.
//
// A "column" here is one (carrier, product_name) pair — treating rawData.products[]
// the same way simple_tiered treats plans[]. Rows are then generated per coverage
// class (flat rate, or the full age-band × coverage-amount grid).

function buildAgeBandedTab(
  productId: number | null,
  productName: string,
  quotes: QuoteRecord[], // structured (age_banded) only
  manualQuotes: QuoteRecord[],
  _ctx: BuildContext
): ComparisonTab {
  const columns: ComparisonColumn[] = [];
  const productByColumn = new Map<string, { quote: QuoteRecord; productIdx: number }>();

  const currentQuotes = quotes.filter((q) => q.source === 'current');
  const proposalQuotes = quotes.filter((q) => q.source === 'proposal');

  for (const q of currentQuotes) {
    const data = q.rawData as AgeBandedData;
    const selected = resolveSelection(q.id, data.products.length, q.planSelection);
    data.products.forEach((p, productIdx) => {
      if (selected && !selected.has(productIdx)) return;
      const columnId = `structured:${q.id}:${productIdx}`;
      columns.push({ columnId, kind: 'current', quoteId: q.id, planName: p.product_name });
      productByColumn.set(columnId, { quote: q, productIdx });
    });
  }

  const byCarrier = new Map<string, QuoteRecord[]>();
  for (const q of proposalQuotes) {
    const list = byCarrier.get(q.carrierName) ?? [];
    list.push(q);
    byCarrier.set(q.carrierName, list);
  }
  for (const [carrierName, carrierQuotes] of byCarrier) {
    for (const q of carrierQuotes) {
      const data = q.rawData as AgeBandedData;
      const selected = resolveSelection(q.id, data.products.length, q.planSelection);
      data.products.forEach((p, productIdx) => {
        if (selected && !selected.has(productIdx)) return;
        const columnId = `structured:${q.id}:${productIdx}`;
        columns.push({
          columnId,
          kind: 'proposal',
          carrierName,
          quoteId: q.id,
          planName: p.product_name,
        });
        productByColumn.set(columnId, { quote: q, productIdx });
      });
    }
  }

  const manualColumns = buildManualColumns(manualQuotes);
  columns.push(...manualColumns);

  // Collect the union of coverage-class names across all columns, in first-seen order,
  // so rows line up the way rate-tier rows do for simple_tiered (no matcher needed —
  // class_name is model-generated but structurally fixed per the Bucket's tool schema).
  const classOrder: string[] = [];
  const seenClasses = new Set<string>();
  for (const { quote, productIdx } of productByColumn.values()) {
    const p = (quote.rawData as AgeBandedData).products[productIdx];
    for (const cls of p.coverage_classes) {
      if (!seenClasses.has(cls.class_name)) {
        seenClasses.add(cls.class_name);
        classOrder.push(cls.class_name);
      }
    }
  }

  const rows: ComparisonRow[] = [];

  for (const className of classOrder) {
    // Fixed-key class-level fields.
    const classFieldRows: Array<{ key: string; label: string }> = [
      { key: 'non_medical_max', label: `${className} — Non-Medical Max` },
      { key: 'overall_benefit_max', label: `${className} — Overall Benefit Max` },
      { key: 'employee_contribution_pct', label: `${className} — Employee Contribution %` },
      { key: 'add_included', label: `${className} — AD&D Included` },
    ];
    for (const { key, label } of classFieldRows) {
      const values: Record<string, CellValue> = {};
      let anyPresent = false;
      for (const [columnId, { quote, productIdx }] of productByColumn) {
        const p = (quote.rawData as AgeBandedData).products[productIdx];
        const cls = p.coverage_classes.find((c) => c.class_name === className);
        const v = cls ? (cls as unknown as Record<string, CellValue>)[key] : null;
        if (v !== undefined && v !== null) anyPresent = true;
        values[columnId] = v ?? null;
      }
      if (anyPresent) {
        rows.push({
          rowId: `class_field:${className}:${key}`,
          label,
          section: 'core_field',
          values,
          wasMatched: false,
        });
      }
    }

    // Flat-rate row (only meaningful for columns whose class is flat-structured).
    {
      const values: Record<string, CellValue> = {};
      let anyPresent = false;
      for (const [columnId, { quote, productIdx }] of productByColumn) {
        const p = (quote.rawData as AgeBandedData).products[productIdx];
        const cls = p.coverage_classes.find((c) => c.class_name === className);
        if (cls?.rate_structure === 'flat') {
          anyPresent = true;
          values[columnId] = cls.flat_rate ?? null;
        } else {
          values[columnId] = null;
        }
      }
      if (anyPresent) {
        rows.push({
          rowId: `flat_rate:${className}`,
          label: `${className} — Flat Rate`,
          section: 'age_band',
          values,
          wasMatched: false,
        });
      }
    }

    // Age-banded grid rows: union of (age-band label, coverage amount) pairs seen
    // for this class across all columns, in first-seen order.
    const bandAmountOrder: string[] = []; // "label|amount"
    const seenBandAmount = new Set<string>();
    for (const { quote, productIdx } of productByColumn.values()) {
      const p = (quote.rawData as AgeBandedData).products[productIdx];
      const cls = p.coverage_classes.find((c) => c.class_name === className);
      if (cls?.rate_structure !== 'age_banded' || !cls.age_bands) continue;
      for (const band of cls.age_bands) {
        for (const amount of Object.keys(band.rates_by_amount)) {
          const key = `${band.label}|${amount}`;
          if (!seenBandAmount.has(key)) {
            seenBandAmount.add(key);
            bandAmountOrder.push(key);
          }
        }
      }
    }
    // Sort amounts numerically within each band label for readability, mirroring the
    // Bucket's own _sort_key_amount convention (strip $/commas, unparseable sorts last).
    const sortKey = (amountStr: string): number => {
      const n = Number(amountStr.replace(/[$,]/g, ''));
      return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
    };
    bandAmountOrder.sort((a, b) => {
      const [labelA, amtA] = a.split('|');
      const [labelB, amtB] = b.split('|');
      if (labelA !== labelB) return labelA.localeCompare(labelB);
      return sortKey(amtA) - sortKey(amtB);
    });

    for (const key of bandAmountOrder) {
      const [bandLabel, amount] = key.split('|');
      const values: Record<string, CellValue> = {};
      let anyPresent = false;
      for (const [columnId, { quote, productIdx }] of productByColumn) {
        const p = (quote.rawData as AgeBandedData).products[productIdx];
        const cls = p.coverage_classes.find((c) => c.class_name === className);
        const band = cls?.age_bands?.find((b) => b.label === bandLabel);
        const v = band?.rates_by_amount[amount];
        if (v !== undefined && v !== null) anyPresent = true;
        values[columnId] = v ?? null;
      }
      if (anyPresent) {
        rows.push({
          rowId: `age_band:${className}:${bandLabel}:${amount}`,
          label: `${className} — Age ${bandLabel} — $${amount}`,
          section: 'age_band',
          values,
          wasMatched: false,
        });
      }
    }
  }

  // Manual quotes: no matcher here, so their `rates` entries become individual
  // unmatched rows rather than being aligned against carrier rows at all. Flagged in
  // the file header as a known simplification — age-banded manual current-plan entry
  // is an edge case, not the primary use case §4 of the design doc describes.
  for (const col of manualColumns) {
    const quote = manualQuotes.find((q) => q.id === col.quoteId);
    const rates = (quote?.rawData as ManualQuoteData | undefined)?.rates;
    if (!rates) continue;
    for (const [label, value] of Object.entries(rates)) {
      rows.push({
        rowId: `manual_rate:${col.quoteId}:${label}`,
        label,
        section: 'manual_note',
        values: { [col.columnId]: value as CellValue },
        wasMatched: false,
      });
    }
  }

  // Supplement on structured quotes (added via the "add/edit details" icon on an
  // already-extracted row) becomes individual rows in that quote's own column(s) —
  // same treatment as manual quotes just above, but merged onto the existing column
  // instead of a separate manual column.
  {
    const seenSupplementQuoteIds = new Set<number>();
    for (const { quote } of productByColumn.values()) {
      if (seenSupplementQuoteIds.has(quote.id)) continue;
      seenSupplementQuoteIds.add(quote.id);
      const supplement = quote.supplement;
      if (!supplement) continue;
      const entries: Array<[string, string | number]> = [];
      if (supplement.rates) entries.push(...Object.entries(supplement.rates));
      if (supplement.notes) entries.push(['Notes (added manually)', supplement.notes]);
      if (entries.length === 0) continue;

      const columnIds = [...productByColumn.entries()]
        .filter(([, v]) => v.quote.id === quote.id)
        .map(([columnId]) => columnId);

      for (const [label, value] of entries) {
        rows.push({
          rowId: `supplement:${quote.id}:${label}`,
          label,
          section: 'manual_note',
          values: Object.fromEntries(columnIds.map((c) => [c, value as CellValue])),
          wasMatched: false,
        });
      }
    }
  }

  const noteRow = manualNoteRow(manualQuotes, manualColumns);
  if (noteRow) rows.push(noteRow);

  return {
    productId,
    productName,
    productType: 'age_banded',
    columns,
    rows,
  };
}

// ---------------------------------------------------------------------------
// flat_rate_per_unit  (new this session)
// ---------------------------------------------------------------------------
//
// Basic Life/AD&D and LTD/STD: a single flat rate per unit of coverage (per $1,000,
// per $100 of covered payroll), not a tiered table or an age-band grid. Modeled on
// the Bucket's own core/xlsx_builder.py build_flat_rate_per_unit layout. Like
// age_banded, there's no free-text dictionary equivalent here, so every row is
// fixed-key and the matcher never runs.
//
// A "column" here is one (carrier, product_name) pair from rawData.products[] — same
// pattern as buildAgeBandedTab, since a single Quote's products[] commonly has more
// than one entry (e.g. "Basic Life and AD&D" bundles the Life and AD&D sub-products).

const FLAT_CORE_FIELD_LABELS: Record<string, string> = {
  benefit_amount_formula: 'Benefit Amount',
  guarantee_issue_max: 'Guarantee Issue Max',
  employee_contribution_pct: 'Employee Contribution %',
  elimination_period: 'Elimination Period',
  benefit_duration: 'Benefit Duration',
};

function buildFlatRateTab(
  productId: number | null,
  productName: string,
  quotes: QuoteRecord[], // structured (flat_rate_per_unit) only
  manualQuotes: QuoteRecord[],
  _ctx: BuildContext
): ComparisonTab {
  const columns: ComparisonColumn[] = [];
  const productByColumn = new Map<string, { quote: QuoteRecord; productIdx: number }>();

  const currentQuotes = quotes.filter((q) => q.source === 'current');
  const proposalQuotes = quotes.filter((q) => q.source === 'proposal');

  for (const q of currentQuotes) {
    const data = q.rawData as FlatRateData;
    const selected = resolveSelection(q.id, data.products.length, q.planSelection);
    data.products.forEach((p, productIdx) => {
      if (selected && !selected.has(productIdx)) return;
      const columnId = `structured:${q.id}:${productIdx}`;
      columns.push({ columnId, kind: 'current', quoteId: q.id, planName: p.product_name });
      productByColumn.set(columnId, { quote: q, productIdx });
    });
  }

  const byCarrier = new Map<string, QuoteRecord[]>();
  for (const q of proposalQuotes) {
    const list = byCarrier.get(q.carrierName) ?? [];
    list.push(q);
    byCarrier.set(q.carrierName, list);
  }
  for (const [carrierName, carrierQuotes] of byCarrier) {
    for (const q of carrierQuotes) {
      const data = q.rawData as FlatRateData;
      const selected = resolveSelection(q.id, data.products.length, q.planSelection);
      data.products.forEach((p, productIdx) => {
        if (selected && !selected.has(productIdx)) return;
        const columnId = `structured:${q.id}:${productIdx}`;
        columns.push({
          columnId,
          kind: 'proposal',
          carrierName,
          quoteId: q.id,
          planName: p.product_name,
        });
        productByColumn.set(columnId, { quote: q, productIdx });
      });
    }
  }

  const manualColumns = buildManualColumns(manualQuotes);
  columns.push(...manualColumns);

  const rows: ComparisonRow[] = [];

  // --- Basis + Rate per Unit, both given 'rate_tier:' rowIds purely so they render as
  // one contiguous visual block (xlsxBuilder groups rows by section, one divider per
  // contiguous run). isCurrencyRow() only formats actual `typeof value === 'number'`
  // cells, so Basis's text value is never mis-formatted despite the 'rate_tier:'
  // prefix it shares with the real currency row below it. ---
  {
    const values: Record<string, CellValue> = {};
    let anyPresent = false;
    for (const [columnId, { quote, productIdx }] of productByColumn) {
      const p = (quote.rawData as FlatRateData).products[productIdx];
      if (p.basis) anyPresent = true;
      values[columnId] = p.basis ?? null;
    }
    if (anyPresent) {
      rows.push({ rowId: 'rate_tier:basis', label: 'Basis', section: 'rate_tier', values, wasMatched: false });
    }
  }
  {
    const values: Record<string, CellValue> = {};
    let anyPresent = false;
    for (const [columnId, { quote, productIdx }] of productByColumn) {
      const p = (quote.rawData as FlatRateData).products[productIdx];
      const v = p.rate_per_unit;
      if (v !== undefined && v !== null) anyPresent = true;
      values[columnId] = v ?? null;
    }
    if (anyPresent) {
      rows.push({
        rowId: 'rate_tier:rate_per_unit',
        label: 'Rate per Unit',
        section: 'rate_tier',
        values,
        wasMatched: false,
      });
    }
  }

  // --- Fixed-key plan-design rows (only added if at least one column has a value). ---
  for (const [key, label] of Object.entries(FLAT_CORE_FIELD_LABELS)) {
    const values: Record<string, CellValue> = {};
    let anyPresent = false;
    for (const [columnId, { quote, productIdx }] of productByColumn) {
      const p = (quote.rawData as FlatRateData).products[productIdx];
      const v = (p as unknown as Record<string, CellValue>)[key];
      if (v !== undefined && v !== null && v !== '') anyPresent = true;
      values[columnId] = v ?? null;
    }
    if (anyPresent) {
      rows.push({ rowId: `core_field:${key}`, label, section: 'core_field', values, wasMatched: false });
    }
  }

  // Manual quotes: same treatment as age_banded — no matcher here, so their `rates`
  // entries become individual unmatched rows.
  for (const col of manualColumns) {
    const quote = manualQuotes.find((q) => q.id === col.quoteId);
    const rates = (quote?.rawData as ManualQuoteData | undefined)?.rates;
    if (!rates) continue;
    for (const [label, value] of Object.entries(rates)) {
      rows.push({
        rowId: `manual_rate:${col.quoteId}:${label}`,
        label,
        section: 'manual_note',
        values: { [col.columnId]: value as CellValue },
        wasMatched: false,
      });
    }
  }

  // Supplement on structured quotes (added via the "add/edit details" icon on an
  // already-extracted row) becomes individual rows in that quote's own column(s) —
  // same treatment as manual quotes just above, but merged onto the existing column
  // instead of a separate manual column.
  {
    const seenSupplementQuoteIds = new Set<number>();
    for (const { quote } of productByColumn.values()) {
      if (seenSupplementQuoteIds.has(quote.id)) continue;
      seenSupplementQuoteIds.add(quote.id);
      const supplement = quote.supplement;
      if (!supplement) continue;
      const entries: Array<[string, string | number]> = [];
      if (supplement.rates) entries.push(...Object.entries(supplement.rates));
      if (supplement.notes) entries.push(['Notes (added manually)', supplement.notes]);
      if (entries.length === 0) continue;

      const columnIds = [...productByColumn.entries()]
        .filter(([, v]) => v.quote.id === quote.id)
        .map(([columnId]) => columnId);

      for (const [label, value] of entries) {
        rows.push({
          rowId: `supplement:${quote.id}:${label}`,
          label,
          section: 'manual_note',
          values: Object.fromEntries(columnIds.map((c) => [c, value as CellValue])),
          wasMatched: false,
        });
      }
    }
  }

  const noteRow = manualNoteRow(manualQuotes, manualColumns);
  if (noteRow) rows.push(noteRow);

  return {
    productId,
    productName,
    productType: 'flat_rate_per_unit',
    columns,
    rows,
  };
}