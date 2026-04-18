-- MAYA Rules Engine v1 Migration
-- Aligns schema with the Rules Engine Implementation Guide.
-- Run AFTER supabase_schema.sql has been applied.
--
-- This migration:
--   1) Adds floor_price / ceiling_price to room_types (migrates from room_constraints)
--   2) Evolves pricing_rules with version, scope filters, is_pickup_rule
--   3) Replaces multi-row pricing_rule_conditions with single-row rule_condition
--   4) Splits pricing_rule_room_types into signal / affected mapping tables
--   5) Creates six new tables: stay_date_snapshot, published_price,
--      ladder_rule_state, ladder_transition_event, pickup_event, evaluation_audit
--   6) Adds RLS policies for new tables

begin;

-- ============================================================================
-- 1. room_types: add floor_price / ceiling_price, migrate from room_constraints
-- ============================================================================

alter table room_types
  add column if not exists floor_price numeric(10,2),
  add column if not exists ceiling_price numeric(10,2);

update room_types rt
set
  floor_price  = coalesce(rc.floor_rate, 1.00),
  ceiling_price = coalesce(rc.ceiling_rate, 99999.99)
from room_constraints rc
where rc.room_type_id = rt.id;

update room_types
set
  floor_price   = coalesce(floor_price, 1.00),
  ceiling_price = coalesce(ceiling_price, 99999.99)
where floor_price is null;

alter table room_types
  alter column floor_price set not null,
  alter column ceiling_price set not null;

alter table room_types
  add constraint chk_floor_price_positive check (floor_price > 0),
  add constraint chk_ceiling_gte_floor check (ceiling_price >= floor_price);

-- ============================================================================
-- 2. pricing_rules: add version, scope filters, is_pickup_rule; drop scope_type
-- ============================================================================

alter table pricing_rules
  add column if not exists version integer not null default 1,
  add column if not exists start_date date,
  add column if not exists end_date date,
  add column if not exists is_annual boolean not null default false,
  add column if not exists dow_mask integer not null default 127,
  add column if not exists is_pickup_rule boolean not null default false;

alter table pricing_rules
  add constraint chk_action_value_positive check (action_value > 0);

-- Drop the old >=0 check if present (allow idempotent re-run)
alter table pricing_rules drop constraint if exists pricing_rules_action_value_check;

alter table pricing_rules drop column if exists scope_type;

create index if not exists idx_pricing_rules_hotel_pickup
  on pricing_rules (hotel_id, is_pickup_rule) where is_active;

-- ============================================================================
-- 3. rule_condition: single-row column-family model (replaces pricing_rule_conditions)
-- ============================================================================

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

-- Migrate existing pricing_rule_conditions into rule_condition.
-- Each rule gets one row; we pivot the multi-row format into columns.
insert into rule_condition (rule_id, occupancy_operator, occupancy_threshold, dta_operator, dta_threshold_days)
select
  pr.id as rule_id,
  (select prc.operator::text from pricing_rule_conditions prc
   where prc.rule_id = pr.id and prc.metric = 'occupancy_percentage' limit 1),
  (select prc.numeric_value / 100.0 from pricing_rule_conditions prc
   where prc.rule_id = pr.id and prc.metric = 'occupancy_percentage' limit 1),
  (select prc.operator::text from pricing_rule_conditions prc
   where prc.rule_id = pr.id and prc.metric = 'booking_window_days' limit 1),
  (select prc.numeric_value::integer from pricing_rule_conditions prc
   where prc.rule_id = pr.id and prc.metric = 'booking_window_days' limit 1)
from pricing_rules pr
where exists (select 1 from pricing_rule_conditions prc where prc.rule_id = pr.id)
  and not exists (select 1 from rule_condition rc where rc.rule_id = pr.id)
  and (
    exists (select 1 from pricing_rule_conditions prc
            where prc.rule_id = pr.id and prc.metric = 'occupancy_percentage')
    or exists (select 1 from pricing_rule_conditions prc
               where prc.rule_id = pr.id and prc.metric = 'booking_window_days')
  );

-- ============================================================================
-- 4. Signal / affected room-type mapping tables
-- ============================================================================

create table if not exists rule_signal_room_type (
  rule_id      uuid not null references pricing_rules(id) on delete cascade,
  room_type_id uuid not null references room_types(id),
  primary key (rule_id, room_type_id)
);

create table if not exists rule_affected_room_type (
  rule_id      uuid not null references pricing_rules(id) on delete cascade,
  room_type_id uuid not null references room_types(id),
  primary key (rule_id, room_type_id)
);

-- Migrate: copy existing pricing_rule_room_types to both signal and affected.
insert into rule_signal_room_type (rule_id, room_type_id)
select rule_id, room_type_id from pricing_rule_room_types
on conflict do nothing;

insert into rule_affected_room_type (rule_id, room_type_id)
select rule_id, room_type_id from pricing_rule_room_types
on conflict do nothing;

-- ============================================================================
-- 5. New tables per Implementation Guide sections 3.5–3.10
-- ============================================================================

-- 5a. Stay-date snapshots (§3.5)
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

-- 5b. Published prices (§3.6)
create table if not exists published_price (
  hotel_id     uuid not null,
  stay_date    date not null,
  room_type_id uuid not null,
  price        numeric(10,2) not null,
  computed_at  timestamptz not null,
  primary key (hotel_id, stay_date, room_type_id)
);

-- 5c. Ladder rule state (§3.7)
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

-- 5d. Ladder transition event ledger (§3.8)
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

-- 5e. Pickup event ledger (§3.9)
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

-- 5f. Evaluation audit log (§3.10)
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
-- 6. RLS for new tables
-- ============================================================================

alter table rule_condition enable row level security;
alter table rule_signal_room_type enable row level security;
alter table rule_affected_room_type enable row level security;
alter table stay_date_snapshot enable row level security;
alter table published_price enable row level security;
alter table ladder_rule_state enable row level security;
alter table ladder_transition_event enable row level security;
alter table pickup_event enable row level security;
alter table evaluation_audit enable row level security;

-- rule_condition / room-type mappings: use rule_hotel_id helper
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

-- Hotel-scoped tables
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

-- §3.2 — keep is_pickup_rule aligned with rule_condition.pickup_operator
create or replace function public.sync_rule_pickup_flag_from_condition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update pricing_rules
  set is_pickup_rule = (new.pickup_operator is not null),
      updated_at = now()
  where id = new.rule_id;
  return new;
end;
$$;

drop trigger if exists trg_rule_condition_sync_pickup on rule_condition;
create trigger trg_rule_condition_sync_pickup
  after insert or update of pickup_operator on rule_condition
  for each row
  execute function public.sync_rule_pickup_flag_from_condition();

commit;
