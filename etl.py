"""
ETL layer — transform raw PMS API JSON into domain dataclasses.

Responsibilities:
  * Dynamic field detection on the first sample reservation.
  * Category-ID → name mapping.
  * Parsing each raw dict into a ``Reservation`` (with ``booking_window``).
  * Extracting ``RoomType`` records for database storage.
"""

from __future__ import annotations

from typing import Any, Optional

from config import logger
from models import FieldMap, Reservation, RoomType
from utils import detect_field, get_nested, parse_date


# ── Field detection ───────────────────────────────────────────────────────────

def detect_field_map(sample: dict[str, Any]) -> FieldMap:
    """Inspect a sample reservation and auto-detect API field names."""
    return FieldMap(
        reservation_id=detect_field(
            sample, ["Id", "ReservationId", "id"], "reservation_id",
        ),
        stay_date=detect_field(
            sample,
            ["ArrivalDate", "ScheduledStartUtc", "StartUtc", "CheckInUtc"],
            "stay_date",
        ),
        booking_date=detect_field(
            sample,
            ["CreatedUtc", "Created", "BookingDate", "CreateDate"],
            "booking_date",
        ),
        room_type_id=detect_field(
            sample,
            ["SpaceCategoryId", "RoomCategoryId", "ResourceCategoryId"],
            "room_type_id",
        ),
        rate=detect_field(
            sample,
            ["StayPriceIncludingTaxes", "TotalAmount.Value", "Rate.Value",
             "Price.Value", "TotalPrice", "Amount"],
            "rate",
        ),
    )


# ── Category helpers ──────────────────────────────────────────────────────────

def build_category_map(data: dict[str, Any]) -> dict[str, str]:
    """Build a mapping of category-ID → category-name from the API response."""
    categories: dict[str, str] = {}
    for key in ("SpaceCategories", "RoomCategories", "ResourceCategories"):
        items = data.get(key)
        if not isinstance(items, list):
            continue
        for cat in items:
            cat_id = cat.get("Id") or cat.get("id")
            cat_name = cat.get("Name") or cat.get("ShortName") or "Unknown"
            if cat_id:
                categories[cat_id] = cat_name
        break
    return categories


def extract_room_types(
    categories: dict[str, str],
    hotel_id: int,
) -> list[RoomType]:
    """Convert the category map into ``RoomType`` instances."""
    return [
        RoomType(hotel_id=hotel_id, category_id=cid, name=cname)
        for cid, cname in categories.items()
    ]


# ── Reservation list discovery ────────────────────────────────────────────────

def find_reservations_list(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Locate the reservations array in the API response."""
    for key in ("Reservations", "reservations", "Items", "items"):
        items = data.get(key)
        if isinstance(items, list) and len(items) > 0:
            return items
    return []


# ── Rate extraction ───────────────────────────────────────────────────────────

def extract_rate(raw: dict[str, Any], rate_field: Optional[str]) -> Optional[float]:
    """Extract and normalise the rate value, handling nested dicts."""
    val = get_nested(raw, rate_field)
    if isinstance(val, dict):
        val = val.get("Value")
    if val is None:
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


# ── Single-reservation parsing ────────────────────────────────────────────────

def parse_single_reservation(
    raw: dict[str, Any],
    field_map: FieldMap,
    categories: dict[str, str],
    hotel_id: int,
) -> Reservation:
    """Transform one raw API dict into a ``Reservation`` dataclass."""
    stay_dt = parse_date(get_nested(raw, field_map.stay_date))
    book_dt = parse_date(get_nested(raw, field_map.booking_date))
    rt_id = get_nested(raw, field_map.room_type_id)

    window: Optional[int] = None
    if stay_dt and book_dt:
        window = (stay_dt - book_dt).days

    return Reservation(
        hotel_id=hotel_id,
        reservation_id=get_nested(raw, field_map.reservation_id),
        room_type=categories.get(rt_id, rt_id or "Unknown"),
        stay_date=stay_dt,
        booking_date=book_dt,
        booking_window=window,
        rate=extract_rate(raw, field_map.rate),
        raw_json=raw,
    )


# ── Batch parsing ─────────────────────────────────────────────────────────────

def parse_api_response(
    data: dict[str, Any],
    hotel_id: int,
) -> tuple[list[Reservation], list[RoomType]]:
    """Full ETL pass: detect fields → parse all reservations + room types."""
    raw_list = find_reservations_list(data)
    if not raw_list:
        logger.warning("Hotel %d: API response contained no reservations.", hotel_id)
        return [], []

    field_map = detect_field_map(raw_list[0])
    logger.info("Hotel %d: detected fields %s", hotel_id, field_map)

    categories = build_category_map(data)
    reservations = [
        parse_single_reservation(r, field_map, categories, hotel_id)
        for r in raw_list
    ]
    room_types = extract_room_types(categories, hotel_id)
    return reservations, room_types
