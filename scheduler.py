"""
Batch scheduler — fetches and processes reservations for all hotels on a
configurable interval using APScheduler.
"""

from __future__ import annotations

import requests
from apscheduler.schedulers.background import BackgroundScheduler

from api_client import MewsApiClient
from config import BATCH_INTERVAL_MINUTES, DB_DSN, logger

# import config loader so we can refresh hotel JSON files alongside the
# reservation batch job; importing here avoids a circular reference from
# ``rms_engine`` modules back into core packages.
from rms_engine import config_loader
from db import (
    get_connection,
    insert_audit_log,
    insert_default_rules,
    load_all_hotels,
    load_metrics,
    load_rule_configs,
    upsert_metrics,
    upsert_reservations,
    upsert_room_types,
)
from etl import parse_api_response
from metrics import compute_metrics_rows, enrich_reservations_from_cache
from models import Hotel, Reservation
from rules_engine import apply_rules


def process_hotel(hotel: Hotel, dsn: str = DB_DSN) -> list[Reservation]:
    """Full pipeline for one hotel: fetch → ETL → store → metrics → rules."""
    logger.info("Processing hotel %d: %s", hotel.id, hotel.name)

    client = MewsApiClient(hotel)
    raw_data = client.fetch_reservations()

    reservations, room_types = parse_api_response(raw_data, hotel.id)
    logger.info(
        "Hotel %d: parsed %d reservations, %d room types.",
        hotel.id, len(reservations), len(room_types),
    )

    with get_connection(dsn) as conn:
        upsert_room_types(conn, hotel.id, room_types)
        upsert_reservations(conn, hotel.id, reservations)

        # load previous metrics so pickup_rate = current − previous occupancy
        previous = load_metrics(conn, hotel.id)
        rows = compute_metrics_rows(reservations, hotel.id, previous=previous)
        upsert_metrics(conn, hotel.id, rows)
        logger.info("Hotel %d: cached %d metrics rows.", hotel.id, len(rows))

        cached = load_metrics(conn, hotel.id)
        enrich_reservations_from_cache(reservations, cached)

        insert_default_rules(conn, hotel.id)
        rule_cfgs = load_rule_configs(conn, hotel.id)

    # capture original rates so we can detect changes
    original_rates = {res.reservation_id: res.rate for res in reservations if res.rate is not None}

    fired = apply_rules(reservations, rule_cfgs, total_rooms=hotel.total_rooms_per_type)
    logger.info("Hotel %d: %d rule(s), %d fired.", hotel.id, len(rule_cfgs), fired)

    # audit-log any rate changes
    if fired:
        with get_connection(dsn) as conn:
            for res in reservations:
                orig = original_rates.get(res.reservation_id)
                if orig is not None and res.rate != orig:
                    insert_audit_log(
                        conn, hotel.id,
                        event_type="rate_adjustment",
                        entity_type="reservation",
                        entity_id=res.reservation_id or "",
                        detail={
                            "room_type": res.room_type,
                            "original_rate": orig,
                            "new_rate": res.rate,
                            "stay_date": str(res.stay_date),
                        },
                    )

    return reservations


def batch_fetch_all_hotels(dsn: str = DB_DSN) -> None:
    """Iterate over every hotel in the database and run the full pipeline."""
    logger.info("Batch run started.")
    with get_connection(dsn) as conn:
        hotels = load_all_hotels(conn)

    if not hotels:
        logger.warning("No hotels configured — skipping batch.")
        return

    for hotel in hotels:
        try:
            process_hotel(hotel, dsn)
        except requests.exceptions.HTTPError as exc:
            logger.error(
                "Hotel %d HTTP %d: %s",
                hotel.id, exc.response.status_code, exc.response.text[:500],
            )
        except requests.exceptions.RequestException as exc:
            logger.error("Hotel %d request failed: %s", hotel.id, exc)
        except Exception as exc:
            logger.exception("Hotel %d unexpected error: %s", hotel.id, exc)

    logger.info("Batch run complete for %d hotel(s).", len(hotels))


def start_scheduler(dsn: str = DB_DSN) -> BackgroundScheduler:
    """Start APScheduler to run ``batch_fetch_all_hotels`` every N minutes."""
    sched = BackgroundScheduler()
    sched.add_job(
        batch_fetch_all_hotels,
        "interval",
        minutes=BATCH_INTERVAL_MINUTES,
        args=[dsn],
        id="maya_batch_fetch",
        replace_existing=True,
    )
    sched.start()
    # start config reload job as well; this will immediately populate the cache
    config_loader.start_config_scheduler(interval_minutes=BATCH_INTERVAL_MINUTES)
    logger.info("Scheduler started — batch every %d min and config reload scheduled.", BATCH_INTERVAL_MINUTES)
    return sched
