"""
The 'library' of column-mapping profiles for tabular (Excel/CSV) uploads
- census exports and carrier commission statements.

This is the tabular counterpart to profile_store.py, but the matching
mechanism is different: a PDF profile matches on a fuzzy text fingerprint
(the document's actual content varies every time), while a spreadsheet's
column HEADERS are usually identical every time the same source system
(the same carrier's statement format, the same payroll/HRIS export)
produces a file. So instead of fuzzy phrase matching, a tabular profile
is looked up by an exact, normalized signature of its header row.

Deliberately carrier-agnostic: a census file can span multiple carriers
in its own data (Medical from one carrier, Dental from another, in the
same file), so there often isn't a single "carrier" to key on the way
PDF profiles are. The header signature alone is what identifies "have we
seen this exact export format before," regardless of which carrier(s)
appear inside it.

Nothing in here calls the Anthropic API - same contract as
profile_store.py. This module only reads and writes the
column_mapping_profiles/ folder.
"""
import hashlib
import json
import re
from datetime import datetime, timezone

from .paths import COLUMN_MAPPING_PROFILES_DIR


def _normalize_header(header: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (header or "").lower()).strip()


def header_signature(headers: list) -> str:
    """
    A stable, order-preserving signature for a header row. Order is kept
    (not sorted) because a genuinely different column order is a
    genuinely different export layout worth treating separately.
    """
    normalized = [_normalize_header(h) for h in headers]
    joined = "|".join(normalized)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:16]


def _path_for(upload_kind: str, signature: str):
    return COLUMN_MAPPING_PROFILES_DIR / f"{upload_kind}__{signature}.json"


def load(upload_kind: str, headers: list):
    """
    Look up a saved mapping profile for this exact header layout, if one
    exists. Returns the profile dict (including 'mapping'), or None if
    this layout hasn't been seen and confirmed before.
    """
    path = _path_for(upload_kind, header_signature(headers))
    if not path.exists():
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save(upload_kind: str, headers: list, mapping: dict, extra: dict | None = None) -> None:
    """
    Save a confirmed column mapping for this exact header layout, so
    future uploads with the same headers skip Claude entirely.
    """
    path = _path_for(upload_kind, header_signature(headers))
    times_used = 0
    created_at = datetime.now(timezone.utc).isoformat()
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
                        existing = json.load(f)
        times_used = existing.get("times_used", 0)
        created_at = existing.get("created_at", created_at)
    profile = {
        "upload_kind": upload_kind,
        "headers": headers,
        "mapping": mapping,
        "created_at": created_at,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "times_used": times_used + 1,
        **(extra or {}),
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(profile, f, indent=2)