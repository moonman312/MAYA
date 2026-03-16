from datetime import datetime

import pytest

from etl import (
    detect_field_map,
    build_category_map,
    extract_room_types,
    find_reservations_list,
    extract_rate,
    parse_single_reservation,
    parse_api_response,
)
from models import RoomType


def test_detect_field_map(sample_raw_reservation):
    fmap = detect_field_map(sample_raw_reservation)
    assert fmap.reservation_id == "Id"
    assert fmap.stay_date == "ArrivalDate"
    assert fmap.booking_date == "CreatedUtc"
    assert fmap.room_type_id == "SpaceCategoryId"
    assert fmap.rate == "StayPriceIncludingTaxes"


def test_build_category_map(sample_api_response):
    cats = build_category_map(sample_api_response)
    assert cats == {"room_1": "Medium"}


def test_extract_room_types():
    cats = {"a": "A", "b": "B"}
    rts = extract_room_types(cats, hotel_id=5)
    assert all(isinstance(rt, RoomType) for rt in rts)
    assert {rt.category_id for rt in rts} == {"a", "b"}


def test_find_reservations_list(sample_api_response):
    lst = find_reservations_list(sample_api_response)
    assert isinstance(lst, list) and len(lst) == 1
    assert lst[0]["Id"] == "res_123"


def test_extract_rate():
    assert extract_rate({"value": 1}, None) is None
    assert extract_rate({"Rate": {"Value": "55.5"}}, "Rate") == 55.5
    assert extract_rate({"Rate": {"Value": "not"}}, "Rate") is None


def test_parse_single_reservation(sample_raw_reservation, sample_api_response):
    fmap = detect_field_map(sample_raw_reservation)
    cats = build_category_map(sample_api_response)
    res = parse_single_reservation(sample_raw_reservation, fmap, cats, hotel_id=99)
    assert res.hotel_id == 99
    assert res.reservation_id == "res_123"
    assert res.booking_window == (res.stay_date - res.booking_date).days
    assert res.rate == 150.0


def test_parse_api_response(sample_api_response):
    res_list, rtypes = parse_api_response(sample_api_response, hotel_id=42)
    assert len(res_list) == 1
    assert res_list[0].hotel_id == 42
    assert len(rtypes) == 1
    assert rtypes[0].hotel_id == 42


def test_parse_api_response_empty():
    empty = {}
    res, rts = parse_api_response(empty, hotel_id=1)
    assert res == []
    assert rts == []


def test_detect_field_map_alternative_and_null(alt_fields_reservation):
    fmap = detect_field_map(alt_fields_reservation)
    # reservation_id should pick ReservationId
    assert fmap.reservation_id == "ReservationId"
    # stay_date should pick ScheduledStartUtc (since ArrivalDate not present)
    assert fmap.stay_date == "ScheduledStartUtc"
    # booking_date should pick CreateDate
    assert fmap.booking_date == "CreateDate"
    # room_type_id candidate is None and should log warning -> result None
    assert fmap.room_type_id is None


def test_parse_single_booking_window_and_rate_missing(sample_raw_reservation):
    # modify sample to have equal stay/booking dates and no rate
    raw = sample_raw_reservation.copy()
    raw["ArrivalDate"] = "2025-05-01T00:00:00Z"
    raw["CreatedUtc"] = "2025-05-01T00:00:00Z"
    del raw["StayPriceIncludingTaxes"]
    fmap = detect_field_map(raw)
    cats = build_category_map({"SpaceCategories": []})
    res = parse_single_reservation(raw, fmap, cats, hotel_id=7)
    assert res.booking_window == 0
    assert res.rate is None
