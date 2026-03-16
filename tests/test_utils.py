import pytest

from utils import get_nested, detect_field, parse_date


def test_get_nested_simple():
    assert get_nested({"a": {"b": 1}}, "a.b") == 1
    assert get_nested({"a": {"b": 1}}, "a.c") is None
    assert get_nested({"a": 1}, "a.b") is None
    assert get_nested({"a": 1}, None) is None


def test_detect_field_matches(monkeypatch):
    sample = {"Foo": 5, "Bar": None}
    # if first candidate present, return it
    res = detect_field(sample, ["Foo", "Bar"], "test")
    assert res == "Foo"
    # if first candidate is None, next should be returned
    sample2 = {"Foo": None, "Bar": 10}
    res2 = detect_field(sample2, ["Foo", "Bar"], "test2")
    assert res2 == "Bar"


def test_detect_field_no_match(caplog):
    caplog.set_level("WARNING")
    sample = {"x": 1}
    res = detect_field(sample, ["a", "b"], "label")
    assert res is None
    assert "No field detected for 'label'" in caplog.text


def test_parse_date_valid():
    iso = "2025-01-02T03:04:05Z"
    dt = parse_date(iso)
    assert dt is not None and dt.isoformat().endswith("+00:00")


def test_parse_date_invalid():
    assert parse_date(None) is None
    assert parse_date(123) is None
    assert parse_date("not-a-date") is None
