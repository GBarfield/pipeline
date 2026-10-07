/**
 * comparison-engine/rowMatcher.ts
 * Destination: apps/api/src/lib/comparisonEngine/rowMatcher.ts
 *
 * Handles the one genuinely hard part identified in the design proposal (§6.4):
 * lining up the free-text `benefits` / `out_of_network` dictionaries across carriers,
 * since those keys are carrier-chosen prose ("Primary Care (Office)" vs.
 * "Primary Care Visit") rather than a fixed schema.
 *
 * Fixed-key fields (rate tiers, deductible_individual, age_bands, etc.) never touch
 * this module — they're assembled directly in tabBuilder.ts.
 *
 * Matching strategy, per the design doc:
 *   1. Apply any remembered RowMapping for this Deal+Product+section first (§6.4:
 *      "worth remembering" — scoped per Deal in this implementation since that's the
 *      actual unit Quotes live under; see types.ts) — these never need reconciling
 *      again.
 *   2. Exact match (case/whitespace-normalized) against labels already seen this build.
 *   3. Everything else: similarity score against every canonical label seen so far,
 *      EXCLUDING rows that already hold a value from the same column (see "Same-column
 *      exclusion" below). High similarity -> flagged as a ReconciliationCandidate, not
 *      silently merged. Low similarity -> becomes its own new canonical row.
 *
 * "Silently merged" is deliberately never done above the exact-match tier — the design
 * doc is explicit that near-duplicates get flagged, not auto-merged, until a human (or a
 * remembered prior decision) confirms it.
 *
 * Same-column exclusion (found by running test-sample.ts against real Node, not just
 * hand-tracing): two different labels appearing in the SAME plan's benefits dict can
 * never legitimately be "the same line item" — if they were, the source data would
 * have used one key, not two. Without this exclusion, a manual quote with both
 * "Employee Only" and "Employee + Family" rates flagged them as a reconciliation
 * candidate against each other (0.58 similarity, shared "Employee" token) — a false
 * positive that would lose data if a user ever confirmed the merge (one value would
 * overwrite the other in the same cell). RowMatcher now tracks which columns have
 * already contributed to each canonical row and skips those rows when fuzzy-matching
 * a new label from that same column.
 *
 * NOTE on RowMatcher's constructor: deliberately NOT using TypeScript's "parameter
 * property" shorthand (constructor(private readonly x: number)). Node's
 * --experimental-strip-types does pure type erasure — it can't emit the `this.x = x`
 * assignment that shorthand requires, and throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
 * Fields are declared explicitly and assigned in the constructor body instead, which
 * strips cleanly. (Found the same way as the exclusion above — by actually running it.)
 */

import type { RowMappingRecord, ReconciliationCandidate } from './types.ts';

const AUTO_MERGE_ON_EXACT = true;

/**
 * Similarity above this triggers a reconciliation candidate. Below it, treated as
 * distinct. Deliberately set on the generous side: missing a real duplicate silently
 * produces a wrong-looking blank cell in the exported sheet, while over-flagging just
 * costs the user one extra "keep separate" click during reconciliation. Worked example
 * from the design doc (§6.4) — "Primary Care Office" vs "Primary Care Visit" — scores
 * ~0.69 here (confirmed by an actual run of test-sample.ts), comfortably above
 * threshold.
 */
export const CANDIDATE_THRESHOLD = 0.55;

// ---------------------------------------------------------------------------
// Label normalization
// ---------------------------------------------------------------------------

/**
 * Lowercase, collapse whitespace, drop punctuation — but keep parenthetical content as
 * tokens rather than deleting it. Carrier labels routinely use parens stylistically
 * ("Primary Care (Office)" in the Bucket's own §8.1 schema example), so "Primary Care
 * (Office)" and "Primary Care Office" need to normalize to the same thing, not diverge.
 */
export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // drop punctuation (including parens), keep the words
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Similarity: blend of token-set (Dice) overlap and normalized Levenshtein.
// Token overlap catches "Primary Care Office" vs "Primary Care Visit" reordering
// and partial matches; Levenshtein catches near-misspellings / abbreviations.
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prevRow = new Array(n + 1);
  let curRow = new Array(n + 1);
  for (let j = 0; j <= n; j++) prevRow[j] = j;

  for (let i = 1; i <= m; i++) {
    curRow[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curRow[j] = Math.min(
        prevRow[j] + 1, // deletion
        curRow[j - 1] + 1, // insertion
        prevRow[j - 1] + cost // substitution
      );
    }
    [prevRow, curRow] = [curRow, prevRow];
  }
  return prevRow[n];
}

function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/** Sorensen-Dice coefficient over word tokens — more forgiving than Jaccard for the
 *  short (2-4 word) phrases carrier documents tend to use, where a single differing
 *  word should still read as "probably the same line item, worth a human glance". */
function tokenSetSimilarity(a: string, b: string): number {
  const setA = new Set(a.split(' ').filter(Boolean));
  const setB = new Set(b.split(' ').filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const tok of setA) if (setB.has(tok)) intersection++;
  const denom = setA.size + setB.size;
  return denom === 0 ? 1 : (2 * intersection) / denom;
}

/** Blended similarity score, 0..1. Weighted toward token overlap since carrier labels
 *  are usually reordered/abbreviated phrases rather than typos. */
export function labelSimilarity(labelA: string, labelB: string): number {
  const a = normalizeLabel(labelA);
  const b = normalizeLabel(labelB);
  if (a === b) return 1;
  const tokenScore = tokenSetSimilarity(a, b);
  const editScore = levenshteinSimilarity(a, b);
  return 0.65 * tokenScore + 0.35 * editScore;
}

// ---------------------------------------------------------------------------
// Matcher state — one instance per (dealId, productId, section) tab build
// ---------------------------------------------------------------------------

export interface MatchResult {
  /** The canonical rowId this label resolved to. */
  rowId: string;
  canonicalLabel: string;
  wasMatched: boolean; // true if this required fuzzy/exact matching against an existing row
  candidate?: ReconciliationCandidate; // present only when this needs human review
}

export interface CanonicalRow {
  rowId: string;
  label: string;
  normalized: string;
}

export class RowMatcher {
  private readonly productId: number;
  private readonly section: 'benefit' | 'out_of_network';
  private readonly canonicalRows: CanonicalRow[] = [];
  private readonly aliasIndex = new Map<string, string>(); // normalized alias -> rowId
  private readonly columnsByRow = new Map<string, Set<string>>(); // rowId -> columnIds that already contributed a value
  private nextRowIndex = 0;

  constructor(
    productId: number,
    section: 'benefit' | 'out_of_network',
    rememberedMappings: RowMappingRecord[] = []
  ) {
    this.productId = productId;
    this.section = section;

    // Seed from remembered mappings so previously-reconciled carriers never
    // re-surface the same near-duplicate (§6.4: "worth remembering").
    // Scoped by section too — benefits and out_of_network are separate dictionaries
    // and a mapping learned in one must not silently apply to the other.
    for (const m of rememberedMappings) {
      if (m.productId !== productId || m.section !== section) continue;
      let rowId = this.aliasIndex.get(normalizeLabel(m.canonicalLabel));
      if (!rowId) {
        rowId = this.addCanonicalRow(m.canonicalLabel);
      }
      this.aliasIndex.set(normalizeLabel(m.aliasLabel), rowId);
    }
  }

  private addCanonicalRow(label: string): string {
    const rowId = `${this.productId}:${this.section}:${this.nextRowIndex++}`;
    this.canonicalRows.push({ rowId, label, normalized: normalizeLabel(label) });
    this.aliasIndex.set(normalizeLabel(label), rowId);
    return rowId;
  }

  private markColumnUsed(rowId: string, columnId: string): void {
    if (!this.columnsByRow.has(rowId)) this.columnsByRow.set(rowId, new Set());
    this.columnsByRow.get(rowId)!.add(columnId);
  }

  /**
   * Resolve one carrier-supplied label (from a specific column) to a row.
   * Call once per (label, column) pair while assembling a tab.
   */
  resolve(rawLabel: string, columnId: string): MatchResult {
    const normalized = normalizeLabel(rawLabel);
    let result: MatchResult;

    // 1. Remembered mapping or exact match already seen this build.
    const exact = this.aliasIndex.get(normalized);
    if (exact) {
      const row = this.canonicalRows.find((r) => r.rowId === exact)!;
      result = { rowId: row.rowId, canonicalLabel: row.label, wasMatched: AUTO_MERGE_ON_EXACT };
    } else {
      // 2. Fuzzy match against every canonical row seen so far — excluding rows that
      // already hold a value from THIS SAME column (see file header: same-column
      // exclusion).
      let best: { row: CanonicalRow; score: number } | null = null;
      for (const row of this.canonicalRows) {
        if (this.columnsByRow.get(row.rowId)?.has(columnId)) continue;
        const score = labelSimilarity(rawLabel, row.label);
        if (!best || score > best.score) best = { row, score };
      }

      if (best && best.score >= CANDIDATE_THRESHOLD) {
        // Flagged, not merged. The row still gets created as its own canonical
        // row for now so nothing renders blank while awaiting reconciliation —
        // the reconciliation step (applyReconciliation) is what actually merges it.
        const rowId = this.addCanonicalRow(rawLabel);
        result = {
          rowId,
          canonicalLabel: rawLabel,
          wasMatched: false,
          candidate: {
            candidateId: `${this.productId}:${this.section}:${normalized}~${normalizeLabel(
              best.row.label
            )}`,
            productId: this.productId,
            section: this.section,
            canonicalLabel: best.row.label,
            aliasLabels: [rawLabel],
            similarity: best.score,
            columnId,
          },
        };
      } else {
        // 3. Nothing close enough — new row.
        const rowId = this.addCanonicalRow(rawLabel);
        result = { rowId, canonicalLabel: rawLabel, wasMatched: false };
      }
    }

    this.markColumnUsed(result.rowId, columnId);
    return result;
  }

  /** Merge two rows that a human (or a remembered mapping) has confirmed are the same. */
  mergeRows(keepRowId: string, mergeAwayRowId: string): void {
    const keep = this.canonicalRows.find((r) => r.rowId === keepRowId);
    if (!keep) return;
    for (const [alias, rowId] of this.aliasIndex.entries()) {
      if (rowId === mergeAwayRowId) this.aliasIndex.set(alias, keepRowId);
    }
    const mergedColumns = this.columnsByRow.get(mergeAwayRowId);
    if (mergedColumns) {
      if (!this.columnsByRow.has(keepRowId)) this.columnsByRow.set(keepRowId, new Set());
      for (const c of mergedColumns) this.columnsByRow.get(keepRowId)!.add(c);
      this.columnsByRow.delete(mergeAwayRowId);
    }
    const idx = this.canonicalRows.findIndex((r) => r.rowId === mergeAwayRowId);
    if (idx >= 0) this.canonicalRows.splice(idx, 1);
  }

  getCanonicalRows(): CanonicalRow[] {
    return [...this.canonicalRows];
  }
}