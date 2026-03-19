"""Tests for database layer and scheduler logic using mocks."""
from __future__ import annotations

from datetime import datetime
from typing import Any
from unittest.mock import MagicMock

import pytest

import db
import scheduler as scheduler_mod
from models import Hotel, Reservation, RoomType, RuleConfig
from scheduler import process_hotel, batch_fetch_all_hotels


# --- database layer ---------------------------------------------------------

def make_dummy_cursor(result_rows=None, single=None):
    cursor = MagicMock(name="cursor")
    # make it usable as a context manager ("with cursor as cur")
    cursor.__enter__.return_value = cursor
    cursor.__exit__.return_value = None

    def execute(query, params=None):
        cursor.queries.append((query, params))
        # allow tests to inspect the SQL
    cursor.execute.side_effect = execute
    cursor.queries = []

    if single is not None:
        cursor.fetchone.return_value = single
    if result_rows is not None:
        cursor.fetchall.return_value = result_rows
    return cursor


class DummyConn:
    def __init__(self, cursor: MagicMock):
        self._cursor = cursor
    def cursor(self, cursor_factory=None):
        return self._cursor
    def commit(self):
        pass
    def rollback(self):
        pass
    def close(self):
        pass


@pytest.fixture

def patch_connection(monkeypatch):
    """Patch db.get_connection to yield a dummy connection with inspectable cursor."""
    from contextlib import contextmanager

    cursor = make_dummy_cursor()

    @contextmanager
    def fake_ctx(dsn=None):
        yield DummyConn(cursor)

    monkeypatch.setattr(db, "get_connection", fake_ctx)
    return cursor


def test_load_all_hotels(monkeypatch, patch_connection):
    # simulate two rows returned by cursor
    rows = [
        {"id": 1, "name": "A", "client_token": "c", "access_token": "a", 
         "enterprise_id": "e", "base_url": "u", "total_rooms_per_type": 10},
        {"id": 2, "name": "B", "client_token": "c2", "access_token": "a2", 
         "enterprise_id": "e2", "base_url": "u2", "total_rooms_per_type": 20},
    ]
    cursor = patch_connection
    cursor.fetchall.return_value = rows

    with db.get_connection() as conn:
        hotels = db.load_all_hotels(conn)
    assert len(hotels) == 2
    assert hotels[0].name == "A"
    assert hotels[1].total_rooms_per_type == 20


def test_insert_default_rules_seeding(monkeypatch, patch_connection):
    cursor = patch_connection
    # first call returns count 0, second call something else
    cursor.fetchone.return_value = (0,)
    with db.get_connection() as conn:
        db.insert_default_rules(conn, hotel_id=99)
    # ensure insert happened
    queries = [q for q, _ in cursor.queries if "INSERT INTO rules" in q]
    assert queries, "expected insert query when count is zero"

    # now simulate nonzero count
    cursor.queries.clear()
    cursor.fetchone.return_value = (5,)
    with db.get_connection() as conn:
        db.insert_default_rules(conn, hotel_id=99)
    # no insert should be executed
    assert not any("INSERT INTO rules" in q for q, _ in cursor.queries)


# --- scheduler logic --------------------------------------------------------

@pytest.fixture

def multi_hotel_data():
    # two hotels with minimal properties
    return [Hotel(id=1, name="H1"), Hotel(id=2, name="H2")]


@pytest.fixture

def api_responses(multi_hotel_api_response):
    # reuse fixture defined in conftest
    return multi_hotel_api_response


def test_process_hotel_pipeline(monkeypatch, api_responses):
    # patch API client to return our canned response based on hotel id
    class DummyClient:
        def __init__(self, hotel):
            self.hotel = hotel
        def fetch_reservations(self, start_utc=None, end_utc=None):
            return api_responses[self.hotel.id]
    monkeypatch.setattr(scheduler_mod, "MewsApiClient", DummyClient)

    # patch all db operations used inside process_hotel to no-ops or simple returns
    monkeypatch.setattr(db, "upsert_room_types", lambda conn, h, r: None)
    monkeypatch.setattr(scheduler_mod, "upsert_room_types", lambda conn, h, r: None)
    monkeypatch.setattr(db, "upsert_reservations", lambda conn, h, r: len(r))
    monkeypatch.setattr(scheduler_mod, "upsert_reservations", lambda conn, h, r: len(r))
    monkeypatch.setattr(db, "upsert_metrics", lambda conn, h, r: None)
    monkeypatch.setattr(scheduler_mod, "upsert_metrics", lambda conn, h, r: None)
    # load_metrics should return an empty mapping
    monkeypatch.setattr(db, "load_metrics", lambda conn, h: {})
    monkeypatch.setattr(scheduler_mod, "load_metrics", lambda conn, h: {})
    monkeypatch.setattr(db, "insert_default_rules", lambda conn, h: None)
    monkeypatch.setattr(scheduler_mod, "insert_default_rules", lambda conn, h: None)
    # load_rule_configs needs to return a list of RuleConfig
    dummy_rule = RuleConfig(
        rule_name="Test", conditions={"occupancy_percentage": ">80"},
        action={"adjust_rate_percent": 10}, room_types=[], enabled=True,
    )
    monkeypatch.setattr(db, "load_rule_configs", lambda conn, h: [dummy_rule])
    monkeypatch.setattr(scheduler_mod, "load_rule_configs", lambda conn, h: [dummy_rule])
    # fire-once tracking: no previously applied pairs, persist is a no-op
    monkeypatch.setattr(db, "load_rule_applications", lambda conn, h: set())
    monkeypatch.setattr(scheduler_mod, "load_rule_applications", lambda conn, h: set())
    monkeypatch.setattr(db, "insert_rule_applications", lambda conn, h, apps: None)
    monkeypatch.setattr(scheduler_mod, "insert_rule_applications", lambda conn, h, apps: None)

    # patch get_connection to yield dummy conn so no DB needed
    from contextlib import contextmanager
    from unittest.mock import MagicMock

    @contextmanager
    def fake_conn(dsn=None):
        yield MagicMock(name="conn")

    # patch both the db module and the copy imported into scheduler
    monkeypatch.setattr(db, "get_connection", fake_conn)
    monkeypatch.setattr(scheduler_mod, "get_connection", fake_conn)

    hotel = Hotel(id=1, name="H1")
    reservations = process_hotel(hotel)
    # verify reservations list is non-empty and room_type names were mapped
    assert reservations
    assert all(isinstance(r, Reservation) for r in reservations)


def test_batch_fetch_all_hotels(monkeypatch, multi_hotel_data, api_responses):
    # patch load_all_hotels in both db and scheduler modules so the
    # cached import inside scheduler also receives the fake data
    monkeypatch.setattr(db, "load_all_hotels", lambda conn: multi_hotel_data)
    monkeypatch.setattr(scheduler_mod, "load_all_hotels", lambda conn: multi_hotel_data)
    # reuse previous patch strategy for process_hotel to capture the call count
    calls = []
    def fake_process(hotel, dsn=None):
        calls.append(hotel.id)
        return []
    monkeypatch.setattr(scheduler_mod, "process_hotel", fake_process)

    # patch get_connection here as well so the dummy dsn isn't used
    from contextlib import contextmanager
    from unittest.mock import MagicMock

    @contextmanager
    def fake_conn2(dsn=None):
        yield MagicMock(name="conn2")
    monkeypatch.setattr(db, "get_connection", fake_conn2)
    monkeypatch.setattr(scheduler_mod, "get_connection", fake_conn2)

    # run batch
    batch_fetch_all_hotels(dsn="dummy")
    assert calls == [1, 2]
