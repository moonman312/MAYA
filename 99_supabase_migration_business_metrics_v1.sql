-- MAYA Business Metrics v1 Migration
-- One row per hotel per day: status, rooms, and the month-equivalent money it
-- represents. Point-in-time questions ("what's MRR now?") never needed this;
-- trends, churn, and win-backs do — a subscription row is upserted in place,
-- so yesterday's truth is gone unless something wrote it down. This table is
-- that something. Charts begin accumulating the day it ships; there is no
-- backfill, because the history was never recorded anywhere.
--
-- Run AFTER 99_supabase_migration_internal_plan_v1.sql. Idempotent.
-- Written nightly by /api/admin/metrics-snapshot (cron example) and lazily by
-- the analytics page for today, so a quiet deployment still accumulates.

begin;

create table if not exists hotel_metrics_daily (
  day             date not null,
  hotel_id        uuid not null references hotels(id) on delete cascade,
  status          text not null,
  entitled        boolean not null,
  plan_kind       text not null default 'stripe',
  rooms           integer not null default 0,
  -- Month-equivalent cents (annual divided by twelve) so every day sums into
  -- one comparable line. Internal plans carry zero — they are fleet, not MRR.
  list_mrr_cents  integer not null default 0,
  net_mrr_cents   integer not null default 0,
  simulation      boolean not null default false,
  primary key (day, hotel_id)
);

create index if not exists idx_hotel_metrics_daily_day on hotel_metrics_daily (day);

alter table hotel_metrics_daily enable row level security;
-- Service-role only: revenue per customer is nobody else's business.
revoke all on hotel_metrics_daily from anon, authenticated;

commit;
