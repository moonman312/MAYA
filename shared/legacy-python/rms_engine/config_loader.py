"""Configuration loader for hotel JSON files.

This module provides a simple file-based configuration system for the
multi-tenant RMS engine.  All JSON files placed under ``configs/`` are read
and validated, and their contents are cached in memory for fast lookup.
A background job periodically refreshes the cache so that changes to the
files are picked up automatically.

The public API consists of:

* ``load_all_configs()`` – read every ``*.json`` file and return a raw
  dict keyed by ``hotel_id``.
* ``start_config_scheduler(interval_minutes: int = 5)`` – start a
  background APScheduler job to refresh the in-memory cache every N minutes.
* ``get_config(hotel_id: int)`` – fetch the cached configuration for a
  specific hotel (or ``None`` if missing).

Internally the module keeps a thread-safe cache protected by a lock.  Only
standard libraries and the existing ``APScheduler`` dependency are used.
"""

from __future__ import annotations

import json
import logging
import os
from threading import Lock
from typing import Any, Dict, Optional

from apscheduler.schedulers.background import BackgroundScheduler

from config import logger as base_logger

# relative path to configuration files
CONFIG_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "configs")

_cache_lock = Lock()
_cache: Dict[int, Dict[str, Any]] = {}
_scheduler: Optional[BackgroundScheduler] = None

_log = base_logger.getChild("config_loader")


# ---- core loading logic ----------------------------------------------------

def _read_json_file(path: str) -> Optional[Dict[str, Any]]:
    """Load a JSON file and return its contents, or ``None`` on error.

    Only files ending in ``.json`` are considered; other names are ignored
    by the caller.  If parsing fails the error is logged and (optionally)
    the file is skipped.
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data
    except json.JSONDecodeError as exc:
        _log.warning("Skipping malformed JSON file %s: %s", path, exc)
    except OSError as exc:
        _log.error("Unable to read config file %s: %s", path, exc)
    return None


def load_all_configs() -> Dict[int, Dict[str, Any]]:
    """Scan the configs directory and load every hotel configuration.

    Returns a mapping ``hotel_id -> config dict``.  Invalid or duplicate
    hotel IDs are skipped with a warning.  This function does **not** modify
    the in-memory cache; it merely returns a fresh mapping.
    """
    configs: Dict[int, Dict[str, Any]] = {}

    if not os.path.isdir(CONFIG_DIR):
        _log.warning("Config directory %s does not exist", CONFIG_DIR)
        return configs

    for fname in os.listdir(CONFIG_DIR):
        if not fname.lower().endswith(".json"):
            continue
        path = os.path.join(CONFIG_DIR, fname)
        data = _read_json_file(path)
        if data is None:
            continue
        hotel_id = data.get("hotel_id")
        if hotel_id is None:
            _log.warning("File %s missing hotel_id; skipping", path)
            continue
        try:
            hotel_id = int(hotel_id)
        except (TypeError, ValueError):
            _log.warning("Invalid hotel_id in %s: %r", path, data.get("hotel_id"))
            continue
        if hotel_id in configs:
            _log.warning("Duplicate hotel_id %s in file %s; previous entry kept", hotel_id, path)
            continue
        configs[hotel_id] = data
    return configs


def _refresh_cache() -> None:
    """Internal helper invoked by the scheduler to reload configs."""
    _log.info("Reloading hotel config files from %s", CONFIG_DIR)
    new_configs = load_all_configs()
    with _cache_lock:
        _cache.clear()
        _cache.update(new_configs)
    _log.info("Config cache now holds %d hotel(s)", len(_cache))


# ---- public helpers --------------------------------------------------------

def start_config_scheduler(interval_minutes: int = 5) -> BackgroundScheduler:
    """Start (or restart) the background job that refreshes the cache.

    The job runs every ``interval_minutes`` minutes.  If the scheduler is
    already running, its interval will be updated.
    """
    global _scheduler
    if _scheduler is None:
        _scheduler = BackgroundScheduler()
        _scheduler.add_job(_refresh_cache, "interval", minutes=interval_minutes,
                           id="config_reload", replace_existing=True)
        _scheduler.start()
        _log.info("Started config reload scheduler every %d minutes", interval_minutes)
    else:
        # ``reschedule_job`` requires specifying the trigger type when
        # altering trigger arguments; without this it defaults to a "date"
        # trigger which does not accept ``minutes``.
        _scheduler.reschedule_job(
            "config_reload", trigger="interval", minutes=interval_minutes
        )
        _log.info("Rescheduled config reload interval to %d minutes", interval_minutes)
    # perform an immediate load
    _refresh_cache()
    return _scheduler


def get_config(hotel_id: int) -> Optional[Dict[str, Any]]:
    """Return the cached configuration dict for ``hotel_id`` or ``None``.

    The returned dictionary should be treated as read-only by callers; if
    modifications are required a deep copy should be made.  The cache is
    protected by a lock to make concurrent access safe.
    """
    with _cache_lock:
        return _cache.get(hotel_id)
