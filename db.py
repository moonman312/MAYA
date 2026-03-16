"""
PostgreSQL database layer — schema management and CRUD for every entity.

All tables include ``hotel_id`` for multi-tenant isolation.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from datetime import date
from typing import Any, Generator

import psycopg2
import psycopg2.extras

from config import DB_DSN, logger
from models import Hotel, MetricsRow, Reservation, RoomType, RuleConfig


# ── Connection helper ─────────────────────────────────────────────────────────

@contextmanager
def get_connection(dsn: str = DB_DSN) -> Generator[psycopg2.extensions.connection, None, None]:
    """Yield a psycopg2 connection; commits on success, rolls back on error."""
    conn = psycopg2.connect(dsn)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ── Schema ────────────────────────────────────────────────────────────────────

_DDL = """
CREATE TABLE IF NOT EXISTS hotels (
    id                  SERIAL PRIMARY KEY,
    name                TEXT NOT NULL,
    client_token        TEXT NOT NULL,
    access_token        TEXT NOT NULL,
    enterprise_id       TEXT NOT NULL,
    base_url            TEXT NOT NULL DEFAULT 'https://api.mews.com/api/connector/v1',
    total_rooms_per_type INTEGER NOT NULL DEFAULT 100,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS room_types (
    id          SERIAL PRIMARY KEY,
    hotel_id    INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT 'Unknown',
    UNIQUE (hotel_id, category_id)
);

CREATE TABLE IF NOT EXISTS reservations (
    id              SERIAL PRIMARY KEY,
    hotel_id        INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    reservation_id  TEXT,
    room_type       TEXT NOT NULL DEFAULT 'Unknown',
    stay_date       TIMESTAMPTZ,
    booking_date    TIMESTAMPTZ,
    booking_window  INTEGER,
    rate            DOUBLE PRECISION,
    raw_json        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (hotel_id, reservation_id)
);

CREATE TABLE IF NOT EXISTS metrics (
    id          SERIAL PRIMARY KEY,
    hotel_id    INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    room_type   TEXT NOT NULL,
    stay_date   DATE NOT NULL,
    occupancy   INTEGER NOT NULL DEFAULT 0,
    pickup_rate INTEGER NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (hotel_id, room_type, stay_date)
);

CREATE TABLE IF NOT EXISTS rules (
    id          SERIAL PRIMARY KEY,
    hotel_id    INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    rule_name   TEXT NOT NULL DEFAULT '',
    conditions  JSONB NOT NULL DEFAULT '{}',
    action      JSONB NOT NULL DEFAULT '{}',
    room_types  JSONB NOT NULL DEFAULT '[]',
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
    id          SERIAL PRIMARY KEY,
    hotel_id    INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT '',
    entity_id   TEXT NOT NULL DEFAULT '',
    detail      JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_hotel ON audit_log (hotel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reservations_hotel     ON reservations (hotel_id);
CREATE INDEX IF NOT EXISTS idx_reservations_stay      ON reservations (hotel_id, stay_date);
CREATE INDEX IF NOT EXISTS idx_metrics_hotel_room_dt  ON metrics (hotel_id, room_type, stay_date);
"""


def create_schema(dsn: str = DB_DSN) -> None:
    """Create all tables and indexes if they do not exist."""
    with get_connection(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(_DDL)
    logger.info("Database schema ensured.")


# ── Hotels ────────────────────────────────────────────────────────────────────

def load_all_hotels(conn: psycopg2.extensions.connection) -> list[Hotel]:
    """Load every hotel from the database."""
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute(
            "SELECT id, name, client_token, access_token, enterprise_id, "
            "base_url, total_rooms_per_type FROM hotels ORDER BY id"
        )
        return [
            Hotel(
                id=r["id"], name=r["name"],
                client_token=r["client_token"],
                access_token=r["access_token"],
                enterprise_id=r["enterprise_id"],
                base_url=r["base_url"],
                total_rooms_per_type=r["total_rooms_per_type"],
            )
            for r in cur.fetchall()
        ]


def upsert_hotel(conn: psycopg2.extensions.connection, hotel: Hotel) -> int:
    """Insert or update a hotel, returning its database id."""
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO hotels (name, client_token, access_token, enterprise_id,
                                base_url, total_rooms_per_type)
            VALUES (%(name)s, %(client_token)s, %(access_token)s,
                    %(enterprise_id)s, %(base_url)s, %(total_rooms_per_type)s)
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                client_token = EXCLUDED.client_token,
                access_token = EXCLUDED.access_token,
                enterprise_id = EXCLUDED.enterprise_id,
                base_url = EXCLUDED.base_url,
                total_rooms_per_type = EXCLUDED.total_rooms_per_type
            RETURNING id
            """,
            {
                "name": hotel.name,
                "client_token": hotel.client_token,
                "access_token": hotel.access_token,
                "enterprise_id": hotel.enterprise_id,
                "base_url": hotel.base_url,
                "total_rooms_per_type": hotel.total_rooms_per_type,
            },
        )
        return cur.fetchone()[0]


# ── Room types ────────────────────────────────────────────────────────────────

def upsert_room_types(
    conn: psycopg2.extensions.connection,
    hotel_id: int,
    room_types: list[RoomType],
) -> None:
    """Upsert room-type records for a hotel."""
    with conn.cursor() as cur:
        for rt in room_types:
            cur.execute(
                """
                INSERT INTO room_types (hotel_id, category_id, name)
                VALUES (%s, %s, %s)
                ON CONFLICT (hotel_id, category_id)
                DO UPDATE SET name = EXCLUDED.name
                """,
                (hotel_id, rt.category_id, rt.name),
            )


# ── Reservations ──────────────────────────────────────────────────────────────

def upsert_reservations(
    conn: psycopg2.extensions.connection,
    hotel_id: int,
    reservations: list[Reservation],
) -> int:
    """Upsert parsed reservations. Returns the count written."""
    with conn.cursor() as cur:
        for res in reservations:
            raw = json.dumps(res.raw_json, default=str) if res.raw_json else None
            cur.execute(
                """
                INSERT INTO reservations
                    (hotel_id, reservation_id, room_type, stay_date,
                     booking_date, booking_window, rate, raw_json, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())
                ON CONFLICT (hotel_id, reservation_id)
                DO UPDATE SET
                    room_type      = EXCLUDED.room_type,
                    stay_date      = EXCLUDED.stay_date,
                    booking_date   = EXCLUDED.booking_date,
                    booking_window = EXCLUDED.booking_window,
                    rate           = EXCLUDED.rate,
                    raw_json       = EXCLUDED.raw_json,
                    updated_at     = NOW()
                """,
                (
                    hotel_id, res.reservation_id, res.room_type,
                    res.stay_date, res.booking_date, res.booking_window,
                    res.rate, raw,
                ),
            )
    return len(reservations)


def load_reservations(
    conn: psycopg2.extensions.connection,
    hotel_id: int,
) -> list[Reservation]:
    """Load all reservations for a hotel from the database."""
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute(
            "SELECT id, hotel_id, reservation_id, room_type, stay_date, "
            "booking_date, booking_window, rate "
            "FROM reservations WHERE hotel_id = %s ORDER BY stay_date",
            (hotel_id,),
        )
        return [
            Reservation(
                id=r["id"], hotel_id=r["hotel_id"],
                reservation_id=r["reservation_id"],
                room_type=r["room_type"],
                stay_date=r["stay_date"], booking_date=r["booking_date"],
                booking_window=r["booking_window"], rate=r["rate"],
            )
            for r in cur.fetchall()
        ]


# ── Metrics ───────────────────────────────────────────────────────────────────

def upsert_metrics(
    conn: psycopg2.extensions.connection,
    hotel_id: int,
    rows: list[MetricsRow],
) -> None:
    """Upsert computed metrics into Postgres for persistent caching."""
    with conn.cursor() as cur:
        for m in rows:
            cur.execute(
                """
                INSERT INTO metrics (hotel_id, room_type, stay_date,
                                     occupancy, pickup_rate, updated_at)
                VALUES (%s, %s, %s, %s, %s, NOW())
                ON CONFLICT (hotel_id, room_type, stay_date)
                DO UPDATE SET
                    occupancy   = EXCLUDED.occupancy,
                    pickup_rate = EXCLUDED.pickup_rate,
                    updated_at  = NOW()
                """,
                (hotel_id, m.room_type, m.stay_date, m.occupancy, m.pickup_rate),
            )


def load_metrics(
    conn: psycopg2.extensions.connection,
    hotel_id: int,
) -> dict[tuple[str, date], MetricsRow]:
    """Load cached metrics keyed by ``(room_type, stay_date)``."""
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute(
            "SELECT id, hotel_id, room_type, stay_date, occupancy, pickup_rate "
            "FROM metrics WHERE hotel_id = %s",
            (hotel_id,),
        )
        return {
            (r["room_type"], r["stay_date"]): MetricsRow(
                id=r["id"], hotel_id=r["hotel_id"],
                room_type=r["room_type"], stay_date=r["stay_date"],
                occupancy=r["occupancy"], pickup_rate=r["pickup_rate"],
            )
            for r in cur.fetchall()
        }


# ── Rules ─────────────────────────────────────────────────────────────────────

def load_rule_configs(
    conn: psycopg2.extensions.connection,
    hotel_id: int,
    enabled_only: bool = True,
) -> list[RuleConfig]:
    """Load rule configurations for a hotel."""
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        sql = (
            "SELECT id, hotel_id, rule_name, conditions, action, room_types, enabled "
            "FROM rules WHERE hotel_id = %s"
        )
        if enabled_only:
            sql += " AND enabled = TRUE"
        sql += " ORDER BY id"
        cur.execute(sql, (hotel_id,))
        return [_row_to_rule_config(r) for r in cur.fetchall()]


def load_all_rule_configs(
    conn: psycopg2.extensions.connection,
    hotel_id: int,
) -> list[RuleConfig]:
    """Load all rule configurations for a hotel (enabled and disabled)."""
    return load_rule_configs(conn, hotel_id, enabled_only=False)


def _row_to_rule_config(r: dict) -> RuleConfig:
    def _parse(val: Any) -> Any:
        return val if isinstance(val, (dict, list)) else json.loads(val)
    return RuleConfig(
        id=r["id"],
        hotel_id=r["hotel_id"],
        rule_name=r["rule_name"],
        conditions=_parse(r["conditions"]),
        action=_parse(r["action"]),
        room_types=_parse(r["room_types"]),
        enabled=r["enabled"],
    )


def upsert_rule(
    conn: psycopg2.extensions.connection,
    hotel_id: int,
    rule: RuleConfig,
) -> int:
    """Insert or update a rule. Returns the rule id."""
    with conn.cursor() as cur:
        if rule.id:
            cur.execute(
                """
                UPDATE rules SET rule_name=%s, conditions=%s, action=%s,
                    room_types=%s, enabled=%s, updated_at=NOW()
                WHERE id=%s AND hotel_id=%s RETURNING id
                """,
                (
                    rule.rule_name, json.dumps(rule.conditions),
                    json.dumps(rule.action), json.dumps(rule.room_types),
                    rule.enabled, rule.id, hotel_id,
                ),
            )
            row = cur.fetchone()
            if row:
                return row[0]
        cur.execute(
            """
            INSERT INTO rules (hotel_id, rule_name, conditions, action, room_types, enabled)
            VALUES (%s, %s, %s, %s, %s, %s) RETURNING id
            """,
            (
                hotel_id, rule.rule_name, json.dumps(rule.conditions),
                json.dumps(rule.action), json.dumps(rule.room_types), rule.enabled,
            ),
        )
        return cur.fetchone()[0]


def delete_rule(
    conn: psycopg2.extensions.connection,
    hotel_id: int,
    rule_id: int,
) -> bool:
    """Delete a rule by id. Returns True if a row was removed."""
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM rules WHERE id = %s AND hotel_id = %s",
            (rule_id, hotel_id),
        )
        return cur.rowcount > 0


def toggle_rule(
    conn: psycopg2.extensions.connection,
    hotel_id: int,
    rule_id: int,
) -> bool:
    """Toggle a rule's enabled flag. Returns True if found."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE rules SET enabled = NOT enabled, updated_at = NOW() "
            "WHERE id = %s AND hotel_id = %s",
            (rule_id, hotel_id),
        )
        return cur.rowcount > 0


def insert_default_rules(
    conn: psycopg2.extensions.connection,
    hotel_id: int,
) -> None:
    """Seed default rules if none exist yet."""
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM rules WHERE hotel_id = %s", (hotel_id,))
        if cur.fetchone()[0] == 0:
            defaults = [
                RuleConfig(
                    rule_name="High Occupancy Surge",
                    conditions={"occupancy_percentage": ">80"},
                    action={"adjust_rate_percent": 10},
                    room_types=[],
                    enabled=True,
                ),
                RuleConfig(
                    rule_name="Last-Minute Premium",
                    conditions={"booking_window": "<3", "occupancy_percentage": ">50"},
                    action={"adjust_rate_percent": 15},
                    room_types=[],
                    enabled=True,
                ),
            ]
            for rule in defaults:
                upsert_rule(conn, hotel_id, rule)
            logger.info("Seeded %d default rules for hotel %d.", len(defaults), hotel_id)


# ── Audit log ────────────────────────────────────────────────────────────────

def insert_audit_log(
    conn: psycopg2.extensions.connection,
    hotel_id: int,
    event_type: str,
    entity_type: str = "",
    entity_id: str = "",
    detail: dict[str, Any] | None = None,
) -> None:
    """Write an entry to the audit_log table."""
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO audit_log (hotel_id, event_type, entity_type, entity_id, detail) "
            "VALUES (%s, %s, %s, %s, %s)",
            (hotel_id, event_type, entity_type, entity_id, json.dumps(detail or {})),
        )
