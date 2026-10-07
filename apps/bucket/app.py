"""
The 'bucket': a web page you drop a proposal PDF onto.

Local dev:
    python app.py
    -> http://127.0.0.1:5000

Production (Railway): gunicorn imports this file and runs the `app`
object directly - see Procfile. debug mode and the __main__ block below
are never used in that path.
"""
import json
import os
import secrets
import threading
import traceback
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

from flask import Flask, jsonify, render_template, request, send_file, Response

from core import jobs
from core.orchestrator import PRODUCT_TYPES, process_pdf
from core.paths import CARRIER_PROFILES_DIR, DATA_DIR, OUTPUT_DIR, UPLOADS_DIR
from core import claude_client, pdf_utils, profile_store, tabular_orchestrator

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024  # 32 MB

DEFAULT_PRODUCT_TYPE = "simple_tiered"

# --- Access control -------------------------------------------------
# Single shared username/password (HTTP Basic Auth), set via env vars.
# This is a password gate for a single-tenant internal tool, not a
# multi-user account system - fine for "keep strangers off my bucket
# page," not a substitute for real auth if this ever needs per-user
# logins. If BUCKET_USERNAME/BUCKET_PASSWORD aren't set (e.g. running
# locally without touching .env), the gate is skipped entirely so local
# dev keeps working exactly as before.
BUCKET_USERNAME = os.environ.get("BUCKET_USERNAME")
BUCKET_PASSWORD = os.environ.get("BUCKET_PASSWORD")


def _auth_ok(auth) -> bool:
    if not auth:
        return False
    user_ok = secrets.compare_digest(auth.username or "", BUCKET_USERNAME)
    pass_ok = secrets.compare_digest(auth.password or "", BUCKET_PASSWORD)
    return user_ok and pass_ok


@app.before_request
def require_auth():
    if not (BUCKET_USERNAME and BUCKET_PASSWORD):
        return  # gate not configured - skip (local dev default)
    auth = request.authorization
    if not _auth_ok(auth):
        return Response(
            "Authentication required.",
            401,
            {"WWW-Authenticate": 'Basic realm="Bucket"'},
        )


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/upload", methods=["POST"])
def upload():
    """
    Kicks off extraction in a background thread and returns immediately
    with a job_id - a Sonnet "discovery" pass on a new carrier can run
    long enough to blow past the IIS/undici timeout chain in front of
    this if done synchronously. Poll /upload/status/<job_id> for progress
    and the final result.
    """
    file = request.files.get("file")
    if not file or not file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Please drop a PDF file."}), 400

    product_type = request.form.get("product_type", DEFAULT_PRODUCT_TYPE)
    if product_type not in PRODUCT_TYPES:
        product_type = DEFAULT_PRODUCT_TYPE

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = UPLOADS_DIR / f"{stamp}_{file.filename}"
    file.save(dest)

    job_id = jobs.create_job()

    def run():
        try:
            result = process_pdf(
                str(dest), product_type, status_cb=lambda line: jobs.append_log(job_id, line)
            )
            jobs.set_done(
                job_id,
                {
                    "data": result["data"],
                    "product_type": product_type,
                    "carrier": result["data"].get("carrier_name"),
                    "group": result["data"].get("group_name"),
                    "plan_count": len(
                        result["data"].get("plans") or result["data"].get("products") or []
                    ),
                    "used_discovery": result["used_discovery"],
                    "warnings": result.get("warnings", []),
                    "download_url": f"/download/{Path(result['xlsx_path']).name}",
                    "pdf_url": f"/uploads/{dest.name}",
                    "xlsx_confirmed_on_disk": result.get("xlsx_confirmed_on_disk"),
                    "xlsx_bytes": result.get("xlsx_bytes"),
                },
            )
        except Exception:
            traceback.print_exc()
            jobs.set_error(job_id, traceback.format_exc().splitlines()[-1])

    threading.Thread(target=run, daemon=True).start()

    return jsonify({"job_id": job_id}), 202


@app.route("/upload/status/<job_id>")
def upload_status(job_id):
    job = jobs.get_job(job_id)
    if job is None:
        return jsonify({"error": "Unknown job_id"}), 404
    return jsonify(job)


@app.route("/download/<path:filename>")
def download(filename):
    path = OUTPUT_DIR / filename
    if not path.exists():
        return "Not found", 404
    return send_file(path, as_attachment=True)
@app.route("/uploads/<path:filename>")
def uploaded_pdf(filename):
    # Serves the original PDF back out - inline (not forced download) so
    # the frontend can open it in a new tab for a quick source-document
    # check against the extracted data.
    path = UPLOADS_DIR / filename
    if not path.exists():
        return "Not found", 404
    return send_file(path, as_attachment=False)
@app.route("/triage", methods=["POST"])
def triage():
    """
    Temporary, throwaway diagnostic route - NOT the real extraction
    pipeline. Classifies a PDF (single vs. multi-product, carrier,
    rate type per product) using a cheap Haiku pass, and separately
    checks the real carrier_profiles/ library (for free, locally) to
    report whether this document would currently match a saved
    profile under EITHER product type. Never writes a profile, never
    creates a Quote - safe to run against a big batch of real
    documents without touching production data.

    Built to catch the known-carrier-matching bug in the act: carrier
    profiles are keyed by (carrier, product_type) only, with no
    benefit-line dimension, so a Medical and Dental proposal from the
    same carrier can silently collide on the same profile file. This
    route surfaces exactly that - which profile file (if any) a
    document matches under each product type, side by side with what
    the document actually looks like.
    """
    file = request.files.get("file")
    if not file or not file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Please drop a PDF file."}), 400

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = UPLOADS_DIR / f"triage_{stamp}_{file.filename}"
    file.save(dest)

    try:
        text = pdf_utils.extract_text(str(dest), max_pages=6)
        profile_matches = {}
        for pt in PRODUCT_TYPES:
            matched = profile_store.match(text, pt)
            profile_matches[pt] = {
                "matched": matched is not None,
                "profile_file": Path(matched["_path"]).name if matched else None,
                "profile_carrier_name": matched.get("carrier_name") if matched else None,
            }
        classification = claude_client.classify_document(str(dest))
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"error": str(exc)}), 500

    return jsonify(
        {
            "filename": file.filename,
            "profile_matches": profile_matches,
            "classification": classification,
            "pdf_url": f"/uploads/{dest.name}",
        }
    )


@app.route("/extract", methods=["POST"])
def extract():
    """
    Classify a dropped PDF, then run one extraction pass per detected
    product (using process_pdf's scope_label to isolate each one) - even
    for single-product documents, so callers get one consistent shape
    (a list of per-product results) instead of two different code paths.

    Runs as a background job, same job store /upload already uses -
    reuses /upload/status/<job_id> to check on it, since the shape
    (processing/done/error + a result) is identical; only the result
    itself differs (a list of products here, vs. one dict from /upload).

    A single product failing to extract does NOT fail the whole job -
    it's recorded as a skipped entry with a reason, so a batch of five
    detected products where four succeed and one doesn't still comes
    back with four usable Quotes instead of losing all five.
    """
    file = request.files.get("file")
    if not file or not file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Please drop a PDF file."}), 400

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = UPLOADS_DIR / f"{stamp}_{file.filename}"
    file.save(dest)

    job_id = jobs.create_job()

    def run():
        try:
            jobs.append_log(job_id, "Classifying document...")
            classification = claude_client.classify_document(str(dest))
            products = classification.get("products") or []
            if not products:
                raise RuntimeError("Classifier found no products in this document.")

            results = []
            for p in products:
                label = p.get("product_label") or "Unknown"
                rate_type = p.get("rate_type")
                rates_present = p.get("rates_present")

                if not rates_present:
                    jobs.append_log(job_id, f"Skipping '{label}' - no rates present.")
                    results.append({
                        "product_label": label, "rate_type": rate_type,
                        "skipped": True, "skip_reason": "No rates present",
                    })
                    continue

                if rate_type not in PRODUCT_TYPES:
                    jobs.append_log(job_id, f"Skipping '{label}' - unsupported rate_type '{rate_type}'.")
                    results.append({
                        "product_label": label, "rate_type": rate_type,
                        "skipped": True,
                        "skip_reason": f"Rate type '{rate_type}' not extractable",
                    })
                    continue

                jobs.append_log(job_id, f"Extracting '{label}' ({rate_type})...")
                try:
                    result = process_pdf(
                        str(dest), rate_type,
                        status_cb=lambda line, label=label: jobs.append_log(job_id, f"[{label}] {line}"),
                        scope_label=label,
                    )
                    results.append({
                        "product_label": label, "rate_type": rate_type,
                        "skipped": False,
                        "download_url": f"/download/{Path(result['xlsx_path']).name}",
                        **result,
                    })
                except Exception as exc:
                    traceback.print_exc()
                    jobs.append_log(job_id, f"Failed extracting '{label}': {exc}")
                    results.append({
                        "product_label": label, "rate_type": rate_type,
                        "skipped": True, "skip_reason": f"Extraction failed: {exc}",
                    })

            jobs.set_done(job_id, {
                "is_multi_product": classification.get("is_multi_product"),
                "carrier": classification.get("carrier_name"),
                "pdf_url": f"/uploads/{dest.name}",
                "products": results,
            })
        except Exception:
            traceback.print_exc()
            jobs.set_error(job_id, traceback.format_exc().splitlines()[-1])

    threading.Thread(target=run, daemon=True).start()

    return jsonify({"job_id": job_id}), 202


@app.route("/extract-tabular", methods=["POST"])
def extract_tabular():
    """
    Census / commission-statement / benefits-document upload. Synchronous
    (not a background job like /upload and /extract) - mapping a handful
    of columns via Haiku (or, for a commission-statement PDF, a single
    Claude extraction call) is a short operation, nowhere near the
    multi-minute budget PDF *discovery* extraction needs for quotes.

    Two different compliance postures depending on upload_kind:

      commission_statement (PDF allowed): carries no employee-level data,
      so a PDF goes straight to Claude as a whole document
      (claude_client.extract_commission_statement_pdf) - same posture as
      quote extraction.

      census (spreadsheet-only, unchanged) and benefits_document (PDF
      allowed as of this change): both can carry employee-level PHI, so a
      PDF here never goes to Claude as a raw document. Instead
      pdf_table_extractor.py locally parses the PDF into plain
      rows/columns with no Claude call, and tabular_orchestrator.extract()
      runs the exact same header-only / de-identified-sample pipeline on
      those rows that it already runs for an uploaded CSV/XLSX.
    """
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "Please attach a file."}), 400

    upload_kind = request.form.get("upload_kind")
    if upload_kind not in tabular_orchestrator.TARGET_FIELDS:
        return jsonify({"error": "upload_kind must be 'census', 'commission_statement', or 'benefits_document'."}), 400

    is_pdf = file.filename.lower().endswith(".pdf")

    if is_pdf and upload_kind not in ("commission_statement", "benefits_document"):
        return jsonify({"error": "PDF uploads are only supported for commission statements and benefits documents, not census."}), 400

    if not is_pdf and not file.filename.lower().endswith((".xlsx", ".csv")):
        return jsonify({"error": "Only .xlsx, .csv, or (for commission statements and benefits documents) .pdf files are supported."}), 400

    if is_pdf and upload_kind == "commission_statement":
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        dest = UPLOADS_DIR / f"{stamp}_{file.filename}"
        file.save(dest)
        try:
            result = claude_client.extract_commission_statement_pdf(str(dest))
        except Exception:
            traceback.print_exc()
            return jsonify({"error": "Failed to process the uploaded PDF."}), 500

        if result["confidence"] < 0.75 or not result["entries"]:
            return jsonify({
                "error": (
                    "Couldn't confidently read this statement. Please double-check "
                    "it, then either re-upload as CSV/Excel or enter the figures "
                    "manually."
                )
            }), 422

        # Fixed response-shape bug: Node's commissionStatements.ts reads
        # bucketJson.rows / bucketJson.needs_review (snake_case), not
        # entries / needsReview - this previously returned the wrong keys.
        # See accounting-bucket-pdf-support.md Section 4, "KNOWN, UNFIXED
        # BUG." Flagged separately in chat since it's outside this task's
        # scope but sits in the exact block being edited here.
        return jsonify({"rows": result["entries"], "needs_review": False})

    # Both benefits_document PDFs and every non-PDF upload (any
    # upload_kind) go through the same orchestrator path.
    try:
        result = tabular_orchestrator.extract(file.read(), file.filename, upload_kind)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception:
        traceback.print_exc()
        return jsonify({"error": "Failed to process the uploaded file."}), 500

    return jsonify(result)


@app.route("/extract-tabular/confirm", methods=["POST"])
def extract_tabular_confirm():
    """
    Applies a human-corrected column mapping (sent after a low-confidence
    /extract-tabular response) and saves it as the new known profile for
    this exact header layout.
    """
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "Please attach the original file again."}), 400

    upload_kind = request.form.get("upload_kind")
    if upload_kind not in tabular_orchestrator.TARGET_FIELDS:
        return jsonify({"error": "upload_kind must be 'census', 'commission_statement', or 'benefits_document'."}), 400

    mapping_json = request.form.get("mapping")
    if not mapping_json:
        return jsonify({"error": "mapping is required."}), 400
    mapping = json.loads(mapping_json)

    try:
        headers, data_rows = tabular_orchestrator._read_rows(file.read(), file.filename)
        rows = tabular_orchestrator.confirm_mapping(upload_kind, headers, mapping, data_rows, file.filename)
    except Exception:
        traceback.print_exc()
        return jsonify({"error": "Failed to apply the corrected mapping."}), 500

    return jsonify({"mapping_source": "confirmed", "mapping": mapping, "needs_review": False, "rows": rows})


@app.route("/debug/storage")
def debug_storage():
    """
    Temporary diagnostic route: shows exactly what this running process
    thinks its storage paths are, and what's actually sitting in them.
    Safe to leave in - it's behind the same auth gate as everything else
    and only reports filenames, never file contents or secrets. Exists
    to answer 'the file was built but downloading it 404s' without
    fighting the Railway CLI/SSH for volume access.
    """

    def listing(d):
        try:
            return sorted(p.name for p in d.iterdir())
        except Exception as exc:
            return [f"<error listing {d}: {exc}>"]

    return jsonify(
        {
            "DATA_DIR_env_raw": os.environ.get("DATA_DIR"),
            "DATA_DIR_resolved": str(DATA_DIR),
            "OUTPUT_DIR": str(OUTPUT_DIR),
            "OUTPUT_DIR_exists": OUTPUT_DIR.exists(),
            "output_files": listing(OUTPUT_DIR),
            "UPLOADS_DIR": str(UPLOADS_DIR),
            "upload_files": listing(UPLOADS_DIR),
            "CARRIER_PROFILES_DIR": str(CARRIER_PROFILES_DIR),
            "profile_files": listing(CARRIER_PROFILES_DIR),
        }
    )


if __name__ == "__main__":
    # Local dev only. In production, gunicorn runs this module without
    # ever hitting this block (see Procfile) - Flask's own dev server
    # explicitly isn't meant to serve real traffic.
    app.run(debug=True, port=5000)
