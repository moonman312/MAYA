"""
Shared utility functions: nested-dict traversal, field detection, date parsing.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from config import logger


def get_nested(obj: dict[str, Any], dotted_key: Optional[str]) -> Any:
    """Traverse a dict using a dot-separated key path.

    >>> get_nested({"a": {"b": 1}}, "a.b")
    1
    """
    if dotted_key is None:
        return None
    val: Any = obj
    for part in dotted_key.split("."):
        if isinstance(val, dict):
            val = val.get(part)
        else:
            return None
    return val


def detect_field(
    sample: dict[str, Any],
    candidates: list[str],
    label: str,
) -> Optional[str]:
    """Return the first candidate key whose value is non-None in *sample*.

    Falls back to ``None`` and logs a warning when nothing matches.
    """
    for candidate in candidates:
        if get_nested(sample, candidate) is not None:
            return candidate
    logger.warning("No field detected for '%s'. Tried: %s", label, candidates)
    return None


def parse_date(date_str: Any) -> Optional[datetime]:
    """Parse an ISO-8601 date string into a timezone-aware datetime.

    Handles the trailing ``Z`` by replacing it with ``+00:00``.
    Returns ``None`` for non-string or unparseable input.
    """
    if not isinstance(date_str, str):
        return None
    try:
        return datetime.fromisoformat(date_str.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
