# Destination: apps/bucket/core/xlsx_builder.py  (full-file replacement)
"""
Turns normalized quote data into a comparison workbook. Three builders,
one per product type:

  build(data, out_path)
      simple_tiered (medical/dental/vision) - see
      claude_client.QUOTE_DATA_TOOL for the input shape. Benefits down
      the left side, one column per plan - the layout used for the
      Baker Farms / Angle Health comparison.

  build_age_banded(data, out_path)
      age_banded (life/AD&D/critical illness) - see
      claude_client.AGE_BANDED_DATA_TOOL for the input shape. One block
      per product/coverage-class, with a real age-band x coverage-amount
      rate grid rather than a flat per-tier rate.

  build_flat_rate_per_unit(data, out_path)
      flat_rate_per_unit (Basic Life/AD&D per $1,000 of coverage,
      LTD/STD per $100 of covered payroll) - see
      claude_client.FLAT_RATE_DATA_TOOL for the input shape. One block
      per product, a single rate line plus whatever plan-design fields
      are present - no per-tier or per-age grid, since there isn't one.

All three are carrier-agnostic: they just read whatever labels/keys the
extracted data happens to have.
"""
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

HEADER_FILL = PatternFill(start_color="6C4FD6", end_color="6C4FD6", fill_type="solid")
HEADER_FONT = Font(name="Arial", bold=True, color="FFFFFF")
SECTION_FONT = Font(name="Arial", bold=True, size=11)
PRODUCT_FONT = Font(name="Arial", bold=True, size=13)
LABEL_FONT = Font(name="Arial")
BODY_FONT = Font(name="Arial")
CURRENCY_FMT = "$#,##0.00"

TIER_LABELS = [
    ("employee_only", "Employee Only"),
    ("employee_spouse", "Employee + Spouse"),
    ("employee_children", "Employee + Child(ren)"),
    ("family", "Family"),
]

DESIGN_ROWS = [
    ("deductible_individual", "Deductible - Individual", "currency"),
    ("deductible_family", "Deductible - Family", "currency"),
    ("oop_max_individual", "OOP Max - Individual", "currency"),
    ("oop_max_family", "OOP Max - Family", "currency"),
    ("deductible_embedded", "Deductible Embedded", "text"),
    ("actuarial_value", "Actuarial Value", "number"),
]


def _write_row(ws, row, label, values, fmt="text"):
    ws.cell(row=row, column=1, value=label).font = LABEL_FONT
    for col, value in enumerate(values, start=2):
        cell = ws.cell(row=row, column=col, value=value)
        cell.font = BODY_FONT
        if fmt == "currency" and isinstance(value, (int, float)):
            cell.number_format = CURRENCY_FMT
        cell.alignment = Alignment(horizontal="center")


# ---------------------------------------------------------------------
# simple_tiered
# ---------------------------------------------------------------------

def build(data: dict, out_path) -> Path:
    out_path = Path(out_path)
    plans = data.get("plans", [])

    wb = Workbook()
    ws = wb.active
    ws.title = "Plan Comparison"

    ws.cell(row=1, column=1, value="Benefit").font = HEADER_FONT
    ws.cell(row=1, column=1).fill = HEADER_FILL
    for col, plan in enumerate(plans, start=2):
        cell = ws.cell(row=1, column=col, value=plan.get("plan_name", f"Plan {col - 1}"))
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(horizontal="center", wrap_text=True)

    row = 2
    ws.cell(row=row, column=1, value="Plan ID").font = LABEL_FONT
    for col, plan in enumerate(plans, start=2):
        ws.cell(row=row, column=col, value=plan.get("plan_id", "")).font = BODY_FONT
    row += 2

    ws.cell(row=row, column=1, value="MONTHLY PREMIUM RATES").font = SECTION_FONT
    row += 1
    for key, label in TIER_LABELS:
        values = [plan.get("rates", {}).get(key) for plan in plans]
        _write_row(ws, row, label, values, fmt="currency")
        row += 1
    row += 1

    ws.cell(row=row, column=1, value="PLAN DESIGN SUMMARY").font = SECTION_FONT
    row += 1
    for key, label, fmt in DESIGN_ROWS:
        values = [plan.get(key) for plan in plans]
        _write_row(ws, row, label, values, fmt=fmt)
        row += 1
    row += 1

    benefit_labels, seen = [], set()
    for plan in plans:
        for label in (plan.get("benefits") or {}).keys():
            if label not in seen:
                seen.add(label)
                benefit_labels.append(label)

    if benefit_labels:
        ws.cell(row=row, column=1, value="IN-NETWORK COST SHARE").font = SECTION_FONT
        row += 1
        for label in benefit_labels:
            values = [plan.get("benefits", {}).get(label, "") for plan in plans]
            _write_row(ws, row, label, values)
            row += 1
        row += 1

    oon_labels, seen = [], set()
    for plan in plans:
        for label in (plan.get("out_of_network") or {}).keys():
            if label not in seen:
                seen.add(label)
                oon_labels.append(label)

    if oon_labels:
        ws.cell(row=row, column=1, value="OUT-OF-NETWORK").font = SECTION_FONT
        row += 1
        for label in oon_labels:
            values = [plan.get("out_of_network", {}).get(label, "") for plan in plans]
            _write_row(ws, row, label, values)
            row += 1

    ws.freeze_panes = "B2"
    ws.column_dimensions["A"].width = 34
    for col in range(2, len(plans) + 2):
        ws.column_dimensions[get_column_letter(col)].width = 20

    wb.save(out_path)
    return out_path


# ---------------------------------------------------------------------
# age_banded
# ---------------------------------------------------------------------

def _sort_key_amount(amount):
    try:
        return float(str(amount).replace(",", "").replace("$", ""))
    except ValueError:
        return float("inf")


def build_age_banded(data: dict, out_path) -> Path:
    out_path = Path(out_path)
    products = data.get("products", [])

    wb = Workbook()
    ws = wb.active
    ws.title = "Age-Banded Coverage"

    row = 1
    max_col_used = 1

    for product in products:
        ws.cell(row=row, column=1, value=product.get("product_name", "Product")).font = PRODUCT_FONT
        row += 1

        for cls in product.get("coverage_classes", []):
            ws.cell(row=row, column=1, value=cls.get("class_name", "")).font = SECTION_FONT
            row += 1

            info_rows = [
                ("Increment", cls.get("increment")),
                ("Non-Medical Max", cls.get("non_medical_max")),
                ("Overall Benefit Max", cls.get("overall_benefit_max")),
                ("AD&D Included", cls.get("add_included")),
                ("Employee Contribution", cls.get("employee_contribution_pct")),
            ]
            for label, value in info_rows:
                if value in (None, ""):
                    continue
                ws.cell(row=row, column=1, value=label).font = LABEL_FONT
                ws.cell(row=row, column=2, value=value).font = BODY_FONT
                row += 1
            row += 1

            if cls.get("rate_structure") == "flat":
                amount_label = cls.get("flat_amount") or "flat amount"
                ws.cell(row=row, column=1, value=f"Monthly Rate ({amount_label})").font = LABEL_FONT
                cell = ws.cell(row=row, column=2, value=cls.get("flat_rate"))
                cell.font = BODY_FONT
                if isinstance(cls.get("flat_rate"), (int, float)):
                    cell.number_format = CURRENCY_FMT
                row += 2
                continue

            bands = cls.get("age_bands", [])
            amounts, seen = [], set()
            for b in bands:
                for amt in (b.get("rates_by_amount") or {}).keys():
                    if amt not in seen:
                        seen.add(amt)
                        amounts.append(amt)
            amounts.sort(key=_sort_key_amount)
            max_col_used = max(max_col_used, len(amounts) + 1)

            ws.cell(row=row, column=1, value="Age Band").font = HEADER_FONT
            ws.cell(row=row, column=1).fill = HEADER_FILL
            for col, amt in enumerate(amounts, start=2):
                label = amt if str(amt).strip().startswith("$") else f"${amt}"
                cell = ws.cell(row=row, column=col, value=label)
                cell.font = HEADER_FONT
                cell.fill = HEADER_FILL
                cell.alignment = Alignment(horizontal="center")
            row += 1

            for b in bands:
                ws.cell(row=row, column=1, value=b.get("label", "")).font = LABEL_FONT
                rates = b.get("rates_by_amount") or {}
                for col, amt in enumerate(amounts, start=2):
                    val = rates.get(amt)
                    cell = ws.cell(row=row, column=col, value=val)
                    cell.font = BODY_FONT
                    if isinstance(val, (int, float)):
                        cell.number_format = CURRENCY_FMT
                    cell.alignment = Alignment(horizontal="center")
                row += 1
            row += 2

    ws.freeze_panes = "B2"
    ws.column_dimensions["A"].width = 28
    for col in range(2, max_col_used + 1):
        ws.column_dimensions[get_column_letter(col)].width = 14

    wb.save(out_path)
    return out_path


# ---------------------------------------------------------------------
# flat_rate_per_unit
# ---------------------------------------------------------------------

def build_flat_rate_per_unit(data: dict, out_path) -> Path:
    out_path = Path(out_path)
    products = data.get("products", [])

    wb = Workbook()
    ws = wb.active
    ws.title = "Flat Rate Products"

    row = 1

    for product in products:
        ws.cell(row=row, column=1, value=product.get("product_name", "Product")).font = PRODUCT_FONT
        row += 1

        rate_label = f"Rate ({product['basis']})" if product.get("basis") else "Rate"
        ws.cell(row=row, column=1, value=rate_label).font = LABEL_FONT
        cell = ws.cell(row=row, column=2, value=product.get("rate_per_unit"))
        cell.font = BODY_FONT
        if isinstance(product.get("rate_per_unit"), (int, float)):
            cell.number_format = CURRENCY_FMT
        row += 1

        info_rows = [
            ("Benefit Amount", product.get("benefit_amount_formula")),
            ("Guarantee Issue Max", product.get("guarantee_issue_max")),
            ("Employee Contribution", product.get("employee_contribution_pct")),
            ("Elimination Period", product.get("elimination_period")),
            ("Benefit Duration", product.get("benefit_duration")),
        ]
        for label, value in info_rows:
            if value in (None, ""):
                continue
            ws.cell(row=row, column=1, value=label).font = LABEL_FONT
            ws.cell(row=row, column=2, value=value).font = BODY_FONT
            row += 1
        row += 2

    ws.freeze_panes = "B2"
    ws.column_dimensions["A"].width = 28
    ws.column_dimensions["B"].width = 32

    wb.save(out_path)
    return out_path