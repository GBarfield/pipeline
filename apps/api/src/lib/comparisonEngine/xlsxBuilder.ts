/**
 * comparison-engine/xlsxBuilder.ts
 * Destination: apps/api/src/lib/comparisonEngine/xlsxBuilder.ts
 *
 * Renders ComparisonTab[] into an .xlsx workbook — one sheet per product, per §6.2/§6.3
 * of the design proposal. Visual conventions deliberately mirror the Bucket's own
 * xlsx_builder.py (currency formatting, frozen header, purple header shading) so a
 * comparison workbook looks like a sibling of a single-carrier Bucket export, not a
 * different tool.
 *
 * Layout per sheet:
 *   Row 1: merged carrier-name headers over each carrier's block of plan columns
 *          (blank over column A/B, "Current" has no carrier header).
 *   Row 2: column headers — "Benefit / Cost", "Current", then one header per plan.
 *   Row 3+: one row per ComparisonRow, section-grouped with a bold section divider.
 *
 * Requires the `exceljs` package (already a dependency of apps/api).
 */

import ExcelJS from 'exceljs';
import type { ComparisonTab, ComparisonColumn, ComparisonRow } from './types.ts';

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF6B4FA0' }, // purple, matching the Bucket's header shading
};
const HEADER_FONT: Partial<ExcelJS.Font> = { color: { argb: 'FFFFFFFF' }, bold: true };
const CARRIER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFEDE7F6' },
};
const SECTION_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF3F1F8' },
};
const CURRENCY_FORMAT = '$#,##0.00';

const SECTION_TITLES: Record<ComparisonRow['section'], string> = {
  rate_tier: 'Monthly Premium Rates',
  core_field: 'Plan Design Summary',
  benefit: 'In-Network Cost Share',
  out_of_network: 'Out-of-Network',
  age_band: 'Rates',
  manual_note: 'Manual Entry',
};

// Fields we know are dollar amounts vs. everything else (percentages, booleans, text).
const CURRENCY_ROW_ID_PREFIXES = ['rate_tier:', 'flat_rate:', 'age_band:'];
const CURRENCY_CORE_FIELD_KEYS = new Set([
  'core_field:deductible_individual',
  'core_field:deductible_family',
  'core_field:oop_max_individual',
  'core_field:oop_max_family',
]);

function isCurrencyRow(rowId: string): boolean {
  if (CURRENCY_CORE_FIELD_KEYS.has(rowId)) return true;
  return CURRENCY_ROW_ID_PREFIXES.some((p) => rowId.startsWith(p));
}

export async function buildComparisonWorkbook(
  tabs: ComparisonTab[],
  opts: { dealName?: string } = {}
): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Pipeline — Comparison Engine';
  workbook.created = new Date();

  // ExcelJS throws if two worksheets share a name, and it's entirely legitimate for
  // two DIFFERENT tabs to have the same display name right now — e.g. quotes still
  // only labeled "Dental" (never assigned to a catalog Product, grouped by
  // tabBuilder.ts's productLabel fallback) sitting alongside a separately-tracked
  // "Dental" tab for quotes that HAVE been assigned to the real Dental Product.
  // Disambiguate the sheet name rather than crashing the whole export over it.
  const usedSheetNames = new Set<string>();
  for (const tab of tabs) {
    const sheet = workbook.addWorksheet(uniqueSheetName(tab, usedSheetNames), {
      views: [{ state: 'frozen', ySplit: 2, xSplit: 2 }],
    });
    writeTab(sheet, tab, opts.dealName);
  }

  if (tabs.length === 0) {
    workbook.addWorksheet('No Data');
  }

  return workbook;
}

function sanitizeSheetName(name: string): string {
  // Excel sheet names: max 31 chars, no []:*?/\\
  return name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet';
}

function uniqueSheetName(tab: ComparisonTab, used: Set<string>): string {
  const base = sanitizeSheetName(tab.productName);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  const withSuffix = (suffix: string) =>
    (base.length + suffix.length > 31 ? base.slice(0, 31 - suffix.length) : base) + suffix;

  // Prefer a readable suffix when we know why they collided (an unassigned tab
  // sharing a display name with an assigned one) — otherwise fall back to a
  // numbered suffix.
  if (tab.productId === null) {
    const candidate = withSuffix(' (unassigned)');
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }

  let n = 2;
  let candidate: string;
  do {
    candidate = withSuffix(` (${n})`);
    n++;
  } while (used.has(candidate));
  used.add(candidate);
  return candidate;
}

function writeTab(sheet: ExcelJS.Worksheet, tab: ComparisonTab, dealName?: string): void {
  const hasCurrentColumn = tab.columns.some((c) => c.kind === 'current');
  const proposalColumns = tab.columns.filter((c) => c.kind === 'proposal');

  // Column order: label, [current], then proposal columns grouped by carrier
  // (already emitted in carrier-grouped order by the tab builder).
  const orderedColumns: ComparisonColumn[] = [
    ...tab.columns.filter((c) => c.kind === 'current'),
    ...proposalColumns,
  ];

  const labelColWidth = 2; // columns A..B reserved for the label (merged) per §6.3 layout
  const firstDataCol = labelColWidth + 1;

  // --- Row 1: merged carrier headers ---
  sheet.mergeCells(1, 1, 2, labelColWidth); // "Benefit / Cost" spans both header rows
  const labelHeaderCell = sheet.getCell(1, 1);
  labelHeaderCell.value = 'Benefit / Cost';
  labelHeaderCell.fill = HEADER_FILL;
  labelHeaderCell.font = HEADER_FONT;
  labelHeaderCell.alignment = { vertical: 'middle', horizontal: 'left' };

  let colIdx = firstDataCol;
  const currentCols = orderedColumns.filter((c) => c.kind === 'current');
  if (hasCurrentColumn) {
    if (currentCols.length > 1) {
      sheet.mergeCells(1, colIdx, 1, colIdx + currentCols.length - 1);
    } else {
      sheet.mergeCells(1, colIdx, 2, colIdx); // no plans under "Current" if just one
    }
    const cell = sheet.getCell(1, colIdx);
    cell.value = 'Current';
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    colIdx += currentCols.length;
  }

  // Group proposal columns by carrier for the merged header block.
  const carrierGroups: Array<{ carrierName: string; cols: ComparisonColumn[] }> = [];
  for (const col of proposalColumns) {
    const last = carrierGroups[carrierGroups.length - 1];
    if (last && last.carrierName === col.carrierName) {
      last.cols.push(col);
    } else {
      carrierGroups.push({ carrierName: col.carrierName ?? 'Unknown Carrier', cols: [col] });
    }
  }

  for (const group of carrierGroups) {
    const span = group.cols.length;
    if (span > 1) {
      sheet.mergeCells(1, colIdx, 1, colIdx + span - 1);
    }
    const cell = sheet.getCell(1, colIdx);
    cell.value = group.carrierName.toUpperCase();
    cell.fill = CARRIER_FILL;
    cell.font = { bold: true };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    colIdx += span;
  }

  // --- Row 2: column headers (plan names / manual-entry markers) ---
  colIdx = firstDataCol;
  for (const col of orderedColumns) {
    const cell = sheet.getCell(2, colIdx);
    if (col.kind === 'current' && currentCols.length <= 1) {
      // already merged into row 1 above — leave blank
    } else {
      cell.value = col.isManualEntry ? `${col.carrierName ?? 'Manual'} (typed)` : col.planName ?? '';
    }
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    colIdx++;
  }

  // Note: no row.commit() calls anywhere in this file — that API is only meaningful
  // for ExcelJS.stream.xlsx.WorkbookWriter (streaming mode). We're using the standard,
  // in-memory Workbook, where setting cell.value directly is sufficient and
  // row.commit() would throw (commitRow is not implemented on a plain Worksheet).

  // --- Data rows, grouped by section with a divider row ---
  let rowIdx = 3;
  let lastSection: ComparisonRow['section'] | null = null;
  for (const row of tab.rows) {
    if (row.section !== lastSection) {
      sheet.mergeCells(rowIdx, 1, rowIdx, colIdx - 1);
      const cell = sheet.getCell(rowIdx, 1);
      cell.value = SECTION_TITLES[row.section];
      cell.fill = SECTION_FILL;
      cell.font = { bold: true, italic: true };
      rowIdx++;
      lastSection = row.section;
    }

    sheet.mergeCells(rowIdx, 1, rowIdx, labelColWidth);
    const labelCell = sheet.getCell(rowIdx, 1);
    labelCell.value = row.label;

    let c = firstDataCol;
    for (const col of orderedColumns) {
      const cell = sheet.getCell(rowIdx, c);
      const value = row.values[col.columnId];
      cell.value = value ?? '';
      if (typeof value === 'number' && isCurrencyRow(row.rowId)) {
        cell.numFmt = CURRENCY_FORMAT;
      }
      c++;
    }
    rowIdx++;
  }

  sheet.getColumn(1).width = 34;
  for (let c = firstDataCol; c < colIdx; c++) {
    sheet.getColumn(c).width = 16;
  }

  if (dealName) {
    sheet.headerFooter = { oddHeader: `&L${dealName} — ${tab.productName}&R&D` };
  }
}