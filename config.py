"""
Centralised configuration constants for the MAYA platform
(Machine Assisted Yield Automation).
"""

from __future__ import annotations

import logging

# ── Database ──────────────────────────────────────────────────────────────────
DB_DSN: str = "dbname=maya user=postgres password=postgres host=localhost port=5432"

# ── Mews API defaults ────────────────────────────────────────────────────────
MEWS_BASE_URL: str = "https://api.mews.com/api/connector/v1"
FETCH_START_UTC: str = "2020-01-01T00:00:00Z"
FETCH_END_UTC: str = "2030-12-31T23:59:59Z"

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
