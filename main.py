"""
MAYA (Machine Assisted Yield Automation) — Multi-Hotel SaaS Entry Point

Orchestration flow:
  1. Ensure Postgres schema exists.
  2. Seed a demo hotel if the table is empty.
  3. Run one immediate batch (fetch → ETL → metrics → rules).
  4. Print first 3 sample reservations as JSON.
  5. Start APScheduler for recurring 5-minute batch fetches.
  6. Block until Ctrl+C.
"""

from __future__ import annotations

import json
import sys
import time

import requests

from config import DB_DSN, logger
from db import create_schema, get_connection, load_all_hotels, upsert_hotel
from models import Hotel
from scheduler import process_hotel, start_scheduler


def seed_demo_hotel(dsn: str = DB_DSN) -> Hotel:
    """Insert a placeholder hotel if the hotels table is empty."""
    with get_connection(dsn) as conn:
        existing = load_all_hotels(conn)
        if existing:
            return existing[0]

        demo = Hotel(
            name="Demo Hotel",
            client_token="YOUR_CLIENT_TOKEN",
            access_token="YOUR_ACCESS_TOKEN",
            enterprise_id="YOUR_ENTERPRISE_ID",
        )
        demo.id = upsert_hotel(conn, demo)
    logger.info("Seeded demo hotel with id=%d.", demo.id)
    return demo


def main() -> None:
    """Initialise schema, run first batch, start scheduler, print samples."""
    create_schema()
    hotel = seed_demo_hotel()

    try:
        reservations = process_hotel(hotel)
    except requests.exceptions.HTTPError as exc:
        logger.error("HTTP %d: %s", exc.response.status_code, exc.response.text)
        sys.exit(1)
    except requests.exceptions.RequestException as exc:
        logger.error("Request failed: %s", exc)
        sys.exit(1)

    print(f"\nTotal reservations: {len(reservations)}")
    print("First 3 records:")
    for res in reservations[:3]:
        print(json.dumps(res.to_dict(), indent=2))

    scheduler = start_scheduler()
    logger.info("Running. Press Ctrl+C to stop.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        scheduler.shutdown()
        logger.info("Scheduler stopped.")


if __name__ == "__main__":
    main()
