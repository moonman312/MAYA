from datetime import datetime, date

from metrics import compute_metrics_rows, enrich_reservations_from_cache
from models import Reservation, MetricsRow


def make_reservation(stay: datetime, room: str) -> Reservation:
    return Reservation(hotel_id=1, room_type=room, stay_date=stay)


def test_compute_metrics_rows_first_run():
    """On first run (no previous), pickup_rate == occupancy."""
    r1 = make_reservation(datetime(2025, 5, 1, 12, 0), "a")
    r2 = make_reservation(datetime(2025, 5, 1, 13, 0), "a")
    r3 = make_reservation(datetime(2025, 5, 2, 12, 0), "b")
    rows = compute_metrics_rows([r1, r2, r3], hotel_id=7)
    assert len(rows) == 2
    keyset = {(r.room_type, r.stay_date) for r in rows}
    assert ("a", date(2025, 5, 1)) in keyset
    for r in rows:
        if r.room_type == "a":
            assert r.occupancy == 2
            assert r.pickup_rate == 2  # first run: pickup == occupancy


def test_compute_metrics_rows_with_previous():
    """When previous metrics exist, pickup = current_count - previous_occupancy."""
    r1 = make_reservation(datetime(2025, 5, 1, 12, 0), "a")
    r2 = make_reservation(datetime(2025, 5, 1, 13, 0), "a")
    r3 = make_reservation(datetime(2025, 5, 1, 14, 0), "a")
    previous = {
        ("a", date(2025, 5, 1)): MetricsRow(hotel_id=7, room_type="a",
                                             stay_date=date(2025, 5, 1),
                                             occupancy=2, pickup_rate=2),
    }
    rows = compute_metrics_rows([r1, r2, r3], hotel_id=7, previous=previous)
    assert len(rows) == 1
    assert rows[0].occupancy == 3
    assert rows[0].pickup_rate == 1  # 3 - 2 = 1 new reservation


def test_enrich_reservations_from_cache():
    r = make_reservation(datetime(2025, 5, 1, 0, 0), "x")
    rows = {("x", date(2025, 5, 1)): MetricsRow(occupancy=10, pickup_rate=5)}
    enrich_reservations_from_cache([r], rows)
    assert r.occupancy == 10
    assert r.pickup_rate == 5


def test_compute_with_zero_and_cached_zero():
    # occupancy zero is represented by a cached row only
    r = make_reservation(datetime(2025, 5, 3, 0, 0), "y")
    rows = compute_metrics_rows([r], hotel_id=8)
    assert len(rows) == 1
    assert rows[0].occupancy == 1  # each reservation counts as one
    # enrich with a zero-occupancy row
    r2 = make_reservation(datetime(2025, 5, 4, 0, 0), "z")
    cached = {("z", date(2025, 5, 4)): MetricsRow(occupancy=0, pickup_rate=100)}
    enrich_reservations_from_cache([r2], cached)
    assert r2.occupancy == 0
    assert r2.pickup_rate == 100
