#!/usr/bin/env python3
"""
Smoke-test script — verify connectivity to the Mews demo environment.

Runs three quick checks:
  1. POST /configuration/get  → confirms auth + returns enterprise metadata
  2. POST /reservations/getAll → fetches a small page of reservations
  3. ETL parse                 → runs the MAYA ETL layer on the live response

Usage:
    python3 tools/smoke_test_mews.py [--access-token TOKEN]

If no --access-token is given the script defaults to the GROSS (UK) demo
token from the Mews documentation.
"""

from __future__ import annotations

import argparse
import json
import sys
import textwrap
import time
from pathlib import Path

import requests

# ensure project root is on sys.path so we can import project modules
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import (
    MEWS_BASE_URL,
    MEWS_CLIENT_NAME,
    MEWS_DEMO_ACCESS_TOKEN_GROSS,
    MEWS_DEMO_CLIENT_TOKEN,
    logger,
)
from etl import parse_api_response


# ── Helpers ──────────────────────────────────────────────────────────────────

def _post(endpoint: str, payload: dict) -> dict:
    """POST to a Mews Connector API endpoint and return the JSON response."""
    url = f"{MEWS_BASE_URL.rstrip('/')}/{endpoint}"
    t0 = time.time()
    resp = requests.post(
        url,
        json=payload,
        headers={"Content-Type": "application/json"},
        timeout=30,
    )
    elapsed = time.time() - t0
    resp.raise_for_status()
    data = resp.json()
    logger.info("  ✓ %s  [%d] %.1fs", endpoint, resp.status_code, elapsed)
    return data


def _base_payload(access_token: str) -> dict:
    return {
        "ClientToken": MEWS_DEMO_CLIENT_TOKEN,
        "AccessToken": access_token,
        "Client": MEWS_CLIENT_NAME,
    }


# ── Checks ───────────────────────────────────────────────────────────────────

def check_configuration(access_token: str) -> dict:
    """1. Hit /configuration/get — validates tokens and returns enterprise info."""
    print("\n─── Check 1: configuration/get ───────────────────────────")
    payload = _base_payload(access_token)
    data = _post("configuration/get", payload)
    enterprise = data.get("Enterprise", data.get("Enterprises", [{}]))
    if isinstance(enterprise, list):
        enterprise = enterprise[0] if enterprise else {}
    name = enterprise.get("Name", "(unknown)")
    eid = enterprise.get("Id", "(unknown)")
    print(f"  Enterprise: {name}")
    print(f"  Enterprise ID: {eid}")
    return data


def check_reservations(access_token: str) -> dict:
    """2. Hit /reservations/getAll — fetch a small page of reservations.

    Mews limits the date interval to **100 hours** per request, so we
    use a 4-day window centred on "now".
    """
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    start = (now - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    end = (now + timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ")

    print("\n─── Check 2: reservations/getAll ─────────────────────────")
    print(f"  Window: {start}  →  {end}")
    payload = {
        **_base_payload(access_token),
        "StartUtc": start,
        "EndUtc": end,
        "Extent": {
            "Reservations": True,
            "SpaceCategories": True,
            "ResourceCategories": True,
            "Items": True,
        },
        "Limitation": {"Count": 10},
    }
    data = _post("reservations/getAll", payload)

    # summarise
    res_key = "Reservations" if "Reservations" in data else "Items"
    res_list = data.get(res_key, [])
    cat_list = data.get("SpaceCategories") or data.get("ResourceCategories") or []
    cursor = data.get("Cursor")
    print(f"  Reservations returned: {len(res_list)}")
    print(f"  Space categories:      {len(cat_list)}")
    print(f"  Cursor (more pages?):  {cursor or 'None (last page)'}")

    if res_list:
        sample = res_list[0]
        print(f"  Sample reservation ID: {sample.get('Id', '?')}")
        print(f"  Sample keys:           {sorted(sample.keys())[:8]}…")
    return data


def check_etl_parse(raw_data: dict) -> None:
    """3. Run the MAYA ETL layer on the live API response."""
    print("\n─── Check 3: ETL parse ──────────────────────────────────")
    reservations, room_types = parse_api_response(raw_data, hotel_id=0)
    print(f"  Parsed reservations:   {len(reservations)}")
    print(f"  Room types detected:   {len(room_types)}")
    if reservations:
        r = reservations[0]
        print(f"  First reservation →  room_type={r.room_type}, "
              f"rate={r.rate}, window={r.booking_window}d")
    if room_types:
        names = [rt.name for rt in room_types]
        print(f"  Room type names:       {names}")


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="MAYA ↔ Mews demo smoke test")
    parser.add_argument(
        "--access-token",
        default=MEWS_DEMO_ACCESS_TOKEN_GROSS,
        help="Mews AccessToken (defaults to the GROSS/UK demo token)",
    )
    args = parser.parse_args()

    print(textwrap.dedent(f"""\
        ╔══════════════════════════════════════════════════╗
        ║  MAYA ↔ Mews Demo Smoke Test                    ║
        ╠══════════════════════════════════════════════════╣
        ║  Base URL : {MEWS_BASE_URL:<36s} ║
        ║  Client   : {MEWS_CLIENT_NAME:<36s} ║
        ╚══════════════════════════════════════════════════╝"""))

    try:
        check_configuration(args.access_token)
        raw = check_reservations(args.access_token)
        check_etl_parse(raw)
        print("\n✅  All smoke-test checks passed!\n")
    except requests.exceptions.HTTPError as exc:
        print(f"\n❌  HTTP error: {exc.response.status_code}")
        print(f"    {exc.response.text[:500]}")
        sys.exit(1)
    except requests.exceptions.ConnectionError as exc:
        print(f"\n❌  Connection error: {exc}")
        sys.exit(1)
    except Exception as exc:
        print(f"\n❌  Unexpected error: {exc}")
        raise


if __name__ == "__main__":
    main()
