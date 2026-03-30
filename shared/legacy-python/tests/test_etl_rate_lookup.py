"""Tests for etl.build_rate_lookup()."""
from __future__ import annotations

import pytest

from etl import build_rate_lookup


class TestBuildRateLookup:
    def test_single_item(self):
        data = {
            "Items": [
                {"OrderId": "r1", "Amount": {"GrossValue": 100.0}},
            ],
        }
        result = build_rate_lookup(data)
        assert result == {"r1": 100.0}

    def test_sums_multiple_items_per_reservation(self):
        data = {
            "Items": [
                {"OrderId": "r1", "Amount": {"GrossValue": 100.0}},
                {"OrderId": "r1", "Amount": {"GrossValue": 50.0}},
                {"OrderId": "r2", "Amount": {"GrossValue": 200.0}},
            ],
        }
        result = build_rate_lookup(data)
        assert result["r1"] == 150.0
        assert result["r2"] == 200.0

    def test_falls_back_to_value(self):
        data = {
            "Items": [
                {"OrderId": "r1", "Amount": {"Value": 75.0}},
            ],
        }
        result = build_rate_lookup(data)
        assert result == {"r1": 75.0}

    def test_prefers_gross_value_over_value(self):
        data = {
            "Items": [
                {"OrderId": "r1", "Amount": {"GrossValue": 100.0, "Value": 90.0}},
            ],
        }
        result = build_rate_lookup(data)
        assert result == {"r1": 100.0}

    def test_order_items_key(self):
        data = {
            "OrderItems": [
                {"OrderId": "r1", "Amount": {"GrossValue": 50.0}},
            ],
        }
        result = build_rate_lookup(data)
        assert result == {"r1": 50.0}

    def test_empty_items(self):
        assert build_rate_lookup({"Items": []}) == {}

    def test_no_items_key(self):
        assert build_rate_lookup({"Reservations": []}) == {}

    def test_none_items(self):
        assert build_rate_lookup({"Items": None}) == {}

    def test_skips_missing_order_id(self):
        data = {
            "Items": [
                {"Amount": {"GrossValue": 100.0}},
                {"OrderId": "r1", "Amount": {"GrossValue": 50.0}},
            ],
        }
        result = build_rate_lookup(data)
        assert result == {"r1": 50.0}

    def test_skips_missing_amount(self):
        data = {
            "Items": [
                {"OrderId": "r1"},
                {"OrderId": "r2", "Amount": {"GrossValue": 100.0}},
            ],
        }
        result = build_rate_lookup(data)
        assert result == {"r2": 100.0}

    def test_skips_invalid_amount_type(self):
        data = {
            "Items": [
                {"OrderId": "r1", "Amount": "not a dict"},
                {"OrderId": "r2", "Amount": {"GrossValue": 50.0}},
            ],
        }
        result = build_rate_lookup(data)
        assert result == {"r2": 50.0}

    def test_string_values_converted(self):
        data = {
            "Items": [
                {"OrderId": "r1", "Amount": {"GrossValue": "99.50"}},
            ],
        }
        result = build_rate_lookup(data)
        assert result == {"r1": 99.50}

    def test_skips_non_numeric_value(self):
        data = {
            "Items": [
                {"OrderId": "r1", "Amount": {"GrossValue": "not_a_number"}},
                {"OrderId": "r2", "Amount": {"GrossValue": 100.0}},
            ],
        }
        result = build_rate_lookup(data)
        # r1 should be skipped due to ValueError
        assert "r1" not in result
        assert result["r2"] == 100.0
