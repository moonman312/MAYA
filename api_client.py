"""
Mews Connector API client.

Encapsulates all HTTP communication with the Mews platform and returns
raw JSON for downstream ETL processing.  Supports cursor-based pagination
so large hotels receive complete data.
"""

from __future__ import annotations

from typing import Any

import requests

from config import FETCH_END_UTC, FETCH_START_UTC, logger
from models import Hotel

# Mews limits each page to 1000 items by default.
_DEFAULT_PAGE_SIZE = 1000


class MewsApiClient:
    """HTTP client for the Mews Connector API, scoped to a single hotel."""

    def __init__(self, hotel: Hotel) -> None:
        self._hotel = hotel

    def fetch_reservations(
        self,
        start_utc: str = FETCH_START_UTC,
        end_utc: str = FETCH_END_UTC,
        page_size: int = _DEFAULT_PAGE_SIZE,
    ) -> dict[str, Any]:
        """Fetch all reservations, automatically paginating via Mews cursors.

        Returns a merged response dict containing all pages of
        ``Reservations`` and category data.

        Raises ``requests.exceptions.HTTPError`` on non-2xx status codes.
        """
        url = f"{self._hotel.base_url.rstrip('/')}/reservations/getAll"
        base_payload: dict[str, Any] = {
            "ClientToken": self._hotel.client_token,
            "AccessToken": self._hotel.access_token,
            "Client": "MAYA",
            "EnterpriseIds": [self._hotel.enterprise_id],
            "StartUtc": start_utc,
            "EndUtc": end_utc,
            "Extent": {"Reservations": True, "SpaceCategories": True},
            "Limitation": {"Count": page_size},
        }

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
                # append reservation arrays from subsequent pages
                for key in ("Reservations", "ReservationItems", "Items"):
                    if key in data and isinstance(data[key], list):
                        merged.setdefault(key, []).extend(data[key])

            # check for next cursor
            next_cursor = data.get("Cursor")
            if not next_cursor or next_cursor == cursor:
                break
            cursor = next_cursor

        total = len(merged.get("Reservations", merged.get("Items", [])))
        logger.info(
            "Hotel %d: API fetch complete — %d page(s), %d reservations.",
            self._hotel.id, page, total,
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
            "Client": "MAYA",
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
