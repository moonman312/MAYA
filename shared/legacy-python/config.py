"""
Centralised configuration constants for the MAYA platform
(Machine Assisted Yield Automation).
"""

from __future__ import annotations

import logging
import os

# ── Database ──────────────────────────────────────────────────────────────────
DB_DSN: str = os.getenv(
    "MAYA_DB_DSN",
    "dbname=maya user=postgres password=postgres host=localhost port=5432",
)

# ── Mews environment ────────────────────────────────────────────────────────
# Set MAYA_MEWS_ENV=production to hit the live Mews API; defaults to "demo".
MEWS_ENV: str = os.getenv("MAYA_MEWS_ENV", "demo")

_MEWS_URLS = {
    "demo": "https://api.mews-demo.com/api/connector/v1",
    "production": "https://api.mews.com/api/connector/v1",
}

MEWS_BASE_URL: str = os.getenv(
    "MAYA_MEWS_BASE_URL",
    _MEWS_URLS.get(MEWS_ENV, _MEWS_URLS["demo"]),
)

# ── Mews demo credentials (publicly available from Mews docs) ───────────────
MEWS_DEMO_CLIENT_TOKEN: str = (
    "E0D439EE522F44368DC78E1BFB03710C-D24FB11DBE31D4621C4817E028D9E1D"
)
MEWS_DEMO_ACCESS_TOKEN_GROSS: str = (
    "C66EF7B239D24632943D115EDE9CB810-EA00F8FD8294692C940F6B5A8F9453D"
)
MEWS_DEMO_ACCESS_TOKEN_NET: str = (
    "4D6C7ABE0E6A4681B0AFB16900AE5D86-DF50CBC89E1D4FF5859DDF021649ED5"
)
MEWS_CLIENT_NAME: str = "MAYA 0.1.0"

# ── Fetch window ─────────────────────────────────────────────────────────────
# Default range for reservation fetches.  The api_client splits this into
# ≤96-hour chunks automatically (Mews caps each request at 100 h).
from datetime import datetime, timedelta, timezone as _tz

_now = datetime.now(_tz.utc)
FETCH_START_UTC: str = os.getenv(
    "MAYA_FETCH_START",
    (_now - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ"),
)
FETCH_END_UTC: str = os.getenv(
    "MAYA_FETCH_END",
    (_now + timedelta(days=396)).strftime("%Y-%m-%dT%H:%M:%SZ"),
)

# ── Scheduler ─────────────────────────────────────────────────────────────────
BATCH_INTERVAL_MINUTES: int = 5

# ── Defaults ─────────────────────────────────────────────────────────────────
DEFAULT_TOTAL_ROOMS_PER_TYPE: int = 100

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger: logging.Logger = logging.getLogger("maya")
