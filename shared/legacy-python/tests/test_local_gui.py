"""Tests for ``tools/local_gui.py`` helpers."""

from typing import Any, Dict, List

import pytest

from tools import local_gui


def make_rule(threshold: float, adjust_pct: float) -> Dict[str, Any]:
    return {
        "rule_name": "test",
        "conditions": {"occupancy_percentage": f">"+str(threshold)},
        "action": {"adjust_rate_percent": adjust_pct},
    }


def test_simulate_rate_changes_no_rules():
    sample = [{"room_type": "x", "occupancy_percentage": 50, "booking_window": 10, "current_rate": 100}]
    result = local_gui.simulate_rate_changes([], sample)
    assert result[0]["new_rate"] == 100
    assert result[0]["applied_rules"] == ""


def test_simulate_rate_changes_applies_rule():
    sample = [{"room_type": "x", "occupancy_percentage": 90, "booking_window": 1, "current_rate": 200}]
    rule = make_rule(80, 10)
    result = local_gui.simulate_rate_changes([rule], sample)
    assert result[0]["new_rate"] == 220.0
    assert "test" in result[0]["applied_rules"]


def test_simulate_rate_changes_multiple_rules():
    sample = [{"room_type": "y", "occupancy_percentage": 90, "booking_window": 1, "current_rate": 100}]
    rules = [make_rule(80, 10), make_rule(70, 20)]
    res = local_gui.simulate_rate_changes(rules, sample)[0]
    # both rules apply; multiplication should stack sequentially
    assert res["new_rate"] == round(100 * 1.1 * 1.2, 2)


def test_simulate_rate_changes_missing_field():
    sample = [{"room_type": "z", "booking_window": 0, "current_rate": 50}]
    # rule checks occupancy percentage which is absent -> should not apply
    rule = make_rule(0, 50)
    res = local_gui.simulate_rate_changes([rule], sample)[0]
    assert res["new_rate"] == 50


def test_preview_no_rules(capsys):
    # missing "rules" key should print error and return
    local_gui.preview_rate_changes_window({})
    assert "No rules loaded" in capsys.readouterr().out


def test_preview_opens_browser(monkeypatch):
    # patch webbrowser.open to capture the call instead of opening a browser
    opened = []
    monkeypatch.setattr(local_gui.webbrowser, "open", lambda url: opened.append(url))
    cfg = {"rules": [make_rule(80, 10)]}
    sample = [{"room_type": "a", "occupancy_percentage": 90, "booking_window": 1, "current_rate": 100}]
    local_gui.preview_rate_changes_window(cfg, sample_reservations=sample)
    assert len(opened) == 1
    assert opened[0].startswith("file://")
