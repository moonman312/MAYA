-- MAYA Supabase/Postgres schema proposal
-- Purpose: multi-tenant RMS data model for hotels, users, rules, runs, and integrations.
-- Notes:
--   1) Uses UUID primary keys for Supabase compatibility.
--   2) User identity is managed by Supabase Auth (auth.users).
--   3) Keep raw payloads in JSONB where traceability is important.

create extension if not exists pgcrypto;

-- ============================================================================
-- ENUMS
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'hotel_membership_role') then
    create type hotel_membership_role as enum ('hotel_admin', 'manager', 'staff', 'viewer');
  end if;

  if not exists (select 1 from pg_type where typname = 'membership_status') then
    create type membership_status as enum ('invited', 'active', 'suspended', 'revoked');
  end if;

  if not exists (select 1 from pg_type where typname = 'pms_type') then
    create type pms_type as enum ('mews', 'cloudbeds', 'opera', 'other');
  end if;

  if not exists (select 1 from pg_type where typname = 'connection_status') then
    create type connection_status as enum ('pending', 'connected', 'degraded', 'disconnected', 'error');
  end if;

  if not exists (select 1 from pg_type where typname = 'scope_type') then
    create type scope_type as enum ('hotel', 'room_type');
  end if;

  if not exists (select 1 from pg_type where typname = 'rule_metric') then
    create type rule_metric as enum (
      'occupancy_percentage',
      'pickup_rate',
      'booking_window_days',
      'room_type'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'rule_operator') then
    create type rule_operator as enum ('gt', 'lt', 'eq', 'gte', 'lte', 'neq');
  end if;

  if not exists (select 1 from pg_type where typname = 'action_type') then
    create type action_type as enum ('percent', 'fixed', 'set_rate');
  end if;

  if not exists (select 1 from pg_type where typname = 'action_direction') then
    create type action_direction as enum ('increase', 'decrease', 'absolute');
  end if;

  if not exists (select 1 from pg_type where typname = 'run_type') then
    create type run_type as enum ('live', 'simulation');
  end if;

  if not exists (select 1 from pg_type where typname = 'run_status') then
    create type run_status as enum ('queued', 'running', 'completed', 'failed', 'partial');
  end if;

  if not exists (select 1 from pg_type where typname = 'rate_update_status') then
    create type rate_update_status as enum ('pending', 'sent', 'succeeded', 'failed', 'skipped');
  end if;
end $$;

-- ============================================================================
-- TENANCY + USERS (hotel-scoped: users access hotels via hotel_memberships)
-- ============================================================================

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists hotels (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'UTC',
  currency text not null default 'USD',
  is_active boolean not null default true,
  -- Default when a category has no explicit inventory in the PMS payload (see room_types.total_rooms).
  total_rooms_per_type integer not null default 100 check (total_rooms_per_type > 0),
  external_enterprise_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name),
  unique nulls not distinct (external_enterprise_id)
);

create table if not exists hotel_memberships (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role hotel_membership_role not null,
  status membership_status not null default 'active',
  created_at timestamptz not null default now(),
  unique (hotel_id, user_id)
);

create index if not exists idx_hotel_memberships_user on hotel_memberships(user_id);

-- ============================================================================
-- PMS + HOTEL SETTINGS
-- ============================================================================

create table if not exists pms_connections (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  pms_type pms_type not null,
  status connection_status not null default 'pending',
  base_url text,
  credentials_encrypted text not null,
  last_tested_at timestamptz,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, pms_type)
);

create table if not exists hotel_settings (
  hotel_id uuid primary key references hotels(id) on delete cascade,
  pricing_horizon_days integer not null default 365 check (pricing_horizon_days > 0),
  pickup_window_cycles integer not null default 1 check (pickup_window_cycles > 0),
  simulation_mode boolean not null default false,
  rounding_mode text not null default 'none',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- INVENTORY + RESERVATIONS + METRICS
-- ============================================================================

create table if not exists room_types (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  external_room_type_id text not null,
  name text not null,
  display_name text,
  is_active boolean not null default true,
  total_rooms integer not null default 100 check (total_rooms > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, external_room_type_id)
);

create table if not exists room_constraints (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  room_type_id uuid not null references room_types(id) on delete cascade,
  floor_rate numeric(12,2),
  ceiling_rate numeric(12,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (floor_rate is null or floor_rate >= 0),
  check (ceiling_rate is null or ceiling_rate >= 0),
  check (
    floor_rate is null
    or ceiling_rate is null
    or floor_rate <= ceiling_rate
  ),
  unique (hotel_id, room_type_id)
);

create table if not exists reservations (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  external_reservation_id text not null,
  room_type_id uuid references room_types(id) on delete set null,
  stay_date date not null,
  booking_date date,
  booking_window_days integer,
  current_rate numeric(12,2),
  base_rate numeric(12,2),
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, external_reservation_id, stay_date),
  check (booking_window_days is null or booking_window_days >= 0),
  check (current_rate is null or current_rate >= 0),
  check (base_rate is null or base_rate >= 0)
);

create index if not exists idx_reservations_hotel_stay_date on reservations(hotel_id, stay_date);
create index if not exists idx_reservations_hotel_room_type on reservations(hotel_id, room_type_id);

-- On sync, `current_rate` always reflects the latest PMS value; `base_rate` is the first-seen
-- rate (original BAR) and must not be overwritten on every sync. Matches legacy Python upsert:
-- base_rate = COALESCE(reservations.base_rate, EXCLUDED.base_rate).
create or replace function public.reservations_sync_base_rate()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.base_rate := coalesce(new.base_rate, new.current_rate);
  elsif tg_op = 'UPDATE' then
    new.base_rate := coalesce(old.base_rate, new.base_rate, new.current_rate);
  end if;
  return new;
end;
$$;

drop trigger if exists reservations_sync_base_rate on reservations;
create trigger reservations_sync_base_rate
  before insert or update on reservations
  for each row
  execute function public.reservations_sync_base_rate();

create table if not exists occupancy_metrics (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  room_type_id uuid not null references room_types(id) on delete cascade,
  stay_date date not null,
  occupancy integer not null default 0 check (occupancy >= 0),
  pickup_rate integer not null default 0 check (pickup_rate >= 0),
  updated_at timestamptz not null default now(),
  unique (hotel_id, room_type_id, stay_date)
);

-- ============================================================================
-- RULE ENGINE (NORMALIZED)
-- ============================================================================

create table if not exists pricing_rules (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  name text not null,
  priority integer not null default 100,
  is_active boolean not null default true,
  scope_type scope_type not null default 'hotel',
  action_type action_type not null,
  action_direction action_direction not null,
  action_value numeric(12,4) not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (action_value >= 0)
);

create index if not exists idx_pricing_rules_hotel_active_priority
  on pricing_rules(hotel_id, is_active, priority);

create table if not exists pricing_rule_conditions (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references pricing_rules(id) on delete cascade,
  metric rule_metric not null,
  operator rule_operator not null,
  numeric_value numeric(14,4),
  text_value text,
  created_at timestamptz not null default now(),
  check (
    (metric = 'room_type' and text_value is not null)
    or
    (metric <> 'room_type' and numeric_value is not null)
  )
);

create table if not exists pricing_rule_room_types (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references pricing_rules(id) on delete cascade,
  room_type_id uuid not null references room_types(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (rule_id, room_type_id)
);

-- Durable once-per-day (or once-per-run) idempotency ledger.
create table if not exists rule_applications (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  rule_id uuid not null references pricing_rules(id) on delete cascade,
  stay_date date not null,
  pricing_run_id uuid,
  applied_at timestamptz not null default now(),
  unique (hotel_id, rule_id, stay_date)
);

-- ============================================================================
-- RUNS + DECISIONS + UPDATE DELIVERY
-- ============================================================================

create table if not exists pricing_runs (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  run_type run_type not null default 'live',
  status run_status not null default 'queued',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  error_summary text,
  initiated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_pricing_runs_hotel_started_at on pricing_runs(hotel_id, started_at desc);

create table if not exists pricing_decisions (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  run_id uuid not null references pricing_runs(id) on delete cascade,
  reservation_id uuid references reservations(id) on delete set null,
  room_type_id uuid references room_types(id) on delete set null,
  stay_date date not null,
  old_rate numeric(12,2),
  new_rate numeric(12,2),
  calculated_rate_pre_constraint numeric(12,2),
  final_rate numeric(12,2),
  rule_triggered jsonb not null default '[]'::jsonb,
  occupancy numeric(8,2),
  pickup_count integer,
  booking_window integer,
  manual_override_detected boolean not null default false,
  decision_reason text,
  decision_time timestamptz not null default now(),
  is_changed boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_pricing_decisions_hotel_stay_date
  on pricing_decisions(hotel_id, stay_date);

create table if not exists rate_updates (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  run_id uuid references pricing_runs(id) on delete set null,
  decision_id uuid references pricing_decisions(id) on delete set null,
  room_type_id uuid references room_types(id) on delete set null,
  stay_date date not null,
  old_rate numeric(12,2),
  new_rate numeric(12,2),
  status rate_update_status not null default 'pending',
  external_response jsonb,
  update_time timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_rate_updates_hotel_update_time
  on rate_updates(hotel_id, update_time desc);

-- ============================================================================
-- AUDIT + OPTIONAL MARKET/COMP DATA
-- ============================================================================

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  entity_type text not null,
  entity_id text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_events_hotel_created_at
  on audit_events(hotel_id, created_at desc);

create table if not exists market_events (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  name text not null,
  event_type text,
  start_date date not null,
  end_date date not null,
  impact_score numeric(6,2),
  source text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (start_date <= end_date)
);

create table if not exists competitor_rates (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  competitor_name text not null,
  room_type_name text,
  stay_date date not null,
  observed_rate numeric(12,2) not null check (observed_rate >= 0),
  observed_at timestamptz not null default now(),
  source text,
  created_at timestamptz not null default now()
);

create index if not exists idx_competitor_rates_hotel_stay_date
  on competitor_rates(hotel_id, stay_date);

-- Grant the authenticated creator a hotel_admin row (SQL Editor / service role: auth.uid() is null).
create or replace function public.auto_hotel_creator_membership()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null then
    insert into public.hotel_memberships (hotel_id, user_id, role, status)
    values (new.id, auth.uid(), 'hotel_admin', 'active')
    on conflict (hotel_id, user_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_hotels_creator_membership on public.hotels;
create trigger trg_hotels_creator_membership
  after insert on public.hotels
  for each row
  execute function public.auto_hotel_creator_membership();

-- ============================================================================
-- ROW LEVEL SECURITY (hotel membership scoped)
-- ============================================================================

alter table profiles enable row level security;
alter table hotels enable row level security;
alter table hotel_memberships enable row level security;
alter table pms_connections enable row level security;
alter table hotel_settings enable row level security;
alter table room_types enable row level security;
alter table room_constraints enable row level security;
alter table reservations enable row level security;
alter table occupancy_metrics enable row level security;
alter table pricing_rules enable row level security;
alter table pricing_rule_conditions enable row level security;
alter table pricing_rule_room_types enable row level security;
alter table rule_applications enable row level security;
alter table pricing_runs enable row level security;
alter table pricing_decisions enable row level security;
alter table rate_updates enable row level security;
alter table audit_events enable row level security;
alter table market_events enable row level security;
alter table competitor_rates enable row level security;

create or replace function public.rule_hotel_id(target_rule_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.hotel_id from pricing_rules r where r.id = target_rule_id
$$;

create or replace function public.has_hotel_role(target_hotel_id uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from hotel_memberships hm
    where hm.hotel_id = target_hotel_id
      and hm.user_id = auth.uid()
      and hm.status = 'active'
      and hm.role::text = any (allowed_roles)
  )
$$;

create or replace function public.is_hotel_accessible(target_hotel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select has_hotel_role(
    target_hotel_id,
    array['hotel_admin', 'manager', 'staff', 'viewer']
  )
$$;

create or replace function public.can_manage_hotel(target_hotel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select has_hotel_role(
    target_hotel_id,
    array['hotel_admin', 'manager']
  )
$$;

-- Drop legacy placeholder policies if they exist.
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles','hotels','hotel_memberships',
    'pms_connections','hotel_settings','room_types','room_constraints','reservations',
    'occupancy_metrics','pricing_rules','pricing_rule_conditions','pricing_rule_room_types',
    'rule_applications','pricing_runs','pricing_decisions','rate_updates','audit_events',
    'market_events','competitor_rates'
  ]
  loop
    execute format('drop policy if exists %I on %I', t || '_authenticated_read', t);
  end loop;
end $$;

-- Profiles
drop policy if exists profiles_select on profiles;
create policy profiles_select
  on profiles for select
  using (id = auth.uid());

drop policy if exists profiles_insert on profiles;
create policy profiles_insert
  on profiles for insert
  with check (id = auth.uid());

drop policy if exists profiles_update on profiles;
create policy profiles_update
  on profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- Hotels and hotel memberships
drop policy if exists hotels_select on hotels;
create policy hotels_select
  on hotels for select
  using (is_hotel_accessible(id));

drop policy if exists hotels_write on hotels;
drop policy if exists hotels_insert on hotels;
drop policy if exists hotels_update on hotels;
drop policy if exists hotels_delete on hotels;

-- Any authenticated user may create a hotel; trigger adds hotel_admin membership when JWT present.
create policy hotels_insert
  on hotels for insert
  with check (auth.uid() is not null);

create policy hotels_update
  on hotels for update
  using (can_manage_hotel(id))
  with check (can_manage_hotel(id));

create policy hotels_delete
  on hotels for delete
  using (has_hotel_role(id, array['hotel_admin']));

drop policy if exists hotel_memberships_select on hotel_memberships;
create policy hotel_memberships_select
  on hotel_memberships for select
  using (is_hotel_accessible(hotel_id) or user_id = auth.uid());

drop policy if exists hotel_memberships_write on hotel_memberships;
create policy hotel_memberships_write
  on hotel_memberships for all
  using (can_manage_hotel(hotel_id))
  with check (can_manage_hotel(hotel_id));

-- Hotel-scoped data: read if accessible, write if manager+.
drop policy if exists pms_connections_access on pms_connections;
create policy pms_connections_access
  on pms_connections for all
  using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

drop policy if exists hotel_settings_access on hotel_settings;
create policy hotel_settings_access
  on hotel_settings for all
  using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

drop policy if exists room_types_access on room_types;
create policy room_types_access
  on room_types for all
  using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

drop policy if exists room_constraints_access on room_constraints;
create policy room_constraints_access
  on room_constraints for all
  using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

drop policy if exists reservations_access on reservations;
create policy reservations_access
  on reservations for all
  using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

drop policy if exists occupancy_metrics_access on occupancy_metrics;
create policy occupancy_metrics_access
  on occupancy_metrics for all
  using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

drop policy if exists pricing_rules_access on pricing_rules;
create policy pricing_rules_access
  on pricing_rules for all
  using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

drop policy if exists pricing_rule_conditions_access on pricing_rule_conditions;
create policy pricing_rule_conditions_access
  on pricing_rule_conditions for all
  using (is_hotel_accessible(rule_hotel_id(rule_id)))
  with check (can_manage_hotel(rule_hotel_id(rule_id)));

drop policy if exists pricing_rule_room_types_access on pricing_rule_room_types;
create policy pricing_rule_room_types_access
  on pricing_rule_room_types for all
  using (is_hotel_accessible(rule_hotel_id(rule_id)))
  with check (can_manage_hotel(rule_hotel_id(rule_id)));

drop policy if exists rule_applications_access on rule_applications;
create policy rule_applications_access
  on rule_applications for all
  using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

drop policy if exists pricing_runs_access on pricing_runs;
create policy pricing_runs_access
  on pricing_runs for all
  using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

drop policy if exists pricing_decisions_access on pricing_decisions;
create policy pricing_decisions_access
  on pricing_decisions for all
  using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

drop policy if exists rate_updates_access on rate_updates;
create policy rate_updates_access
  on rate_updates for all
  using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

drop policy if exists audit_events_access on audit_events;
create policy audit_events_access
  on audit_events for all
  using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

drop policy if exists market_events_access on market_events;
create policy market_events_access
  on market_events for all
  using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

drop policy if exists competitor_rates_access on competitor_rates;
create policy competitor_rates_access
  on competitor_rates for all
  using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

-- Existing DBs: add room_types.total_rooms and reservations_sync_base_rate (see table DDL above) if missing.
