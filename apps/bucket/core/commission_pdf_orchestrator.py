"""
NEW FILE — drop in as-is at: apps/bucket/core/commission_pdf_orchestrator.py

Orchestrates PDF -> structured commission-statement rows, mirroring the
shape of tabular_orchestrator.py's pipeline (see
commission-reconciliation-technical-documentation.md, Section 5.1) but for
PDF input instead of CSV/XLSX.

Unlike the census/commission tabular pipeline, this path is NOT subject to
the "no PHI to Claude" constraint documented for census uploads — commission
statements carry no employee-level fields (see TARGET_FIELDS below), so the
whole PDF's text is sent to Claude directly, the same compliance posture as
the existing Marketing/quote PDF extraction pipeline.

ACTION NEEDED (see 00_IMPLEMENTATION_PLAN.md item 1):
    Replace `_extract_pdf_text()` below with a direct call to whatever PDF
    text-extraction helper apps/bucket already uses for the quote pipeline
    (the comprehensive doc confirms one exists — profile_store.py's carrier
    fingerprinting runs against "the first six pages of the PDF's extracted
    text"). Reusing it avoids two slightly different PDF-parsing code paths
    in the same service. The inline pdfplumber fallback here is only a
    placeholder so this file works standalone if you can't find that helper
    quickly.
"""

from __future__ import annotations

import logging
from typing import Any

from core import claude_client

logger = logging.getLogger(__name__)

# Same target fields as the tabular commission_statement pipeline
# (commission-reconciliation-technical-documentation.md, Section 5.1).
TARGET_FIELDS = ["carrierName", "productLabel", "reportedPremium", "commissionAmount"]

# Below this confidence, don't persist — surface for human review instead.
# Matches the CONFIDENCE_THRESHOLD used by tabular_orchestrator.py.
CONFIDENCE_THRESHOLD = 0.75

# How much of the PDF's extracted text to send to Claude. Commission
# statements are typically short (1-3 pages); this is a generous cap to
# avoid an unbounded prompt on an unexpectedly long document.
MAX_TEXT_CHARS = 40_000


def _extract_pdf_text(file_bytes: bytes) -> str:
    """
    Placeholder PDF text extraction — REPLACE with the existing helper used
    by the quote/Marketing PDF pipeline if one exists in this codebase
    (see module docstring). This fallback uses pdfplumber directly so the
    module works even if you haven't wired in the real helper yet.
    """
    try:
        from core.pdf_utils import extract_pdf_text  # type: ignore

        return extract_pdf_text(file_bytes)
    except ImportError:
        pass

    try:
        from core.pdf_extraction import extract_text  # type: ignore

        return extract_text(file_bytes)
    except ImportError:
        pass

    # Last-resort inline fallback.
    import io

    import pdfplumber

    text_parts: list[str] = []
    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text() or ""
            text_parts.append(page_text)
    return "\n".join(text_parts)


def extract_commission_pdf(file_bytes: bytes, filename: str) -> dict[str, Any]:
    """
    Main entry point, called from the new Flask route
    (30_bucket_app_py_ADDITIONS.py).

    Returns a dict in one of two shapes, matching the /extract-tabular
    success/needs-review contract so the Node side and persistCommissionRows()
    require no changes:

        {"entries": [...], "needsReview": False, "extractionMethod": "pdf"}

    or, when confidence is low or nothing could be extracted:

        {"entries": [], "needsReview": True, "message": "...", "extractionMethod": "pdf"}
    """
    text = _extract_pdf_text(file_bytes)
    text = text.strip()

    if not text:
        logger.warning("commission_pdf_orchestrator: no extractable text in %s", filename)
        return {
            "entries": [],
            "needsReview": True,
            "message": (
                "Couldn't read any text from this PDF — it may be a scanned "
                "image without a text layer. Try re-exporting as CSV/Excel, "
                "or contact support."
            ),
            "extractionMethod": "pdf",
        }

    if len(text) > MAX_TEXT_CHARS:
        logger.info(
            "commission_pdf_orchestrator: truncating %s from %d to %d chars",
            filename,
            len(text),
            MAX_TEXT_CHARS,
        )
        text = text[:MAX_TEXT_CHARS]

    result = claude_client.extract_commission_statement_pdf(
        pdf_text=text,
        target_fields=TARGET_FIELDS,
    )

    # Audit log line — mirrors _log_audit_line() convention documented for
    # the tabular pipeline (Section 5.1, item 6), adapted for PDF input.
    logger.info(
        "commission_pdf_extraction filename=%s confidence=%.2f row_count=%d",
        filename,
        result.get("confidence", 0.0),
        len(result.get("entries", [])),
    )

    if result.get("confidence", 0.0) < CONFIDENCE_THRESHOLD or not result.get("entries"):
        return {
            "entries": [],
            "needsReview": True,
            "message": (
                "Extracted this PDF but wasn't confident in the result. "
                "Please double check the statement and enter the figures "
                "manually, or contact support if this carrier's statements "
                "keep failing to extract."
            ),
            "extractionMethod": "pdf",
        }

    return {
        "entries": result["entries"],
        "needsReview": False,
        "extractionMethod": "pdf",
    }