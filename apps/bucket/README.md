# BenAdmin Quote Parser

A local web page with a drop bucket for insurance benefits proposals (PDF).
Drop one in, get a plan-comparison spreadsheet out. Known carriers are
processed cheaply; new carriers get figured out once and remembered, so
this is meant to grow into the "library" the rest of the BenAdmin
pipeline (quoting pages, etc.) can draw on.

## How it decides what to do

1. **Fingerprint the PDF locally** — free, no API call. Checks the first
   few pages of text against every saved profile in `carrier_profiles/`.
2. **Known carrier** — a cheap Claude Haiku call, using that carrier's
   saved `extraction_notes` as a cached instruction block, pulls the
   structured data straight out of the PDF.
3. **Unknown carrier (or a known-carrier extraction that fails a sanity
   check)** — a Claude Sonnet call reads the document, extracts the
   data, *and* writes a new carrier profile (fingerprint + layout notes)
   that gets saved for next time. Every carrier only pays the expensive
   path once.
4. The extracted data is validated, saved as JSON (for future automation
   to consume directly), and turned into an `.xlsx` comparison — benefits
   down the left, one column per plan, same layout as a hand-built
   comparison.

## Setup

1. Get everything into the right folders — run this once from the folder
   where you saved all the `bqp__*` files:

   ```
   python bqp__setup_layout.py
   ```

   This creates `core/`, `templates/`, `carrier_profiles/`, `uploads/`,
   and `output/`, and moves each file into place.

2. Install dependencies:

   ```
   pip install -r requirements.txt
   ```

3. Add your API key:

   ```
   cp .env.example .env
   ```

   then paste your key into `.env` as `ANTHROPIC_API_KEY=sk-ant-...`.

4. Run it:

   ```
   python app.py
   ```

   Open `http://127.0.0.1:5000` and drop a PDF on it.

## Cost

Claude Haiku 4.5 is $1 / $5 per million input/output tokens. A typical
20-30 page proposal is roughly 15-25k tokens, so a known-carrier run
costs a few cents, and repeat runs for the same carrier cost less than
that again because the layout instructions are cached. Discovery runs
(new carrier, Sonnet) cost more — figure tens of cents — but only happen
once per carrier, ever, unless their format changes.

## What's already seeded

`carrier_profiles/angle_health.json` is pre-built from the Baker Farms /
Angle Health proposal already worked through in chat, so the very first
real Angle Health PDF you drop on this will already hit the cheap path.

## Known limitations / where to extend next

- **Progress is not live-streamed.** The status log returns all at once
  when processing finishes, not incrementally. Real-time updates would
  need Server-Sent Events or a websocket — a reasonable next step if
  processing time becomes noticeable.
- **Discovery calls aren't guaranteed to save a profile.** The Sonnet
  call is instructed to call both tools (extract data + write profile),
  but isn't forced to. If a discovery run doesn't produce a profile, the
  carrier just goes through discovery again next time — costs a bit more,
  doesn't break anything. Worth tightening if a particular carrier keeps
  missing its profile.
- **Validation is minimal** (checks that plans exist and have numeric
  rates). Worth adding more carrier-specific sanity checks as edge cases
  show up — e.g., expected tier count, plan count matching a rate-summary
  table if the carrier has one.
- **No auth, no multi-user support.** This is a personal local tool. If
  this becomes something other people on the team use, it'll need a
  login and probably a real database instead of flat JSON files.
- **The "library" is just a folder of JSON files right now.** That's
  intentional — it's easy for any other script or agent to read directly.
  If it needs to be queried/searched at scale later, that's the point to
  move it into a real database.

## Project layout (after running the setup script)

```
app.py                  Flask app: the page + upload endpoint
templates/index.html    The drop bucket page
core/
  pdf_utils.py           Local, free PDF text extraction + base64 encoding
  profile_store.py       Load/save/match carrier profiles (no API calls)
  claude_client.py       All Anthropic API calls live here
  orchestrator.py        Ties it together: fingerprint -> extract -> validate -> save
  xlsx_builder.py        Normalized JSON -> comparison workbook
carrier_profiles/        One JSON file per known carrier (the "library")
uploads/                 Dropped PDFs land here temporarily
output/                  Generated .xlsx + .json land here
```
