#!/usr/bin/env python3
"""
Demo environment bootstrap — register the Mews demo hotel in Postgres
and optionally run one full pipeline cycle.

Steps:
  1. Ensure the database schema exists.
  2. Upsert a "Mews Demo Hotel" with the public demo credentials.
  3. (Optional) Run one cycle of process_hotel() to fetch live data.

Usage:
    python3 tools/setup_demo.py             # register only
    python3 tools/setup_demo.py --run       # register + one pipeline cycle
    python3 tools/setup_demo.py --net       # use the NET/US demo token
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# ensure project root is on sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import (
    DB_DSN,
    MEWS_BASE_URL,
    MEWS_DEMO_ACCESS_TOKEN_GROSS,
    MEWS_DEMO_ACCESS_TOKEN_NET,
    MEWS_DEMO_CLIENT_TOKEN,
    logger,
)
from db import create_schema, get_connection, upsert_hotel
from models import Hotel


def main() -> None:
    parser = argparse.ArgumentParser(description="MAYA demo environment setup")
    parser.add_argument(
        "--run", action="store_true",
        help="Run one full pipeline cycle after registering the hotel",
    )
    parser.add_argument(
        "--net", action="store_true",
        help="Use the NET/US demo access token instead of GROSS/UK",
    )
    parser.add_argument(
        "--rooms", type=int, default=30,
        help="Total rooms per type for the demo hotel (default: 30)",
    )
    args = parser.parse_args()

    access_token = (
        MEWS_DEMO_ACCESS_TOKEN_NET if args.net
        else MEWS_DEMO_ACCESS_TOKEN_GROSS
    )
    label = "NET/US" if args.net else "GROSS/UK"

    # ── 1. Schema ────────────────────────────────────────────────────────
    print("1/3  Ensuring database schema …")
    create_schema(DB_DSN)

    # ── 2. Upsert demo hotel ─────────────────────────────────────────────
    print(f"2/3  Registering Mews Demo Hotel ({label}) …")
    demo_hotel = Hotel(
        name=f"Mews Demo Hotel ({label})",
        client_token=MEWS_DEMO_CLIENT_TOKEN,
        access_token=access_token,
        enterprise_id="",  # will be discovered on first fetch
        base_url=MEWS_BASE_URL,
        total_rooms_per_type=args.rooms,
    )
    with get_connection(DB_DSN) as conn:
        hotel_id = upsert_hotel(conn, demo_hotel)
    print(f"     → hotel id = {hotel_id}")

    # ── 3. Optional pipeline run ─────────────────────────────────────────
    if args.run:
        print("3/3  Running one pipeline cycle …")
        # import here to avoid circular imports during schema-only setup
        from scheduler import process_hotel as _process_hotel

        demo_hotel.id = hotel_id
        reservations = _process_hotel(demo_hotel, DB_DSN)
        print(f"     → {len(reservations)} reservations processed")
    else:
        print("3/3  Skipped pipeline run (use --run to execute).")

    print("\n✅  Demo setup complete!")
    print(f"    Base URL:  {MEWS_BASE_URL}")
    print(f"    Hotel ID:  {hotel_id}")
    print(f"    Token set: {label}")


if __name__ == "__main__":
    main()
