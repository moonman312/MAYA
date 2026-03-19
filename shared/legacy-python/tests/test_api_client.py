import json

import pytest

from api_client import MewsApiClient
from models import Hotel


class DummyResponse:
    def __init__(self, status_code=200, content=b"", json_data=None):
        self.status_code = status_code
        self.content = content
        self._json = json_data or {}

    def raise_for_status(self):
        if not (200 <= self.status_code < 300):
            raise Exception(f"HTTP {self.status_code}")

    def json(self):
        return self._json


# Use a short (< 96 h) window so the windowed fetch makes exactly one call.
_SHORT_START = "2025-06-01T00:00:00Z"
_SHORT_END = "2025-06-02T00:00:00Z"


def test_fetch_reservations_success(monkeypatch):
    hotel = Hotel(id=1, base_url="https://example.com", client_token="ct", access_token="at", enterprise_id="e1")
    client = MewsApiClient(hotel)
    dummy = DummyResponse(200, b"{}", json_data={"foo": "bar"})

    def fake_post(url, json, headers, timeout):
        assert url.endswith("/reservations/getAll")
        assert json["ClientToken"] == "ct"
        return dummy

    monkeypatch.setattr("requests.post", fake_post)
    result = client.fetch_reservations(start_utc=_SHORT_START, end_utc=_SHORT_END)
    assert result == {"foo": "bar"}


def test_fetch_reservations_http_error(monkeypatch):
    hotel = Hotel(id=2, base_url="https://example.com", client_token="ct", access_token="at", enterprise_id="e1")
    client = MewsApiClient(hotel)
    dummy = DummyResponse(status_code=500, content=b"oops")

    def fake_post(url, json, headers, timeout):
        return dummy

    monkeypatch.setattr("requests.post", fake_post)
    with pytest.raises(Exception):
        client.fetch_reservations(start_utc=_SHORT_START, end_utc=_SHORT_END)


def test_fetch_reservations_pagination(monkeypatch):
    """Verify that multiple cursor pages within a single window are merged."""
    hotel = Hotel(id=3, base_url="https://example.com", client_token="ct",
                  access_token="at", enterprise_id="e1")
    client = MewsApiClient(hotel)

    page1 = DummyResponse(200, b"{}", json_data={
        "Reservations": [{"Id": "r1"}, {"Id": "r2"}],
        "Cursor": "page2",
    })
    page2 = DummyResponse(200, b"{}", json_data={
        "Reservations": [{"Id": "r3"}],
        # no Cursor = last page
    })
    pages = iter([page1, page2])

    def fake_post(url, json, headers, timeout):
        return next(pages)

    monkeypatch.setattr("requests.post", fake_post)
    # Use a short window so only one window chunk is needed (pagination
    # still exercises multiple calls via the cursor).
    result = client.fetch_reservations(
        start_utc=_SHORT_START, end_utc=_SHORT_END, page_size=2,
    )
    assert len(result["Reservations"]) == 3
    assert [r["Id"] for r in result["Reservations"]] == ["r1", "r2", "r3"]


def test_fetch_reservations_multi_window(monkeypatch):
    """Verify that a wide date range is split into multiple windows."""
    hotel = Hotel(id=4, base_url="https://example.com", client_token="ct",
                  access_token="at", enterprise_id="e1")
    client = MewsApiClient(hotel)

    call_count = 0

    def fake_post(url, json, headers, timeout):
        nonlocal call_count
        call_count += 1
        return DummyResponse(200, b"{}", json_data={
            "Reservations": [{"Id": f"r{call_count}"}],
        })

    monkeypatch.setattr("requests.post", fake_post)
    # 10-day window → at least 3 chunks (96 h ≈ 4 days each)
    result = client.fetch_reservations(
        start_utc="2025-06-01T00:00:00Z",
        end_utc="2025-06-11T00:00:00Z",
    )
    assert call_count >= 3
    assert len(result["Reservations"]) == call_count
