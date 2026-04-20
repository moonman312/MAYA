"""
Mews Connector API client.

Encapsulates all HTTP communication with the Mews platform and returns
raw JSON for downstream ETL processing.  Supports cursor-based pagination
so large hotels receive complete data.

The Mews Connector API limits each reservation query interval (see docs;
typically up to ~3 months). ``fetch_reservations`` splits wider windows
into chunks and merges the results.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import requests

from config import FETCH_END_UTC, FETCH_START_UTC, MEWS_CLIENT_NAME, logger
from models import Hotel

# Mews limits each page to 1000 items by default.
_DEFAULT_PAGE_SIZE = 1000

# Mews limits reservation time filters to ~3 months per request (Connector API).
# Use 90-day chunks to reduce round-trips (was 96h for early experimentation).
_MAX_WINDOW = timedelta(days=90)


def _parse_utc(ts: str) -> datetime:
    """Parse an ISO-8601 UTC timestamp into a tz-aware datetime."""
    ts = ts.rstrip("Z")
    return datetime.fromisoformat(ts).replace(tzinfo=timezone.utc)


class MewsApiClient:
    """HTTP client for the Mews Connector API, scoped to a single hotel."""

    def __init__(self, hotel: Hotel) -> None:
        self._hotel = hotel

    # ── Internal: single-window fetch with cursor pagination ──────────

    def _fetch_window(
        self,
        url: str,
        start_utc: str,
        end_utc: str,
        page_size: int,
    ) -> dict[str, Any]:
        """Fetch reservations for a single date window, paginating."""
        base_payload: dict[str, Any] = {
            "ClientToken": self._hotel.client_token,
            "AccessToken": self._hotel.access_token,
            "Client": MEWS_CLIENT_NAME,
            "StartUtc": start_utc,
            "EndUtc": end_utc,
            # Include Canceled so downstream ETL can drop them locally (default omits them).
            "States": [
                "Enquired",
                "Confirmed",
                "Started",
                "Processed",
                "Canceled",
                "Optional",
                "Requested",
            ],
            "Extent": {
                "Reservations": True,
                "SpaceCategories": True,
                "ResourceCategories": True,
                "Items": True,
            },
            "Limitation": {"Count": page_size},
        }
        if self._hotel.enterprise_id:
            base_payload["EnterpriseIds"] = [self._hotel.enterprise_id]

        merged: dict[str, Any] = {}
        cursor: str | None = None
        page = 0

        while True:
            payload = dict(base_payload)
            if cursor:
                payload["Limitation"] = {"Count": page_size, "Cursor": cursor}

            resp = requests.post(
                url,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=60,
            )
            resp.raise_for_status()
            data = resp.json()
            page += 1

            if not merged:
                merged = data
            else:
                for key in ("Reservations", "ReservationItems", "Items"):
                    if key in data and isinstance(data[key], list):
                        merged.setdefault(key, []).extend(data[key])

            next_cursor = data.get("Cursor")
            if not next_cursor or next_cursor == cursor:
                break
            cursor = next_cursor

        return merged

    # ── Public: full-range fetch ──────────────────────────────────────

    def fetch_reservations(
        self,
        start_utc: str = FETCH_START_UTC,
        end_utc: str = FETCH_END_UTC,
        page_size: int = _DEFAULT_PAGE_SIZE,
    ) -> dict[str, Any]:
        """Fetch all reservations between *start_utc* and *end_utc*.

        Automatically splits wide date ranges into bounded windows and merges the results.

        Returns a merged response dict containing all ``Reservations``
        and category data.

        Raises ``requests.exceptions.HTTPError`` on non-2xx status codes.
        """
        url = f"{self._hotel.base_url.rstrip('/')}/reservations/getAll"
        dt_start = _parse_utc(start_utc)
        dt_end = _parse_utc(end_utc)

        merged: dict[str, Any] = {}
        window_start = dt_start
        windows = 0

        while window_start < dt_end:
            window_end = min(window_start + _MAX_WINDOW, dt_end)
            ws = window_start.strftime("%Y-%m-%dT%H:%M:%SZ")
            we = window_end.strftime("%Y-%m-%dT%H:%M:%SZ")

            chunk = self._fetch_window(url, ws, we, page_size)
            windows += 1

            if not merged:
                merged = chunk
            else:
                for key in ("Reservations", "ReservationItems", "Items"):
                    if key in chunk and isinstance(chunk[key], list):
                        merged.setdefault(key, []).extend(chunk[key])

            window_start = window_end

        total = len(merged.get("Reservations", merged.get("Items", [])))
        logger.info(
            "Hotel %d: API fetch complete — %d window(s), %d reservations.",
            self._hotel.id, windows, total,
        )
        return merged

    # ── Rate push-back ───────────────────────────────────────────────────

    def push_rate_update(
        self,
        rate_plan_id: str,
        space_category_id: str,
        start_utc: str,
        end_utc: str,
        amount: float,
        currency: str = "USD",
    ) -> dict[str, Any]:
        """Push an adjusted rate back to Mews via the rates/addRate endpoint.

        Uses the Mews Connector API ``rates/addRate`` command to set
        a specific price for a room category within a date range.

        Returns the raw JSON response from Mews.
        Raises ``requests.exceptions.HTTPError`` on failure.
        """
        url = f"{self._hotel.base_url.rstrip('/')}/rates/addRate"
        payload: dict[str, Any] = {
            "ClientToken": self._hotel.client_token,
            "AccessToken": self._hotel.access_token,
            "Client": MEWS_CLIENT_NAME,
            "RatePlanId": rate_plan_id,
            "SpaceCategoryId": space_category_id,
            "StartUtc": start_utc,
            "EndUtc": end_utc,
            "Amount": {
                "Currency": currency,
                "GrossValue": amount,
            },
        }
        resp = requests.post(
            url,
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=30,
        )
        resp.raise_for_status()
        logger.info(
            "Hotel %d: pushed rate $%.2f for %s (%s–%s).",
            self._hotel.id, amount, space_category_id, start_utc, end_utc,
        )
        return resp.json()
