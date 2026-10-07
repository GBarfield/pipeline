# Destination: apps/bucket/core/orchestrator.py  (full-file replacement)
"""
Wires everything together:
  1. Fingerprint the PDF locally (free) against the saved profile library,
     scoped to the product type the user selected on the bucket page (and,
     if given, a specific benefit line within a multi-product document).
  2. Known carrier -> cheap Haiku extraction using that carrier's profile.
  3. Unknown carrier, OR a known-carrier extraction that fails
     validation -> Sonnet discovery call, which also writes a
     new/updated profile.
  4. Validate the result - both for hard failures (blocks delivery) and
     completeness gaps (surfaced as warnings, doesn't block delivery).
  5. Hand the normalized data to the matching xlsx builder.
  6. Save the normalized JSON alongside the spreadsheet, so other
     tools/agents in the larger BenAdmin pipeline can consume the
     structured data directly instead of re-parsing a spreadsheet.
"""
import json
from datetime import datetime

from . import claude_client, pdf_utils, profile_store, xlsx_builder
from .paths import OUTPUT_DIR

PRODUCT_TYPES = ("simple_tiered", "age_banded", "flat_rate_per_unit")

# A plan/class missing more than this many fields that other plans/classes
# in the same document have is treated as a red flag, not normal variation
# (a plan legitimately lacking a rider or two is common; missing a handful
# of standard categories usually means the model got lazy partway through
# a long document, not that the design is actually different).
COMPLETENESS_GAP_THRESHOLD = 2


# ---------------------------------------------------------------------
# simple_tiered validation
# ---------------------------------------------------------------------

def _hard_problems_simple_tiered(data: dict) -> list:
    problems = []
    plans = data.get("plans") or []
    if not plans:
        problems.append("No plans were extracted.")
    for plan in plans:
        if not isinstance(plan, dict):
            problems.append(f"A plan entry was malformed (expected an object, got {type(plan).__name__}).")
            continue
        name = plan.get("plan_name", "<unnamed plan>")
        rates = plan.get("rates") or {}
        if not isinstance(rates, dict):
            problems.append(f"'{name}' has a malformed rates field (expected an object, got {type(rates).__name__}).")
            continue
        numeric_rates = [v for v in rates.values() if isinstance(v, (int, float))]
        if not numeric_rates:
            problems.append(f"'{name}' has no numeric rates.")
    return problems


def _completeness_warnings_simple_tiered(data: dict) -> list:
    plans = [p for p in (data.get("plans") or []) if isinstance(p, dict)]
    if len(plans) < 2:
        return []

    all_labels = set()
    for plan in plans:
        all_labels |= set((plan.get("benefits") or {}).keys())
    if not all_labels:
        return []

    warnings = []
    for plan in plans:
        name = plan.get("plan_name", "<unnamed plan>")
        have = set((plan.get("benefits") or {}).keys())
        missing = sorted(all_labels - have)
        if len(missing) > COMPLETENESS_GAP_THRESHOLD:
            shown = ", ".join(missing[:6]) + ("..." if len(missing) > 6 else "")
            warnings.append(f"'{name}' is missing {len(missing)} benefit field(s) other plans have: {shown}")
    return warnings


# ---------------------------------------------------------------------
# age_banded validation
# ---------------------------------------------------------------------

def _hard_problems_age_banded(data: dict) -> list:
    problems = []
    products = data.get("products") or []
    if not products:
        problems.append("No products were extracted.")
    for product in products:
        if not isinstance(product, dict):
            problems.append(f"A product entry was malformed (expected an object, got {type(product).__name__}).")
            continue
        pname = product.get("product_name", "<unnamed product>")
        classes = product.get("coverage_classes") or []
        if not classes:
            problems.append(f"'{pname}' has no coverage classes.")
        for cls in classes:
            if not isinstance(cls, dict):
                problems.append(f"'{pname}' has a malformed coverage class (expected an object, got {type(cls).__name__}).")
                continue
            cname = cls.get("class_name", "<unnamed class>")
            structure = cls.get("rate_structure")
            if structure == "age_banded":
                bands = cls.get("age_bands") or []
                if not bands:
                    problems.append(f"'{pname} / {cname}' is age-banded but has no age bands.")
                elif not all(isinstance(b, dict) for b in bands):
                    problems.append(f"'{pname} / {cname}' has a malformed age band entry.")
                elif not any(b.get("rates_by_amount") for b in bands):
                    problems.append(f"'{pname} / {cname}' age bands have no rates.")
            elif structure == "flat":
                if cls.get("flat_rate") is None:
                    problems.append(f"'{pname} / {cname}' is flat-rate but has no flat_rate value.")
            else:
                problems.append(f"'{pname} / {cname}' has an unrecognized rate_structure: {structure!r}.")
    return problems


def _completeness_warnings_age_banded(data: dict) -> list:
    warnings = []
    for product in data.get("products") or []:
        if not isinstance(product, dict):
            continue
        pname = product.get("product_name", "<unnamed product>")
        for cls in product.get("coverage_classes") or []:
            if not isinstance(cls, dict):
                continue
            cname = cls.get("class_name", "<unnamed class>")
            bands = [b for b in (cls.get("age_bands") or []) if isinstance(b, dict)]
            if len(bands) < 2:
                continue
            all_amounts = set()
            for b in bands:
                all_amounts |= set((b.get("rates_by_amount") or {}).keys())
            if not all_amounts:
                continue
            for b in bands:
                have = set((b.get("rates_by_amount") or {}).keys())
                missing = sorted(all_amounts - have)
                if missing:
                    warnings.append(
                        f"'{pname} / {cname}' age band '{b.get('label')}' is missing rates for: "
                        + ", ".join(missing)
                    )
    return warnings


# ---------------------------------------------------------------------
# flat_rate_per_unit validation
# ---------------------------------------------------------------------

def _hard_problems_flat_rate_per_unit(data: dict) -> list:
    problems = []
    products = data.get("products") or []
    if not products:
        problems.append("No products were extracted.")
    for product in products:
        if not isinstance(product, dict):
            problems.append(f"A product entry was malformed (expected an object, got {type(product).__name__}).")
            continue
        pname = product.get("product_name", "<unnamed product>")
        if not product.get("basis"):
            problems.append(f"'{pname}' has no basis (e.g. 'per $1,000 of coverage').")
        if not isinstance(product.get("rate_per_unit"), (int, float)):
            problems.append(f"'{pname}' has no numeric rate_per_unit.")
    return problems


def _completeness_warnings_flat_rate_per_unit(data: dict) -> list:
    # Each product here is typically a single flat number rather than a
    # multi-row grid, so there isn't the same "missing rows/columns"
    # completeness risk the other two structures have. Kept as an empty
    # stub - rather than omitted - so _validators_for() stays uniform.
    return []


def _validators_for(product_type: str):
    if product_type == "age_banded":
        return _hard_problems_age_banded, _completeness_warnings_age_banded
    if product_type == "flat_rate_per_unit":
        return _hard_problems_flat_rate_per_unit, _completeness_warnings_flat_rate_per_unit
    if product_type == "simple_tiered":
        return _hard_problems_simple_tiered, _completeness_warnings_simple_tiered
    raise ValueError(f"Unknown product_type: {product_type!r}")


def _count_items(data: dict, product_type: str) -> int:
    if product_type in ("age_banded", "flat_rate_per_unit"):
        return len(data.get("products") or [])
    return len(data.get("plans") or [])


def process_pdf(pdf_path: str, product_type: str, status_cb=None, scope_label: str = None) -> dict:
    """
    Run the full pipeline on a single PDF for the given product_type
    ('simple_tiered', 'age_banded', or 'flat_rate_per_unit' - see
    PRODUCT_TYPES). `status_cb`, if given, is called with short
    human-readable progress strings (used to drive the status text on
    the web page). Every one of those messages is also printed to the
    console, so the terminal running `python app.py` (or the Waitress
    logs, in production) shows live progress even if the browser request
    later fails.

    scope_label, if given, restricts extraction (and carrier-profile
    matching/saving) to just that one product within the document - used
    when a PDF contains multiple products and each is being processed as
    its own independent call rather than trying to pull everything out
    in a single pass. Omit it for the original single-product-per-PDF
    flow; behavior is identical to before when it's not given.

    Returns: {data, xlsx_path, json_path, used_discovery, warnings}
    """
    if product_type not in PRODUCT_TYPES:
        raise ValueError(f"Unknown product_type: {product_type!r}. Expected one of {PRODUCT_TYPES}.")

    hard_problems_fn, completeness_warnings_fn = _validators_for(product_type)

    def report(msg: str):
        print(f"[quote-parser:{product_type}] {msg}")
        if status_cb:
            status_cb(msg)

    report("Reading document...")
    fingerprint_text = pdf_utils.extract_text(pdf_path)

    profile = profile_store.match(fingerprint_text, product_type, benefit_line=scope_label)
    used_discovery = False
    new_profile = None

    if profile:
        report(f"Recognized carrier: {profile.get('carrier_name')}. Extracting (cheap path)...")
        data = claude_client.extract_known(pdf_path, profile, product_type, scope_label=scope_label)
        retry_reasons = hard_problems_fn(data) + completeness_warnings_fn(data)
        if retry_reasons:
            report("Known-carrier extraction looked incomplete. Re-analyzing from scratch...")
            data, new_profile = claude_client.discover_and_extract(pdf_path, product_type, scope_label=scope_label)
            used_discovery = True
    else:
        report("New carrier/document — analyzing structure...")
        data, new_profile = claude_client.discover_and_extract(pdf_path, product_type, scope_label=scope_label)
        used_discovery = True

    hard = hard_problems_fn(data)
    if hard:
        report("Validation failed: " + "; ".join(hard))
        raise RuntimeError("Extraction failed validation: " + "; ".join(hard))

    warnings = completeness_warnings_fn(data)
    for w in warnings:
        report(f"Warning: {w}")
    report(f"Extracted {_count_items(data, product_type)} item(s).")

    if new_profile:
        saved_path = profile_store.save(new_profile, product_type, benefit_line=scope_label)
        report(f"Saved carrier profile: {saved_path.name}")
    elif profile:
        profile_store.save(profile, product_type, benefit_line=scope_label)  # bump times_used / updated_at

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    carrier_slug = (data.get("carrier_name") or "carrier").replace(" ", "_")
    group_slug = (data.get("group_name") or "group").replace(" ", "_")
    label_slug = f"_{scope_label.replace(' ', '_')}" if scope_label else ""
    base_name = f"{carrier_slug}_{group_slug}{label_slug}_{stamp}"

    json_path = OUTPUT_DIR / f"{base_name}.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    report("Building comparison spreadsheet...")
    if product_type == "age_banded":
        xlsx_path = xlsx_builder.build_age_banded(data, OUTPUT_DIR / f"{base_name}.xlsx")
    elif product_type == "flat_rate_per_unit":
        xlsx_path = xlsx_builder.build_flat_rate_per_unit(data, OUTPUT_DIR / f"{base_name}.xlsx")
    else:
        xlsx_path = xlsx_builder.build(data, OUTPUT_DIR / f"{base_name}.xlsx")

    # Self-check, in this same process, at the moment of creation - not a
    # separate request/instance that could be looking at a different
    # container or a stale volume mount. If this ever logs False, the
    # problem is the write itself (or how it's persisted), not a routing
    # or filename mismatch downstream.
    exists_now = xlsx_path.exists()
    size_now = xlsx_path.stat().st_size if exists_now else 0
    report(f"Spreadsheet written: {exists_now} ({size_now} bytes) at {xlsx_path}")

    report("Done.")
    return {
        "data": data,
        "xlsx_path": str(xlsx_path),
        "json_path": str(json_path),
        "used_discovery": used_discovery,
        "warnings": warnings,
        "xlsx_confirmed_on_disk": exists_now,
        "xlsx_bytes": size_now,
    }