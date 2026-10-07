"""
Local, free PDF helpers. Nothing in this file calls the Anthropic API —
it's used to fingerprint a document (which carrier is this?) before
deciding whether we can use the cheap known-carrier path or need to
fall back to Claude for discovery.
"""
import base64
from pathlib import Path

import pdfplumber


def extract_text(pdf_path: str, max_pages: int = 6) -> str:
    """
    Pull plain text from the first `max_pages` pages of a PDF.

    A handful of pages is enough to fingerprint a carrier reliably —
    their name, email domain, and quote-header formatting usually show
    up on page 1-3 — so this is capped to keep it fast even on long
    proposals.
    """
    text_chunks = []
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages):
            if i >= max_pages:
                break
            text_chunks.append(page.extract_text() or "")
    return "\n".join(text_chunks)


def pdf_to_base64(pdf_path: str) -> str:
    """Read a PDF and return its base64-encoded bytes, for sending to Claude."""
    data = Path(pdf_path).read_bytes()
    return base64.standard_b64encode(data).decode("utf-8")
