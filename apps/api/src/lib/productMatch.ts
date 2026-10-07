// Destination: apps/api/src/lib/productMatch.ts
import { prisma } from './prisma.ts';

// Census/commission productLabel values will often already match a catalog
// Product name exactly (Medical, Dental, Vision, ...), since that's what the
// Bucket's target field asks for. But real plan-label strings coming out of
// the EN Elections Loader are far messier - carrier-specific plan SKU codes,
// year-prefixed renewal cycles ("2025-26 Vision Plan", "2026 Vision"), and
// one-off custom names. A real production pull surfaced 1,060 distinct
// unmatched strings (2026-08-23 finding) - an exact-match synonym table
// cannot scale to that, since every renewal cycle mints a fresh batch of
// "202X ..." strings needing yet another manual entry.
//
// Matching order, first hit wins:
//   1. Exact catalog name match (case-insensitive) - unchanged from before.
//   2. Exact-string synonym table (whole-label abbreviations like "STD",
//      "EAP") - unchanged in spirit from before, just extended.
//   3. Keyword/substring classification against CATEGORY_RULES. Checked
//      top-to-bottom - narrower/more specific categories are listed before
//      broader ones. This ordering matters for real collisions in the data:
//      e.g. carrier name "PacificLife" contains the substring "life", so
//      "PacificLife Dental 2026 - Elite" must hit the "dental" rule before
//      ever reaching the generic "life" rule, or it would misclassify as
//      Life. Same reasoning puts "basic life" before the generic "life"
//      catch-all, and puts every named category before the broad Medical
//      catch-all (medical/ppo/hmo/hdhp/hsa/epo/cpos) at the very end.
//
// This intentionally does not aim for 100% coverage. Bare carrier plan-SKU
// codes ("P5000i100LX21", "HP50002575i8025B") and generic admin/fee line
// items ("Membership Fee", "ACH Processing Fee", "Payroll Deduction Form")
// carry no recognizable category keyword and are expected to remain
// unmatched - same as the original design doc anticipated. The goal is
// catching the categorizable majority automatically and staying
// self-maintaining (a brand new "2027 Vision Plan" matches with zero code
// changes, since it contains "vision").
const PRODUCT_LABEL_SYNONYMS: Record<string, string> = {
  med: 'Medical',
  std: 'Short Term Disability',
  ltd: 'Long Term Disability',
  life: 'Group (Term) Life',
  'basic life': 'Basic Life',
  eap: 'Employee Assistance Program',
};

interface CategoryRule {
  keywords: string[];
  productName: string;
}

// Order matters - see comment above. Keep narrower categories above broader
// ones, and keep the Medical catch-all last.
const CATEGORY_RULES: CategoryRule[] = [
  { keywords: ['vision'], productName: 'Vision' },
  { keywords: ['dental'], productName: 'Dental' },
  { keywords: ['hospital indemnity'], productName: 'Hospital Indemnity' },
  { keywords: ['critical illness', 'criticalillness'], productName: 'Critical Illness' },
  { keywords: ['cancer'], productName: 'Cancer' },
  {
    keywords: ['long term disability', 'long-term disability', 'longtermdisability', 'long term disabliity' /* observed typo in source data, 2026-08-23 */],
    productName: 'Long Term Disability',
  },
  {
    keywords: ['short term disability', 'short-term disability', 'shorttermdisability'],
    productName: 'Short Term Disability',
  },
  { keywords: ['accident'], productName: 'Accident' },
  { keywords: ['telemedicine', 'telemed'], productName: 'Telemedicine' },
  {
    keywords: ['legalshield', 'idshield', 'identity protection', 'ultrasecure', 'legal protection', 'identity theft', 'legal and identity', 'legal plan'],
    productName: 'Legal & ID Protection',
  },
  { keywords: ['gap'], productName: 'Gap Coverage' },
  { keywords: ['pet insurance', 'pet plan'], productName: 'Pet Insurance' },
  // Life rules: "basic life" before the generic "life" catch-all, so
  // "Basic Life and AD&D" resolves to Basic Life, not Group (Term) Life.
  { keywords: ['basic life'], productName: 'Basic Life' },
  { keywords: ['life'], productName: 'Group (Term) Life' },
  // Standalone AD&D only ever reached when no "life" rule already matched
  // above (e.g. "Voluntary AD&D", "Basic AD&D" - no "life" in the name).
  { keywords: ['ad&d'], productName: 'AD&D' },
  // Broadest catch-all - deliberately last. Common medical plan-network
  // acronyms mop up a large share of otherwise-cryptic plan codes
  // ("1500 PPO", "HDHP 3400", "Anthem Gold PPO 3000").
  { keywords: ['medical', 'ppo', 'hmo', 'hdhp', 'hsa', 'epo', 'cposii', 'cpos'], productName: 'Medical' },
];

export async function resolveProductId(productLabel: string | undefined | null): Promise<number | null> {
  if (!productLabel) return null;
  const catalog = await prisma.product.findMany();
  const normalized = productLabel.trim().toLowerCase();

  const exact = catalog.find((p) => p.name.toLowerCase() === normalized);
  if (exact) return exact.id;

  const synonymName = PRODUCT_LABEL_SYNONYMS[normalized];
  if (synonymName) {
    const match = catalog.find((p) => p.name.toLowerCase() === synonymName.toLowerCase());
    if (match) return match.id;
  }

  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((kw) => normalized.includes(kw))) {
      const match = catalog.find((p) => p.name.toLowerCase() === rule.productName.toLowerCase());
      if (match) return match.id;
      // Catalog is missing a category this rule expects - don't silently
      // fall through to "no match" without a trace; a human needs to add it.
      console.warn(`[resolveProductId] Rule matched "${rule.productName}" for label "${productLabel}" but no catalog Product with that name exists.`);
      return null;
    }
  }

  return null;
}

export function parseCurrency(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const cleaned = String(value).replace(/[$,]/g, '').trim();
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}