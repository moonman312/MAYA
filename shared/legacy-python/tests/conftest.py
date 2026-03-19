"""Pytest fixtures shared across tests."""

from datetime import datetime
from typing import Any, Dict

import pytest

from models import Reservation


@pytest.fixture

def sample_raw_reservation() -> Dict[str, Any]:
    """Return a simple raw reservation dict with the most common fields."""
    return {
        "Id": "res_123",
        "ArrivalDate": "2025-05-01T14:00:00Z",
        "CreatedUtc": "2025-04-15T09:30:00Z",
        "SpaceCategoryId": "room_1",
        "StayPriceIncludingTaxes": {"Value": "150.00"},
    }


@pytest.fixture

def sample_api_response(sample_raw_reservation: Dict[str, Any]) -> Dict[str, Any]:
    """A minimal API response containing the sample reservation and one category."""
    return {
        "Reservations": [sample_raw_reservation],
        "SpaceCategories": [{"Id": "room_1", "Name": "Medium"}],
    }


@pytest.fixture

def simple_reservation() -> Reservation:
    """Reservation object with occupancy and rate already set."""
    return Reservation(
        hotel_id=1,
        reservation_id="r1",
        room_type="foo",
        stay_date=datetime(2025, 5, 1, 14, 0),
        booking_date=datetime(2025, 4, 15, 9, 30),
        booking_window=16,
        rate=100.0,
        occupancy=90,
    )


# ----- additional fixtures --------------------------------------------------

@pytest.fixture

def alt_fields_reservation() -> dict[str, Any]:
    """Reservation using alternate API field names with some nulls."""
    return {
        "ReservationId": "alt123",
        "ScheduledStartUtc": "2025-05-01T00:00:00Z",
        "CreateDate": "2025-05-01T00:00:00Z",
        "RoomCategoryId": None,  # null value should be skipped by detector
        "TotalAmount": {"Value": "200"},
    }

@pytest.fixture

def multi_hotel_api_response() -> dict[int, dict[str, Any]]:
    """Simulate two hotels each returning a small set of reservations."""
    base = {
        "Reservations": [
            {
                "Id": "h{hid}_r1",
                "ArrivalDate": "2025-06-01T12:00:00Z",
                "CreatedUtc": "2025-05-01T10:00:00Z",
                "SpaceCategoryId": "roomA",
                "StayPriceIncludingTaxes": {"Value": "100"},
            },
            {
                "Id": "h{hid}_r2",
                "ArrivalDate": "2025-06-02T12:00:00Z",
                "CreatedUtc": "2025-05-02T10:00:00Z",
                "SpaceCategoryId": "roomB",
                "StayPriceIncludingTaxes": {"Value": "150"},
            },
        ],
        "SpaceCategories": [
            {"Id": "roomA", "Name": "A"},
            {"Id": "roomB", "Name": "B"},
        ],
    }
    return {
        1: base,
        2: base,
    }

@pytest.fixture

def fake_connection(monkeypatch):
    """Provide a MagicMock connection and patch db.get_connection."""
    from unittest.mock import MagicMock, contextmanager

    conn = MagicMock(name="conn")

    @contextmanager
    def fake_conn_ctx(*args, **kwargs):
        yield conn

    monkeypatch.setattr("db.get_connection", fake_conn_ctx)
    return conn
