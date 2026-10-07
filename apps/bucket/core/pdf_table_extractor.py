"""
Local, no-Claude extraction of a table (headers + rows) from a PDF, for
upload_kind values where sending the raw PDF to Claude is not safe (e.g.
benefits_document - eligibility rosters and enrollment confirmations
commonly carry employee-level PHI, unlike commission-statement PDFs,
which go straight to Claude via core/claude_client.py's
extract_commission_statement_pdf).

Uses pdfplumber (already a dependency of this project) purely for its
table-detection, never Claude - the whole point is that this file never
makes a network call. Once a (headers, rows) pair comes out of here, it
flows through the exact same tabular_orchestrator.extract() pipeline a
CSV/XLSX upload already uses: known-profile check, header-only Claude
call, confidence-gated de-identified-sample fallback. Claude only ever
sees headers or a de-identified sample, never this file's output
directly.

Table detection is heuristic and WILL get some real PDFs wrong (merged
header cells, a title/logo banner mistaken for a header row, inconsistent
column counts row to row). Rather than guessing past that, this module
raises ValueError with a plain-language message on anything it isn't
reasonably confident about - app.py's /extract-tabular route already
turns a ValueError into a 400 the frontend can show directly, same
treatment an empty CSV already gets from tabular_orchestrator._read_rows.
"""
import io

import pdfplumber

# If more than this fraction of data rows have a different column count
# than the header row, treat the whole extraction as unreliable rather
# than silently dropping/misaligning cells.
MAX_RAGGED_ROW_FRACTION = 0.2

# A text layer this short (across the first few pages) means the PDF is
# almost certainly a scan/image with no real text underneath it - OCR
# would be needed, which this module deliberately does not attempt (see
# the design doc's Section 2.3). Fail clearly rather than returning
# garbage.
MIN_TEXT_LENGTH_FOR_TEXT_LAYER = 40


def _looks_like_scanned_pdf(pdf) -> bool:
    total_text = ""
    for page in pdf.pages[:3]:
        total_text += page.extract_text() or ""
        if len(total_text.strip()) >= MIN_TEXT_LENGTH_FOR_TEXT_LAYER:
            return False
    return len(total_text.strip()) < MIN_TEXT_LENGTH_FOR_TEXT_LAYER


def _extract_raw_tables(pdf) -> list:
    """One list of rows (each a list of cell strings) per detected table, in page order."""
    tables = []
    for page in pdf.pages:
        for table in page.extract_tables():
            # pdfplumber returns None for a blank cell - normalize to "".
            cleaned = [
                ["" if cell is None else str(cell).strip() for cell in row]
                for row in table
                if any(cell is not None and str(cell).strip() for cell in row)
            ]
            if cleaned:
                tables.append(cleaned)
    return tables


def _merge_continuation_tables(tables: list) -> list:
    """
    Concatenates consecutive tables whose header row matches exactly -
    the common shape for a multi-page roster where pdfplumber detects one
    table per page. Deliberately exact-match only, not fuzzy.
    """
    if not tables:
        return []
    merged = [tables[0]]
    for table in tables[1:]:
        if table and merged[-1] and table[0] == merged[-1][0]:
            merged[-1] = merged[-1] + table[1:]
        else:
            merged.append(table)
    return merged


def extract_headers_and_rows(file_bytes: bytes):
    """
    Returns (headers, rows) in the same shape tabular_orchestrator._read_rows
    already produces for CSV/XLSX. Raises ValueError (caught by the
    /extract-tabular route and turned into a 400) when the PDF can't be
    read with reasonable confidence - a scanned/image PDF, or no table
    detected at all.
    """
    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        if not pdf.pages:
            raise ValueError("This PDF has no pages.")

        if _looks_like_scanned_pdf(pdf):
            raise ValueError(
                "This PDF appears to be a scanned image with no selectable text. "
                "Please upload a text-based export or a spreadsheet instead."
            )

        raw_tables = _extract_raw_tables(pdf)

    if not raw_tables:
        raise ValueError(
            "Couldn't find a table in this PDF. Please upload a spreadsheet "
            "(CSV/XLSX) instead, or check that the file isn't blank."
        )

    tables = _merge_continuation_tables(raw_tables)
    # Use the largest table found (by row count) - the common case for a
    # roster/statement PDF is exactly one real data table plus maybe a
    # small unrelated table (e.g. a summary box) elsewhere on the page.
    headers, *data_rows = max(tables, key=len)

    if not data_rows:
        raise ValueError("Found a table in this PDF, but it has no data rows.")

    ragged = sum(1 for row in data_rows if len(row) != len(headers))
    if ragged / len(data_rows) > MAX_RAGGED_ROW_FRACTION:
        raise ValueError(
            "This PDF's table structure looks inconsistent (column counts "
            "don't line up row to row). Please upload a spreadsheet (CSV/XLSX) "
            "instead, or double-check the source file."
        )

    # Pad/truncate ragged rows to the header's column count so
    # tabular_orchestrator's zip(headers, row) never silently misaligns.
    normalized_rows = []
    for row in data_rows:
        if len(row) < len(headers):
            row = row + [""] * (len(headers) - len(row))
        elif len(row) > len(headers):
            row = row[: len(headers)]
        normalized_rows.append(row)

    return headers, normalized_rows