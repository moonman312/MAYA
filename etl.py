"""
ETL layer — transform raw PMS API JSON into domain dataclasses.

Responsibilities:
  * Dynamic field detection on the first sample reservation.
  * Category-ID → name mapping (including Mews localised ``Names`` dicts).
  * Building a reservation-to-rate lookup from the ``Items`` array when
    rates are not embedded in the reservation itself.
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
            [
                "SpaceCategoryId",
                "RoomCategoryId",
                "ResourceCategoryId",
                "RequestedCategoryId",
            ],
            "room_type_id",
        ),
        rate=detect_field(
            sample,
            [
                "StayPriceIncludingTaxes",
                "TotalAmount.Value",
                "Rate.Value",
                "Price.Value",
                "TotalPrice",
                "Amount",
            ],
            "rate",
        ),
    )


# ── Category helpers ──────────────────────────────────────────────────────────

_PREFERRED_LOCALES = ("en-US", "en-GB", "en-AU", "en")


def _resolve_name(cat: dict[str, Any]) -> str:
    """Extract a human-readable name from a category dict.

    Mews API ≥2024 uses a localised ``Names`` dict instead of a flat
    ``Name`` string.  We prefer ``en-US`` → ``en-GB`` → first available.
    Falls back to ``ShortName`` or ``"Unknown"``.
    """
    # flat Name field (older or simpler APIs)
    flat = cat.get("Name")
    if isinstance(flat, str) and flat:
        return flat

    # localised Names dict
    names: dict[str, str] | None = cat.get("Names")
    if isinstance(names, dict) and names:
        for locale in _PREFERRED_LOCALES:
            if locale in names:
                return names[locale]
        # take the first available locale
        return next(iter(names.values()))

    # ShortName / ShortNames fallback
    short = cat.get("ShortName")
    if isinstance(short, str) and short:
        return short
    short_names: dict[str, str] | None = cat.get("ShortNames")
    if isinstance(short_names, dict) and short_names:
        for locale in _PREFERRED_LOCALES:
            if locale in short_names:
                return short_names[locale]
        return next(iter(short_names.values()))

    return "Unknown"


def build_category_map(data: dict[str, Any]) -> dict[str, str]:
    """Build a mapping of category-ID → category-name from the API response."""
    categories: dict[str, str] = {}
    for key in ("SpaceCategories", "RoomCategories", "ResourceCategories"):
        items = data.get(key)
        if not isinstance(items, list):
            continue
        for cat in items:
            cat_id = cat.get("Id") or cat.get("id")
            cat_name = _resolve_name(cat)
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


# ── Item-based rate lookup ───────────────────────────────────────────────────

def build_rate_lookup(data: dict[str, Any]) -> dict[str, float]:
    """Build a reservation-ID → total-rate mapping from the Items array.

    The Mews Connector API returns line-item charges in an ``Items``
    (or ``OrderItems``) array.  Each item's ``OrderId`` matches the
    reservation ``Id``.  We sum ``Amount.GrossValue`` (falling back
    to ``Amount.Value``) per reservation to get the total stay rate.
    """
    rate_map: dict[str, float] = {}
    items: list[dict[str, Any]] | None = data.get("Items") or data.get("OrderItems")
    if not isinstance(items, list):
        return rate_map

    for item in items:
        order_id = item.get("OrderId")
        if not order_id:
            continue
        amount = item.get("Amount")
        if not isinstance(amount, dict):
            continue
        val = amount.get("GrossValue") or amount.get("Value")
        if val is None:
            continue
        try:
            rate_map[order_id] = rate_map.get(order_id, 0.0) + float(val)
        except (ValueError, TypeError):
            pass

    return rate_map


# ── Reservation list discovery ────────────────────────────────────────────────

def find_reservations_list(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Locate the reservations array in the API response."""
    for key in ("Reservations", "reservations"):
        items = data.get(key)
        if isinstance(items, list) and len(items) > 0:
            return items
    # Only fall back to Items if there is no Reservations key at all
    for key in ("Items", "items"):
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
    rate_lookup: dict[str, float] | None = None,
) -> Reservation:
    """Transform one raw API dict into a ``Reservation`` dataclass."""
    stay_dt = parse_date(get_nested(raw, field_map.stay_date))
    book_dt = parse_date(get_nested(raw, field_map.booking_date))
    rt_id = get_nested(raw, field_map.room_type_id)

    window: Optional[int] = None
    if stay_dt and book_dt:
        window = (stay_dt - book_dt).days

    # Try the inline rate field first, then fall back to the Items-based lookup
    rate = extract_rate(raw, field_map.rate)
    if rate is None and rate_lookup:
        res_id = get_nested(raw, field_map.reservation_id)
        if res_id:
            rate = rate_lookup.get(res_id)

    return Reservation(
        hotel_id=hotel_id,
        reservation_id=get_nested(raw, field_map.reservation_id),
        room_type=categories.get(rt_id, rt_id or "Unknown"),
        stay_date=stay_dt,
        booking_date=book_dt,
        booking_window=window,
        rate=rate,
        base_rate=rate,
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
    rate_lookup = build_rate_lookup(data)
    if rate_lookup:
        logger.info("Hotel %d: built rate lookup from Items (%d entries).",
                     hotel_id, len(rate_lookup))

    reservations = [
        parse_single_reservation(r, field_map, categories, hotel_id, rate_lookup)
        for r in raw_list
    ]
    room_types = extract_room_types(categories, hotel_id)
    return reservations, room_types
