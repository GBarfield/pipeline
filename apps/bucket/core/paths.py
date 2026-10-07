"""
Single source of truth for where persistent data lives.

Locally, DATA_DIR defaults to the project folder itself, so nothing
changes about how this behaves on your own machine. On a host like
Railway, DATA_DIR is set (via the DATA_DIR environment variable) to a
mounted persistent volume - e.g. /data - so carrier_profiles/, uploads/,
and output/ survive restarts and redeploys instead of living on the
container's throwaway filesystem.

Every module that needs one of these folders imports it from here
instead of computing its own relative path, so there's exactly one
place this decision is made.
"""
import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR") or Path(__file__).resolve().parent.parent)

CARRIER_PROFILES_DIR = DATA_DIR / "carrier_profiles"
UPLOADS_DIR = DATA_DIR / "uploads"
OUTPUT_DIR = DATA_DIR / "output"
COLUMN_MAPPING_PROFILES_DIR = DATA_DIR / "column_mapping_profiles"

for _dir in (CARRIER_PROFILES_DIR, UPLOADS_DIR, OUTPUT_DIR, COLUMN_MAPPING_PROFILES_DIR):
    _dir.mkdir(parents=True, exist_ok=True)
