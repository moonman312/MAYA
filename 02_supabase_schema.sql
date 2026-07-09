-- MAYA Supabase/Postgres schema
-- Purpose: multi-tenant RMS data model for hotels, users, rules, runs, and integrations.
-- Aligned with Rules Engine Implementation Guide v1.
-- Notes:
--   1) Uses UUID primary keys for Supabase compatibility.
--   2) User identity is managed by Supabase Auth (auth.users).
--   3) Keep raw payloads in JSONB where traceability is important.

create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists supabase_vault with schema vault cascade;

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

  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type app_role as enum ('platform_admin', 'platform_support');
  end if;

  if not exists (select 1 from pg_type where typname = 'pending_membership_status') then
    create type pending_membership_status as enum ('pending', 'accepted', 'expired', 'revoked');
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
-- PLATFORM ROLES + INVITES + AUDIT (Command Center)
-- Locked down below (RLS on, grants revoked from authenticated/anon). Reads
-- are mediated by the SECURITY DEFINER helper is_platform_admin() and by the
-- platform_* RPCs defined later in this file.
-- ============================================================================

create table if not exists app_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role app_role not null,
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id) on delete set null,
  primary key (user_id, role)
);

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
-- Locked down below (RLS on, no policy, grants revoked from authenticated/anon).
-- Read/write only via SECURITY DEFINER RPCs: pms_secret_get / pms_secret_set /
-- pms_secret_delete (defined further down in this file).
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

-- Legacy table kept for backward compatibility.
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

-- Legacy metrics table.
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
-- RULE ENGINE (Implementation Guide §3.2–3.4)
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

-- Grant the authenticated creator a hotel_admin row, UNLESS the creator is a
-- platform admin provisioning on behalf of a customer (Command Center flow).
create or replace function public.auto_hotel_creator_membership()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null and not public.is_platform_admin() then
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

-- Materialize pending_memberships into hotel_memberships when an invited user
-- signs up (or accepts a Supabase Auth invite, which is also an INSERT on
-- auth.users). Also ensures a public.profiles row exists.
create or replace function public.accept_pending_memberships_for_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.email is null then
    return new;
  end if;

  insert into public.profiles (id, full_name, is_active)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', null),
    true
  )
  on conflict (id) do nothing;

  insert into public.hotel_memberships (hotel_id, user_id, role, status)
  select pm.hotel_id, new.id, pm.role, 'active'
  from public.pending_memberships pm
  where pm.email = (new.email)::citext
    and pm.status = 'pending'
  on conflict (hotel_id, user_id) do nothing;

  update public.pending_memberships pm
     set status = 'accepted',
         accepted_at = now(),
         accepted_by = new.id
   where pm.email = (new.email)::citext
     and pm.status = 'pending';

  return new;
end;
$$;

drop trigger if exists trg_accept_pending_memberships on auth.users;
create trigger trg_accept_pending_memberships
  after insert on auth.users
  for each row execute function public.accept_pending_memberships_for_user();

-- ============================================================================
-- ROW LEVEL SECURITY (hotel membership scoped)
-- ============================================================================

alter table profiles enable row level security;
alter table hotels enable row level security;
alter table hotel_memberships enable row level security;
alter table app_roles enable row level security;
alter table pending_memberships enable row level security;
alter table platform_audit_events enable row level security;
alter table pms_connections enable row level security;
alter table pms_connection_secrets enable row level security;

-- ---------------------------------------------------------------------------
-- Command Center: lock down platform tables. No JWT-role policies exist by
-- design — access happens via SECURITY DEFINER helpers (is_platform_admin)
-- and the platform_* RPCs in PR 2 of the Command Center work.
-- ---------------------------------------------------------------------------

revoke all on app_roles from public;
revoke all on app_roles from anon;
revoke all on app_roles from authenticated;
grant select, insert, update, delete on app_roles to service_role;

revoke all on pending_memberships from public;
revoke all on pending_memberships from anon;
revoke all on pending_memberships from authenticated;
grant select, insert, update, delete on pending_memberships to service_role;

-- platform_audit_events is read-only for platform admins via the policy below;
-- writes only from service role / SECURITY DEFINER paths.
revoke all on platform_audit_events from public;
revoke all on platform_audit_events from anon;
revoke insert, update, delete on platform_audit_events from authenticated;
grant select on platform_audit_events to authenticated;
grant select, insert, update, delete on platform_audit_events to service_role;

comment on table app_roles is
  'Platform-level roles independent of hotel memberships. Read via the '
  'SECURITY DEFINER helper is_platform_admin(); JWT roles cannot SELECT this '
  'table directly.';

comment on table pending_memberships is
  'Pre-staged hotel memberships for invited users. Materialized into '
  'hotel_memberships by trg_accept_pending_memberships on auth.users insert.';

comment on table platform_audit_events is
  'Audit log for platform-level provisioning actions. Read by platform admins '
  'via RLS; writes only via service role or SECURITY DEFINER RPCs.';

-- Lock pms_connection_secrets down so PostgREST cannot touch it. RLS on with
-- no policy denies JWT roles; explicit revokes are belt-and-suspenders.
revoke all on pms_connection_secrets from public;
revoke all on pms_connection_secrets from anon;
revoke all on pms_connection_secrets from authenticated;
grant select, insert, update, delete on pms_connection_secrets to service_role;

comment on table pms_connection_secrets is
  'PMS credentials kept encrypted in Supabase Vault. Read/write only via '
  'SECURITY DEFINER RPCs pms_secret_get / pms_secret_set / pms_secret_delete. '
  'No RLS policy exists by design — JWT roles cannot touch this table directly.';
alter table hotel_settings enable row level security;
alter table room_types enable row level security;
alter table room_constraints enable row level security;
alter table reservations enable row level security;
alter table occupancy_metrics enable row level security;
alter table pricing_rules enable row level security;
alter table rule_condition enable row level security;
alter table rule_signal_room_type enable row level security;
alter table rule_affected_room_type enable row level security;
alter table pricing_rule_conditions enable row level security;
alter table pricing_rule_room_types enable row level security;
alter table rule_applications enable row level security;
alter table pricing_runs enable row level security;
alter table pricing_decisions enable row level security;
alter table rate_updates enable row level security;
alter table audit_events enable row level security;
alter table market_events enable row level security;
alter table competitor_rates enable row level security;
alter table stay_date_snapshot enable row level security;
alter table published_price enable row level security;
alter table ladder_rule_state enable row level security;
alter table ladder_transition_event enable row level security;
alter table pickup_event enable row level security;
alter table evaluation_audit enable row level security;

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

-- Platform-admin gateway: returns true iff the user is in app_roles with
-- role='platform_admin'. Wrapped in SECURITY DEFINER so callers don't need
-- direct SELECT on the locked-down app_roles table.
create or replace function public.is_platform_admin(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.app_roles
    where user_id = p_user_id
      and role = 'platform_admin'
  )
$$;

revoke all on function public.is_platform_admin(uuid) from public;
grant execute on function public.is_platform_admin(uuid)
  to authenticated, service_role;

-- Hotel-membership predicates now OR with is_platform_admin() so platform
-- operators bypass all hotel-scoped RLS without rewriting individual policies.
create or replace function public.is_hotel_accessible(target_hotel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_platform_admin()
      or has_hotel_role(
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
  select public.is_platform_admin()
      or has_hotel_role(
           target_hotel_id,
           array['hotel_admin', 'manager']
         )
$$;

-- ============================================================================
-- PMS SECRETS: triggers + SECURITY DEFINER RPCs (Vault-backed credential store)
-- ============================================================================

-- Keep updated_at fresh on UPDATE.
create or replace function public.pms_connection_secrets_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_pms_connection_secrets_touch on public.pms_connection_secrets;
create trigger trg_pms_connection_secrets_touch
  before update on public.pms_connection_secrets
  for each row execute function public.pms_connection_secrets_touch_updated_at();

-- Cascade Vault cleanup on row delete (manual delete or hotels CASCADE).
create or replace function public.pms_connection_secrets_cleanup_vault()
returns trigger
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
begin
  if old.vault_secret_id is not null then
    delete from vault.secrets where id = old.vault_secret_id;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_pms_connection_secrets_cleanup on public.pms_connection_secrets;
create trigger trg_pms_connection_secrets_cleanup
  after delete on public.pms_connection_secrets
  for each row execute function public.pms_connection_secrets_cleanup_vault();

-- RPC: read decrypted credentials for a hotel/pms pair.
-- Authorization: service_role always; otherwise caller must satisfy can_manage_hotel.
create or replace function public.pms_secret_get(
  p_hotel_id uuid,
  p_pms_type public.pms_type
) returns jsonb
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  v_secret_id uuid;
  v_text text;
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.can_manage_hotel(p_hotel_id) then
    raise exception 'Not authorized to read PMS credentials for hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  select s.vault_secret_id
    into v_secret_id
  from public.pms_connection_secrets s
  where s.hotel_id = p_hotel_id
    and s.pms_type = p_pms_type;

  if v_secret_id is null then
    return null;
  end if;

  select decrypted_secret
    into v_text
  from vault.decrypted_secrets
  where id = v_secret_id;

  if v_text is null then
    return null;
  end if;

  return v_text::jsonb;
end;
$$;

revoke all on function public.pms_secret_get(uuid, public.pms_type) from public;
grant execute on function public.pms_secret_get(uuid, public.pms_type)
  to authenticated, service_role;

-- RPC: create or rotate credentials. Stores plaintext in Vault, only the
-- vault_secret_id reference lands in pms_connection_secrets.
create or replace function public.pms_secret_set(
  p_hotel_id uuid,
  p_pms_type public.pms_type,
  p_secret jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  v_secret_id uuid;
  v_secret_name text;
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.can_manage_hotel(p_hotel_id) then
    raise exception 'Not authorized to set PMS credentials for hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  if p_secret is null then
    raise exception 'PMS secret payload may not be null'
      using errcode = '22004';
  end if;

  v_secret_name := format('pms:%s:%s', p_pms_type::text, p_hotel_id::text);

  select s.vault_secret_id
    into v_secret_id
  from public.pms_connection_secrets s
  where s.hotel_id = p_hotel_id
    and s.pms_type = p_pms_type;

  if v_secret_id is null then
    v_secret_id := vault.create_secret(
      p_secret::text,
      v_secret_name,
      'MAYA PMS credentials'
    );

    insert into public.pms_connection_secrets (hotel_id, pms_type, vault_secret_id)
    values (p_hotel_id, p_pms_type, v_secret_id);
  else
    perform vault.update_secret(v_secret_id, p_secret::text);

    update public.pms_connection_secrets
       set updated_at = now()
     where vault_secret_id = v_secret_id;
  end if;

  return v_secret_id;
end;
$$;

revoke all on function public.pms_secret_set(uuid, public.pms_type, jsonb) from public;
grant execute on function public.pms_secret_set(uuid, public.pms_type, jsonb)
  to authenticated, service_role;

-- RPC: delete credentials. Row-delete trigger handles Vault cleanup.
create or replace function public.pms_secret_delete(
  p_hotel_id uuid,
  p_pms_type public.pms_type
) returns boolean
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  v_deleted bigint := 0;
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.can_manage_hotel(p_hotel_id) then
    raise exception 'Not authorized to delete PMS credentials for hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  delete from public.pms_connection_secrets s
   where s.hotel_id = p_hotel_id
     and s.pms_type = p_pms_type;

  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

revoke all on function public.pms_secret_delete(uuid, public.pms_type) from public;
grant execute on function public.pms_secret_delete(uuid, public.pms_type)
  to authenticated, service_role;

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

drop policy if exists rule_condition_access on rule_condition;
create policy rule_condition_access
  on rule_condition for all
  using (is_hotel_accessible(rule_hotel_id(rule_id)))
  with check (can_manage_hotel(rule_hotel_id(rule_id)));

drop policy if exists rule_signal_room_type_access on rule_signal_room_type;
create policy rule_signal_room_type_access
  on rule_signal_room_type for all
  using (is_hotel_accessible(rule_hotel_id(rule_id)))
  with check (can_manage_hotel(rule_hotel_id(rule_id)));

drop policy if exists rule_affected_room_type_access on rule_affected_room_type;
create policy rule_affected_room_type_access
  on rule_affected_room_type for all
  using (is_hotel_accessible(rule_hotel_id(rule_id)))
  with check (can_manage_hotel(rule_hotel_id(rule_id)));

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

-- Command Center audit log: read-only for platform admins. Writes go through
-- service role / SECURITY DEFINER paths (no JWT-writable policy).
drop policy if exists platform_audit_events_read on platform_audit_events;
create policy platform_audit_events_read
  on platform_audit_events for select
  using (public.is_platform_admin());

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

-- Engine tables
drop policy if exists stay_date_snapshot_access on stay_date_snapshot;
create policy stay_date_snapshot_access
  on stay_date_snapshot for all
  using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

drop policy if exists published_price_access on published_price;
create policy published_price_access
  on published_price for all
  using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

drop policy if exists ladder_rule_state_access on ladder_rule_state;
create policy ladder_rule_state_access
  on ladder_rule_state for all
  using (is_hotel_accessible(rule_hotel_id(rule_id)))
  with check (can_manage_hotel(rule_hotel_id(rule_id)));

drop policy if exists ladder_transition_event_access on ladder_transition_event;
create policy ladder_transition_event_access
  on ladder_transition_event for all
  using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

drop policy if exists pickup_event_access on pickup_event;
create policy pickup_event_access
  on pickup_event for all
  using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

drop policy if exists evaluation_audit_access on evaluation_audit;
create policy evaluation_audit_access
  on evaluation_audit for all
  using (is_hotel_accessible(hotel_id))
  with check (can_manage_hotel(hotel_id));

-- ============================================================================
-- COMMAND CENTER RPCs + VIEW (mirrors 99_supabase_migration_command_center_v2)
-- ============================================================================

create or replace view public.platform_users_view as
select
  u.id,
  u.email::text as email,
  u.created_at,
  u.last_sign_in_at,
  p.full_name,
  p.is_active,
  (select array_agg(role::text) from public.app_roles where user_id = u.id) as platform_roles
from auth.users u
left join public.profiles p on p.id = u.id;

revoke all on public.platform_users_view from public;
revoke all on public.platform_users_view from anon;
revoke all on public.platform_users_view from authenticated;
grant select on public.platform_users_view to service_role;

comment on view public.platform_users_view is
  'Auth.users + profiles + platform roles. Not directly queryable via '
  'PostgREST; consumed by SECURITY DEFINER platform_list_users.';

create or replace function public.platform_list_users(
  p_search text default null,
  p_limit int default 100,
  p_offset int default 0
) returns table (
  id uuid,
  email text,
  full_name text,
  is_active boolean,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  platform_roles text[],
  hotel_count int
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
    select
      v.id,
      v.email,
      v.full_name,
      v.is_active,
      v.created_at,
      v.last_sign_in_at,
      v.platform_roles,
      (select count(*)::int from public.hotel_memberships hm where hm.user_id = v.id) as hotel_count
    from public.platform_users_view v
    where p_search is null
       or v.email ilike '%' || p_search || '%'
       or coalesce(v.full_name, '') ilike '%' || p_search || '%'
    order by v.created_at desc
    limit greatest(1, least(p_limit, 500))
    offset greatest(0, p_offset);
end;
$$;

revoke all on function public.platform_list_users(text, int, int) from public;
grant execute on function public.platform_list_users(text, int, int)
  to authenticated, service_role;

create or replace function public.platform_list_hotel_users(
  p_hotel_id uuid
) returns table (
  membership_id uuid,
  user_id uuid,
  email text,
  full_name text,
  role public.hotel_membership_role,
  status public.membership_status,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_platform_admin() or public.can_manage_hotel(p_hotel_id)) then
    raise exception 'Not authorized for hotel %', p_hotel_id using errcode = '42501';
  end if;

  return query
    select
      hm.id,
      hm.user_id,
      u.email::text,
      p.full_name,
      hm.role,
      hm.status,
      hm.created_at
    from public.hotel_memberships hm
    join auth.users u on u.id = hm.user_id
    left join public.profiles p on p.id = hm.user_id
    where hm.hotel_id = p_hotel_id
    order by hm.created_at asc;
end;
$$;

revoke all on function public.platform_list_hotel_users(uuid) from public;
grant execute on function public.platform_list_hotel_users(uuid)
  to authenticated, service_role;

create or replace function public.platform_list_hotels(
  p_search text default null
) returns table (
  id uuid,
  name text,
  timezone text,
  currency text,
  is_active boolean,
  total_rooms_per_type int,
  external_enterprise_id text,
  created_at timestamptz,
  updated_at timestamptz,
  pms_type public.pms_type,
  pms_status public.connection_status,
  pms_last_sync_at timestamptz,
  membership_count int
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
    select
      h.id,
      h.name,
      h.timezone,
      h.currency,
      h.is_active,
      h.total_rooms_per_type,
      h.external_enterprise_id,
      h.created_at,
      h.updated_at,
      pc.pms_type,
      pc.status,
      pc.last_sync_at,
      (select count(*)::int from public.hotel_memberships hm where hm.hotel_id = h.id) as membership_count
    from public.hotels h
    left join public.pms_connections pc on pc.hotel_id = h.id
    where p_search is null
       or h.name ilike '%' || p_search || '%'
    order by h.created_at desc;
end;
$$;

revoke all on function public.platform_list_hotels(text) from public;
grant execute on function public.platform_list_hotels(text)
  to authenticated, service_role;

create or replace function public.platform_list_pending_invites(
  p_hotel_id uuid default null
) returns table (
  id uuid,
  email text,
  hotel_id uuid,
  hotel_name text,
  role public.hotel_membership_role,
  status public.pending_membership_status,
  invited_by uuid,
  invited_by_email text,
  invited_at timestamptz,
  accepted_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
    select
      pm.id,
      pm.email::text,
      pm.hotel_id,
      h.name as hotel_name,
      pm.role,
      pm.status,
      pm.invited_by,
      inviter.email::text as invited_by_email,
      pm.invited_at,
      pm.accepted_at
    from public.pending_memberships pm
    join public.hotels h on h.id = pm.hotel_id
    left join auth.users inviter on inviter.id = pm.invited_by
    where p_hotel_id is null or pm.hotel_id = p_hotel_id
    order by pm.invited_at desc;
end;
$$;

revoke all on function public.platform_list_pending_invites(uuid) from public;
grant execute on function public.platform_list_pending_invites(uuid)
  to authenticated, service_role;

create or replace function public.platform_log_event(
  p_event_type text,
  p_entity_type text,
  p_entity_id text default null,
  p_hotel_id uuid default null,
  p_detail jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized to write audit events' using errcode = '42501';
  end if;

  insert into public.platform_audit_events (actor_user_id, event_type, entity_type, entity_id, hotel_id, detail)
  values (auth.uid(), p_event_type, p_entity_type, p_entity_id, p_hotel_id, coalesce(p_detail, '{}'::jsonb))
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.platform_log_event(text, text, text, uuid, jsonb) from public;
grant execute on function public.platform_log_event(text, text, text, uuid, jsonb)
  to authenticated, service_role;

create or replace function public.platform_invite_user(
  p_email citext,
  p_hotel_id uuid,
  p_role public.hotel_membership_role,
  p_supabase_invite_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_existing_user uuid;
begin
  if not (public.is_platform_admin() or public.can_manage_hotel(p_hotel_id)) then
    raise exception 'Not authorized to invite users to hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  insert into public.pending_memberships (email, hotel_id, role, invited_by, supabase_invite_id)
  values (lower(p_email::text)::citext, p_hotel_id, p_role, auth.uid(), p_supabase_invite_id)
  on conflict (email, hotel_id) do update
    set role = excluded.role,
        status = 'pending',
        invited_by = excluded.invited_by,
        invited_at = now(),
        accepted_at = null,
        accepted_by = null,
        supabase_invite_id = excluded.supabase_invite_id
  returning id into v_id;

  select u.id into v_existing_user
  from auth.users u
  where u.email = p_email::text
  limit 1;

  if v_existing_user is not null then
    insert into public.hotel_memberships (hotel_id, user_id, role, status)
    values (p_hotel_id, v_existing_user, p_role, 'active')
    on conflict (hotel_id, user_id) do update
      set role = excluded.role,
          status = 'active';

    update public.pending_memberships
       set status = 'accepted',
           accepted_at = now(),
           accepted_by = v_existing_user
     where id = v_id;
  end if;

  insert into public.platform_audit_events (actor_user_id, event_type, entity_type, entity_id, hotel_id, detail)
  values (
    auth.uid(),
    case when v_existing_user is not null then 'user.added_to_hotel' else 'user.invited' end,
    'pending_membership',
    v_id::text,
    p_hotel_id,
    jsonb_build_object(
      'email', lower(p_email::text),
      'role', p_role::text,
      'existing_user', v_existing_user is not null
    )
  );

  return v_id;
end;
$$;

revoke all on function public.platform_invite_user(citext, uuid, public.hotel_membership_role, uuid) from public;
grant execute on function public.platform_invite_user(citext, uuid, public.hotel_membership_role, uuid)
  to authenticated, service_role;

create or replace function public.platform_set_membership_role(
  p_hotel_id uuid,
  p_user_id uuid,
  p_role public.hotel_membership_role
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_platform_admin() or public.can_manage_hotel(p_hotel_id)) then
    raise exception 'Not authorized to modify memberships for hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  update public.hotel_memberships
     set role = p_role
   where hotel_id = p_hotel_id and user_id = p_user_id;

  if not found then
    raise exception 'Membership not found (hotel=%, user=%)', p_hotel_id, p_user_id
      using errcode = 'P0002';
  end if;

  insert into public.platform_audit_events (actor_user_id, event_type, entity_type, entity_id, hotel_id, detail)
  values (auth.uid(), 'membership.role_changed', 'hotel_membership',
          p_hotel_id::text || ':' || p_user_id::text, p_hotel_id,
          jsonb_build_object('user_id', p_user_id, 'new_role', p_role::text));
end;
$$;

revoke all on function public.platform_set_membership_role(uuid, uuid, public.hotel_membership_role) from public;
grant execute on function public.platform_set_membership_role(uuid, uuid, public.hotel_membership_role)
  to authenticated, service_role;

create or replace function public.platform_remove_membership(
  p_hotel_id uuid,
  p_user_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_platform_admin() or public.can_manage_hotel(p_hotel_id)) then
    raise exception 'Not authorized to remove memberships for hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  delete from public.hotel_memberships
   where hotel_id = p_hotel_id and user_id = p_user_id;

  insert into public.platform_audit_events (actor_user_id, event_type, entity_type, entity_id, hotel_id, detail)
  values (auth.uid(), 'membership.removed', 'hotel_membership',
          p_hotel_id::text || ':' || p_user_id::text, p_hotel_id,
          jsonb_build_object('user_id', p_user_id));
end;
$$;

revoke all on function public.platform_remove_membership(uuid, uuid) from public;
grant execute on function public.platform_remove_membership(uuid, uuid)
  to authenticated, service_role;

create or replace function public.platform_revoke_pending(
  p_pending_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hotel_id uuid;
begin
  select hotel_id into v_hotel_id
  from public.pending_memberships
  where id = p_pending_id;

  if v_hotel_id is null then
    raise exception 'Pending invite not found' using errcode = 'P0002';
  end if;

  if not (public.is_platform_admin() or public.can_manage_hotel(v_hotel_id)) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  update public.pending_memberships
     set status = 'revoked'
   where id = p_pending_id and status = 'pending';

  insert into public.platform_audit_events (actor_user_id, event_type, entity_type, entity_id, hotel_id, detail)
  values (auth.uid(), 'invite.revoked', 'pending_membership', p_pending_id::text, v_hotel_id, '{}'::jsonb);
end;
$$;

revoke all on function public.platform_revoke_pending(uuid) from public;
grant execute on function public.platform_revoke_pending(uuid)
  to authenticated, service_role;

create or replace function public.platform_grant_role(
  p_user_id uuid,
  p_role public.app_role
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  insert into public.app_roles (user_id, role, granted_by)
  values (p_user_id, p_role, auth.uid())
  on conflict (user_id, role) do nothing;

  insert into public.platform_audit_events (actor_user_id, event_type, entity_type, entity_id, detail)
  values (auth.uid(), 'app_role.granted', 'app_role', p_user_id::text,
          jsonb_build_object('user_id', p_user_id, 'role', p_role::text));
end;
$$;

revoke all on function public.platform_grant_role(uuid, public.app_role) from public;
grant execute on function public.platform_grant_role(uuid, public.app_role)
  to authenticated, service_role;

create or replace function public.platform_revoke_role(
  p_user_id uuid,
  p_role public.app_role
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if p_role = 'platform_admin'
     and p_user_id = auth.uid()
     and (select count(*) from public.app_roles where role = 'platform_admin') <= 1 then
    raise exception 'Cannot revoke the last platform_admin' using errcode = '23514';
  end if;

  delete from public.app_roles where user_id = p_user_id and role = p_role;

  insert into public.platform_audit_events (actor_user_id, event_type, entity_type, entity_id, detail)
  values (auth.uid(), 'app_role.revoked', 'app_role', p_user_id::text,
          jsonb_build_object('user_id', p_user_id, 'role', p_role::text));
end;
$$;

revoke all on function public.platform_revoke_role(uuid, public.app_role) from public;
grant execute on function public.platform_revoke_role(uuid, public.app_role)
  to authenticated, service_role;
