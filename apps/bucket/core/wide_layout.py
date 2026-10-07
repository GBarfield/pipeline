# Destination: apps/bucket/core/wide_layout.py  (new file)
"""
Detects and explodes "wide" carrier eligibility/enrollment files - one row
per person with N plan types spread across column groups (e.g. "Accident
Plan Coverage", "Accident Plan Employee Monthly Cost", "Group Life Plan",
"Group Life Employee Monthly Cost", "Group Life Employer Monthly Cost", ...)
- into the flat, one-row-per-plan shape the rest of tabular_orchestrator.py
already assumes.

Detection and grouping (detect_wide_layout, detect_identity_columns,
explode) are local and deterministic - no Claude call, no data leaves the
server. Only the resulting group->productLabel guess optionally goes to
Claude as headers-only classification afterward (see
claude_client.classify_wide_layout, called by tabular_orchestrator.py) -
real row values are read and re-emitted purely locally in explode().

See claude/benefits-document-wide-format-and-dollar-reconciliation-design.md
in the project docs for the full design this implements.
"""
import re

# Longest-match-first: role suffix -> field role name. Order matters -
# "Employee Per Pay Cost" must be checked before "Employee Monthly Cost",
# since a naive endswith() scan would otherwise match the shorter, wrong
# suffix first. Extend this list as new carriers' naming conventions are
# seen - it's the one place that should need editing for a genuinely new
# vocabulary, not the grouping/explosion logic itself.
ROLE_SUFFIXES = [
    ("Employee Per Pay Cost", "employeePerPayCost"),
    ("Employee Monthly Cost", "employeeMonthlyCost"),
    ("Employer Monthly Cost", "employerMonthlyCost"),
    ("Employer Per Pay Cost", "employerPerPayCost"),
    ("Member Monthly Cost", "employeeMonthlyCost"),
    ("Member Cost", "employeeMonthlyCost"),
    ("Member Benefit", "benefitAmount"),
    ("Coverage", "coverageTier"),
    ("Plan", "planName"),
    ("Benefit", "benefitAmount"),  # LTD/STD reclassify this to coveredPayrollAmount - see claude_client.classify_wide_layout
]
# NOTE: deliberately no separate "Plan Coverage" entry above, even though
# several real headers look like "<X> Plan Coverage" - a compound suffix
# there would strip "Plan" out of the group key for that ONE role but not
# for "<X> Plan Employee Monthly Cost" (which only matches "Employee
# Monthly Cost" and keeps "Plan" in ITS group key), producing two
# different group keys ("X" vs "X Plan") for what is really one plan.
# Found by running this against the real Allied Guardian file - see
# test output in chat. The trailing-" Plan" strip below is a second,
# independent safety net for the same class of problem with any future
# carrier's suffix vocabulary.


def _normalize_group_key(group: str) -> str:
    return re.sub(r"\s+Plan$", "", group).strip()

# Threshold for "this file is wide, not flat": at least this many distinct
# plan-groups, each contributing at least this many role columns. Allied
# Guardian's real file produces 7 groups x 2-4 roles each - comfortably
# past this bar. A genuinely flat file (one column per target field)
# produces zero groups and is untouched.
MIN_GROUPS = 2
MIN_ROLES_PER_GROUP = 2

_SSN_HEADER_RE = re.compile(r"social security|\bssn\b", re.I)


def _strip_role_suffix(header: str):
    h = header.strip()
    for suffix, role in ROLE_SUFFIXES:
        if h.endswith(suffix) and len(h) > len(suffix):
            group = _normalize_group_key(h[: -len(suffix)])
            if group:
                return group, role
    return None


def detect_wide_layout(headers: list) -> dict | None:
    """
    Returns None if this looks like a normal flat file (nothing to group,
    or not enough grouping to be worth treating as wide). Otherwise
    returns {plan_label_guess: {role: source_header, ...}, ...} - a
    first-pass grouping by shared prefix + known role suffix. This is the
    RAW heuristic result (plan_label_guess is just the stripped column
    prefix, e.g. "Group Long-Term Disability") - claude_client.classify_wide_layout
    turns these into real productLabel values and settles the
    benefitAmount-vs-coveredPayrollAmount question.
    """
    groups: dict[str, dict[str, str]] = {}
    for h in headers:
        stripped = _strip_role_suffix(h)
        if not stripped:
            continue
        group, role = stripped
        groups.setdefault(group, {})[role] = h

    qualifying = {g: roles for g, roles in groups.items() if len(roles) >= MIN_ROLES_PER_GROUP}
    if len(qualifying) < MIN_GROUPS:
        return None
    return qualifying


def detect_identity_columns(headers: list) -> dict:
    """
    Shared, whole-person columns that apply to every plan block, not one
    plan. Local/deterministic - same posture as the rest of this module.
    Prefers split First/Last Name over Full Name when both exist (see
    design doc S2.2 - a carrier's own Full Name column can be wrong even
    when First/Last are right, or vice versa; keeping both available lets
    _employee_name() below pick the more trustworthy one per row rather
    than committing to one column for the whole file).
    """
    identity: dict[str, str] = {}
    for h in headers:
        norm = h.strip().lower()
        if _SSN_HEADER_RE.search(norm) and "employeeSsnRaw" not in identity:
            identity["employeeSsnRaw"] = h
        elif norm == "relationship":
            identity["relationship"] = h
        elif norm == "last name":
            identity["lastName"] = h
        elif norm == "first name":
            identity["firstName"] = h
        elif norm == "full name":
            identity["fullName"] = h
    return identity


def _get(row: list, index: dict, header: str | None) -> str:
    if not header:
        return ""
    idx = index.get(header)
    if idx is None or idx >= len(row):
        return ""
    return row[idx]


def _employee_name(row: list, index: dict, identity_columns: dict) -> str:
    first = _get(row, index, identity_columns.get("firstName")).strip()
    last = _get(row, index, identity_columns.get("lastName")).strip()
    if first and last:
        return f"{last}, {first}"
    full = _get(row, index, identity_columns.get("fullName")).strip()
    if full:
        return full
    return first or last


# Output header shape - deliberately matches TARGET_FIELDS["benefits_document"]
# names directly (tabular_orchestrator.py), so the normal header-only mapping
# pass downstream maps these 1:1 with high confidence, or a cached profile
# skips mapping entirely on repeat uploads of the same (already-exploded)
# shape.
EXPLODED_HEADERS = [
    "employeeName", "relationship", "employeeSsnRaw", "productLabel",
    "planName", "coverageTier", "employeeMonthlyCost", "employeePerPayCost",
    "employerMonthlyCost", "benefitAmount", "coveredPayrollAmount",
]


def explode(headers: list, data_rows: list, plan_blocks: dict, identity_columns: dict) -> tuple[list, list]:
    """
    plan_blocks: {productLabel: {role: source_header, ...}, ...} - the
    CLASSIFIED grouping (from claude_client.classify_wide_layout, or a
    cached tabular_profile_store profile) - role keys are target-field
    names (employeeMonthlyCost, employeePerPayCost, employerMonthlyCost,
    planName, coverageTier, benefitAmount, coveredPayrollAmount).
    identity_columns: {role: source_header, ...} from detect_identity_columns
    (or a cached profile).

    Returns (EXPLODED_HEADERS, new_rows) - one output row per person per
    plan they show any data for. Dollar fields (employeeMonthlyCost,
    employeePerPayCost, employerMonthlyCost, benefitAmount,
    coveredPayrollAmount) are populated ONLY when Relationship == "Employee"
    - decided with Gregg 2026-09-08: a dependent's row repeats the
    family-level premium rather than showing their own share, so carrying
    dollars on every dependent row would multiply-count it in reconciliation.
    Dependent rows still explode (identity/eligibility only) so the
    existing side-by-side display isn't missing anyone.
    """
    index = {h: i for i, h in enumerate(headers)}
    new_rows = []

    for row in data_rows:
        relationship = _get(row, index, identity_columns.get("relationship")).strip()
        is_subscriber = relationship.lower() == "employee"
        employee_name = _employee_name(row, index, identity_columns)
        ssn = _get(row, index, identity_columns.get("employeeSsnRaw")).strip()

        for product_label, roles in plan_blocks.items():
            values = {role: _get(row, index, header).strip() for role, header in roles.items()}
            if not any(values.values()):
                continue  # this person has nothing in this plan block at all

            def money(role: str) -> str:
                return values.get(role, "") if is_subscriber else ""

            new_rows.append([
                employee_name,
                relationship,
                ssn,
                product_label,
                values.get("planName", ""),
                values.get("coverageTier", ""),
                money("employeeMonthlyCost"),
                money("employeePerPayCost"),
                money("employerMonthlyCost"),
                money("benefitAmount"),
                money("coveredPayrollAmount"),
            ])

    return EXPLODED_HEADERS, new_rows