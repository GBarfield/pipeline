/**
 * comparison-engine/types.ts
 * Destination: apps/api/src/lib/comparisonEngine/types.ts
 *
 * Shared types for the Proposal Worksheets comparison engine.
 *
 * Updated for this session's Quote schema changes (the multi-product
 * classify+extract flow):
 *   - productId is now nullable — a freshly-extracted Quote starts
 *     unassigned to a catalog Product until a human confirms it via the
 *     editable Product column in QuoteBucketPanel. tabBuilder.ts groups
 *     these by productLabel instead of dropping them, so nothing
 *     extracted ever silently vanishes from the comparison.
 *   - productLabel: the classifier's raw guess, carried alongside
 *     productId - never overwritten by a Product assignment, so it's
 *     always available as a grouping fallback.
 *   - excluded: soft-delete flag. The orchestrator filters these out at
 *     the Prisma query level; kept on the type for completeness/defensive
 *     use elsewhere.
 *   - flat_rate_per_unit: the third real rate structure (Basic Life/AD&D,
 *     LTD/STD), added alongside simple_tiered and age_banded.
 */

// ---------------------------------------------------------------------------
// Bucket rawData shapes (as documented in The Bucket — Technical Reference §8)
// ---------------------------------------------------------------------------

export interface SimpleTieredRates {
  employee_only?: number;
  employee_spouse?: number;
  employee_children?: number;
  family?: number;
}

export interface SimpleTieredPlan {
  plan_name: string;
  plan_id?: string;
  rates: SimpleTieredRates;
  deductible_individual?: number;
  deductible_family?: number;
  oop_max_individual?: number;
  oop_max_family?: number;
  deductible_embedded?: boolean;
  actuarial_value?: number;
  // Free-text, carrier-chosen labels -> free-text value. This is the part that
  // needs fuzzy matching across carriers (§6.4).
  benefits?: Record<string, string>;
  out_of_network?: Record<string, string>;
}

export interface SimpleTieredData {
  carrier_name: string;
  group_name?: string;
  quote_id?: string;
  effective_date?: string;
  plans: SimpleTieredPlan[];
}

export interface AgeBandRow {
  label: string; // e.g. "30-34"
  rates_by_amount: Record<string, number>; // coverage amount (string) -> rate
}

export interface CoverageClass {
  class_name: string;
  increment?: number;
  non_medical_max?: number;
  overall_benefit_max?: number;
  add_included?: boolean;
  employee_contribution_pct?: number;
  rate_structure: 'age_banded' | 'flat';
  // if flat:
  flat_amount?: number;
  flat_rate?: number;
  // if age_banded:
  age_bands?: AgeBandRow[];
}

export interface AgeBandedProduct {
  product_name: string;
  coverage_classes: CoverageClass[];
}

export interface AgeBandedData {
  carrier_name: string;
  group_name?: string;
  quote_id?: string;
  effective_date?: string;
  products: AgeBandedProduct[];
}

/**
 * flat_rate_per_unit rawData shape, per claude_client.py's FLAT_RATE_DATA_TOOL
 * and core/xlsx_builder.py's build_flat_rate_per_unit. Basic Life/AD&D and
 * LTD/STD - a single flat rate per unit of coverage (per $1,000, per $100 of
 * payroll, etc.), not a tiered or age-banded table. A single Quote's
 * `products` array commonly has more than one entry (e.g. "Basic Life and
 * AD&D" contains both the Life and the AD&D sub-product) - tabBuilder.ts
 * treats each entry as its own column, same as it does for age_banded.
 */
export interface FlatRateProduct {
  product_name: string;
  basis: string;
  rate_per_unit: number;
  benefit_amount_formula?: string;
  guarantee_issue_max?: string;
  employee_contribution_pct?: string;
  elimination_period?: string;
  benefit_duration?: string;
}

export interface FlatRateData {
  carrier_name: string;
  group_name?: string;
  quote_id?: string;
  effective_date?: string;
  products: FlatRateProduct[];
}

/**
 * What a manual-entry Current Products quote actually stores, per the real
 * apps/api/src/routes/quotes.ts POST /manual handler:
 *   rawData: { notes: notes ?? null, rates: rates ?? null }
 * `rates` shape isn't schema-constrained on the write side — treated here as a flat
 * label -> value dict (matches the design doc's "a few key rates/benefits typed
 * directly"). If your manual-entry form on the frontend sends something structurally
 * different, update this type and the one read site in tabBuilder.ts that uses it.
 */
export interface ManualQuoteData {
  notes: string | null;
  rates: Record<string, string | number> | null;
}

/** Matches Quote.productType's actual values, including the "manual" case
 *  quotes.ts writes for the no-document Current Products fallback, and
 *  "flat_rate_per_unit" added this session for Basic Life/AD&D and LTD/STD. */
export type QuoteProductType = 'simple_tiered' | 'age_banded' | 'flat_rate_per_unit' | 'manual';
export type QuoteSource = 'current' | 'proposal';

// ---------------------------------------------------------------------------
// Quote row — matches your real Prisma model
// ---------------------------------------------------------------------------

export interface QuoteRecord {
  id: number;
  dealId: number;
  productId: number | null;
  productLabel: string | null;
  source: QuoteSource;
  carrierName: string;
  productType: QuoteProductType;
  usedDiscovery: boolean;
  rawData: SimpleTieredData | AgeBandedData | FlatRateData | ManualQuoteData;
  warnings: unknown | null;
  xlsxPath: string | null;
  originalPdfPath?: string | null;
  excluded: boolean;
  /**
   * Gap-filling for a row that already extracted - added via the "add/edit details"
   * icon on any Quote row, not just ones the extractor flagged. Same {notes, rates}
   * shape as a manual-entry Quote's rawData, but merged onto this existing row's own
   * column(s) in the comparison tab rather than creating a new column. Null/undefined
   * for a quote nothing's been added to.
   */
  supplement?: ManualQuoteData | null;
  /**
   * Allow-list of which plan/product options (by zero-based index into
   * rawData.plans[] for simple_tiered, or rawData.products[] for age_banded/
   * flat_rate_per_unit) actually appear in the comparison. Exists because a single
   * carrier document can list a couple dozen plan variations (a 20-option medical
   * proposal is the real case this was built for) and the agent usually only wants a
   * handful of them in the deliverable - see the "Plans Shown" picker in
   * QuoteBucketPanel.tsx and PATCH /:id/plan-selection.
   *
   * Indexed by POSITION, not by plan_name/product_name - an earlier version keyed
   * this by name and broke whenever two plans in the same document happened to
   * share an identical name (not rare with auto-generated combinatorial names like
   * "ANG TRAD 5000 7000"), since antd's Checkbox.Group and any name-based Set
   * lookup can't tell two same-named entries apart. Position is always unique
   * within one quote's own array.
   *
   * null/undefined means no filter - every plan/product shows, exactly as every
   * quote behaved before this field existed. Applies uniformly across every build
   * (Preview Current/Proposal and Final), not just the Final export, so a preview
   * always shows what the export will actually contain. If a reprocess changes the
   * plan count, tabBuilder.ts falls back to showing everything rather than trusting
   * indices that may now point at the wrong plan - see resolveSelection().
   */
  planSelection?: { included: number[] } | null;
  createdAt: string;
}

export interface ProductRecord {
  id: number;
  name: string; // "Medical" | "Dental" | "Vision" | "Life" | ...
}

// ---------------------------------------------------------------------------
// Row mapping memory (§6.4 — "worth remembering" — scoped per Deal here, since
// that's the actual unit Quotes are grouped under in your schema. A renewal next
// year is a new Deal and starts its reconciliation memory fresh, which is a
// reasonable default; revisit if you want it to span a Group's whole history.)
//
// Note: remembered mappings are keyed to a real Product id, so they only ever
// apply to quotes that have been assigned a catalog Product. Unassigned
// (productId: null) tabs simply don't benefit from remembered mappings yet —
// a natural incentive to assign the Product, not a bug.
// ---------------------------------------------------------------------------

export interface RowMappingRecord {
  id: number;
  dealId: number;
  productId: number;
  /** benefits and out_of_network are separate dictionaries — a mapping learned in
   *  one must not bleed into the other, so it's scoped alongside productId. */
  section: 'benefit' | 'out_of_network';
  /** The label the comparison tab actually displays for this row. */
  canonicalLabel: string;
  /** A raw carrier-supplied label that has been confirmed to mean canonicalLabel. */
  aliasLabel: string;
  /** How this mapping was created — surfaced in the reconciliation UI. */
  confirmedBy: 'auto_exact' | 'user_confirmed' | 'user_manual';
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Comparison output shapes — what the tab assembler produces, before xlsx
// ---------------------------------------------------------------------------

/** One column in a tab: either a "Current" column or one carrier plan/manual entry. */
export interface ComparisonColumn {
  columnId: string; // stable id, e.g. `${quoteId}:${planName}` or `manual:${quoteId}`
  kind: 'current' | 'proposal';
  carrierName?: string; // undefined for the "current" column
  planName?: string; // undefined for the "current" column
  quoteId: number;
  isManualEntry?: boolean; // true for productType: "manual" quotes
}

export type CellValue = string | number | boolean | null;

/** One row in a tab: a line item plus a value per column (sparse — missing = blank). */
export interface ComparisonRow {
  rowId: string; // stable id for reconciliation persistence
  label: string; // display label (canonical, once matched)
  section: 'rate_tier' | 'core_field' | 'benefit' | 'out_of_network' | 'age_band' | 'manual_note';
  values: Record<string /* columnId */, CellValue>;
  /** True if this row's label came from fuzzy-matching free-text carrier labels. */
  wasMatched: boolean;
}

/** A candidate merge the matcher wasn't fully confident about — needs user review. */
export interface ReconciliationCandidate {
  candidateId: string;
  productId: number;
  section: 'benefit' | 'out_of_network';
  /** The label being proposed as canonical (usually the first-seen label). */
  canonicalLabel: string;
  /** The other label(s) the matcher thinks might be the same line item. */
  aliasLabels: string[];
  similarity: number; // 0..1
  columnId: string; // which column the alias label came from, for traceability
}

export interface ComparisonTab {
  /** null for quotes not yet assigned a catalog Product - grouped instead by
   *  productLabel (see tabBuilder.ts). Still a fully real, exportable tab. */
  productId: number | null;
  productName: string;
  /** The dominant productType among this tab's structured quotes. If the product
   *  has manual-only entries and no structured quotes at all, defaults to
   *  'simple_tiered' purely to pick a layout — see tabBuilder.ts. */
  productType: 'simple_tiered' | 'age_banded' | 'flat_rate_per_unit';
  columns: ComparisonColumn[];
  rows: ComparisonRow[];
}

export interface ComparisonBuildResult {
  dealId: number;
  tabs: ComparisonTab[];
  /** Empty once everything above the confidence threshold has auto-matched. */
  reconciliation: ReconciliationCandidate[];
}

/** A user's decision on one reconciliation candidate. */
export interface ReconciliationDecision {
  candidateId: string;
  action: 'merge' | 'keep_separate' | 'remap';
  /** Required when action === 'remap': merge into this existing row instead. */
  remapToRowId?: string;
}