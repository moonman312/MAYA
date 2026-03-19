"""
Metrics computation layer.

Computes per-room-type per-stay-date occupancy and pickup counts, then
persists results to Postgres via the db module for reliable multi-hotel
caching.

**Occupancy** = total reservation count for a (room_type, stay_date) pair.
**Pickup**    = net new reservations since the last batch (current count
                minus previously cached count).  On the first run the pickup
                equals the occupancy.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from typing import Any

from config import logger
from models import MetricsRow, Reservation


def compute_metrics_rows(
    reservations: list[Reservation],
    hotel_id: int,
    previous: dict[tuple[str, date], MetricsRow] | None = None,
) -> list[MetricsRow]:
    """Aggregate occupancy and pickup counts per room_type per stay_date.

    Parameters
    ----------
    reservations : list[Reservation]
        Current batch of reservations.
    hotel_id : int
        Owning hotel.
    previous : dict | None
        Cached metrics from the prior batch keyed by ``(room_type, stay_date)``.
        When supplied, pickup_rate = current_count - previous_occupancy.
        When ``None`` (first run), pickup_rate defaults to the current count.

    Returns a flat list of ``MetricsRow`` objects ready for upsert.
    """
    prev = previous or {}
    counters: dict[tuple[str, date], int] = defaultdict(int)

    for res in reservations:
        if res.stay_date is None:
            continue
        key = (res.room_type, res.stay_date.date())
        counters[key] += 1

    rows: list[MetricsRow] = []
    for (rt, sd), count in counters.items():
        prev_row = prev.get((rt, sd))
        prev_occ = prev_row.occupancy if prev_row else 0
        pickup = max(count - prev_occ, 0)
        rows.append(
            MetricsRow(
                hotel_id=hotel_id,
                room_type=rt,
                stay_date=sd,
                occupancy=count,
                pickup_rate=pickup,
            )
        )
    return rows


def enrich_reservations_from_cache(
    reservations: list[Reservation],
    cached: dict[tuple[str, date], MetricsRow],
) -> None:
    """Attach Postgres-cached occupancy/pickup to each reservation in-place."""
    for res in reservations:
        if res.stay_date is None:
            continue
        key = (res.room_type, res.stay_date.date())
        row = cached.get(key)
        if row:
            res.occupancy = row.occupancy
            res.pickup_rate = row.pickup_rate
