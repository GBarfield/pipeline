# Destination: apps/bucket/core/profile_store.py  (full-file replacement)
"""
The 'library' of carrier profiles.

Each profile is a JSON file describing:
  - how to recognize this carrier's document from its text (fingerprint)
  - a pre-tuned extraction prompt Claude should use to pull data out of
    this carrier's documents (learned once, reused forever after)

Profiles are scoped by (carrier, product_type) and, optionally,
benefit_line. A carrier's medical proposal layout and its life proposal
layout have nothing to do with each other even though they share a logo,
so they get separate profile files and are never cross-matched on
product_type alone.

That alone isn't enough once a carrier has MULTIPLE benefit lines that
share the same rate structure - e.g. Dental and Vision are both
simple_tiered. Without a benefit_line dimension, those two would collide
on the exact same profile file, and matching one wrongly informs
extraction of the other. benefit_line closes that gap: when provided, it
scopes matching/saving to that specific product line (e.g. 'dental',
'basic_life'), not just the rate structure. It's optional and defaults
to the old carrier+product_type-only behavior for callers that don't yet
know the benefit line (the original single-upload flow), so this is a
non-breaking change.

Nothing in here calls the Anthropic API. This module only reads and
writes the carrier_profiles/ folder, so it costs nothing to run.
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path


def _normalize(text: str) -> str:
    # Collapses runs of whitespace (including line-wrap-induced newlines
    # in the middle of a phrase) into single spaces before matching, so a
    # PDF-extraction line break in the middle of a fingerprint phrase
    # doesn't silently break an otherwise-correct match.
    return re.sub(r"\s+", " ", (text or "").lower()).strip()

PROFILE_DIR = Path(__file__).resolve().parent.parent / "carrier_profiles"

# Profiles saved before product types existed didn't record one. Treat
# them as simple_tiered, since that's the only type that existed then.
DEFAULT_PRODUCT_TYPE = "simple_tiered"


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", (name or "").lower()).strip("_")
    return slug or "unknown_carrier"


def load_all(product_type: str = None, benefit_line: str = None) -> list:
    """
    Load every saved carrier profile. If product_type is given, only
    profiles for that product type are returned. If benefit_line is also
    given, further restricts to profiles tagged with that exact benefit
    line. Profiles saved before benefit_line existed have none recorded,
    so a benefit_line-scoped lookup will not match them - they get
    re-discovered once under the new scheme instead of risking a wrong
    match. That's a deliberate, self-healing one-time cost, not a bug.
    """
    PROFILE_DIR.mkdir(exist_ok=True)
    profiles = []
    for path in PROFILE_DIR.glob("*.json"):
        with open(path, "r", encoding="utf-8") as f:
            profile = json.load(f)
        profile["_path"] = str(path)
        profile.setdefault("product_type", DEFAULT_PRODUCT_TYPE)
        if product_type and profile.get("product_type") != product_type:
            continue
        if benefit_line and profile.get("benefit_line") != benefit_line:
            continue
        profiles.append(profile)
    return profiles


def match(document_text: str, product_type: str, benefit_line: str = None):
    """
    Check a new PDF's extracted text against every saved profile's
    fingerprint FOR THE SELECTED PRODUCT TYPE (and, if given, benefit
    line) ONLY. Returns the first matching profile dict, or None if this
    looks like a combination we haven't seen before.

    Pass benefit_line (e.g. 'dental', 'basic_life') whenever it's known
    - it prevents two different benefit lines from the same carrier and
    rate structure (Dental vs. Vision, both simple_tiered) from ever
    cross-matching. Omit it to preserve the original carrier+product_type
    -only matching used by callers that don't yet know the benefit line.
    """
    text_norm = _normalize(document_text)
    for profile in load_all(product_type=product_type, benefit_line=benefit_line):
        fingerprint = profile.get("fingerprint", {})
        must_contain = [_normalize(s) for s in fingerprint.get("must_contain", [])]
        any_of = [_normalize(s) for s in fingerprint.get("any_of", [])]

        if not must_contain and not any_of:
            continue
        if must_contain and not all(s in text_norm for s in must_contain):
            continue
        if any_of and not any(s in text_norm for s in any_of):
            continue
        return profile
    return None


def save(profile: dict, product_type: str, benefit_line: str = None) -> Path:
    """
    Save a new or updated carrier profile, scoped to a product type and,
    if given, a benefit line. Filename is derived from carrier name +
    product type (+ benefit line, if given), e.g.
    metlife__simple_tiered__dental.json, so re-saving an updated profile
    overwrites the old one instead of piling up duplicates, and a
    carrier's different product types AND different benefit lines never
    collide with each other. benefit_line is also stored inside the
    profile JSON itself (not just implied by the filename), so match()
    can filter on it directly.
    """
    PROFILE_DIR.mkdir(exist_ok=True)
    profile = dict(profile)  # don't mutate caller's copy
    profile.pop("_path", None)
    profile["product_type"] = product_type
    if benefit_line:
        profile["benefit_line"] = benefit_line
    profile.setdefault("created_at", datetime.now(timezone.utc).isoformat())
    profile["updated_at"] = datetime.now(timezone.utc).isoformat()
    profile["times_used"] = profile.get("times_used", 0) + 1

    slug = _slugify(profile.get("carrier_name", "unknown_carrier"))
    if benefit_line:
        line_slug = _slugify(benefit_line)
        path = PROFILE_DIR / f"{slug}__{product_type}__{line_slug}.json"
    else:
        path = PROFILE_DIR / f"{slug}__{product_type}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(profile, f, indent=2)
    return path