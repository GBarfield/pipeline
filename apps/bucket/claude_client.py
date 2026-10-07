# Destination: apps/bucket/core/claude_client.py  (full-file replacement,
# up through discover_and_extract - append your existing triage addition,
# classify_document() etc. from earlier in this project after this)
"""
Talks to the Anthropic API. This is the only file in the project that
costs money to run.

Three product types are supported, each with its own extraction schema:

  simple_tiered
      Medical / dental / vision - a named plan with a flat monthly rate
      per enrollment tier (Employee, +Spouse, +Child(ren), Family) and
      cost-share text per benefit.

  age_banded
      Life / AD&D / Critical Illness - a product with one or more
      coverage classes (Employee, Spouse, Child), each either a flat
      rate or a full age-band x coverage-amount rate grid.

  flat_rate_per_unit
      Basic Life / AD&D (per $1,000 of coverage), LTD / STD (per $100 of
      covered monthly payroll/salary) - a product priced as a single
      flat rate per unit of a basis amount, not broken out by enrollment
      tier and not varying by age.

For each product type there are two call patterns:

  extract_known(pdf_path, profile, product_type, scope_label=None)
      Cheap path. Used when profile_store.match() already found a
      carrier profile for this document (scoped to this product type,
      and to a benefit line if scope_label is given). Sends the PDF plus
      that carrier's pre-tuned extraction notes as a CACHED system block
      (cache_control), so repeat runs for the same carrier only pay full
      input price for the small instruction block once per cache window,
      not on every upload. Uses Haiku.

  discover_and_extract(pdf_path, product_type, scope_label=None)
      Used the first time a carrier/product-type (/benefit-line)
      combination is seen. Sends the PDF with a more general prompt
      asking Claude to both extract the data AND write a reusable
      profile (fingerprint + extraction notes) for next time. Uses
      Sonnet.

scope_label, when given, restricts extraction to just one product within
a multi-product document (e.g. "LTD" out of a PDF that also has Medical,
Dental, and Basic Life) - used when a document is being processed as
several independent per-product calls rather than one call trying to
pull everything out at once. In extract_known, the scope instruction is
deliberately kept OUT of the cached system block: it changes on every
call (different product each time) while the carrier's extraction_notes
don't, so keeping them separate means repeat calls to the same carrier
still hit the cache even as scope_label varies across products in the
same document.

Both extraction paths return structured data via forced tool calls, not
free-text JSON parsing, so the output shape is guaranteed rather than
hoped-for.

Both also run as streaming requests (client.messages.stream(...)) even
though the app only cares about the final assembled message, not the
incremental chunks. This isn't optional: with MAX_OUTPUT_TOKENS set high
enough to cover a large proposal, the Anthropic SDK refuses a plain
blocking .create() call, since a response that big could in theory take
longer than its default request timeout - streaming keeps the
connection open safely for however long generation actually takes.
"""
import os

from anthropic import Anthropic

from . import pdf_utils

CHEAP_MODEL = "claude-haiku-4-5-20251001"
DISCOVERY_MODEL = "claude-sonnet-5"

# A large proposal (15-20+ plans, each with ~25 benefit line items, or
# 90+ rate-grid rows for a life product) can need well over 10k output
# tokens to describe in full. There's no cost downside to setting this
# high - you're only billed for tokens actually generated, not the cap
# - so it's set generously to avoid silent truncation on big documents.
MAX_OUTPUT_TOKENS = 48000

# Shared reminder injected into every extraction call. First real-world
# test (Angle Health / Baker Farms, 19 plans) came back with 4 benefit
# rows populated for only 2 of the 19 plans, even though the source PDF
# has that data on every plan's detail page - the model was implicitly
# treating similar-looking plans as "already covered." This line exists
# specifically to counter that, and applies equally to plans, coverage
# classes, and age-band rows.
COMPLETENESS_REMINDER = (
    "IMPORTANT: Every plan, product, or coverage class in this document "
    "gets its own complete set of entries, even if several look similar "
    "to each other or share values. Do not skip a row for one item just "
    "because you already recorded a similar-looking row for a different "
    "item - re-read and re-record it. If a rate table has N rows or "
    "columns, extract all N, not a representative subset."
)

_client = None


def _get_client() -> Anthropic:
    global _client
    if _client is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY is not set. Copy .env.example to .env, "
                "add your key, and restart the app."
            )
        _client = Anthropic(api_key=api_key)
    return _client


# ---------------------------------------------------------------------
# simple_tiered schema: medical / dental / vision
# ---------------------------------------------------------------------

QUOTE_DATA_TOOL = {
    "name": "record_quote_data",
    "description": (
        "Record every plan found in this insurance benefits proposal/quote, "
        "normalized into a single consistent structure regardless of carrier. "
        "Every plan must be extracted with the same level of completeness - "
        "do not summarize or abbreviate later plans just because earlier ones "
        "looked similar."
    ),
    "input_schema": {
        "type": "object",
        "required": ["carrier_name", "group_name", "plans"],
        "properties": {
            "carrier_name": {"type": "string", "description": "The insurance carrier/company that issued this proposal."},
            "group_name": {"type": "string", "description": "The employer/group the quote was prepared for."},
            "quote_id": {"type": "string"},
            "effective_date": {"type": "string", "description": "YYYY-MM-DD if determinable."},
            "plans": {
                "type": "array",
                "description": (
                    "One entry per plan, in the same order they appear in the document. "
                    "Every plan should have a similarly complete 'benefits' object - if plan "
                    "1 has 18 benefit entries, plan 12 should also have close to 18, not 4."
                ),
                "items": {
                    "type": "object",
                    "required": ["plan_name", "rates"],
                    "properties": {
                        "plan_name": {"type": "string"},
                        "plan_id": {"type": "string"},
                        "rates": {
                            "type": "object",
                            "description": "Monthly premium by enrollment tier. Omit tiers not offered by this plan.",
                            "properties": {
                                "employee_only": {"type": "number"},
                                "employee_spouse": {"type": "number"},
                                "employee_children": {"type": "number"},
                                "family": {"type": "number"},
                            },
                        },
                        "deductible_individual": {"type": "number"},
                        "deductible_family": {"type": "number"},
                        "oop_max_individual": {"type": "number"},
                        "oop_max_family": {"type": "number"},
                        "deductible_embedded": {"type": "boolean"},
                        "actuarial_value": {"type": "number"},
                        "benefits": {
                            "type": "object",
                            "description": (
                                "Map of benefit/service name (e.g. 'Primary Care (Office)', "
                                "'Emergency Room', 'Tier 1 - Generic Rx') to a short plain-text "
                                "description of the member's in-network cost share, e.g. "
                                "'$25 copay, not subject to deductible' or '20% coinsurance after deductible'. "
                                "Keep each value brief - a few words, not a sentence - to control output "
                                "length, but do NOT drop entire benefit rows to save space. Every plan "
                                "should list the same benefit categories as the others in this document. "
                                "Leave empty if this document genuinely doesn't disclose per-benefit detail "
                                "(e.g. a compact rate grid) - do not invent values."
                            ),
                            "additionalProperties": {"type": "string"},
                        },
                        "out_of_network": {
                            "type": "object",
                            "description": "Out-of-network deductible/OOP max/coinsurance figures as brief plain text, keyed by label.",
                            "additionalProperties": {"type": "string"},
                        },
                    },
                },
            },
        },
    },
}

# ---------------------------------------------------------------------
# age_banded schema: life / AD&D / critical illness
# ---------------------------------------------------------------------

AGE_BANDED_DATA_TOOL = {
    "name": "record_age_banded_data",
    "description": (
        "Record every product found in this age-banded insurance proposal "
        "(e.g. Supplemental Life, AD&D, Critical Illness), including every "
        "coverage class and its full rate grid. Extract with total completeness "
        "- every age band row and every coverage-amount column, for every class."
    ),
    "input_schema": {
        "type": "object",
        "required": ["carrier_name", "group_name", "products"],
        "properties": {
            "carrier_name": {"type": "string"},
            "group_name": {"type": "string"},
            "quote_id": {"type": "string"},
            "effective_date": {"type": "string"},
            "products": {
                "type": "array",
                "description": "One entry per product (e.g. 'Supplemental Term Life', 'Voluntary AD&D', 'Critical Illness').",
                "items": {
                    "type": "object",
                    "required": ["product_name", "coverage_classes"],
                    "properties": {
                        "product_name": {"type": "string"},
                        "coverage_classes": {
                            "type": "array",
                            "description": (
                                "One entry per covered relationship (Employee, Spouse, Child, etc). "
                                "Extract EVERY class the document defines, with its complete rate grid - "
                                "do not summarize, truncate, or skip any age band or coverage amount."
                            ),
                            "items": {
                                "type": "object",
                                "required": ["class_name", "rate_structure"],
                                "properties": {
                                    "class_name": {"type": "string", "description": "e.g. 'Employee', 'Spouse', 'Child'."},
                                    "increment": {"type": "string", "description": "Purchase increment as written, e.g. 'Increments of $10,000'."},
                                    "non_medical_max": {"type": "string", "description": "Guarantee-issue / non-medical maximum, as written."},
                                    "overall_benefit_max": {"type": "string", "description": "Overall benefit maximum, as written (may reference salary multiples)."},
                                    "add_included": {"type": "boolean", "description": "Whether AD&D coverage is bundled at the same amount as the life benefit."},
                                    "employee_contribution_pct": {"type": "string", "description": "e.g. '100%'."},
                                    "rate_structure": {
                                        "type": "string",
                                        "enum": ["age_banded", "flat"],
                                        "description": "'age_banded' if premium varies by age (fill age_bands). 'flat' if there is one premium regardless of age (fill flat_amount/flat_rate).",
                                    },
                                    "flat_amount": {"type": "string", "description": "Only for rate_structure='flat': the fixed coverage amount, e.g. '$10,000'."},
                                    "flat_rate": {"type": "number", "description": "Only for rate_structure='flat': the fixed monthly premium."},
                                    "age_bands": {
                                        "type": "array",
                                        "description": "Only for rate_structure='age_banded'. One entry per age-band row in the rate table, in the printed order.",
                                        "items": {
                                            "type": "object",
                                            "required": ["label", "rates_by_amount"],
                                            "properties": {
                                                "label": {"type": "string", "description": "e.g. 'Under 30', '30-34', '70+', exactly as printed."},
                                                "rates_by_amount": {
                                                    "type": "object",
                                                    "description": (
                                                        "Coverage amount as printed (e.g. '10000') -> monthly premium for "
                                                        "that amount at this age band. Include EVERY coverage-amount column "
                                                        "from the table for every age band, not just a subset."
                                                    ),
                                                    "additionalProperties": {"type": "number"},
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
}

# ---------------------------------------------------------------------
# flat_rate_per_unit schema: Basic Life / AD&D / LTD / STD
# ---------------------------------------------------------------------

FLAT_RATE_DATA_TOOL = {
    "name": "record_flat_rate_data",
    "description": (
        "Record every product priced as a single flat rate per unit of a "
        "basis amount - e.g. Basic Life or AD&D priced per $1,000 of "
        "coverage, or LTD/STD priced per $100 of covered monthly payroll "
        "or salary. Not for per-enrollment-tier pricing (use simple_tiered) "
        "or pricing that varies by age (use age_banded)."
    ),
    "input_schema": {
        "type": "object",
        "required": ["carrier_name", "group_name", "products"],
        "properties": {
            "carrier_name": {"type": "string"},
            "group_name": {"type": "string"},
            "quote_id": {"type": "string"},
            "effective_date": {"type": "string"},
            "products": {
                "type": "array",
                "description": "One entry per product (e.g. 'Basic Life', 'Basic AD&D', 'LTD', 'STD').",
                "items": {
                    "type": "object",
                    "required": ["product_name", "basis", "rate_per_unit"],
                    "properties": {
                        "product_name": {"type": "string"},
                        "basis": {
                            "type": "string",
                            "description": "What the rate applies per, exactly as written, e.g. 'per $1,000 of coverage' or 'per $100 of covered monthly payroll/salary'.",
                        },
                        "rate_per_unit": {"type": "number", "description": "The flat dollar rate per unit of basis."},
                        "benefit_amount_formula": {
                            "type": "string",
                            "description": "How the coverage amount is determined, as written, e.g. 'Flat $50,000' or '60% of monthly salary to a $10,000 max'.",
                        },
                        "guarantee_issue_max": {"type": "string", "description": "Guarantee-issue / non-medical maximum, as written, if any."},
                        "employee_contribution_pct": {"type": "string", "description": "e.g. '100%' for employer-paid."},
                        "elimination_period": {"type": "string", "description": "LTD/STD only: elimination/waiting period, as written."},
                        "benefit_duration": {"type": "string", "description": "LTD/STD only: max benefit duration, as written, e.g. 'to age 65'."},
                    },
                },
            },
        },
    },
}

# Reused for all three product types - a fingerprint + a plain-English
# description of the layout is a generic enough shape to cover any of
# them.
CARRIER_PROFILE_TOOL = {
    "name": "record_new_carrier_profile",
    "description": (
        "Record a reusable profile for this carrier so future documents from "
        "them (of this same product type) can be processed on the cheap, "
        "no-discovery-needed path."
    ),
    "input_schema": {
        "type": "object",
        "required": ["carrier_name", "fingerprint", "extraction_notes"],
        "properties": {
            "carrier_name": {"type": "string"},
            "fingerprint": {
                "type": "object",
                "description": "Text snippets that reliably identify this carrier's documents.",
                "properties": {
                    "must_contain": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "Strings that must ALL appear (case-insensitive, exact substring match) "
                            "for a future document to match this profile - keep this list SHORT (1-2 "
                            "items) and stick to things you are certain are quoted verbatim from the "
                            "document, like the carrier's legal name or email domain. A single wrong "
                            "or paraphrased entry here blocks the match entirely, even if everything "
                            "else is correct - do NOT include generic boilerplate you're inferring "
                            "from memory (e.g. a guessed cover-page title like 'Group Insurance "
                            "Proposal') unless you can see that exact wording on the page."
                        ),
                    },
                    "any_of": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "Strings where at least one must appear - safer to be generous here than "
                            "in must_contain, since only one needs to hit. Put anything you're less "
                            "than fully certain is verbatim here instead of in must_contain, e.g. this "
                            "product's naming convention, a quote/proposal ID number, or a website."
                        ),
                    },
                },
            },
            "extraction_notes": {
                "type": "string",
                "description": (
                    "A description, in your own words, of how this document is laid out: "
                    "where the rate table(s) are, how coverage classes or plans are structured, "
                    "what labels are used, any quirks (missing tiers/bands, non-standard labels, "
                    "multi-page tables). Explicitly note the total count of plans/products/classes "
                    "so a future reader can confirm nothing was skipped. This gets reused as an "
                    "instruction for a cheaper model on future documents from this carrier, so be "
                    "specific and complete."
                ),
            },
        },
    },
}


def _pdf_content_block(pdf_path: str) -> dict:
    return {
        "type": "document",
        "source": {
            "type": "base64",
            "media_type": "application/pdf",
            "data": pdf_utils.pdf_to_base64(pdf_path),
        },
    }


def _extract_tool_input(message, tool_name: str):
    for block in message.content:
        if getattr(block, "type", None) == "tool_use" and block.name == tool_name:
            return block.input
    return None


def _check_truncated(message, where: str):
    """
    If Claude hit the token cap mid-response, the tool call may be
    incomplete or missing entirely. Fail loudly and specifically instead
    of quietly returning something that looks like 'no data found'.
    """
    if getattr(message, "stop_reason", None) == "max_tokens":
        raise RuntimeError(
            f"Claude's response was cut off by the token limit during {where}. "
            f"Raise MAX_OUTPUT_TOKENS in core/claude_client.py (currently "
            f"{MAX_OUTPUT_TOKENS}) and try again."
        )


def _stream_to_message(client, **kwargs):
    """
    Run a messages.create()-equivalent call as a stream and return the
    fully-assembled final Message, so the rest of the code can treat it
    exactly like a normal (non-streaming) response.
    """
    with client.messages.stream(**kwargs) as stream:
        return stream.get_final_message()


def _data_tool_for(product_type: str) -> dict:
    if product_type == "age_banded":
        return AGE_BANDED_DATA_TOOL
    if product_type == "flat_rate_per_unit":
        return FLAT_RATE_DATA_TOOL
    if product_type == "simple_tiered":
        return QUOTE_DATA_TOOL
    raise ValueError(f"Unknown product_type: {product_type!r}")


def _scope_instruction(scope_label: str) -> str:
    return (
        f"This document contains multiple products - only extract the "
        f"'{scope_label}' product. Ignore every other product present; "
        "do not include them in your response."
    )


def extract_known(pdf_path: str, profile: dict, product_type: str, scope_label: str = None) -> dict:
    """Cheap path: known carrier+product-type, pre-tuned instructions, Haiku, cached system prompt."""
    client = _get_client()
    data_tool = _data_tool_for(product_type)
    cached_prompt = (
        "You extract structured data from insurance benefits proposals/quotes. "
        f"This document is from {profile.get('carrier_name', 'a known carrier')}. "
        "Here is what a previous read of this carrier's documents learned about "
        "their layout — use it to extract quickly and accurately:\n\n"
        f"{profile.get('extraction_notes', '')}\n\n"
        f"{COMPLETENESS_REMINDER}\n\n"
        f"Call {data_tool['name']} with everything in the document. Do not skip "
        "any item or column present in the source."
    )
    # scope_label is deliberately kept OUT of the cached block - it changes
    # per product on a multi-product document, while extraction_notes don't,
    # so splitting them keeps the cache hit rate intact across products.
    system_blocks = [{"type": "text", "text": cached_prompt, "cache_control": {"type": "ephemeral"}}]
    if scope_label:
        system_blocks.append({"type": "text", "text": _scope_instruction(scope_label)})

    message = _stream_to_message(
        client,
        model=CHEAP_MODEL,
        max_tokens=MAX_OUTPUT_TOKENS,
        system=system_blocks,
        tools=[data_tool],
        tool_choice={"type": "tool", "name": data_tool["name"]},
        messages=[{"role": "user", "content": [_pdf_content_block(pdf_path)]}],
    )
    _check_truncated(message, "known-carrier extraction")
    data = _extract_tool_input(message, data_tool["name"])
    if data is None:
        raise RuntimeError(
            f"Claude did not return structured data on the known-carrier path "
            f"(stop_reason={getattr(message, 'stop_reason', '?')})."
        )
    return data


def discover_and_extract(pdf_path: str, product_type: str, scope_label: str = None):
    """Unknown carrier+product-type: extract data AND write a reusable profile. Sonnet."""
    client = _get_client()
    data_tool = _data_tool_for(product_type)
    scope_note = f"{_scope_instruction(scope_label)}\n\n" if scope_label else ""
    system_prompt = (
        "You extract structured data from insurance benefits proposals/quotes, "
        "and you are seeing a carrier/document you have not processed before. Do two things:\n"
        f"1. Call {data_tool['name']} with everything in the document, normalized into "
        "the standard schema, regardless of what this carrier calls things.\n"
        "2. Call record_new_carrier_profile with a fingerprint (unique strings that "
        "will reliably identify future documents from this same carrier and product "
        "type) and extraction_notes describing this document's layout in enough detail "
        "that a cheaper model could extract from a similar document next time without "
        "re-figuring-out the format.\n\n"
        f"{scope_note}"
        f"{COMPLETENESS_REMINDER}\n\n"
        "Call both tools in this response. Keep text values brief, but complete."
    )
    message = _stream_to_message(
        client,
        model=DISCOVERY_MODEL,
        max_tokens=MAX_OUTPUT_TOKENS,
        system=system_prompt,
        tools=[data_tool, CARRIER_PROFILE_TOOL],
        tool_choice={"type": "any"},
        messages=[{"role": "user", "content": [_pdf_content_block(pdf_path)]}],
    )
    _check_truncated(message, "discovery extraction")
    data = _extract_tool_input(message, data_tool["name"])
    profile = _extract_tool_input(message, "record_new_carrier_profile")
    if data is None:
        raise RuntimeError(
            f"Claude did not return structured data on the discovery path "
            f"(stop_reason={getattr(message, 'stop_reason', '?')})."
        )
    return data, profile


# ---------------------------------------------------------------------
# Triage: a fast, cheap classification pass - NOT part of the real
# extraction pipeline. Never writes a carrier profile, never produces
# data meant to become a real Quote. Used both by the standalone /triage
# diagnostic route and as the first step of /extract's classify-then-
# extract-per-product flow.
# ---------------------------------------------------------------------

TRIAGE_MODEL = CHEAP_MODEL
# Output here is a handful of short fields, not a full extraction - no
# need for the generous 48000 cap used elsewhere.
TRIAGE_MAX_OUTPUT_TOKENS = 2000

DOCUMENT_TRIAGE_TOOL = {
    "name": "record_document_triage",
    "description": (
        "Classify this insurance proposal document at a high level, without doing "
        "a full data extraction. This is a fast, cheap triage pass used to figure "
        "out what kind of document this is before deciding how to process it."
    ),
    "input_schema": {
        "type": "object",
        "required": ["is_multi_product", "carrier_name", "products"],
        "properties": {
            "is_multi_product": {
                "type": "boolean",
                "description": (
                    "True if this single document contains distinct rate/benefit "
                    "information for more than one insurance product (e.g. Medical "
                    "AND Dental in the same PDF). False if it's just one product. "
                    "Note: Basic Life and Basic AD&D are almost always sold and "
                    "priced together as a single bundled benefit - if a document "
                    "shows Basic Life and Basic AD&D together, treat that as ONE "
                    "product, not two, even though they are technically two "
                    "coverage types."
                ),
            },
            "carrier_name": {
                "type": "string",
                "description": "The insurance carrier/company that issued this proposal, as best you can tell.",
            },
            "products": {
                "type": "array",
                "description": "One entry per distinct product found (just one entry if is_multi_product is false).",
                "items": {
                    "type": "object",
                    "required": ["product_label", "rates_present", "rate_type"],
                    "properties": {
                        "product_label": {
                            "type": "string",
                            "enum": [
                                "Medical", "Dental", "Vision",
                                "Basic Life and AD&D", "Voluntary Life and AD&D",
                                "STD", "LTD", "Critical Illness",
                                "Hospital Indemnity", "Accident",
                                "Other", "Unclear",
                            ],
                            "description": (
                                "The benefit line, chosen from this fixed list - not free text. "
                                "This is used as a stable key to recognize the SAME product across "
                                "repeat runs of the SAME document, so consistent wording matters more "
                                "than precision. Basic Life and Basic AD&D are almost always bundled "
                                "and priced together - use 'Basic Life and AD&D' for that combination, "
                                "not two separate entries; same for 'Voluntary Life and AD&D'. Use "
                                "'Other' for a real benefit line that doesn't fit this list (describe "
                                "it in product_label_detail) and 'Unclear' only if you genuinely can't "
                                "tell what this product is."
                            ),
                        },
                        "product_label_detail": {
                            "type": "string",
                            "description": (
                                "Optional free-text detail alongside product_label - e.g. the "
                                "document's own section heading, or clarification when product_label "
                                "is 'Other'. Never used for matching, only for display."
                            ),
                        },
                        "rates_present": {
                            "type": "boolean",
                            "description": (
                                "True if this product's section actually contains dollar rate/"
                                "premium figures, not just a benefit summary with no pricing."
                            ),
                        },
                        "rate_type": {
                            "type": "string",
                            "enum": ["simple_tiered", "age_banded", "flat_rate_per_unit", "not_applicable", "unclear"],
                            "description": (
                                "'simple_tiered' if pricing is a flat monthly rate per enrollment "
                                "tier (EE / +Spouse / +Child(ren) / Family) - typical of Medical/"
                                "Dental/Vision. 'age_banded' if pricing varies by age band and/or a "
                                "coverage-amount grid - typical of Voluntary/Supplemental Life, "
                                "AD&D, and Critical Illness. 'flat_rate_per_unit' if pricing is a "
                                "single flat rate per unit of coverage rather than a tiered or "
                                "age-banded table - this covers Basic Life/AD&D (rate per $1,000 "
                                "of coverage) and LTD/STD (rate per $100 of covered monthly "
                                "payroll or salary). 'not_applicable' if rates_present is false - "
                                "there's no pricing to classify. 'unclear' if rates ARE present but "
                                "you genuinely can't tell which structure applies."
                            ),
                        },
                    },
                },
            },
            "notes": {
                "type": "string",
                "description": (
                    "Anything else worth flagging for a human reviewer - ambiguity, an unusual "
                    "layout, more than one carrier in one document, illegible sections, etc. "
                    "Leave blank if there's nothing notable."
                ),
            },
        },
    },
}


def classify_document(pdf_path: str) -> dict:
    """
    Triage-only pass: cheap, fast, and deliberately NOT part of the real
    extraction pipeline - never writes a carrier profile, never touches
    Quote data. Returns the record_document_triage tool input as-is.
    """
    client = _get_client()
    system_prompt = (
        "You are doing a quick first-pass triage of an insurance benefits proposal "
        "document, not a full extraction. Look at the whole document before answering - "
        "a multi-product proposal often has each product on separate pages. Basic Life "
        "and Basic AD&D are almost always bundled as a single product with one combined "
        "rate, even when both are technically listed - do not split them into two "
        "products. Basic Life/AD&D and LTD/STD are typically priced as a flat rate per "
        "unit (per $1,000 of coverage, or per $100 of covered monthly payroll/salary), "
        "not age-banded - use 'flat_rate_per_unit' for those, and reserve 'age_banded' "
        "for products like Voluntary/Supplemental Life, AD&D, and Critical Illness where "
        "the rate table actually varies by age. If a product's section has no dollar "
        "rate figures at all, set rates_present to false and rate_type to "
        "'not_applicable'. "
        f"Call {DOCUMENT_TRIAGE_TOOL['name']} with your assessment."
    )
    message = _stream_to_message(
        client,
        model=TRIAGE_MODEL,
        max_tokens=TRIAGE_MAX_OUTPUT_TOKENS,
        system=system_prompt,
        tools=[DOCUMENT_TRIAGE_TOOL],
        tool_choice={"type": "tool", "name": DOCUMENT_TRIAGE_TOOL["name"]},
        messages=[{"role": "user", "content": [_pdf_content_block(pdf_path)]}],
    )
    _check_truncated(message, "document triage")
    data = _extract_tool_input(message, DOCUMENT_TRIAGE_TOOL["name"])
    if data is None:
        raise RuntimeError(
            f"Claude did not return triage data (stop_reason={getattr(message, 'stop_reason', '?')})."
        )
    return data