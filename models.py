"""
Domain data models for the MAYA platform (Machine Assisted Yield Automation).

All models are dataclasses with full type hints. Every table-backed model
includes ``hotel_id`` for multi-tenant isolation.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from typing import Any, Optional

from config import MEWS_BASE_URL, DEFAULT_TOTAL_ROOMS_PER_TYPE


# ── Tenant ────────────────────────────────────────────────────────────────────

@dataclass
class Hotel:
    """A tenant hotel in the SaaS platform."""

    id: Optional[int] = None
    name: str = ""
    client_token: str = ""
    access_token: str = ""
    enterprise_id: str = ""
    base_url: str = MEWS_BASE_URL
    total_rooms_per_type: int = DEFAULT_TOTAL_ROOMS_PER_TYPE


# ── Inventory ─────────────────────────────────────────────────────────────────

@dataclass
class RoomType:
    """Room category metadata scoped to a hotel."""

    id: Optional[int] = None
    hotel_id: Optional[int] = None
    category_id: str = ""
    name: str = "Unknown"


# ── Reservations ──────────────────────────────────────────────────────────────

@dataclass
class Reservation:
    """A single reservation with computed metrics, scoped to a hotel."""

    id: Optional[int] = None
    hotel_id: Optional[int] = None
    reservation_id: Optional[str] = None
    room_type: str = "Unknown"
    stay_date: Optional[datetime] = None
    booking_date: Optional[datetime] = None
    booking_window: Optional[int] = None
    rate: Optional[float] = None
    base_rate: Optional[float] = None
    occupancy: Optional[int] = None
    pickup_rate: Optional[int] = None
    raw_json: Optional[dict[str, Any]] = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a JSON-friendly dict, excluding raw_json."""
        result: dict[str, Any] = {}
        for key, val in asdict(self).items():
            if key == "raw_json":
                continue
            if isinstance(val, (datetime, date)):
                result[key] = val.isoformat()
            else:
                result[key] = val
        return result


# ── Metrics ───────────────────────────────────────────────────────────────────

@dataclass
class MetricsRow:
    """Cached per-room-type per-date metrics for a hotel (Postgres-backed)."""

    id: Optional[int] = None
    hotel_id: Optional[int] = None
    room_type: str = ""
    stay_date: Optional[date] = None
    occupancy: int = 0
    pickup_rate: int = 0


# ── Rules config ──────────────────────────────────────────────────────────────

@dataclass
class RuleConfig:
    """A rule definition stored per-hotel in the database.

    Uses a unified JSON-based format:
      * ``rule_name``  — human-readable label
      * ``conditions`` — dict of field→operator+value, e.g. ``{"occupancy_percentage": ">80"}``
      * ``action``     — dict, e.g. ``{"adjust_rate_percent": 10}`` or ``{"adjust_rate_dollars": 25}``
      * ``room_types`` — list of room-type names this rule applies to (empty = all)
    """

    id: Optional[int] = None
    hotel_id: Optional[int] = None
    rule_name: str = ""
    conditions: dict[str, Any] = field(default_factory=dict)
    action: dict[str, Any] = field(default_factory=dict)
    room_types: list[str] = field(default_factory=list)
    enabled: bool = True


# ── ETL helper ────────────────────────────────────────────────────────────────

@dataclass
class FieldMap:
    """Detected API field names for reservation attributes."""

    reservation_id: Optional[str] = None
    stay_date: Optional[str] = None
    booking_date: Optional[str] = None
    room_type_id: Optional[str] = None
    rate: Optional[str] = None
