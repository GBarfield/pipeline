"""
Orchestrates a census or commission-statement spreadsheet upload: read
the file, check for a known column-mapping profile, fall back to Claude
(header-only first, de-identified sample second) only when needed, apply
the final mapping to the REAL data locally, and return real rows -
Claude itself never sees real row data, only headers and, sometimes, a
de-identified sample. See core/deidentify.py for why that's safe, and
core/tabular_profile_store.py for the profile-reuse mechanism.
"""
import csv
import io
import logging
from datetime import datetime, timezone

from openpyxl import load_workbook

from . import claude_client, deidentify, pdf_table_extractor, tabular_profile_store, wide_layout

logger = logging.getLogger(__name__)

CONFIDENCE_THRESHOLD = 0.75
SAMPLE_SIZE = 5

TARGET_FIELDS = {
    "census": {
        "employeeName": "The covered employee's full name.",
        "carrierName": "The insurance carrier for this enrollment.",
        "productLabel": "The benefit line, e.g. Medical, Dental, Vision.",
        "planName": "The specific plan name, if given.",
        "coverageTier": "Enrollment tier, e.g. Employee Only, Employee + Spouse, Family.",
        "premium": "The monthly premium amount for this enrollment.",
    },
        "commission_statement": {
        "carrierName": "The insurance carrier this statement is from.",
        "productLabel": "The benefit line, e.g. Medical, Dental, Vision.",
        "reportedPremium": "The premium amount the carrier is basing commission on.",
        "commissionAmount": "The dollar amount of commission paid, if given.",
        "employeeMonthlyCost": "The employee's monthly cost for this specific plan, if given.",
        "employeePerPayCost": "The employee's per-pay-period cost for this specific plan, if this is a distinct figure from the monthly cost.",
        "employerMonthlyCost": "The employer's monthly cost/contribution for this specific plan, if given.",
        "benefitAmount": "The face-value coverage/benefit amount for this plan (e.g. a life insurance benefit), if given.",
        "coveredPayrollAmount": "The covered monthly payroll amount this plan's rate is based on (LTD/STD), if given.",
        "employeeSsnRaw": "The employee's Social Security Number, for matching to internal records only - never displayed.",
        "companyName": (
            "The employer/company this row's premium or commission is for, ONLY if "
            "the file identifies a company per row or section (e.g. a multi-company "
            "statement with a 'Group Name' or 'Employer' column). Leave every column "
            "unmapped to this field if the file is a single company's statement with "
            "no such column - do not guess a company name from context."
        ),
        "statementPeriodStart": (
            "The start date of the billing/coverage period this row's premium or "
            "commission covers, ONLY if the file states one explicitly per row (e.g. "
            "a 'Coverage Period' or 'Bill Month' column). Leave unmapped if the file "
            "doesn't specify a period."
        ),
        "statementPeriodEnd": (
            "The end date of the billing/coverage period this row's premium or "
            "commission covers, ONLY if the file states one explicitly and separately "
            "from the start date. Leave unmapped if not present, or if the file only "
            "gives a single period date/month (map that single column to "
            "statementPeriodStart instead, and leave statementPeriodEnd unmapped)."
        ),
    },
    "benefits_document": {
        "employeeName": "The covered employee's full name.",
        "carrierName": "The insurance carrier for this enrollment.",
        "productLabel": "The benefit line, e.g. Medical, Dental, Vision.",
        "planName": "The specific plan name, if given.",
        "coverageTier": "Enrollment tier, e.g. Employee Only, Employee + Spouse, Family.",
        "effectiveDate": "The coverage effective/start date for this enrollment, if given.",
        "terminationDate": "The coverage termination/end date for this enrollment, if given.",
        "status": "The enrollment status as reported by the document, e.g. active, termed, pending, if given.",
        "companyName": (
            "The employer/company this row belongs to, ONLY if the file identifies a "
            "company per row or section (e.g. a multi-company roster with a 'Group "
            "Name' or 'Employer' column). Leave every column unmapped to this field if "
            "the file is a single company's document with no such column - do not "
            "guess a company name from context."
        ),
    },
}


def _read_rows(file_bytes: bytes, filename: str):
    """Returns (headers, rows) - rows is a list of lists, same column order as headers."""
    if filename.lower().endswith(".csv"):
        text = file_bytes.decode("utf-8-sig")
        reader = csv.reader(io.StringIO(text))
        rows = [row for row in reader if any(cell.strip() for cell in row)]
        if not rows:
            raise ValueError("File is empty.")
        return rows[0], rows[1:]

    workbook = load_workbook(io.BytesIO(file_bytes), data_only=True, read_only=True)
    sheet = workbook.active
    all_rows = [
        ["" if cell is None else str(cell) for cell in row]
        for row in sheet.iter_rows(values_only=True)
        if any(cell is not None and str(cell).strip() for cell in row)
    ]
    if not all_rows:
        raise ValueError("File is empty.")
    return all_rows[0], all_rows[1:]


def _to_mapping_dict(tool_result: dict):
    mapping, confidences = {}, {}
    for entry in tool_result.get("mappings", []):
        col = entry.get("source_column")
        mapping[col] = entry.get("target_field")
        confidences[col] = entry.get("confidence", 0)
    return mapping, confidences


def _apply_mapping(headers: list, data_rows: list, mapping: dict, filename: str) -> list:
    index_by_header = {h: i for i, h in enumerate(headers)}
    results = []
    for row in data_rows:
        record = {"sourceFile": filename, "rawRow": dict(zip(headers, row))}
        for header, target_field in mapping.items():
            if not target_field or target_field == "unmapped":
                continue
            idx = index_by_header.get(header)
            if idx is None or idx >= len(row):
                continue
            record[target_field] = row[idx]
        results.append(record)
    return results


def _log_audit_line(upload_kind: str, headers: list, sample_sent: bool, sample_row_count):
    # This is the compliance audit trail: proof of exactly what was (or
    # wasn't) sent to Claude for a given mapping request. Real row values
    # are never included here - only headers, which aren't PHI.
    logger.info(
        "tabular_mapping_request upload_kind=%s headers=%s sample_sent=%s sample_rows=%s at=%s",
        upload_kind, headers, sample_sent, sample_row_count if sample_sent else None,
        datetime.now(timezone.utc).isoformat(),
    )


def extract(file_bytes: bytes, filename: str, upload_kind: str) -> dict:
    if upload_kind not in TARGET_FIELDS:
        raise ValueError(f"Unknown upload_kind: {upload_kind!r}")

    headers, data_rows = _read_rows(file_bytes, filename)
    target_fields = TARGET_FIELDS[upload_kind]

    if upload_kind == "benefits_document":
        wide_groups = wide_layout.detect_wide_layout(headers)
        if wide_groups:
            original_headers = headers
            wide_profile = tabular_profile_store.load(upload_kind, original_headers)
            if wide_profile and wide_profile.get("layout") == "wide_multi_plan":
                plan_blocks = wide_profile["plan_blocks"]
                identity_columns = wide_profile["identity_columns"]
            else:
                identity_columns = wide_layout.detect_identity_columns(original_headers)
                classified = claude_client.classify_wide_layout(wide_groups, original_headers)
                plan_blocks = classified["plan_blocks"]
                tabular_profile_store.save(
                    upload_kind, original_headers, mapping={},
                    extra={"layout": "wide_multi_plan", "plan_blocks": plan_blocks, "identity_columns": identity_columns},
                )
            headers, data_rows = wide_layout.explode(original_headers, data_rows, plan_blocks, identity_columns)

    known = tabular_profile_store.load(upload_kind, headers)
    if known:
        return {
            "mapping_source": "known_profile",
            "mapping": known["mapping"],
            "needs_review": False,
            "rows": _apply_mapping(headers, data_rows, known["mapping"], filename),
        }

    # Header-only pass first - zero data exposure.
    header_result = claude_client.map_tabular_columns(headers, target_fields)
    mapping, confidences = _to_mapping_dict(header_result)
    _log_audit_line(upload_kind, headers, sample_sent=False, sample_row_count=None)

    low_confidence = any(c < CONFIDENCE_THRESHOLD for c in confidences.values())
    mapping_source = "header_only"

    if low_confidence:
        sample_rows = data_rows[:SAMPLE_SIZE]
        synthesized = deidentify.synthesize_sample(headers, sample_rows)
        sample_result = claude_client.map_tabular_columns(headers, target_fields, sample_rows=synthesized)
        mapping, confidences = _to_mapping_dict(sample_result)
        _log_audit_line(upload_kind, headers, sample_sent=True, sample_row_count=len(synthesized))
        mapping_source = "sample_fallback"

    needs_review = any(c < CONFIDENCE_THRESHOLD for c in confidences.values())

    return {
        "mapping_source": mapping_source,
        "mapping": mapping,
        "needs_review": needs_review,
        "rows": _apply_mapping(headers, data_rows, mapping, filename),
    }


def confirm_mapping(upload_kind: str, headers: list, corrected_mapping: dict, data_rows: list, filename: str) -> list:
    """
    Called after a human reviews/corrects a low-confidence mapping. Saves
    the corrected mapping as the new known profile, then applies it to
    the real data.
    """
    tabular_profile_store.save(upload_kind, headers, corrected_mapping)
    return _apply_mapping(headers, data_rows, corrected_mapping, filename)