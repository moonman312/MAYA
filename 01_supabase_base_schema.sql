-- MAYA base schema (run this first in Supabase)
-- Includes core tables + enums needed before any seed data.
-- No seed inserts in this file.
--
-- Aligned with Rules Engine Implementation Guide v1.

create extension if not exists pgcrypto;
create extension if not exists citext;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'hotel_membership_role') then
    create type hotel_membership_role as enum ('hotel_admin', 'manager', 'staff', 'viewer');
  end if;

  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type app_role as enum ('platform_admin', 'platform_support');
  end if;

  if not exists (select 1 from pg_type where typname = 'pending_membership_status') then
    create type pending_membership_status as enum ('pending', 'accepted', 'expired', 'revoked');
  end if;

  if not exists (select 1 from pg_type where typname = 'membership_status') then
    create type membership_status as enum ('invited', 'active', 'suspended', 'revoked');
  end if;

  if not exists (select 1 from pg_type where typname = 'pms_type') then
    create type pms_type as enum ('mews', 'cloudbeds', 'think', 'opera', 'other');
  end if;

  if not exists (select 1 from pg_type where typname = 'connection_status') then
    create type connection_status as enum ('pending', 'connected', 'degraded', 'disconnected', 'error');
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
  total_rooms_per_type integer not null default 100 check (total_rooms_per_type > 0),
  external_enterprise_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name),
  -- NULLS DISTINCT: many hotels may have no enterprise id (Cloudbeds/Think/none);
  -- uniqueness is only enforced across non-null values.
  unique nulls distinct (external_enterprise_id)
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

-- Platform-level roles, independent of hotel memberships. Locked down in
-- 02_supabase_schema.sql; readable only via the is_platform_admin() helper.
create table if not exists app_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role app_role not null,
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id) on delete set null,
  primary key (user_id, role)
);

-- Pre-staged hotel memberships for invited users. Materialized into
-- hotel_memberships by a trigger on auth.users when the user accepts.
create table if not exists pending_memberships (
  id uuid primary key default gen_random_uuid(),
  email citext not null,
  hotel_id uuid not null references hotels(id) on delete cascade,
  role hotel_membership_role not null,
  status pending_membership_status not null default 'pending',
  invited_by uuid references auth.users(id) on delete set null,
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  supabase_invite_id uuid,
  unique (email, hotel_id)
);

create index if not exists idx_pending_memberships_email
  on pending_memberships (email);
create index if not exists idx_pending_memberships_hotel_status
  on pending_memberships (hotel_id, status);

-- Audit log for platform-level provisioning actions. Not hotel-scoped: some
-- actions (granting platform_admin, etc.) have no parent hotel.
create table if not exists platform_audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  entity_type text not null,
  entity_id text,
  hotel_id uuid references hotels(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_platform_audit_events_created_at
  on platform_audit_events(created_at desc);
create index if not exists idx_platform_audit_events_hotel
  on platform_audit_events(hotel_id, created_at desc);
create index if not exists idx_platform_audit_events_actor
  on platform_audit_events(actor_user_id, created_at desc);

-- ============================================================================
-- PMS + HOTEL SETTINGS
-- ============================================================================

create table if not exists pms_connections (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  pms_type pms_type not null,
  status connection_status not null default 'pending',
  base_url text,
  last_tested_at timestamptz,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, pms_type)
);

-- Credentials live in Supabase Vault, referenced by vault_secret_id.
-- Read/write only via SECURITY DEFINER RPCs in 02_supabase_schema.sql.
create table if not exists pms_connection_secrets (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id) on delete cascade,
  pms_type pms_type not null,
  vault_secret_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, pms_type)
);

create index if not exists idx_pms_connection_secrets_hotel
  on pms_connection_secrets(hotel_id);

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
  floor_price numeric(10,2) not null default 1.00,
  ceiling_price numeric(10,2) not null default 99999.99,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, external_room_type_id),
  check (floor_price > 0),
  check (ceiling_price >= floor_price)
);

create index if not exists idx_room_types_hotel_active
  on room_types (hotel_id) where is_active;

-- Legacy table kept for backward compatibility; floor_price/ceiling_price on
-- room_types is the canonical source for the rules engine.
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

-- Legacy metrics table; stay_date_snapshot is the canonical source for the engine.
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
-- STAY-DATE SNAPSHOTS (Implementation Guide §3.5)
-- ============================================================================

create table if not exists stay_date_snapshot (
  hotel_id        uuid not null,
  snapshot_ts     timestamptz not null,
  stay_date       date not null,
  room_type_id    uuid not null,
  sellable_units  integer not null check (sellable_units >= 0),
  booked_units    integer not null check (booked_units >= 0),
  booked_revenue  numeric(12,2) not null check (booked_revenue >= 0),
  primary key (hotel_id, snapshot_ts, stay_date, room_type_id)
);

create index if not exists idx_snapshot_hotel_stay_ts
  on stay_date_snapshot (hotel_id, stay_date, snapshot_ts desc);

-- ============================================================================
-- RULES ENGINE (Implementation Guide §3.2–3.4)
-- ============================================================================

create table if not exists pricing_rules (
  id                uuid primary key default gen_random_uuid(),
  hotel_id          uuid not null references hotels(id) on delete cascade,
  name              text not null,
  is_active         boolean not null default true,
  version           integer not null default 1,
  -- scope
  start_date        date,
  end_date          date,
  is_annual         boolean not null default false,
  dow_mask          integer not null default 127,
  -- action
  action_type       text not null check (action_type in ('percent','fixed')),
  action_direction  text not null check (action_direction in ('increase','decrease')),
  action_value      numeric(10,4) not null check (action_value > 0),
  -- precedence
  priority          integer not null default 100,
  -- classification
  is_pickup_rule    boolean not null default false,
  -- audit
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_pricing_rules_hotel_active
  on pricing_rules (hotel_id, is_active);

create index if not exists idx_pricing_rules_hotel_pickup
  on pricing_rules (hotel_id, is_pickup_rule) where is_active;

-- Single-row condition model (§3.4)
create table if not exists rule_condition (
  rule_id               uuid primary key references pricing_rules(id) on delete cascade,
  occupancy_operator    text check (occupancy_operator in ('gt','lt')),
  occupancy_threshold   numeric(8,4) check (occupancy_threshold between 0 and 1),
  dta_operator          text check (dta_operator in ('gt','lt')),
  dta_threshold_days    integer check (dta_threshold_days >= 0),
  pickup_operator       text check (pickup_operator in ('gt','lt')),
  pickup_threshold      numeric(10,2),
  pickup_window_days    integer check (pickup_window_days in (1,3,7)),
  pickup_metric         text check (pickup_metric in ('room_nights','revenue')),
  check (
    (pickup_operator is null and pickup_threshold is null
     and pickup_window_days is null and pickup_metric is null)
    or
    (pickup_operator is not null and pickup_threshold is not null
     and pickup_window_days is not null and pickup_metric is not null)
  ),
  check (
    occupancy_operator is not null
    or dta_operator is not null
    or pickup_operator is not null
  )
);

-- Signal room types: rooms whose demand drives the rule's metrics (§3.3)
create table if not exists rule_signal_room_type (
  rule_id      uuid not null references pricing_rules(id) on delete cascade,
  room_type_id uuid not null references room_types(id),
  primary key (rule_id, room_type_id)
);

-- Affected room types: rooms whose prices the rule changes (§3.3)
create table if not exists rule_affected_room_type (
  rule_id      uuid not null references pricing_rules(id) on delete cascade,
  room_type_id uuid not null references room_types(id),
  primary key (rule_id, room_type_id)
);

-- Legacy tables kept for backward compatibility with existing UI/API code.
create table if not exists pricing_rule_conditions (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references pricing_rules(id) on delete cascade,
  metric text not null,
  operator text not null,
  numeric_value numeric(14,4),
  text_value text,
  created_at timestamptz not null default now()
);

create table if not exists pricing_rule_room_types (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references pricing_rules(id) on delete cascade,
  room_type_id uuid not null references room_types(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (rule_id, room_type_id)
);

-- Legacy idempotency ledger; superseded by ladder_rule_state + pickup_event.
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
-- LADDER RULE STATE + EVENT LEDGER (Implementation Guide §3.7–3.8)
-- ============================================================================

create table if not exists ladder_rule_state (
  rule_id            uuid not null references pricing_rules(id) on delete cascade,
  rule_version       integer not null,
  stay_date          date not null,
  room_type_id       uuid not null,
  is_active          boolean not null,
  activated_at       timestamptz,
  deactivated_at     timestamptz,
  last_evaluated_at  timestamptz not null,
  action_kind        text not null,
  action_direction   text not null,
  action_value       numeric(10,4) not null,
  primary key (rule_id, stay_date, room_type_id)
);

create index if not exists idx_ladder_state_active
  on ladder_rule_state (stay_date, room_type_id) where is_active;

create table if not exists ladder_transition_event (
  id                 uuid primary key default gen_random_uuid(),
  hotel_id           uuid not null,
  rule_id            uuid not null,
  rule_version       integer not null,
  stay_date          date not null,
  room_type_id       uuid not null,
  transition         text not null check (transition in ('activate','deactivate')),
  transitioned_at    timestamptz not null,
  metrics_snapshot   jsonb not null,
  action_kind        text not null,
  action_direction   text not null,
  action_value       numeric(10,4) not null
);

create index if not exists idx_ladder_event_hotel_stay
  on ladder_transition_event (hotel_id, stay_date, room_type_id, transitioned_at desc);

create index if not exists idx_ladder_event_rule_stay
  on ladder_transition_event (rule_id, stay_date, transitioned_at desc);

-- ============================================================================
-- PICKUP EVENT LEDGER (Implementation Guide §3.9)
-- ============================================================================

create table if not exists pickup_event (
  id                            uuid primary key default gen_random_uuid(),
  hotel_id                      uuid not null,
  rule_id                       uuid not null references pricing_rules(id),
  rule_version                  integer not null,
  stay_date                     date not null,
  affected_room_type_id         uuid not null,
  baseline_start_ts             timestamptz not null,
  baseline_end_ts               timestamptz not null,
  signal_booked_units_start     integer not null,
  signal_booked_units_end       integer not null,
  signal_booked_revenue_start   numeric(12,2) not null,
  signal_booked_revenue_end     numeric(12,2) not null,
  applied_at                    timestamptz not null,
  retired_at                    timestamptz,
  action_kind                   text not null,
  action_direction              text not null,
  action_value                  numeric(10,4) not null
);

create index if not exists idx_pickup_event_active
  on pickup_event (hotel_id, stay_date, affected_room_type_id) where retired_at is null;

create index if not exists idx_pickup_event_rule_stay
  on pickup_event (rule_id, stay_date, applied_at desc);

-- ============================================================================
-- PUBLISHED PRICES (Implementation Guide §3.6)
-- ============================================================================

create table if not exists published_price (
  hotel_id     uuid not null,
  stay_date    date not null,
  room_type_id uuid not null,
  price        numeric(10,2) not null,
  computed_at  timestamptz not null,
  primary key (hotel_id, stay_date, room_type_id)
);

-- ============================================================================
-- EVALUATION AUDIT LOG (Implementation Guide §3.10)
-- ============================================================================

create table if not exists evaluation_audit (
  id                     uuid primary key default gen_random_uuid(),
  evaluation_run_id      uuid not null,
  hotel_id               uuid not null,
  stay_date              date not null,
  room_type_id           uuid not null,
  evaluated_at           timestamptz not null,
  base_price             numeric(10,2) not null,
  floor_price            numeric(10,2) not null,
  ceiling_price          numeric(10,2) not null,
  ladder_subtotal_delta  numeric(10,2) not null,
  pickup_subtotal_delta  numeric(10,2) not null,
  pre_clamp_price        numeric(10,2) not null,
  final_price            numeric(10,2) not null,
  details                jsonb not null
);

create index if not exists idx_eval_audit_hotel_stay
  on evaluation_audit (hotel_id, stay_date, room_type_id, evaluated_at desc);

-- ============================================================================
-- RUNS + DECISIONS + UPDATE DELIVERY (legacy, kept for compatibility)
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
