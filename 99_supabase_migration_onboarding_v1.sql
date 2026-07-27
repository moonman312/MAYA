-- ============================================================================
-- Onboarding flow (v1): "Hold My Hand" / "Let Me Drive"
--
-- New-customer onboarding: user picks a path after login; the guided path
-- connects a PMS, auto-creates the hotel from PMS data, imports multi-year
-- reservation history in the background (checkpointed import_jobs), asks
-- optional strategy questions (floor/ceiling/confidence), then surfaces
-- data-cleaning findings for review.
--
-- Run AFTER 02_supabase_schema.sql (+ command center migrations).
-- Also folded into 02_supabase_schema.sql; drops added to 00_supabase_reset_dev.
-- ============================================================================

-- ── Enums ───────────────────────────────────────────────────────────────────

do $$ begin
  create type onboarding_path as enum ('self_serve', 'guided');
exception when duplicate_object then null; end $$;

do $$ begin
  create type import_job_status as enum ('queued', 'running', 'completed', 'failed', 'canceled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type finding_kind as enum (
    'closed_period', 'suspect_room_type', 'duplicate_room_type',
    'rate_outlier', 'zero_rate_rows', 'unmapped_room_type', 'other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type finding_status as enum ('proposed', 'confirmed', 'dismissed', 'auto_applied');
exception when duplicate_object then null; end $$;

-- ── profiles: user-level path choice (works before any hotel exists) ─────────

alter table profiles
  add column if not exists onboarding_path onboarding_path,
  add column if not exists onboarding_dismissed_at timestamptz;

-- ── import_jobs: checkpointed background import ─────────────────────────────

create table if not exists import_jobs (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  pms_type pms_type not null,
  status import_job_status not null default 'queued',
  -- discover -> sync_current -> historical -> analyze -> done
  phase text not null default 'discover',
  requested_by uuid references auth.users(id) on delete set null,
  -- adaptive year-by-year depth: window 0 = last 365d (+forward, detail sync),
  -- window N = the year before window N-1 (slim list-only pull)
  window_index integer not null default 0,
  window_from date,
  window_to date,
  enum_cursor jsonb not null default '{}'::jsonb,
  row_cap integer not null default 300000,
  max_windows integer not null default 10,
  -- progress counters (drive the onboarding UI)
  reservations_enumerated integer not null default 0,
  rows_upserted integer not null default 0,
  windows_completed integer not null default 0,
  oldest_stay_date date,
  newest_stay_date date,
  -- worker coordination
  lease_expires_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  stats jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_import_jobs_runnable
  on import_jobs(status) where status in ('queued', 'running');
create index if not exists idx_import_jobs_hotel
  on import_jobs(hotel_id, created_at desc);
-- One active job per hotel: a duplicate import would fight the base_rate
-- first-seen trigger and double-count progress.
create unique index if not exists uq_import_jobs_one_active_per_hotel
  on import_jobs(hotel_id) where status in ('queued', 'running');

-- ── onboarding_states: per-hotel onboarding progress ────────────────────────

create table if not exists onboarding_states (
  hotel_id uuid primary key references hotels(id) on delete cascade,
  path onboarding_path not null default 'guided',
  import_job_id uuid references import_jobs(id) on delete set null,
  connected_at timestamptz,
  questions jsonb not null default '{}'::jsonb,
  questions_completed_at timestamptz,
  review_completed_at timestamptz,
  -- room count at completion; billing tier verification hook (no billing yet)
  payment_tier_rooms integer,
  payment_tier_flagged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── onboarding_findings: data-cleaning findings for the review step ─────────

create table if not exists onboarding_findings (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  job_id uuid references import_jobs(id) on delete set null,
  kind finding_kind not null,
  status finding_status not null default 'proposed',
  payload jsonb not null default '{}'::jsonb,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_onboarding_findings_hotel
  on onboarding_findings(hotel_id, status);

-- ── hotel_closed_periods: confirmed closures, excluded from analysis ────────

create table if not exists hotel_closed_periods (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  room_type_id uuid references room_types(id) on delete cascade, -- null = whole property
  start_date date not null,
  end_date date not null,
  source text not null default 'onboarding', -- onboarding | manual
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);

create index if not exists idx_hotel_closed_periods
  on hotel_closed_periods(hotel_id, start_date);

-- ── hotel_settings: strategy answers ────────────────────────────────────────

alter table hotel_settings
  add column if not exists strategy_floor numeric(10,2),
  add column if not exists strategy_ceiling numeric(10,2),
  add column if not exists pricing_confidence text;

do $$ begin
  alter table hotel_settings
    add constraint hotel_settings_pricing_confidence_check
    check (pricing_confidence is null or pricing_confidence in ('automate_current', 'find_upside'));
exception when duplicate_object then null; end $$;

-- ── claim_import_job: atomic worker claim (skip-locked) ─────────────────────
-- The import worker calls this to grab the next runnable job: queued, or
-- running with an expired lease (crashed worker). Service role only.

create or replace function public.claim_import_job(p_lease_seconds integer default 180)
returns setof import_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select id into v_id
  from import_jobs
  where status = 'queued'
     or (status = 'running' and lease_expires_at is not null and lease_expires_at < now())
  order by created_at
  limit 1
  for update skip locked;

  if v_id is null then
    return;
  end if;

  return query
  update import_jobs
  set status = 'running',
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempts = attempts + 1,
      started_at = coalesce(started_at, now()),
      updated_at = now()
  where id = v_id
  returning *;
end;
$$;

revoke all on function public.claim_import_job(integer) from public;
grant execute on function public.claim_import_job(integer) to service_role;

-- ── Analysis aggregates (service-role only, used by the import worker) ──────

-- Daily booked room-nights across the whole property.
create or replace function public.onboarding_daily_room_nights(p_hotel_id uuid)
returns table(stay_date date, room_nights bigint)
language sql
security definer
set search_path = public, pg_temp
as $$
  select r.stay_date, count(*)::bigint
  from reservations r
  where r.hotel_id = p_hotel_id
  group by r.stay_date
  order by r.stay_date;
$$;

revoke all on function public.onboarding_daily_room_nights(uuid) from public;
grant execute on function public.onboarding_daily_room_nights(uuid) to service_role;

-- Per-room-type stats for the cleaning heuristics: volume, rate distribution,
-- and length-of-stay shape.
create or replace function public.onboarding_room_type_stats(p_hotel_id uuid)
returns table(
  room_type_id uuid,
  external_room_type_id text,
  name text,
  is_active boolean,
  row_count bigint,
  median_rate numeric,
  p99_rate numeric,
  max_rate numeric,
  reservation_count bigint,
  single_night_reservations bigint,
  median_los numeric
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with res_nights as (
    select r.room_type_id as rt_id, r.external_reservation_id, count(*) as nights
    from reservations r
    where r.hotel_id = p_hotel_id
    group by 1, 2
  ),
  rate_stats as (
    select r.room_type_id as rt_id,
      count(*)::bigint as row_count,
      percentile_cont(0.5) within group (order by r.current_rate) as median_rate,
      percentile_cont(0.99) within group (order by r.current_rate) as p99_rate,
      max(r.current_rate) as max_rate
    from reservations r
    where r.hotel_id = p_hotel_id and r.current_rate is not null and r.current_rate > 0
    group by 1
  ),
  los_stats as (
    select rt_id,
      count(*)::bigint as reservation_count,
      count(*) filter (where nights = 1)::bigint as single_night_reservations,
      percentile_cont(0.5) within group (order by nights) as median_los
    from res_nights
    group by 1
  )
  select rt.id, rt.external_room_type_id, rt.name, rt.is_active,
    coalesce(rs.row_count, 0), rs.median_rate, rs.p99_rate, rs.max_rate,
    coalesce(ls.reservation_count, 0), coalesce(ls.single_night_reservations, 0),
    ls.median_los
  from room_types rt
  left join rate_stats rs on rs.rt_id = rt.id
  left join los_stats ls on ls.rt_id = rt.id
  where rt.hotel_id = p_hotel_id;
$$;

revoke all on function public.onboarding_room_type_stats(uuid) from public;
grant execute on function public.onboarding_room_type_stats(uuid) to service_role;

-- ── RLS ─────────────────────────────────────────────────────────────────────

alter table import_jobs enable row level security;
alter table onboarding_states enable row level security;
alter table onboarding_findings enable row level security;
alter table hotel_closed_periods enable row level security;

-- Members can watch import progress; only the service-role worker writes.
drop policy if exists import_jobs_read on import_jobs;
create policy import_jobs_read on import_jobs
  for select using (is_hotel_accessible(hotel_id));
revoke insert, update, delete on import_jobs from anon, authenticated;

drop policy if exists onboarding_states_access on onboarding_states;
create policy onboarding_states_access on onboarding_states
  for all using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

drop policy if exists onboarding_findings_access on onboarding_findings;
create policy onboarding_findings_access on onboarding_findings
  for all using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

drop policy if exists hotel_closed_periods_access on hotel_closed_periods;
create policy hotel_closed_periods_access on hotel_closed_periods
  for all using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));
