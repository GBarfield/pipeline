# Destination: apps/bucket/core/jobs.py  (NEW FILE)
#
# In-memory background-job tracking for long-running PDF extractions.
#
# Deliberately simple: a single dict guarded by a lock, no persistence, no
# external queue (Celery/RQ/Redis) - this is a single-process, single-
# tenant internal tool, and Waitress runs it as one process. A job's
# status is lost if the Bucket service restarts mid-extraction; the
# frontend surfaces that as "please re-upload" rather than hanging
# forever. That's an acceptable tradeoff for the scale this runs at.

import threading
import uuid
from typing import Any, Dict, Optional

_lock = threading.Lock()
_jobs: Dict[str, Dict[str, Any]] = {}


def create_job() -> str:
    job_id = uuid.uuid4().hex
    with _lock:
        _jobs[job_id] = {"status": "processing", "log": [], "result": None, "error": None}
    return job_id


def append_log(job_id: str, line: str) -> None:
    with _lock:
        job = _jobs.get(job_id)
        if job is not None:
            job["log"].append(line)


def set_done(job_id: str, result: dict) -> None:
    with _lock:
        job = _jobs.get(job_id)
        if job is not None:
            job["status"] = "done"
            job["result"] = result


def set_error(job_id: str, error: str) -> None:
    with _lock:
        job = _jobs.get(job_id)
        if job is not None:
            job["status"] = "error"
            job["error"] = error


def get_job(job_id: str) -> Optional[dict]:
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            return None
        # Shallow copy so the caller can't mutate internal state, and the
        # log list is copied too since it's actively appended to from the
        # background extraction thread while a status request might be
        # reading it concurrently.
        return {**job, "log": list(job["log"])}