/**
 * comparison-engine/test-sample.ts
 * Suggested location for now: apps/api/src/lib/comparisonEngine/test-sample.ts
 * (not part of the production router — just a script to run once, by hand)
 *
 * Standalone check of the tab builder + row matcher against synthetic data shaped
 * like the two real documents already run through the Bucket for Baker Farms
 * (Aetna and Angle Health, both simple_tiered — see §10 of the design proposal,
 * "tested against the two real carrier PDFs already in this project"), plus a
 * hand-typed "current plan" row and one manual-entry quote (productType: "manual",
 * the real shape written by apps/api/src/routes/quotes.ts POST /manual).
 *
 * Not a unit test framework — just a runnable script that prints what the engine
 * produces, and writes an actual .xlsx so the output can be opened and eyeballed.
 * I was not able to execute this myself (the sandbox failed to start this session) —
 * I traced the matching logic by hand instead, which caught real bugs already fixed
 * in these files (see README.md). Please run this for real before wiring the engine
 * into apps/api.
 *
 * Run (from apps/api/src/lib/comparisonEngine/, after `pnpm add exceljs` in apps/api):
 *   node --experimental-strip-types test-sample.ts
 * or, if tsx is available:
 *   npx tsx test-sample.ts
 */

import { buildComparisonTabs } from './tabBuilder.ts';
import { buildComparisonWorkbook } from './xlsxBuilder.ts';
import type { QuoteRecord, ProductRecord, RowMappingRecord } from './types.ts';

const products: ProductRecord[] = [{ id: 1, name: 'Medical' }];
const DEAL_ID = 100;

const quotes: QuoteRecord[] = [
  // Hand-typed current plan, but WITH a real document run through the Bucket (source:
  // "current", productType: "simple_tiered") — the structured case.
  {
    id: 1,
    dealId: DEAL_ID,
    productId: 1,
    source: 'current',
    carrierName: 'Existing Carrier',
    productType: 'simple_tiered',
    usedDiscovery: false,
    warnings: null,
    xlsxPath: null,
    createdAt: new Date().toISOString(),
    rawData: {
      carrier_name: 'Existing Carrier',
      group_name: 'Baker Farms',
      plans: [
        {
          plan_name: 'Current Plan',
          rates: { employee_only: 412.0, employee_spouse: 824.0 },
          deductible_individual: 500,
          benefits: {
            'Primary Care (Office)': '$25 copay, not subject to deductible',
            Specialist: '$50 copay',
          },
        },
      ],
    },
  },
  // Aetna proposal — two plans
  {
    id: 2,
    dealId: DEAL_ID,
    productId: 1,
    source: 'proposal',
    carrierName: 'Aetna',
    productType: 'simple_tiered',
    usedDiscovery: true,
    warnings: null,
    xlsxPath: null,
    createdAt: new Date().toISOString(),
    rawData: {
      carrier_name: 'Aetna',
      group_name: 'Baker Farms',
      plans: [
        {
          plan_name: 'Plan A',
          rates: { employee_only: 398.5, employee_spouse: 797.0 },
          deductible_individual: 500,
          benefits: {
            'Primary Care Office': '$25 copay, not subject to deductible',
            'Specialist Visit': '$50 copay',
          },
        },
        {
          plan_name: 'Plan B',
          rates: { employee_only: 375.0, employee_spouse: 750.0 },
          deductible_individual: 750,
          benefits: {
            'Primary Care Office': '$35 copay',
            'Specialist Visit': '$60 copay',
          },
        },
      ],
    },
  },
  // Angle Health proposal — one plan, deliberately worded differently
  {
    id: 3,
    dealId: DEAL_ID,
    productId: 1,
    source: 'proposal',
    carrierName: 'Angle Health',
    productType: 'simple_tiered',
    usedDiscovery: true,
    warnings: null,
    xlsxPath: null,
    createdAt: new Date().toISOString(),
    rawData: {
      carrier_name: 'Angle Health',
      group_name: 'Baker Farms',
      plans: [
        {
          plan_name: 'Plan A',
          rates: { employee_only: 405.0, employee_spouse: 810.0 },
          benefits: {
            'Primary Care Visit': '$30 copay',
            'Specialist Care': '$55 copay',
          },
        },
      ],
    },
  },
  // Dental: a manual-entry Current Products quote — no document at all, just what an
  // agent typed in. This is the productType: "manual" case from POST /manual.
  {
    id: 4,
    dealId: DEAL_ID,
    productId: 2,
    source: 'current',
    carrierName: 'Guardian (per client)',
    productType: 'manual',
    usedDiscovery: false,
    warnings: null,
    xlsxPath: null,
    createdAt: new Date().toISOString(),
    rawData: {
      notes: 'Client believes deductible is waived for preventive care; unconfirmed.',
      rates: { 'Employee Only': 32.5, 'Employee + Family': 88.0 },
    },
  },
];

const products2 = [...products, { id: 2, name: 'Dental' }];
const rememberedMappings: RowMappingRecord[] = [];

const { tabs, reconciliation } = buildComparisonTabs(DEAL_ID, quotes, products2, rememberedMappings);

console.log('=== TABS ===');
for (const tab of tabs) {
  console.log(`\n--- ${tab.productName} (${tab.productType}) ---`);
  console.log(
    'Columns:',
    tab.columns.map((c) => `${c.carrierName ?? 'Current'}/${c.planName ?? (c.isManualEntry ? 'manual' : '')}`)
  );
  for (const row of tab.rows) {
    console.log(`[${row.section}] ${row.label}:`, row.values);
  }
}

console.log('\n=== RECONCILIATION CANDIDATES ===');
for (const c of reconciliation) {
  console.log(`"${c.aliasLabels[0]}" ~ "${c.canonicalLabel}" (similarity ${c.similarity.toFixed(2)})`);
}

// Expectations this script is meant to demonstrate:
//   1. "Primary Care (Office)" (current) and "Primary Care Office" (Aetna) should
//      land in the SAME row automatically (exact match after normalization) — no
//      reconciliation candidate for that pair.
//   2. "Primary Care Visit" (Angle Health) should show up as a reconciliation
//      candidate against "Primary Care (Office)" — a likely match, not auto-merged.
//   3. "Specialist" / "Specialist Visit" / "Specialist Care" should behave the same
//      way: Aetna's "Specialist Visit" either exact-matches or candidates against
//      "Specialist"; Angle's "Specialist Care" candidates too.
//   4. Rate-tier rows (Employee Only, Employee + Spouse) should line up for all
//      three Medical columns with zero matching involved.
//   5. The Dental tab should exist with exactly one column (the manual entry), its
//      "Employee Only" / "Employee + Family" rates showing up as benefit-section rows
//      (not rate-tier rows — manual entries never get fixed-key treatment), and the
//      note showing up as a "Notes (manual entry)" row.

buildComparisonWorkbook(tabs, { dealName: 'Baker Farms — 2027 Renewal' }).then(async (wb) => {
  await wb.xlsx.writeFile('baker-farms-comparison.xlsx');
  console.log('\nWrote baker-farms-comparison.xlsx — open it and eyeball the layout.');
});
