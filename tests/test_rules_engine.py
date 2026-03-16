"""Tests for the JSON-based rules engine."""

from rules_engine import apply_rules, compute_new_rate, rule_matches
from models import Reservation, RuleConfig


def make_rule(**kw) -> RuleConfig:
    return RuleConfig(
        rule_name=kw.get("rule_name", "test"),
        conditions=kw.get("conditions", {}),
        action=kw.get("action", {}),
        room_types=kw.get("room_types", []),
        enabled=kw.get("enabled", True),
    )


def make_reservation(rate: float, occupancy: int) -> Reservation:
    return Reservation(rate=rate, occupancy=occupancy, room_type="Standard", hotel_id=1)


# ── rule_matches ──────────────────────────────────────────────────────────


def test_rule_matches_gt():
    rule = make_rule(conditions={"occupancy_percentage": ">80"})
    assert rule_matches(rule, {"occupancy_percentage": 90, "room_type": "Standard"})
    assert not rule_matches(rule, {"occupancy_percentage": 70, "room_type": "Standard"})


def test_rule_matches_lt():
    rule = make_rule(conditions={"booking_window": "<3"})
    assert rule_matches(rule, {"booking_window": 1, "room_type": "Standard"})
    assert not rule_matches(rule, {"booking_window": 5, "room_type": "Standard"})


def test_rule_matches_multi_condition():
    rule = make_rule(conditions={"occupancy_percentage": ">50", "booking_window": "<10"})
    assert rule_matches(rule, {"occupancy_percentage": 60, "booking_window": 5, "room_type": "Standard"})
    assert not rule_matches(rule, {"occupancy_percentage": 60, "booking_window": 15, "room_type": "Standard"})


def test_rule_matches_room_type_filter():
    rule = make_rule(conditions={"occupancy_percentage": ">50"}, room_types=["Suite"])
    assert not rule_matches(rule, {"occupancy_percentage": 90, "room_type": "Standard"})
    assert rule_matches(rule, {"occupancy_percentage": 90, "room_type": "Suite"})


def test_rule_matches_missing_field():
    rule = make_rule(conditions={"occupancy_percentage": ">50"})
    assert not rule_matches(rule, {"room_type": "Standard"})


def test_rule_matches_empty_conditions():
    rule = make_rule(conditions={})
    assert rule_matches(rule, {"room_type": "Standard"})


# ── compute_new_rate ─────────────────────────────────────────────────────


def test_compute_new_rate_percent():
    assert compute_new_rate(100, {"adjust_rate_percent": 10}) == 110.0


def test_compute_new_rate_dollars():
    assert compute_new_rate(100, {"adjust_rate_dollars": 25}) == 125.0


def test_compute_new_rate_negative_percent():
    assert compute_new_rate(200, {"adjust_rate_percent": -5}) == 190.0


# ── apply_rules ──────────────────────────────────────────────────────────


def test_apply_rules_fires():
    rule = make_rule(
        conditions={"occupancy_percentage": ">50"},
        action={"adjust_rate_percent": 10},
    )
    r = make_reservation(rate=100, occupancy=60)
    fired = apply_rules([r], [rule], total_rooms=100)
    assert fired == 1
    assert r.rate == 110.0


def test_apply_rules_no_fire():
    rule = make_rule(
        conditions={"occupancy_percentage": ">90"},
        action={"adjust_rate_percent": 10},
    )
    r = make_reservation(rate=100, occupancy=10)
    fired = apply_rules([r], [rule], total_rooms=100)
    assert fired == 0
    assert r.rate == 100


def test_apply_rules_skips_none_rate():
    rule = make_rule(conditions={}, action={"adjust_rate_percent": 10})
    r = make_reservation(rate=None, occupancy=100)
    fired = apply_rules([r], [rule], total_rooms=100)
    assert fired == 0


def test_apply_rules_stacks():
    rules = [
        make_rule(conditions={"occupancy_percentage": ">50"}, action={"adjust_rate_percent": 10}),
        make_rule(conditions={"occupancy_percentage": ">50"}, action={"adjust_rate_dollars": 20}),
    ]
    r = make_reservation(rate=100, occupancy=60)
    fired = apply_rules([r], rules, total_rooms=100)
    assert fired == 2
    assert r.rate == 130.0  # 100*1.1=110, then +20=130
