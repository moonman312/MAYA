"""
Rules engine — JSON-based revenue-management rules.

Rules are stored per-hotel in the ``rules`` table using a unified format:
  * ``conditions`` — dict of field→operator+value (e.g. ``{"occupancy_percentage": ">80"}``)
  * ``action``     — dict (e.g. ``{"adjust_rate_percent": 10}``)
  * ``room_types`` — list of room-type names (empty = all)

At runtime, ``RuleConfig`` objects are evaluated directly against
``Reservation`` dicts — no OOP subclassing required.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from config import logger
from models import Reservation, RuleConfig


def rule_matches(rule: RuleConfig, res_data: dict[str, Any]) -> bool:
    """Return True when every condition in *rule* is satisfied by *res_data*.

    ``res_data`` should contain keys like ``occupancy_percentage``, ``booking_window``,
    ``pickup_rate``, ``room_type``, ``rate``.
    """
    rt_filter = rule.room_types or []
    if rt_filter and res_data.get("room_type") not in rt_filter:
        return False
    for key, val in rule.conditions.items():
        if key not in res_data:
            return False
        res_val = res_data[key]
        if isinstance(val, str):
            if val.startswith(">") and not res_val > float(val[1:]):
                return False
            elif val.startswith("<") and not res_val < float(val[1:]):
                return False
            elif val.startswith("=") and not res_val == float(val[1:]):
                return False
        else:
            if res_val != val:
                return False
    return True


def compute_new_rate(rate: float, action: dict[str, Any]) -> float:
    """Apply a rule action to compute the new rate."""
    new_rate = rate
    if "adjust_rate_percent" in action:
        new_rate *= 1 + action["adjust_rate_percent"] / 100
    if "adjust_rate_dollars" in action:
        new_rate += action["adjust_rate_dollars"]
    return round(new_rate, 2)


def reservation_to_eval_dict(res: Reservation, total_rooms: int) -> dict[str, Any]:
    """Convert a Reservation dataclass into a dict suitable for rule evaluation."""
    occ_pct = 0.0
    if res.occupancy is not None and total_rooms > 0:
        occ_pct = round(res.occupancy / total_rooms * 100, 1)
    return {
        "room_type": res.room_type,
        "occupancy_percentage": occ_pct,
        "booking_window": res.booking_window or 0,
        "pickup_rate": res.pickup_rate or 0,
        "rate": res.rate or 0,
    }


def apply_rules(
    reservations: list[Reservation],
    rules: list[RuleConfig],
    total_rooms: int = 100,
    applied: set[tuple[int, date]] | None = None,
) -> tuple[int, set[tuple[int, date]]]:
    """Evaluate every rule against every reservation.

    Rules fire **at most once per stay date**, ever.  Pass the set of
    previously applied ``(rule_id, stay_date)`` pairs via *applied*; any
    matching pair is skipped.  Newly fired pairs are returned as the second
    element of the return tuple so the caller can persist them.

    Rules without a database id (e.g. in unit tests) bypass tracking and
    always fire when conditions match.

    Returns ``(fired_count, newly_applied)`` where *fired_count* is the number
    of unique ``(rule, stay_date)`` pairs triggered this cycle and
    *newly_applied* is the set of those pairs to be written to the DB.

    Modifies ``reservation.rate`` in place.
    """
    applied = applied or set()
    newly_applied: set[tuple[int, date]] = set()
    fired = 0

    for res in reservations:
        if res.rate is None:
            continue
        stay_date = res.stay_date.date() if res.stay_date else None
        effective_rate = res.rate  # start from the current Mews rate
        eval_dict = reservation_to_eval_dict(res, total_rooms)

        for rule in rules:
            # Rules with a DB id are tracked; skip if already applied on this date.
            if rule.id is not None:
                key = (rule.id, stay_date)
                if key in applied:
                    continue  # fired in a prior cycle — permanent skip

            if rule_matches(rule, eval_dict):
                effective_rate = compute_new_rate(effective_rate, rule.action)
                eval_dict["rate"] = effective_rate
                logger.info(
                    "Rule [%s]: reservation %s %.2f -> %.2f (stay %s)",
                    rule.rule_name, res.reservation_id, res.rate, effective_rate, stay_date,
                )
                # Count and record each unique (rule, date) pair once.
                if rule.id is not None:
                    key = (rule.id, stay_date)
                    if key not in newly_applied:
                        newly_applied.add(key)
                        fired += 1
                else:
                    fired += 1  # untracked rules (tests): count every match

        res.rate = effective_rate
    return fired, newly_applied
