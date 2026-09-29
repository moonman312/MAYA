-- ============================================================================
-- MAYA pricing cadence: a daily pass plus touched nights, over 396 nights (v1)
-- ============================================================================
--
-- Decided by Jake on 2026-09-17 and again on 2026-09-28. Until now every
-- scheduled tick (about every five minutes) priced every night of a 60-night
-- window. From this change:
--
--   * Once a hotel day, on the first cycle after the date changes at the
--     property, every night up to 396 nights out is priced ("the daily
--     pass"). The pass runs in chunks, nearest nights first, and remembers
--     how far it got (hotel_pricing_state), so a crash, a failed read or a
--     busy tick carries on where it stopped.
--   * Every cycle, only the nights whose inputs changed are priced again.
--     Triggers below record those nights (pricing_dirty_nights): bookings
--     that arrive, change, move or cancel, and owner edits of nights (typed
--     prices, rooms out of service, answers to the three-changes alert) and
--     of base rates. The list is cleared only by the run that priced the
--     night, and only if the night was not marked again after it was read.
--   * Owner edits that can move any night (rules, their conditions and room
--     type lists, room types, closed periods, "not a fair comparison" flags,
--     the hotel's time zone) ask for a new pass (full_reprice_seq).
--   * A night where a run changed a rule's state (a change made, taken off
--     or restated, a ladder rule switched) is marked again for the next
--     tick, until a run changes nothing there.
--
-- Nothing in a price moves with the clock during a hotel day (Jake,
-- 2026-09-28): pickup count windows and rule waits count whole hotel days,
-- and the code deployed with this file reads them that way. So the daily
-- pass plus the marked nights gives the prices that pricing every night
-- every tick would.
--
-- Nothing here prices anything. The scheduled functions read the list with
-- pricing_work() and report what they priced with pricing_run_done(). The
-- env switch MAYA_PRICING_CADENCE=every_tick makes them price the whole
-- window every tick again, as before; the triggers keep marking and the
-- marks are cleared by those runs.
--
-- Safe to run more than once. No backfill: the first tick after the deploy
-- starts a pass for every hotel. Marks written between this file and the
-- deploy are cleared by those passes.
--
-- Sections:
--   1. Tables: pricing_dirty_nights, hotel_pricing_state
--   2. evaluation_run_log: run_kind, nights_priced, nights
--   3. pms_connections.base_rates_through
--   4. Access: row level security on, no policies, service role only
--   5. Marking functions
--   6. Triggers: bookings, base rates, typed prices, rooms out of service,
--      alert answers, and the hotel-level edits
--   7. Functions the scheduled functions and the engine call
--   8. Checks
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Tables
-- ----------------------------------------------------------------------------

-- One number for every mark, night or hotel. A mark made after a run read
-- the list always carries a bigger number than the one the run read for that
-- night, so the run's clear leaves it for the next tick.
create sequence if not exists public.pricing_mark_seq;

create table if not exists public.pricing_dirty_nights (
  hotel_id        uuid not null references public.hotels(id) on delete cascade,
  stay_date       date not null,
  -- The oldest change to this night not yet priced. The push holds a price
  -- whose night has waited on a change longer than its freshness limit.
  first_marked_at timestamptz not null default now(),
  last_marked_at  timestamptz not null default now(),
  mark_seq        bigint not null,
  -- booking | base_rate | manual_price | out_of_service | alert_answer |
  -- retry (a night a run could not fully write) | follow_up (a night a run
  -- changed a rule's state on)
  reasons         text[] not null default '{}',
  primary key (hotel_id, stay_date)
);

comment on table public.pricing_dirty_nights is
  'Nights whose pricing inputs changed since they were last priced. Filled by '
  'triggers (99_supabase_migration_pricing_cadence_v1.sql), read by '
  'pricing_work(), cleared by pricing_run_done() only for rows not marked '
  'again since they were read.';

create table if not exists public.hotel_pricing_state (
  hotel_id                  uuid primary key references public.hotels(id) on delete cascade,
  -- The hotel date the current (or last) daily pass is for.
  pass_date                 date,
  -- Next night the pass prices; null once it has reached the last night.
  pass_cursor               date,
  pass_started_at           timestamptz,
  pass_completed_at         timestamptz,
  -- new_day | owner_edit | horizon | first_run
  pass_reason               text,
  -- The window length the pass was started with.
  pass_horizon_days         integer,
  -- full_reprice_seq as it was when the current pass started.
  pass_reprice_seq          bigint,
  -- Bumped by every owner edit that can move any night; a new pass starts
  -- when it is past pass_reprice_seq.
  full_reprice_seq          bigint,
  full_reprice_requested_at timestamptz,
  -- Last tick that priced (or found nothing to price) without an error.
  last_ok_run_at            timestamptz,
  -- Nights whose booking speed reading leans on nearby nights (momentum), as
  -- each night's latest pricing found: a booking on a night up to 10 days
  -- away re-prices them.
  momentum_nights           date[] not null default '{}',
  -- Moving average of engine time per night priced.
  ms_per_night              numeric,
  updated_at                timestamptz not null default now()
);

comment on table public.hotel_pricing_state is
  'Per hotel: how far today''s daily pass has got, whether an owner edit '
  'asked for a new one, and when pricing last ran cleanly. See '
  '99_supabase_migration_pricing_cadence_v1.sql.';

-- ----------------------------------------------------------------------------
-- 2. evaluation_run_log
-- ----------------------------------------------------------------------------

alter table public.evaluation_run_log
  add column if not exists run_kind text,
  add column if not exists nights_priced integer,
  add column if not exists nights date[];

comment on column public.evaluation_run_log.run_kind is
  'window: every night from first_stay_date to last_stay_date. nights: the '
  'nights listed in `nights` (first/last are then null). idle: a tick with '
  'nothing to price. save: a typed price''s own run. Null on older rows.';

-- ----------------------------------------------------------------------------
-- 3. pms_connections.base_rates_through
-- ----------------------------------------------------------------------------

alter table public.pms_connections
  add column if not exists base_rates_through date;

comment on column public.pms_connections.base_rates_through is
  'Last night the most recent base rate refresh read. A window reaching '
  'further makes the refresh due at once instead of within the hour.';

-- ----------------------------------------------------------------------------
-- 4. Access
-- ----------------------------------------------------------------------------
-- Only the scheduled functions (service role) and the security definer
-- functions below touch these tables. Signed-in sessions still mark nights:
-- the triggers run as the function owner.

alter table public.pricing_dirty_nights enable row level security;
alter table public.hotel_pricing_state enable row level security;

revoke all on table public.pricing_dirty_nights from public, anon, authenticated;
revoke all on table public.hotel_pricing_state from public, anon, authenticated;
grant select, insert, update, delete on table public.pricing_dirty_nights to service_role;
grant select, insert, update, delete on table public.hotel_pricing_state to service_role;
revoke all on sequence public.pricing_mark_seq from public, anon, authenticated;
grant usage, select on sequence public.pricing_mark_seq to service_role;

-- ----------------------------------------------------------------------------
-- 5. Marking functions
-- ----------------------------------------------------------------------------

-- Marks nights. Pairs of (hotel, night); nights before yesterday (UTC) are
-- over for every time zone and skipped, and so are hotels that no longer
-- exist (a hotel being deleted cascades into the tables that mark). Rows are
-- written in key order, so two writers marking overlapping nights lock them
-- in the same order.
create or replace function public.pricing_mark_many(p_hotels uuid[], p_dates date[], p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_hotels is null or p_dates is null then
    return;
  end if;
  insert into public.pricing_dirty_nights as d (hotel_id, stay_date, mark_seq, reasons)
  select x.hotel_id, x.stay_date, nextval('public.pricing_mark_seq'), array[p_reason]
    from (
      select distinct u.h as hotel_id, u.s as stay_date
        from unnest(p_hotels, p_dates) as u(h, s)
       where u.h is not null
         and u.s is not null
         and u.s >= (now() at time zone 'utc')::date - 1
    ) x
   where exists (select 1 from public.hotels h where h.id = x.hotel_id)
   order by x.hotel_id, x.stay_date
  on conflict (hotel_id, stay_date) do update
     set last_marked_at = now(),
         -- Taken here, in the update itself: a row that waited on another
         -- writer's lock still gets a number bigger than anything read.
         mark_seq = nextval('public.pricing_mark_seq'),
         reasons = case when p_reason = any(d.reasons) then d.reasons else d.reasons || p_reason end;
end;
$$;

revoke all on function public.pricing_mark_many(uuid[], date[], text) from public, anon, authenticated;
grant execute on function public.pricing_mark_many(uuid[], date[], text) to service_role;

-- Every night from p_from to p_to, clipped to yesterday (UTC) .. 800 nights on.
create or replace function public.pricing_mark_range(p_hotel_id uuid, p_from date, p_to date, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_from date := greatest(p_from, (now() at time zone 'utc')::date - 1);
  v_to   date := least(p_to, (now() at time zone 'utc')::date + 800);
begin
  if p_hotel_id is null or v_from is null or v_to is null or v_to < v_from then
    return;
  end if;
  perform public.pricing_mark_many(
    array_agg(p_hotel_id),
    array_agg(d::date),
    p_reason
  )
  from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') as g(d);
end;
$$;

revoke all on function public.pricing_mark_range(uuid, date, date, text) from public, anon, authenticated;
grant execute on function public.pricing_mark_range(uuid, date, date, text) to service_role;

-- Asks for a new daily pass: an edit that can move any night.
create or replace function public.pricing_mark_hotel(p_hotel_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_hotel_id is null then
    return;
  end if;
  insert into public.hotel_pricing_state as s (hotel_id, full_reprice_seq, full_reprice_requested_at)
  select p_hotel_id, nextval('public.pricing_mark_seq'), now()
   where exists (select 1 from public.hotels h where h.id = p_hotel_id)
  on conflict (hotel_id) do update
     set full_reprice_seq = nextval('public.pricing_mark_seq'),
         full_reprice_requested_at = now(),
         updated_at = now();
end;
$$;

revoke all on function public.pricing_mark_hotel(uuid) from public, anon, authenticated;
grant execute on function public.pricing_mark_hotel(uuid) to service_role;

-- ----------------------------------------------------------------------------
-- 6. Triggers
-- ----------------------------------------------------------------------------

-- 6a. Bookings. One trigger per event (a trigger with transition tables
-- takes one event). An update marks both the old and the new night, and only
-- when a column pricing reads changed: a payload-only rewrite (a guest note,
-- a redaction) marks nothing. A move is a delete of the old nights and an
-- insert of the new ones; a cancellation deletes the rows; a room type change
-- updates room_type_id on the same night. A column the engine starts reading
-- later must be added to both lists below (see the cadence tests).

create or replace function public.pricing_mark_reservations_ins()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.pricing_mark_many(array_agg(n.hotel_id), array_agg(n.stay_date), 'booking')
    from (select distinct r.hotel_id, r.stay_date from new_rows r) n;
  return null;
end;
$$;

create or replace function public.pricing_mark_reservations_upd()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.pricing_mark_many(array_agg(c.hotel_id), array_agg(c.stay_date), 'booking')
    from (
      select o.hotel_id, o.stay_date
        from old_rows o join new_rows n on n.id = o.id
       where (o.hotel_id, o.stay_date, o.room_type_id, o.current_rate, o.base_rate, o.booking_date,
              o.booking_window_days, o.external_reservation_id, o.created_at)
             is distinct from
             (n.hotel_id, n.stay_date, n.room_type_id, n.current_rate, n.base_rate, n.booking_date,
              n.booking_window_days, n.external_reservation_id, n.created_at)
      union
      select n.hotel_id, n.stay_date
        from old_rows o join new_rows n on n.id = o.id
       where (o.hotel_id, o.stay_date, o.room_type_id, o.current_rate, o.base_rate, o.booking_date,
              o.booking_window_days, o.external_reservation_id, o.created_at)
             is distinct from
             (n.hotel_id, n.stay_date, n.room_type_id, n.current_rate, n.base_rate, n.booking_date,
              n.booking_window_days, n.external_reservation_id, n.created_at)
    ) c;
  return null;
end;
$$;

create or replace function public.pricing_mark_reservations_del()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.pricing_mark_many(array_agg(o.hotel_id), array_agg(o.stay_date), 'booking')
    from (select distinct r.hotel_id, r.stay_date from old_rows r) o;
  return null;
end;
$$;

drop trigger if exists trg_pricing_mark_reservations_ins on public.reservations;
create trigger trg_pricing_mark_reservations_ins
  after insert on public.reservations
  referencing new table as new_rows
  for each statement execute function public.pricing_mark_reservations_ins();

drop trigger if exists trg_pricing_mark_reservations_upd on public.reservations;
create trigger trg_pricing_mark_reservations_upd
  after update on public.reservations
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.pricing_mark_reservations_upd();

drop trigger if exists trg_pricing_mark_reservations_del on public.reservations;
create trigger trg_pricing_mark_reservations_del
  after delete on public.reservations
  referencing old table as old_rows
  for each statement execute function public.pricing_mark_reservations_del();

-- 6b. Base rates: the hotel's own rate, read from the PMS hourly. A rate
-- that did not change marks nothing.

create or replace function public.pricing_mark_base_rates_ins()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.pricing_mark_many(array_agg(n.hotel_id), array_agg(n.stay_date), 'base_rate')
    from (select distinct r.hotel_id, r.stay_date from new_rows r) n;
  return null;
end;
$$;

create or replace function public.pricing_mark_base_rates_upd()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.pricing_mark_many(array_agg(c.hotel_id), array_agg(c.stay_date), 'base_rate')
    from (
      select distinct n.hotel_id, n.stay_date
        from old_rows o
        join new_rows n
          on n.hotel_id = o.hotel_id and n.stay_date = o.stay_date and n.room_type_id = o.room_type_id
       where n.price is distinct from o.price
    ) c;
  return null;
end;
$$;

create or replace function public.pricing_mark_base_rates_del()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.pricing_mark_many(array_agg(o.hotel_id), array_agg(o.stay_date), 'base_rate')
    from (select distinct r.hotel_id, r.stay_date from old_rows r) o;
  return null;
end;
$$;

drop trigger if exists trg_pricing_mark_base_rates_ins on public.base_rate_calendar;
create trigger trg_pricing_mark_base_rates_ins
  after insert on public.base_rate_calendar
  referencing new table as new_rows
  for each statement execute function public.pricing_mark_base_rates_ins();

drop trigger if exists trg_pricing_mark_base_rates_upd on public.base_rate_calendar;
create trigger trg_pricing_mark_base_rates_upd
  after update on public.base_rate_calendar
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.pricing_mark_base_rates_upd();

drop trigger if exists trg_pricing_mark_base_rates_del on public.base_rate_calendar;
create trigger trg_pricing_mark_base_rates_del
  after delete on public.base_rate_calendar
  referencing old table as old_rows
  for each statement execute function public.pricing_mark_base_rates_del();

-- 6c. Typed prices, and rates the hotel changed in the PMS on nights MAYA
-- had sent (both are manual_price rows). Typing, re-typing (set_at moves:
-- a rule's wait runs from it), clearing and deleting all mark the night.

create or replace function public.pricing_mark_manual_price_ins()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.pricing_mark_many(array_agg(n.hotel_id), array_agg(n.stay_date), 'manual_price')
    from (select distinct r.hotel_id, r.stay_date from new_rows r) n;
  return null;
end;
$$;

create or replace function public.pricing_mark_manual_price_upd()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.pricing_mark_many(array_agg(c.hotel_id), array_agg(c.stay_date), 'manual_price')
    from (
      select distinct n.hotel_id, n.stay_date
        from old_rows o
        join new_rows n
          on n.hotel_id = o.hotel_id and n.stay_date = o.stay_date and n.room_type_id = o.room_type_id
       where (n.price, n.set_at, n.cleared_at) is distinct from (o.price, o.set_at, o.cleared_at)
    ) c;
  return null;
end;
$$;

create or replace function public.pricing_mark_manual_price_del()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.pricing_mark_many(array_agg(o.hotel_id), array_agg(o.stay_date), 'manual_price')
    from (select distinct r.hotel_id, r.stay_date from old_rows r) o;
  return null;
end;
$$;

drop trigger if exists trg_pricing_mark_manual_price_ins on public.manual_price;
create trigger trg_pricing_mark_manual_price_ins
  after insert on public.manual_price
  referencing new table as new_rows
  for each statement execute function public.pricing_mark_manual_price_ins();

drop trigger if exists trg_pricing_mark_manual_price_upd on public.manual_price;
create trigger trg_pricing_mark_manual_price_upd
  after update on public.manual_price
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.pricing_mark_manual_price_upd();

drop trigger if exists trg_pricing_mark_manual_price_del on public.manual_price;
create trigger trg_pricing_mark_manual_price_del
  after delete on public.manual_price
  referencing old table as old_rows
  for each statement execute function public.pricing_mark_manual_price_del();

-- 6d. Rooms out of service: every night of the old range and of the new.

create or replace function public.pricing_mark_out_of_service()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.pricing_mark_range(old.hotel_id, old.start_date, old.end_date, 'out_of_service');
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.pricing_mark_range(new.hotel_id, new.start_date, new.end_date, 'out_of_service');
  end if;
  return null;
end;
$$;

drop trigger if exists trg_pricing_mark_out_of_service_ins_del on public.room_type_out_of_service;
create trigger trg_pricing_mark_out_of_service_ins_del
  after insert or delete on public.room_type_out_of_service
  for each row execute function public.pricing_mark_out_of_service();

drop trigger if exists trg_pricing_mark_out_of_service_upd on public.room_type_out_of_service;
create trigger trg_pricing_mark_out_of_service_upd
  after update on public.room_type_out_of_service
  for each row
  when ((old.room_type_id, old.start_date, old.end_date, old.units, old.cleared_at)
        is distinct from
        (new.room_type_id, new.start_date, new.end_date, new.units, new.cleared_at))
  execute function public.pricing_mark_out_of_service();

-- 6e. The owner's answer to the three-changes alert: stop, keep adjusting,
-- or let the rule run again. The engine's own writes to these rows (filing,
-- counts, closing a night) never change the choice or set 'resumed', so this
-- cannot loop.

create or replace function public.pricing_mark_alert_answer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.pricing_mark_many(array[new.hotel_id], array[new.stay_date], 'alert_answer');
  return null;
end;
$$;

drop trigger if exists trg_pricing_mark_alert_answer on public.rule_repeat_alert_nights;
create trigger trg_pricing_mark_alert_answer
  after update on public.rule_repeat_alert_nights
  for each row
  when (old.choice is distinct from new.choice
        or (new.closed_reason = 'resumed' and old.closed_reason is distinct from 'resumed'))
  execute function public.pricing_mark_alert_answer();

-- 6f. Edits that can move any night ask for a new pass.

create or replace function public.pricing_mark_hotel_row()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hotel uuid;
  v_rule  uuid;
begin
  if tg_table_name in ('rule_condition', 'rule_signal_room_type', 'rule_affected_room_type') then
    if tg_op = 'DELETE' then
      v_rule := old.rule_id;
    else
      v_rule := new.rule_id;
    end if;
    -- A rule deleted with its children is marked by the rule's own trigger.
    select r.hotel_id into v_hotel from public.pricing_rules r where r.id = v_rule;
    -- A child moved from one rule to another marks both hotels (never in
    -- practice: the ids are the rule's own).
    if tg_op = 'UPDATE' and old.rule_id is distinct from new.rule_id then
      perform public.pricing_mark_hotel((select r.hotel_id from public.pricing_rules r where r.id = old.rule_id));
    end if;
  elsif tg_table_name = 'hotels' then
    v_hotel := new.id;
  elsif tg_op = 'DELETE' then
    v_hotel := old.hotel_id;
  else
    v_hotel := new.hotel_id;
  end if;
  perform public.pricing_mark_hotel(v_hotel);
  return null;
end;
$$;

drop trigger if exists trg_pricing_mark_rules_ins_del on public.pricing_rules;
create trigger trg_pricing_mark_rules_ins_del
  after insert or delete on public.pricing_rules
  for each row execute function public.pricing_mark_hotel_row();

drop trigger if exists trg_pricing_mark_rules_upd on public.pricing_rules;
create trigger trg_pricing_mark_rules_upd
  after update on public.pricing_rules
  for each row
  when ((old.is_active, old.version, old.priority, old.start_date, old.end_date, old.is_annual, old.dow_mask,
         old.action_type, old.action_direction, old.action_value, old.is_pickup_rule, old.undo_on_cancellation)
        is distinct from
        (new.is_active, new.version, new.priority, new.start_date, new.end_date, new.is_annual, new.dow_mask,
         new.action_type, new.action_direction, new.action_value, new.is_pickup_rule, new.undo_on_cancellation))
  execute function public.pricing_mark_hotel_row();

drop trigger if exists trg_pricing_mark_rule_condition on public.rule_condition;
create trigger trg_pricing_mark_rule_condition
  after insert or update or delete on public.rule_condition
  for each row execute function public.pricing_mark_hotel_row();

drop trigger if exists trg_pricing_mark_rule_signals on public.rule_signal_room_type;
create trigger trg_pricing_mark_rule_signals
  after insert or update or delete on public.rule_signal_room_type
  for each row execute function public.pricing_mark_hotel_row();

drop trigger if exists trg_pricing_mark_rule_affected on public.rule_affected_room_type;
create trigger trg_pricing_mark_rule_affected
  after insert or update or delete on public.rule_affected_room_type
  for each row execute function public.pricing_mark_hotel_row();

-- The syncs re-write room types every tick; only a change pricing reads marks.
drop trigger if exists trg_pricing_mark_room_types_ins_del on public.room_types;
create trigger trg_pricing_mark_room_types_ins_del
  after insert or delete on public.room_types
  for each row execute function public.pricing_mark_hotel_row();

drop trigger if exists trg_pricing_mark_room_types_upd on public.room_types;
create trigger trg_pricing_mark_room_types_upd
  after update on public.room_types
  for each row
  when ((old.is_active, old.floor_price, old.ceiling_price, old.total_rooms, old.counts_as_room)
        is distinct from
        (new.is_active, new.floor_price, new.ceiling_price, new.total_rooms, new.counts_as_room))
  execute function public.pricing_mark_hotel_row();

drop trigger if exists trg_pricing_mark_closed_periods on public.hotel_closed_periods;
create trigger trg_pricing_mark_closed_periods
  after insert or update or delete on public.hotel_closed_periods
  for each row execute function public.pricing_mark_hotel_row();

drop trigger if exists trg_pricing_mark_challenges on public.assumption_challenges;
create trigger trg_pricing_mark_challenges
  after insert or update or delete on public.assumption_challenges
  for each row execute function public.pricing_mark_hotel_row();

drop trigger if exists trg_pricing_mark_hotel_timezone on public.hotels;
create trigger trg_pricing_mark_hotel_timezone
  after update of timezone on public.hotels
  for each row
  when (old.timezone is distinct from new.timezone)
  execute function public.pricing_mark_hotel_row();

revoke all on function public.pricing_mark_reservations_ins() from public, anon, authenticated;
revoke all on function public.pricing_mark_reservations_upd() from public, anon, authenticated;
revoke all on function public.pricing_mark_reservations_del() from public, anon, authenticated;
revoke all on function public.pricing_mark_base_rates_ins() from public, anon, authenticated;
revoke all on function public.pricing_mark_base_rates_upd() from public, anon, authenticated;
revoke all on function public.pricing_mark_base_rates_del() from public, anon, authenticated;
revoke all on function public.pricing_mark_manual_price_ins() from public, anon, authenticated;
revoke all on function public.pricing_mark_manual_price_upd() from public, anon, authenticated;
revoke all on function public.pricing_mark_manual_price_del() from public, anon, authenticated;
revoke all on function public.pricing_mark_out_of_service() from public, anon, authenticated;
revoke all on function public.pricing_mark_alert_answer() from public, anon, authenticated;
revoke all on function public.pricing_mark_hotel_row() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 7. Functions the scheduled functions and the engine call
-- ----------------------------------------------------------------------------

-- What one hotel has to price this tick, in one call: the marked nights in
-- the window (with the number each was read at) and the hotel's pass state.
-- Rows outside the window are left for pricing_run_done() to tidy.
create or replace function public.pricing_work(
  p_hotel_id uuid,
  p_first date,
  p_last date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'Only the scheduled sync reads the pricing work list'
      using errcode = '42501';
  end if;

  return jsonb_build_object(
    'dirty', coalesce((
      select jsonb_agg(jsonb_build_object(
               'stay_date', d.stay_date,
               'mark_seq', d.mark_seq,
               'first_marked_at', d.first_marked_at,
               'reasons', to_jsonb(d.reasons))
             order by d.stay_date)
        from public.pricing_dirty_nights d
       where d.hotel_id = p_hotel_id
         and d.stay_date between p_first and p_last
    ), '[]'::jsonb),
    'state', (select to_jsonb(s) from public.hotel_pricing_state s where s.hotel_id = p_hotel_id)
  );
end;
$$;

revoke all on function public.pricing_work(uuid, date, date) from public, anon, authenticated;
grant execute on function public.pricing_work(uuid, date, date) to service_role;

-- What a run priced, in one call and one transaction (p_run, jsonb):
--   at            the tick's instant
--   first, last   the window
--   nights        every night the run priced
--   dirty         [{stay_date, mark_seq}] marks the run read for nights it
--                 priced: each is cleared only if not marked again since
--   failed        nights not fully written (a failed publish or fire):
--                 marked again for the next tick
--   again         nights where the run changed a rule's state (a change made,
--                 taken off or restated, a ladder rule switched): the next
--                 run can decide differently on them, so they are marked
--                 again too, until a run changes nothing
--   pass          {date, start, from, next, horizon, reason, reprice_seq}
--                 when the run included a chunk of the daily pass. A start
--                 records a new pass; otherwise the cursor moves from `from`
--                 to `next` only if nobody moved it since (a stale run
--                 changes nothing). next null: the pass is done.
--   momentum      nights priced whose booking speed reading leans on nearby
--                 nights (the nights priced take this answer, the others
--                 keep theirs)
--   ms_per_night  engine time per night priced this run
--   idle          true for a tick with nothing to price: writes its
--                 heartbeat to evaluation_run_log (run_id)
create or replace function public.pricing_run_done(p_hotel_id uuid, p_run jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_at     timestamptz := (p_run->>'at')::timestamptz;
  v_first  date := (p_run->>'first')::date;
  v_last   date := (p_run->>'last')::date;
  v_nights date[] := coalesce(
    (select array_agg(value::date) from jsonb_array_elements_text(coalesce(p_run->'nights', '[]'::jsonb))),
    '{}'::date[]
  );
  v_momentum date[] := coalesce(
    (select array_agg(distinct value::date) from jsonb_array_elements_text(coalesce(p_run->'momentum', '[]'::jsonb))),
    '{}'::date[]
  );
  -- A JSON null is no pass step, the same as the key left out.
  v_pass   jsonb := nullif(p_run->'pass', 'null'::jsonb);
  v_cleared integer := 0;
  v_kept   integer := 0;
  v_moved  boolean := null;
  v_ms     numeric := nullif(p_run->>'ms_per_night', '')::numeric;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'Only the scheduled sync records pricing runs'
      using errcode = '42501';
  end if;
  if v_at is null or v_first is null or v_last is null then
    raise exception 'pricing_run_done needs at, first and last' using errcode = '22023';
  end if;

  -- Marks the run read and priced, unless marked again since.
  with read as (
    select x.stay_date, x.mark_seq
      from jsonb_to_recordset(coalesce(p_run->'dirty', '[]'::jsonb)) as x(stay_date date, mark_seq bigint)
     where x.stay_date = any(v_nights)
  ), gone as (
    delete from public.pricing_dirty_nights d
     using read r
     where d.hotel_id = p_hotel_id
       and d.stay_date = r.stay_date
       and d.mark_seq <= r.mark_seq
    returning 1
  )
  select count(*) into v_cleared from gone;

  -- Priced, but marked again while the run worked: what is left waiting is
  -- no older than this run.
  update public.pricing_dirty_nights d
     set first_marked_at = greatest(d.first_marked_at, v_at)
   where d.hotel_id = p_hotel_id
     and d.stay_date = any(v_nights);
  get diagnostics v_kept = row_count;

  -- Past nights, and nights past the window (the pass covers them as they
  -- come into it).
  delete from public.pricing_dirty_nights d
   where d.hotel_id = p_hotel_id and (d.stay_date < v_first or d.stay_date > v_last);

  -- Nights the run could not fully write come back next tick, and so do the
  -- nights where it changed what the next run reads.
  perform public.pricing_mark_many(
    array_agg(p_hotel_id),
    array_agg(value::date),
    'retry'
  )
  from jsonb_array_elements_text(coalesce(p_run->'failed', '[]'::jsonb));
  perform public.pricing_mark_many(
    array_agg(p_hotel_id),
    array_agg(value::date),
    'follow_up'
  )
  from jsonb_array_elements_text(coalesce(p_run->'again', '[]'::jsonb));

  insert into public.hotel_pricing_state (hotel_id)
  select p_hotel_id where exists (select 1 from public.hotels h where h.id = p_hotel_id)
  on conflict (hotel_id) do nothing;

  if v_pass is not null and coalesce((v_pass->>'start')::boolean, false) then
    update public.hotel_pricing_state s
       set pass_date = (v_pass->>'date')::date,
           pass_cursor = nullif(v_pass->>'next', '')::date,
           pass_started_at = v_at,
           pass_completed_at = case when nullif(v_pass->>'next', '') is null then v_at else null end,
           pass_reason = v_pass->>'reason',
           pass_horizon_days = nullif(v_pass->>'horizon', '')::integer,
           pass_reprice_seq = coalesce(nullif(v_pass->>'reprice_seq', '')::bigint, s.pass_reprice_seq)
     where s.hotel_id = p_hotel_id;
    v_moved := found;
  elsif v_pass is not null then
    update public.hotel_pricing_state s
       set pass_cursor = nullif(v_pass->>'next', '')::date,
           pass_completed_at = case when nullif(v_pass->>'next', '') is null then v_at else null end
     where s.hotel_id = p_hotel_id
       and s.pass_date = (v_pass->>'date')::date
       and s.pass_cursor = (v_pass->>'from')::date;
    v_moved := found;
  end if;

  -- Each night's momentum flag is the one its latest pricing found: the
  -- nights this run priced take this run's answer, the others keep theirs.
  update public.hotel_pricing_state s
     set last_ok_run_at = greatest(coalesce(s.last_ok_run_at, v_at), v_at),
         momentum_nights = (
           select coalesce(array_agg(distinct m order by m), '{}'::date[])
             from (
               select k.m from unnest(s.momentum_nights) as k(m)
                where k.m >= v_first and not (k.m = any(v_nights))
               union
               select n.m from unnest(v_momentum) as n(m)
             ) u(m)
         ),
         ms_per_night = case
           when v_ms is null then s.ms_per_night
           when s.ms_per_night is null then v_ms
           else round(s.ms_per_night * 0.8 + v_ms * 0.2, 3)
         end,
         updated_at = now()
   where s.hotel_id = p_hotel_id;

  if coalesce((p_run->>'idle')::boolean, false) and p_run->>'run_id' is not null then
    insert into public.evaluation_run_log
      (hotel_id, evaluation_run_id, evaluated_at, cells_checked, cells_changed, run_kind, nights_priced)
    values (p_hotel_id, (p_run->>'run_id')::uuid, v_at, 0, 0, 'idle', 0)
    on conflict (hotel_id, evaluation_run_id) do nothing;
  end if;

  return jsonb_build_object(
    'cleared', v_cleared,
    'kept', v_kept,
    'pass_moved', v_moved
  );
end;
$$;

revoke all on function public.pricing_run_done(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.pricing_run_done(uuid, jsonb) to service_role;

-- Stretches of more than p_min_gap_seconds between two successful runs of a
-- hotel, from p_from to p_to, the two ends counting as runs. A pickup count
-- whose window opens inside such a stretch is stale: nothing was priced for
-- the whole of it. Before this change the engine asked whether the snapshot
-- under the baseline was more than 12 hours older than it; with most nights
-- priced once a day that is true of every quiet night, while "no run at all"
-- is the outage the check was for.
create or replace function public.engine_run_gaps(
  p_hotel_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_min_gap_seconds integer
)
returns table(gap_from timestamptz, gap_to timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.is_hotel_accessible(p_hotel_id) then
    raise exception 'Not authorized to read runs for hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  return query
  with runs as (
    select l.evaluated_at as at
      from public.evaluation_run_log l
     where l.hotel_id = p_hotel_id
       and l.evaluated_at > p_from
       and l.evaluated_at < p_to
    union all select p_from
    union all select p_to
  ), ordered as (
    select r.at, lag(r.at) over (order by r.at) as prev
      from runs r
  )
  select o.prev, o.at
    from ordered o
   where o.prev is not null
     and o.at - o.prev > make_interval(secs => p_min_gap_seconds)
   order by o.prev;
end;
$$;

revoke all on function public.engine_run_gaps(uuid, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.engine_run_gaps(uuid, timestamptz, timestamptz, integer)
  to authenticated, service_role;

-- "Price everything again" from the app: a manager (or the service role)
-- asks for a new pass; the next tick starts it.
create or replace function public.request_full_reprice(p_hotel_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.can_manage_hotel(p_hotel_id) then
    raise exception 'Not authorized to re-price hotel %', p_hotel_id
      using errcode = '42501';
  end if;
  perform public.pricing_mark_hotel(p_hotel_id);
end;
$$;

revoke all on function public.request_full_reprice(uuid) from public, anon;
grant execute on function public.request_full_reprice(uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 8. Checks
-- ----------------------------------------------------------------------------

do $$
declare
  v_missing text;
begin
  select string_agg(t, ', ') into v_missing
    from unnest(array['pricing_dirty_nights', 'hotel_pricing_state']) t
   where to_regclass('public.' || t) is null;
  if v_missing is not null then
    raise exception 'pricing cadence: missing tables %', v_missing;
  end if;

  select string_agg(t, ', ') into v_missing
    from unnest(array[
      'trg_pricing_mark_reservations_ins', 'trg_pricing_mark_reservations_upd', 'trg_pricing_mark_reservations_del',
      'trg_pricing_mark_base_rates_ins', 'trg_pricing_mark_base_rates_upd', 'trg_pricing_mark_base_rates_del',
      'trg_pricing_mark_manual_price_ins', 'trg_pricing_mark_manual_price_upd', 'trg_pricing_mark_manual_price_del',
      'trg_pricing_mark_out_of_service_ins_del', 'trg_pricing_mark_out_of_service_upd',
      'trg_pricing_mark_alert_answer', 'trg_pricing_mark_rules_ins_del', 'trg_pricing_mark_rules_upd',
      'trg_pricing_mark_rule_condition', 'trg_pricing_mark_rule_signals', 'trg_pricing_mark_rule_affected',
      'trg_pricing_mark_room_types_ins_del', 'trg_pricing_mark_room_types_upd',
      'trg_pricing_mark_closed_periods', 'trg_pricing_mark_challenges', 'trg_pricing_mark_hotel_timezone'
    ]) t
   where not exists (select 1 from pg_trigger g where g.tgname = t and not g.tgisinternal);
  if v_missing is not null then
    raise exception 'pricing cadence: missing triggers %', v_missing;
  end if;

  if exists (
    select 1 from pg_class c
     where c.relname in ('pricing_dirty_nights', 'hotel_pricing_state')
       and c.relnamespace = 'public'::regnamespace
       and not c.relrowsecurity
  ) then
    raise exception 'pricing cadence: row level security is off on a queue table';
  end if;
end $$;

commit;

-- Verification (run by hand after the file):
--   select count(*) from public.pricing_dirty_nights;            -- grows as bookings sync
--   select hotel_id, pass_date, pass_cursor, last_ok_run_at
--     from public.hotel_pricing_state order by updated_at desc;   -- filled by the first ticks
