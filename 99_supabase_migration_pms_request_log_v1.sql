-- MAYA PMS Request Log v1 Migration
-- Adds pms_request_log: one row per outbound PMS API call (Cloudbeds today),
-- written fire-and-forget by the service-role sync / onboarding workers.
-- Powers the dashboard PMS health strip (24h success rate + activity feed).
--
-- Run AFTER 02_supabase_schema.sql. Safe to re-run (idempotent guards).
-- Also folded into 02_supabase_schema.sql; drop added to 00_supabase_reset_dev.

begin;

-- ── pms_request_log: one row per outbound PMS API request ───────────────────

create table if not exists pms_request_log (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  pms_type pms_type not null,
  http_method text not null,
  endpoint text not null,
  status_code integer,
  ok boolean not null,
  duration_ms integer,
  message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_pms_request_log_hotel
  on pms_request_log(hotel_id, created_at desc);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Members can watch their hotel's PMS traffic; only the service-role
-- workers write (same pattern as import_jobs).

alter table pms_request_log enable row level security;

drop policy if exists pms_request_log_read on pms_request_log;
create policy pms_request_log_read on pms_request_log
  for select using (is_hotel_accessible(hotel_id));
revoke insert, update, delete on pms_request_log from anon, authenticated;

commit;
