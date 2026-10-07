"""
Local, deterministic de-identification for spreadsheet sample data before
it's ever considered for sending to Claude. No AI, no network call - pure
pattern matching against values already sitting in memory on this server.

Exists because census/commission uploads can contain PHI (employee names,
member IDs, dates of birth). Claude's column-mapping call only ever needs
to know what KIND of thing is in each column, not real values - see
tabular_orchestrator.py for how the two-tier header-only / sample-fallback
calls use this.

Three buckets per column, decided by inspecting every value in a small
sample (not just the first row, since one blank cell shouldn't wrongly
tip a column into a different bucket):

  identifying      - looks like a name, SSN, member/policy ID, DOB,
                      address, email, or phone number. Real values are
                      NEVER sent - replaced with fabricated placeholders
                      that preserve only the format.
  categorical       - a small number of distinct values repeated across
                      many rows (coverage tier, carrier name, product
                      type). Real values ARE sent - a repeated label
                      isn't identifying information about any one
                      person, and it's useful signal for classifying
                      the column correctly.
  numeric_or_date   - looks like currency, a plain number, or a date.
                      Real values are NEVER sent - replaced with a
                      clearly fake placeholder of matching format.

Anything not confidently matched falls back to "identifying" - the safe
default when unsure is to synthesize, not to transmit.
"""
import re

_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z.'-]*(\s+[A-Za-z][A-Za-z.'-]*)+$")
_SSN_RE = re.compile(r"^\d{3}-?\d{2}-?\d{4}$")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_PHONE_RE = re.compile(r"^[\d()+\-.\s]{7,}$")
_DATE_RE = re.compile(r"^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$")
_CURRENCY_RE = re.compile(r"^\$?-?\d[\d,]*(\.\d{1,2})?$")

_FAKE_BY_SUBTYPE = {
    "name": ["Sample Employee A", "Sample Employee B", "Sample Employee C", "Sample Employee D"],
    "ssn": "000-00-0000",
    "email": "sample.employee@example.com",
    "phone": "000-000-0000",
}

CATEGORICAL_MAX_DISTINCT = 15


def _identifying_subtype(value: str):
    v = value.strip()
    if _SSN_RE.match(v):
        return "ssn"
    if _EMAIL_RE.match(v):
        return "email"
    if _NAME_RE.match(v):
        return "name"
    if _PHONE_RE.match(v) and sum(c.isdigit() for c in v) >= 7:
        return "phone"
    return None


def _looks_numeric_or_date(value: str) -> bool:
    v = value.strip()
    if not v:
        return False
    return bool(_DATE_RE.match(v) or _CURRENCY_RE.match(v))


def classify_column(values: list) -> str:
    """
    values: every sample value seen for one column (as strings). Returns
    'categorical', 'identifying', or 'numeric_or_date'.
    """
    non_blank = [v for v in values if v and v.strip()]
    if not non_blank:
        return "categorical"  # nothing to hide in an empty sample

    distinct = set(non_blank)
    if len(distinct) <= CATEGORICAL_MAX_DISTINCT and len(distinct) < len(non_blank):
        # Repeats within the sample, few distinct values - a real category
        # column (coverage tier, carrier, product type), not a per-row
        # unique identifier.
        return "categorical"

    if all(_identifying_subtype(v) for v in non_blank):
        return "identifying"

    if all(_looks_numeric_or_date(v) for v in non_blank):
        return "numeric_or_date"

    # Mixed or unrecognized shape - safe default is to treat as
    # identifying rather than risk sending something real.
    return "identifying"


def synthesize_sample(headers: list, rows: list) -> list:
    """
    rows: list of lists (raw sample rows, same column order as headers).
    Returns an equivalent-shaped sample where every column has been
    replaced according to its classification - categorical columns keep
    real values, everything else is fabricated.
    """
    if not rows:
        return []

    columns = list(zip(*rows))
    classifications = [classify_column([str(v) for v in col]) for col in columns]
    subtypes = []
    for col, kind in zip(columns, classifications):
        if kind != "identifying":
            subtypes.append(None)
            continue
        first_match = next((_identifying_subtype(str(v)) for v in col if str(v).strip()), None)
        subtypes.append(first_match or "name")

    synthesized_rows = []
    for row in rows:
        new_row = []
        for i, value in enumerate(row):
            kind = classifications[i]
            if kind == "categorical":
                new_row.append(value)
            elif kind == "numeric_or_date":
                original = str(value).strip()
                new_row.append("$100.00" if _CURRENCY_RE.match(original) else "2020-01-01")
            else:  # identifying
                subtype = subtypes[i]
                fake = _FAKE_BY_SUBTYPE[subtype]
                new_row.append(fake[i % len(fake)] if isinstance(fake, list) else fake)
        synthesized_rows.append(new_row)

    return synthesized_rows