"""Tests for db.py CRUD functions using mock cursors.

Covers:
  - upsert_room_types
  - upsert_reservations
  - load_reservations
  - upsert_metrics / load_metrics
  - load_rule_configs / upsert_rule / delete_rule / toggle_rule
  - load_rule_applications / insert_rule_applications
  - insert_audit_log
  - _row_to_rule_config
"""
from __future__ import annotations

import json
from datetime import date, datetime
from typing import Any
from unittest.mock import MagicMock, call

import pytest

import db
from models import Hotel, MetricsRow, Reservation, RoomType, RuleConfig


# ── Helpers ───────────────────────────────────────────────────────────────────

class SpyCursor:
    """A cursor mock that records all execute() calls."""

    def __init__(self, *, fetchone_val=None, fetchall_val=None, rowcount=0):
        self.calls: list[tuple[str, Any]] = []
        self._fetchone = fetchone_val
        self._fetchall = fetchall_val or []
        self.rowcount = rowcount

    def execute(self, query, params=None):
        self.calls.append((query, params))

    def fetchone(self):
        return self._fetchone

    def fetchall(self):
        return self._fetchall

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


class FakeConn:
    """Minimal connection-like object that returns a SpyCursor."""

    def __init__(self, cursor: SpyCursor):
        self._cursor = cursor

    def cursor(self, cursor_factory=None):
        return self._cursor

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


# ── upsert_room_types ────────────────────────────────────────────────────────

class TestUpsertRoomTypes:
    def test_inserts_each_room_type(self):
        cur = SpyCursor()
        conn = FakeConn(cur)
        room_types = [
            RoomType(category_id="cat1", name="Standard"),
            RoomType(category_id="cat2", name="Deluxe"),
        ]
        db.upsert_room_types(conn, hotel_id=1, room_types=room_types)
        assert len(cur.calls) == 2
        for sql, params in cur.calls:
            assert "INSERT INTO room_types" in sql
            assert "ON CONFLICT" in sql

    def test_empty_list_no_queries(self):
        cur = SpyCursor()
        conn = FakeConn(cur)
        db.upsert_room_types(conn, hotel_id=1, room_types=[])
        assert len(cur.calls) == 0

    def test_passes_correct_params(self):
        cur = SpyCursor()
        conn = FakeConn(cur)
        rt = RoomType(category_id="c99", name="Suite")
        db.upsert_room_types(conn, hotel_id=5, room_types=[rt])
        _, params = cur.calls[0]
        assert params == (5, "c99", "Suite")


# ── upsert_reservations ──────────────────────────────────────────────────────

class TestUpsertReservations:
    def test_returns_count(self):
        cur = SpyCursor()
        conn = FakeConn(cur)
        res = [
            Reservation(hotel_id=1, reservation_id="r1", room_type="Std", rate=100.0),
            Reservation(hotel_id=1, reservation_id="r2", room_type="Dlx", rate=200.0),
        ]
        count = db.upsert_reservations(conn, hotel_id=1, reservations=res)
        assert count == 2

    def test_uses_coalesce_for_base_rate(self):
        cur = SpyCursor()
        conn = FakeConn(cur)
        res = [Reservation(hotel_id=1, reservation_id="r1", rate=100.0, base_rate=90.0)]
        db.upsert_reservations(conn, hotel_id=1, reservations=res)
        sql = cur.calls[0][0]
        assert "COALESCE(reservations.base_rate, EXCLUDED.base_rate)" in sql

    def test_empty_list_returns_zero(self):
        cur = SpyCursor()
        conn = FakeConn(cur)
        assert db.upsert_reservations(conn, hotel_id=1, reservations=[]) == 0

    def test_serializes_raw_json(self):
        cur = SpyCursor()
        conn = FakeConn(cur)
        raw = {"key": "value"}
        res = [Reservation(hotel_id=1, reservation_id="r1", raw_json=raw)]
        db.upsert_reservations(conn, hotel_id=1, reservations=res)
        _, params = cur.calls[0]
        # raw_json is the 9th parameter
        assert json.loads(params[8]) == raw


# ── load_reservations ────────────────────────────────────────────────────────

class TestLoadReservations:
    def test_returns_reservation_objects(self):
        rows = [
            {"id": 10, "hotel_id": 1, "reservation_id": "r1", "room_type": "Std",
             "stay_date": datetime(2026, 5, 1), "booking_date": datetime(2026, 4, 1),
             "booking_window": 30, "rate": 150.0, "base_rate": 140.0},
        ]
        cur = SpyCursor(fetchall_val=rows)
        conn = FakeConn(cur)
        result = db.load_reservations(conn, hotel_id=1)
        assert len(result) == 1
        assert result[0].reservation_id == "r1"
        assert result[0].rate == 150.0
        assert result[0].base_rate == 140.0

    def test_empty_result(self):
        cur = SpyCursor(fetchall_val=[])
        conn = FakeConn(cur)
        assert db.load_reservations(conn, hotel_id=1) == []


# ── upsert_metrics / load_metrics ────────────────────────────────────────────

class TestMetrics:
    def test_upsert_metrics_inserts(self):
        cur = SpyCursor()
        conn = FakeConn(cur)
        rows = [
            MetricsRow(hotel_id=1, room_type="Std", stay_date=date(2026, 5, 1),
                       occupancy=80, pickup_rate=5),
        ]
        db.upsert_metrics(conn, hotel_id=1, rows=rows)
        assert len(cur.calls) == 1
        assert "INSERT INTO metrics" in cur.calls[0][0]

    def test_load_metrics_returns_dict(self):
        rows = [
            {"id": 1, "hotel_id": 1, "room_type": "Std", "stay_date": date(2026, 5, 1),
             "occupancy": 80, "pickup_rate": 5},
        ]
        cur = SpyCursor(fetchall_val=rows)
        conn = FakeConn(cur)
        result = db.load_metrics(conn, hotel_id=1)
        assert ("Std", date(2026, 5, 1)) in result
        assert result[("Std", date(2026, 5, 1))].occupancy == 80


# ── Rules CRUD ───────────────────────────────────────────────────────────────

class TestRulesCrud:
    def test_load_rule_configs_enabled_only(self):
        rows = [
            {"id": 1, "hotel_id": 1, "rule_name": "R1",
             "conditions": {"occ": ">80"}, "action": {"adjust_rate_percent": 10},
             "room_types": [], "enabled": True},
        ]
        cur = SpyCursor(fetchall_val=rows)
        conn = FakeConn(cur)
        result = db.load_rule_configs(conn, hotel_id=1, enabled_only=True)
        assert len(result) == 1
        assert result[0].rule_name == "R1"
        sql = cur.calls[0][0]
        assert "AND enabled = TRUE" in sql

    def test_load_all_rule_configs(self):
        cur = SpyCursor(fetchall_val=[])
        conn = FakeConn(cur)
        db.load_all_rule_configs(conn, hotel_id=1)
        sql = cur.calls[0][0]
        assert "AND enabled = TRUE" not in sql

    def test_upsert_rule_insert(self):
        cur = SpyCursor(fetchone_val=(42,))
        conn = FakeConn(cur)
        rule = RuleConfig(
            rule_name="New",
            conditions={"occ": ">50"},
            action={"adjust_rate_dollars": 20},
            room_types=["Suite"],
            enabled=True,
        )
        rule_id = db.upsert_rule(conn, hotel_id=1, rule=rule)
        assert rule_id == 42
        sql = cur.calls[0][0]
        assert "INSERT INTO rules" in sql

    def test_upsert_rule_update(self):
        cur = SpyCursor(fetchone_val=(7,))
        conn = FakeConn(cur)
        rule = RuleConfig(
            id=7,
            rule_name="Existing",
            conditions={},
            action={"adjust_rate_percent": 5},
            room_types=[],
            enabled=False,
        )
        rule_id = db.upsert_rule(conn, hotel_id=1, rule=rule)
        assert rule_id == 7
        sql = cur.calls[0][0]
        assert "UPDATE rules" in sql

    def test_delete_rule_found(self):
        cur = SpyCursor(rowcount=1)
        conn = FakeConn(cur)
        assert db.delete_rule(conn, hotel_id=1, rule_id=5) is True

    def test_delete_rule_not_found(self):
        cur = SpyCursor(rowcount=0)
        conn = FakeConn(cur)
        assert db.delete_rule(conn, hotel_id=1, rule_id=999) is False

    def test_toggle_rule_found(self):
        cur = SpyCursor(rowcount=1)
        conn = FakeConn(cur)
        assert db.toggle_rule(conn, hotel_id=1, rule_id=3) is True
        sql = cur.calls[0][0]
        assert "NOT enabled" in sql

    def test_toggle_rule_not_found(self):
        cur = SpyCursor(rowcount=0)
        conn = FakeConn(cur)
        assert db.toggle_rule(conn, hotel_id=1, rule_id=999) is False


# ── Rule applications ────────────────────────────────────────────────────────

class TestRuleApplications:
    def test_load_rule_applications(self):
        rows = [
            (1, date(2026, 5, 1)),
            (2, date(2026, 5, 2)),
        ]
        cur = SpyCursor(fetchall_val=rows)
        conn = FakeConn(cur)
        result = db.load_rule_applications(conn, hotel_id=1)
        assert result == {(1, date(2026, 5, 1)), (2, date(2026, 5, 2))}

    def test_load_rule_applications_empty(self):
        cur = SpyCursor(fetchall_val=[])
        conn = FakeConn(cur)
        assert db.load_rule_applications(conn, hotel_id=1) == set()

    def test_insert_rule_applications(self):
        cur = SpyCursor()
        conn = FakeConn(cur)
        apps = {(1, date(2026, 5, 1)), (2, date(2026, 5, 2))}
        db.insert_rule_applications(conn, hotel_id=1, applications=apps)
        assert len(cur.calls) == 2
        for sql, _ in cur.calls:
            assert "INSERT INTO rule_applications" in sql
            assert "ON CONFLICT" in sql
            assert "DO NOTHING" in sql

    def test_insert_empty_set(self):
        cur = SpyCursor()
        conn = FakeConn(cur)
        db.insert_rule_applications(conn, hotel_id=1, applications=set())
        assert len(cur.calls) == 0


# ── Audit log ────────────────────────────────────────────────────────────────

class TestAuditLog:
    def test_insert_audit_log(self):
        cur = SpyCursor()
        conn = FakeConn(cur)
        db.insert_audit_log(
            conn, hotel_id=1,
            event_type="rate_change",
            entity_type="reservation",
            entity_id="r1",
            detail={"old": 100, "new": 110},
        )
        assert len(cur.calls) == 1
        sql, params = cur.calls[0]
        assert "INSERT INTO audit_log" in sql
        assert params[1] == "rate_change"
        assert json.loads(params[4]) == {"old": 100, "new": 110}

    def test_insert_audit_log_default_detail(self):
        cur = SpyCursor()
        conn = FakeConn(cur)
        db.insert_audit_log(conn, hotel_id=1, event_type="test")
        _, params = cur.calls[0]
        assert json.loads(params[4]) == {}


# ── _row_to_rule_config ──────────────────────────────────────────────────────

class TestRowToRuleConfig:
    def test_dict_values(self):
        row = {
            "id": 10, "hotel_id": 1, "rule_name": "Test",
            "conditions": {"occ": ">80"},
            "action": {"adjust_rate_percent": 10},
            "room_types": ["Std"],
            "enabled": True,
        }
        result = db._row_to_rule_config(row)
        assert result.id == 10
        assert result.conditions == {"occ": ">80"}
        assert result.room_types == ["Std"]

    def test_json_string_values(self):
        row = {
            "id": 10, "hotel_id": 1, "rule_name": "Test",
            "conditions": '{"occ": ">80"}',
            "action": '{"adjust_rate_percent": 10}',
            "room_types": '["Std"]',
            "enabled": True,
        }
        result = db._row_to_rule_config(row)
        assert result.conditions == {"occ": ">80"}
        assert result.room_types == ["Std"]
