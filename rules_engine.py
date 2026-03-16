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
) -> int:
    """Evaluate every rule against every reservation. Returns fire count.

    Modifies ``reservation.rate`` in place when a rule fires.
    """
    fired = 0
    for res in reservations:
        if res.rate is None:
            continue
        eval_dict = reservation_to_eval_dict(res, total_rooms)
        for rule in rules:
            if rule_matches(rule, eval_dict):
                original = res.rate
                res.rate = compute_new_rate(res.rate, rule.action)
                # update eval_dict so stacked rules see the updated rate
                eval_dict["rate"] = res.rate
                logger.info(
                    "Rule [%s]: reservation %s rate %.2f -> %.2f",
                    rule.rule_name, res.reservation_id, original, res.rate,
                )
                fired += 1
    return fired
