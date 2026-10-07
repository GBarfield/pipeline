/**
 * apps/api/src/lib/rateTemplate.ts
 * Destination: apps/api/src/lib/rateTemplate.ts
 *
 * Lets an agent hand Node a filled-in spreadsheet instead of typing rates into the
 * free-text manual-entry box. One workbook, one tab per rate structure (Simple
 * Tiered / Age-Banded / Flat Rate per Unit) plus an Instructions tab — fill in
 * whichever ONE tab matches the product, leave the other two blank, upload it back
 * through "Enter manually instead". The parser figures out which tab has data and
 * builds the exact same rawData shape a real carrier extraction would produce, so
 * the resulting Quote is a genuine simple_tiered/age_banded/flat_rate_per_unit
 * quote — not a "manual" one — and aligns in the comparison workbook exactly like an
 * uploaded PDF would. No changes needed anywhere in comparisonEngine/ for this to
 * work; that's the whole point of matching the real shape instead of inventing a new
 * one.
 *
 * The free-text manual-entry box (POST /manual in routes/quotes.ts) is untouched —
 * this is an alternative path for when someone already has the numbers in a
 * spreadsheet, not a replacement for quick free-text entry.
 */

import ExcelJS from 'exceljs';
import type {
  SimpleTieredData,
  SimpleTieredPlan,
  AgeBandedData,
  CoverageClass,
  AgeBandRow,
  FlatRateData,
  FlatRateProduct,
} from './comparisonEngine/types.ts';

// ---------------------------------------------------------------------------
// Template generation
// ---------------------------------------------------------------------------

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF6B4FA0' },
};
const HEADER_FONT: Partial<ExcelJS.Font> = { color: { argb: 'FFFFFFFF' }, bold: true };

const SIMPLE_TIERED_HEADERS = [
  'Plan Name',
  'Employee Only',
  'Employee + Spouse',
  'Employee + Child(ren)',
  'Family',
  'Deductible (Individual)',
  'Deductible (Family)',
  'Out-of-Pocket Max (Individual)',
  'Out-of-Pocket Max (Family)',
];

// The amount headers here (10000, 25000, ...) are just examples - the parser reads
// whatever headers actually end up in row 1 starting at column 3, since coverage
// amounts vary per plan and can't be fixed in a shared template.
const AGE_BANDED_HEADERS: Array<string | number> = ['Coverage Class', 'Age Band', 10000, 25000, 50000, 100000];

const FLAT_RATE_HEADERS = [
  'Product Name',
  'Basis',
  'Rate per Unit',
  'Benefit Amount Formula',
  'Guarantee Issue Max',
  'Employee Contribution %',
  'Elimination Period',
  'Benefit Duration',
];

function styleHeaderRow(row: ExcelJS.Row) {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  row.height = 20;
}

export async function buildRateTemplateWorkbook(): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Pipeline — Rate Template';
  workbook.created = new Date();

  const instructions = workbook.addWorksheet('Instructions');
  instructions.getColumn(1).width = 105;
  const lines = [
    'How to use this template',
    '',
    "This workbook has one tab for each rate structure: Simple Tiered, Age-Banded, and Flat Rate per Unit.",
    "Fill in ONLY the ONE tab that matches this product's rate structure, and leave the other two tabs",
    'completely blank below the header row. Upload the file back through "Enter manually instead".',
    '',
    'Simple Tiered — most medical/dental/vision plans. One row per plan option.',
    '',
    'Age-Banded — most Life/LTD/STD-style rate grids. One row per age band. The coverage-amount column',
    "headers (10000, 25000, ...) are just examples — add, remove, or relabel them to match this plan's",
    'actual coverage amounts. Leave "Coverage Class" blank unless there is more than one class (e.g.',
    'Active Employees vs. Retirees).',
    '',
    'Flat Rate per Unit — a single rate per unit of coverage (e.g. per $1,000, per $100 of payroll) —',
    'typically Basic Life/AD&D or LTD/STD. One row per sub-benefit, so Basic Life and AD&D can be two',
    'rows in one upload.',
  ];
  lines.forEach((line, i) => {
    instructions.getCell(i + 1, 1).value = line;
  });
  instructions.getCell(1, 1).font = { bold: true, size: 14 };

  const simpleTiered = workbook.addWorksheet('Simple Tiered');
  simpleTiered.addRow(SIMPLE_TIERED_HEADERS);
  styleHeaderRow(simpleTiered.getRow(1));
  simpleTiered.columns.forEach((col) => (col.width = 20));

  const ageBanded = workbook.addWorksheet('Age-Banded');
  ageBanded.addRow(AGE_BANDED_HEADERS);
  styleHeaderRow(ageBanded.getRow(1));
  ageBanded.columns.forEach((col) => (col.width = 16));

  const flatRate = workbook.addWorksheet('Flat Rate per Unit');
  flatRate.addRow(FLAT_RATE_HEADERS);
  styleHeaderRow(flatRate.getRow(1));
  flatRate.columns.forEach((col) => (col.width = 20));

  return workbook;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface RateTemplateParseResult {
  productType: 'simple_tiered' | 'age_banded' | 'flat_rate_per_unit';
  rawData: SimpleTieredData | AgeBandedData | FlatRateData;
  warnings: string[];
}

export interface RateTemplateParseError {
  error: string;
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString();
    if ('richText' in (v as Record<string, unknown>)) {
      const rt = (v as { richText: Array<{ text: string }> }).richText;
      return rt.map((r) => r.text).join('').trim();
    }
    if ('result' in (v as Record<string, unknown>)) {
      // Formula cell — use the computed result rather than the formula text.
      return String((v as { result: unknown }).result ?? '').trim();
    }
    return String(v).trim();
  }
  return String(v).trim();
}

function cellNumber(cell: ExcelJS.Cell): number | undefined {
  const text = cellText(cell);
  if (!text) return undefined;
  const n = Number(text.replace(/[$,%]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function sheetHasData(sheet: ExcelJS.Worksheet | undefined, anchorCol: number): boolean {
  if (!sheet) return false;
  for (let r = 2; r <= sheet.rowCount; r++) {
    if (cellText(sheet.getCell(r, anchorCol))) return true;
  }
  return false;
}

export function parseRateTemplateWorkbook(
  workbook: ExcelJS.Workbook,
  carrierName: string
): RateTemplateParseResult | RateTemplateParseError {
  const simpleSheet = workbook.getWorksheet('Simple Tiered');
  const ageSheet = workbook.getWorksheet('Age-Banded');
  const flatSheet = workbook.getWorksheet('Flat Rate per Unit');

  const hasSimple = sheetHasData(simpleSheet, 1); // Plan Name
  const hasAge = sheetHasData(ageSheet, 2); // Age Band
  const hasFlat = sheetHasData(flatSheet, 1); // Product Name

  const filledCount = [hasSimple, hasAge, hasFlat].filter(Boolean).length;
  if (filledCount === 0) {
    return {
      error:
        "No rate data found in any tab. Fill in the one tab that matches this product's rate structure " +
        '(Simple Tiered, Age-Banded, or Flat Rate per Unit) and leave the other two blank.',
    };
  }
  if (filledCount > 1) {
    return {
      error:
        "Data was found in more than one tab. Fill in just the one tab that matches this product's rate " +
        'structure, and leave the others blank.',
    };
  }

  if (hasSimple) return parseSimpleTiered(simpleSheet!, carrierName);
  if (hasAge) return parseAgeBanded(ageSheet!, carrierName);
  return parseFlatRate(flatSheet!, carrierName);
}

function parseSimpleTiered(
  sheet: ExcelJS.Worksheet,
  carrierName: string
): RateTemplateParseResult | RateTemplateParseError {
  const warnings: string[] = [];
  const plans: SimpleTieredPlan[] = [];

  for (let r = 2; r <= sheet.rowCount; r++) {
    const planName = cellText(sheet.getCell(r, 1));
    if (!planName) continue;

    const rates = {
      employee_only: cellNumber(sheet.getCell(r, 2)),
      employee_spouse: cellNumber(sheet.getCell(r, 3)),
      employee_children: cellNumber(sheet.getCell(r, 4)),
      family: cellNumber(sheet.getCell(r, 5)),
    };
    if (Object.values(rates).every((v) => v === undefined)) {
      warnings.push(`Row ${r} ("${planName}"): no rate tiers had a value — row skipped.`);
      continue;
    }

    plans.push({
      plan_name: planName,
      rates,
      deductible_individual: cellNumber(sheet.getCell(r, 6)),
      deductible_family: cellNumber(sheet.getCell(r, 7)),
      oop_max_individual: cellNumber(sheet.getCell(r, 8)),
      oop_max_family: cellNumber(sheet.getCell(r, 9)),
    });
  }

  if (plans.length === 0) {
    return {
      error:
        'The Simple Tiered tab has no usable rows — each row needs a Plan Name and at least one rate ' +
        'tier filled in.',
    };
  }

  return {
    productType: 'simple_tiered',
    rawData: { carrier_name: carrierName, plans },
    warnings,
  };
}

function parseAgeBanded(
  sheet: ExcelJS.Worksheet,
  carrierName: string
): RateTemplateParseResult | RateTemplateParseError {
  const warnings: string[] = [];

  // Amount columns start at column 3 (after Coverage Class, Age Band) — read
  // whatever header values are actually present rather than a fixed list.
  const headerRow = sheet.getRow(1);
  const amountCols: Array<{ col: number; amount: string }> = [];
  for (let c = 3; c <= sheet.columnCount; c++) {
    const header = cellText(headerRow.getCell(c));
    if (header) amountCols.push({ col: c, amount: header });
  }
  if (amountCols.length === 0) {
    return {
      error: 'The Age-Banded tab has no coverage-amount columns — add at least one column header after "Age Band".',
    };
  }

  const classesByName = new Map<string, CoverageClass & { age_bands: AgeBandRow[] }>();

  for (let r = 2; r <= sheet.rowCount; r++) {
    const bandLabel = cellText(sheet.getCell(r, 2));
    if (!bandLabel) continue;
    const className = cellText(sheet.getCell(r, 1)) || 'All Employees';

    const ratesByAmount: Record<string, number> = {};
    for (const { col, amount } of amountCols) {
      const v = cellNumber(sheet.getCell(r, col));
      if (v !== undefined) ratesByAmount[amount] = v;
    }
    if (Object.keys(ratesByAmount).length === 0) {
      warnings.push(`Row ${r} (age band "${bandLabel}"): no rates had a value — row skipped.`);
      continue;
    }

    if (!classesByName.has(className)) {
      classesByName.set(className, { class_name: className, rate_structure: 'age_banded', age_bands: [] });
    }
    classesByName.get(className)!.age_bands.push({ label: bandLabel, rates_by_amount: ratesByAmount });
  }

  if (classesByName.size === 0) {
    return {
      error:
        'The Age-Banded tab has no usable rows — each row needs an Age Band and at least one coverage-' +
        'amount column filled in.',
    };
  }

  return {
    productType: 'age_banded',
    rawData: {
      carrier_name: carrierName,
      products: [{ product_name: carrierName, coverage_classes: [...classesByName.values()] }],
    },
    warnings,
  };
}

function parseFlatRate(
  sheet: ExcelJS.Worksheet,
  carrierName: string
): RateTemplateParseResult | RateTemplateParseError {
  const warnings: string[] = [];
  const products: FlatRateProduct[] = [];

  for (let r = 2; r <= sheet.rowCount; r++) {
    const productName = cellText(sheet.getCell(r, 1));
    if (!productName) continue;

    const basis = cellText(sheet.getCell(r, 2));
    const ratePerUnit = cellNumber(sheet.getCell(r, 3));
    if (!basis || ratePerUnit === undefined) {
      warnings.push(`Row ${r} ("${productName}"): needs both a Basis and a Rate per Unit — row skipped.`);
      continue;
    }

    products.push({
      product_name: productName,
      basis,
      rate_per_unit: ratePerUnit,
      benefit_amount_formula: cellText(sheet.getCell(r, 4)) || undefined,
      guarantee_issue_max: cellText(sheet.getCell(r, 5)) || undefined,
      employee_contribution_pct: cellText(sheet.getCell(r, 6)) || undefined,
      elimination_period: cellText(sheet.getCell(r, 7)) || undefined,
      benefit_duration: cellText(sheet.getCell(r, 8)) || undefined,
    });
  }

  if (products.length === 0) {
    return {
      error:
        'The Flat Rate per Unit tab has no usable rows — each row needs a Product Name, a Basis, and a ' +
        'Rate per Unit.',
    };
  }

  return {
    productType: 'flat_rate_per_unit',
    rawData: { carrier_name: carrierName, products },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Flattening — for the "Add/edit details" path on an EXISTING quote
// ---------------------------------------------------------------------------

/**
 * Collapses a parsed template into the flat label -> value dict that
 * Quote.supplement.rates already expects (the same shape produced by typing
 * "Label: Value" lines into the free-text box). A supplement always layers onto one
 * already-existing quote's own column(s) — see tabBuilder.ts — so unlike
 * POST /upload-template (which creates a brand-new, independently-columned quote),
 * there's no second quote to create here; the structured template data just becomes
 * more key/value entries on the same row. Simple Tiered's tier labels are the exact
 * strings buildSimpleTieredTab/RATE_TIER_ALIASES already recognize, so a single-plan
 * template still lines up with the fixed rate-tier rows instead of becoming
 * standalone unmatched rows.
 */
export function flattenRateTemplateResult(result: RateTemplateParseResult): Record<string, string | number> {
  const flat: Record<string, string | number> = {};

  if (result.productType === 'simple_tiered') {
    const data = result.rawData as SimpleTieredData;
    const multiPlan = data.plans.length > 1;
    const tierLabels: Array<[keyof SimpleTieredPlan['rates'], string]> = [
      ['employee_only', 'Employee Only'],
      ['employee_spouse', 'Employee + Spouse'],
      ['employee_children', 'Employee + Child(ren)'],
      ['family', 'Family'],
    ];
    for (const plan of data.plans) {
      const prefix = multiPlan ? `${plan.plan_name} - ` : '';
      for (const [key, label] of tierLabels) {
        const v = plan.rates[key];
        if (v !== undefined) flat[`${prefix}${label}`] = v;
      }
      if (plan.deductible_individual !== undefined) flat[`${prefix}Deductible (Individual)`] = plan.deductible_individual;
      if (plan.deductible_family !== undefined) flat[`${prefix}Deductible (Family)`] = plan.deductible_family;
      if (plan.oop_max_individual !== undefined) flat[`${prefix}OOP Max (Individual)`] = plan.oop_max_individual;
      if (plan.oop_max_family !== undefined) flat[`${prefix}OOP Max (Family)`] = plan.oop_max_family;
    }
  } else if (result.productType === 'age_banded') {
    const data = result.rawData as AgeBandedData;
    const multiProduct = data.products.length > 1;
    for (const product of data.products) {
      const pPrefix = multiProduct ? `${product.product_name} - ` : '';
      const multiClass = product.coverage_classes.length > 1;
      for (const cls of product.coverage_classes) {
        const cPrefix = multiClass ? `${cls.class_name} - ` : '';
        for (const band of cls.age_bands ?? []) {
          for (const [amount, rate] of Object.entries(band.rates_by_amount)) {
            flat[`${pPrefix}${cPrefix}${band.label} / $${amount}`] = rate;
          }
        }
      }
    }
  } else {
    const data = result.rawData as FlatRateData;
    const multiProduct = data.products.length > 1;
    for (const product of data.products) {
      const prefix = multiProduct ? `${product.product_name} - ` : '';
      flat[`${prefix}Rate per Unit (${product.basis})`] = product.rate_per_unit;
      if (product.benefit_amount_formula) flat[`${prefix}Benefit Amount Formula`] = product.benefit_amount_formula;
      if (product.guarantee_issue_max) flat[`${prefix}Guarantee Issue Max`] = product.guarantee_issue_max;
      if (product.employee_contribution_pct) flat[`${prefix}Employee Contribution %`] = product.employee_contribution_pct;
      if (product.elimination_period) flat[`${prefix}Elimination Period`] = product.elimination_period;
      if (product.benefit_duration) flat[`${prefix}Benefit Duration`] = product.benefit_duration;
    }
  }

  return flat;
}