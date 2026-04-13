-- MAYA base schema (run this first in Supabase)
-- Includes core tables + enums needed before any seed data.
-- No seed inserts in this file.

create extension if not exists pgcrypto;

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
  -- Fallback when a PMS category has no explicit inventory (see room_types.total_rooms).
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
-- RULES + EXECUTION CORE
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

create table if not exists rule_applications (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  rule_id uuid not null references pricing_rules(id) on delete cascade,
  stay_date date not null,
  pricing_run_id uuid,
  applied_at timestamptz not null default now(),
  unique (hotel_id, rule_id, stay_date)
);

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
-- AUDIT CORE
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
