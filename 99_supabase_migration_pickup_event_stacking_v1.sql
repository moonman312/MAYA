-- ============================================================================
-- MAYA pickup event stacking (v1)
-- ============================================================================
--
-- Booking speed rules and pickup count rules (event rules) can now hold more
-- than one adjustment on the same night and room type. Once a rule's wait
-- has passed and its condition still holds, it fires again: a raise raises
-- again, a cut cuts again. Before this, a partial unique index allowed one
-- open pickup_event per (rule, night, room type), and the cancellation check
-- retired a cut in the very run that made it, so a "slower" cut showed for
-- one run and a "pickup less than" cut was written and retired every run.
--
-- 1. pickup_event gets:
--      fire_seq                 1, 2, 3 ... per (rule, night, room type), never
--                               reused. uq_pickup_event_fire makes it unique,
--                               and is what stops two overlapping runs from
--                               both adding the same fire (the loser gets a
--                               23505 naming the index and records
--                               'concurrent_fire').
--      retired_reason           why a fire came off: night_passed,
--                               bookings_cancelled, manual_price, rule_edited,
--                               self_cancelled (the old same-run bug, marked
--                               below) or legacy (retired before reasons were
--                               kept). Set exactly when retired_at is set.
--      cancel_check             which cancellation test can take a raise off:
--                               none, net_units, window_bookings or either.
--                               Cuts are always none.
--      window_from / window_to  the booking speed window at the fire, in hotel
--                               dates (bookings made from .. to, inclusive).
--      window_bookings_at_fire  bookings made in that window, and
--      window_expected_at_fire  the bookings a night like it usually gets.
--      signal_set_key           the measured room types at the fire (sorted
--                               ids, comma separated). The cancellation tests
--                               are skipped while the rule measures another set.
--    Existing rows are numbered in applied_at order. Rows retired in the run
--    that fired them (retired_at = applied_at) are marked self_cancelled.
--    Rows retired by a manual price save (retired_at = the cell's
--    manual_price.set_at, fired before it) are marked manual_price. Every other
--    retired row is legacy. Open raises from a "pickup more than" rule keep
--    today's cancellation test (net_units); nothing else is undone by
--    cancellations. Nothing is re-opened and nothing is deleted.
--
-- 2. uq_pickup_event_active_per_rule_stay_room (one open row per rule, night
--    and room type) is replaced by uq_pickup_event_fire.
--
-- 3. rule_condition.booking_speed_cooldown_days is at least 1. A stored 0
--    becomes 1: with stacking, 0 would cut or raise every five minutes.
--
-- 4. Drops trg_rule_condition_sync_pickup and its function. It set
--    is_pickup_rule = (pickup_operator is not null) after every rule_condition
--    insert, so a booking speed rule saved through the app (pricing_rules
--    first, then its condition) became a ladder rule with no wait. Rules with
--    a pickup or booking speed condition are set back to event rules, and any
--    ladder adjustment they hold is switched off with a deactivate transition
--    event, so a rule never applies its old ladder effect and its new fires at
--    once.
--
-- 5. pickup_fire_heads(hotel, rules, from, to): per (rule, night, room type,
--    rule version), the highest fire_seq, the newest fire that starts a wait
--    (open, or retired for cancellations, a passed night or legacy), and how
--    many fires count toward the owner alert (open or retired for
--    cancellations) with the newest of them. The engine reads it once per run.
--    rule_fire_counts leaves out self_cancelled rows. set_manual_prices_from_pms
--    (from 99_supabase_migration_push_guardrails_v1.sql) retires fires with
--    retired_reason 'manual_price'.
--
-- 6. Owner alerts when a rule keeps adjusting a night:
--      rule_repeat_alerts         one open alert per rule. Several nights
--                                 reaching 3 fires group into it.
--      rule_repeat_alert_nights   one row per (rule, night, rule version) that
--                                 reached 3 fires, with the numbers behind the
--                                 latest fire and the owner's choice.
--      rule_repeat_alert_choose() how a rule manager answers, and
--      rule_repeat_alert_resume() how they take an answer back.
--    See section 6 for what each column means and what writes it.
--
-- RLS: pickup_event keeps its policies. The alert tables are written by the
-- service role only (the scheduled runs and the manual price republish). Any
-- member of the hotel reads them. A run under a signed-in session (the
-- evaluate button, which runs the engine on the caller's own session) reads
-- them and logs its alert writes as refused; the next scheduled run files
-- what the fires already show. A choice goes through
-- rule_repeat_alert_choose and is taken back through
-- rule_repeat_alert_resume; both check can_manage_hotel. Nobody signed in
-- can delete, per 99_supabase_migration_no_customer_deletes_v1.sql.
--
-- Run AFTER 02_supabase_schema.sql, 99_supabase_migration_rules_engine_v1.sql,
-- 99_supabase_migration_booking_speed_v1.sql,
-- 99_supabase_migration_roles_v2_part2.sql (is_hotel_accessible,
-- can_manage_hotel), 99_supabase_migration_room_type_counts_as_room_v1.sql,
-- 99_supabase_migration_manual_price_v1.sql,
-- 99_supabase_migration_large_property_scale_v1.sql and
-- 99_supabase_migration_push_guardrails_v1.sql. Re-running
-- 99_supabase_migration_push_guardrails_v1.sql afterwards brings back its
-- set_manual_prices_from_pms, which names 'manual_price' on the fires it
-- retires. An older copy of that file does not: section 1f names those
-- retirements from the cell's own price, so a replay of the 99_ files in
-- filename order (this file sorts first) leaves a database that works either
-- way.
--
-- Idempotent. There is no pre-migration path in the code: run this, then
-- deploy cloudbeds-scheduled-sync, mews-scheduled-sync,
-- think-scheduled-sync and onboarding-import-worker (one command each; loops
-- are blocked), then push the app straight after. onboarding-import-worker is
-- on the list because it is the only place that writes a hotel's starter
-- rules and their explanations (_shared/onboarding/generate-rules.ts through
-- analysis.ts), and those now say that a rule adjusts again and that MAYA
-- asks after three times; a hotel onboarded on the old bundle keeps the old
-- text for good.
--
-- Until the code is deployed, the old engine's inserts fail on fire_seq (no
-- fires, logged as write_failed) and its retirements fail the reason check
-- (nothing is taken off), so nothing stacks unguarded and nothing is wiped in
-- the gap. The one path in the gap that does not fail soft is
-- /api/manual-price, which writes in steps and throws on a failed one: section
-- 1f names its retirement for it so a typed price still saves.
--
-- Checks afterwards are at the end of this file.

begin;

-- ----------------------------------------------------------------------------
-- 1. pickup_event columns
-- ----------------------------------------------------------------------------

alter table public.pickup_event
  add column if not exists fire_seq integer,
  add column if not exists retired_reason text,
  add column if not exists cancel_check text not null default 'none',
  add column if not exists window_from date,
  add column if not exists window_to date,
  add column if not exists window_bookings_at_fire integer,
  add column if not exists window_expected_at_fire numeric(10,2),
  add column if not exists signal_set_key text;

comment on column public.pickup_event.fire_seq is
  'Fire number per (rule, night, room type), from 1, never reused. Unique with uq_pickup_event_fire.';
comment on column public.pickup_event.retired_reason is
  'night_passed | bookings_cancelled | manual_price | rule_edited | self_cancelled | legacy. '
  'Set exactly when retired_at is set.';
comment on column public.pickup_event.cancel_check is
  'Which cancellation test can retire this raise: none | net_units | window_bookings | either. Cuts are none.';
comment on column public.pickup_event.window_from is
  'First booking date of the booking speed window at the fire (hotel date).';
comment on column public.pickup_event.window_to is
  'Last booking date of the booking speed window at the fire (hotel date, the run''s date).';
comment on column public.pickup_event.window_bookings_at_fire is
  'Bookings for the night made in the booking speed window, at the fire.';
comment on column public.pickup_event.window_expected_at_fire is
  'Bookings a night like it usually gets in that window, at the fire.';
comment on column public.pickup_event.signal_set_key is
  'The room types the rule measured at the fire: sorted ids, comma separated.';

-- Re-added in step 1e, after the backfill.
alter table public.pickup_event drop constraint if exists pickup_event_retired_reason_chk;
alter table public.pickup_event drop constraint if exists pickup_event_retired_reason_set_chk;
alter table public.pickup_event drop constraint if exists pickup_event_cancel_check_chk;
alter table public.pickup_event drop constraint if exists pickup_event_cancel_increase_chk;
alter table public.pickup_event drop constraint if exists pickup_event_window_chk;
alter table public.pickup_event drop constraint if exists pickup_event_fire_seq_chk;

-- 1a. Why existing rows were retired. The same run stamped applied_at and
-- retired_at with one clock, so equal times are the same-run bug exactly. A
-- manual price save stamped the retirement with the price's set_at (only the
-- latest save per cell is still on record).
update public.pickup_event
   set retired_reason = 'self_cancelled'
 where retired_reason is null
   and retired_at is not null
   and retired_at = applied_at;

update public.pickup_event e
   set retired_reason = 'manual_price'
  from public.manual_price m
 where e.retired_reason is null
   and e.retired_at is not null
   and m.hotel_id = e.hotel_id
   and m.room_type_id = e.affected_room_type_id
   and m.stay_date = e.stay_date
   and e.retired_at = m.set_at
   and e.applied_at < e.retired_at;

update public.pickup_event
   set retired_reason = 'legacy'
 where retired_reason is null
   and retired_at is not null;

-- 1b. Rows from before this migration (fire_seq still null) measured the
-- rule's current set, as far as anyone can tell: active room types that count
-- as rooms, the set the engine measures. Sorted byte-wise, as the engine sorts.
update public.pickup_event e
   set signal_set_key = coalesce((
         select string_agg(s.room_type_id::text, ',' order by s.room_type_id::text collate "C")
           from public.rule_signal_room_type s
           join public.room_types rt on rt.id = s.room_type_id
          where s.rule_id = e.rule_id
            and rt.is_active
            and rt.counts_as_room is not false
       ), '')
 where e.fire_seq is null
   and e.signal_set_key is null;

-- 1c. Open raises from before this migration keep the cancellation test they
-- had, where it meant something: a "pickup more than" rule whose bookings
-- grew. A booking speed raise never recorded its window, so it holds until
-- its night passes, a price is set for it or the rule is edited.
update public.pickup_event e
   set cancel_check = 'net_units'
  from public.rule_condition c
 where e.fire_seq is null
   and c.rule_id = e.rule_id
   and c.pickup_operator = 'gt'
   and coalesce(c.pickup_threshold, 0) >= 0
   and e.retired_at is null
   and e.action_direction = 'increase'
   and e.cancel_check = 'none'
   and e.signal_booked_units_end > e.signal_booked_units_start;

-- 1d. Fire numbers, retired rows included, in the order they fired. Only rows
-- without one are numbered, above the cell's highest, so this can run again.
with top as (
  select rule_id, stay_date, affected_room_type_id, coalesce(max(fire_seq), 0) as top
    from public.pickup_event
   group by rule_id, stay_date, affected_room_type_id
),
numbered as (
  select e.id,
         t.top + row_number() over (
           partition by e.rule_id, e.stay_date, e.affected_room_type_id
           order by e.applied_at, e.id
         ) as n
    from public.pickup_event e
    join top t
      on t.rule_id = e.rule_id
     and t.stay_date = e.stay_date
     and t.affected_room_type_id = e.affected_room_type_id
   where e.fire_seq is null
)
update public.pickup_event e
   set fire_seq = numbered.n
  from numbered
 where numbered.id = e.id;

alter table public.pickup_event alter column fire_seq set not null;
alter table public.pickup_event alter column signal_set_key set not null;

-- 1e. Checks.
alter table public.pickup_event add constraint pickup_event_fire_seq_chk
  check (fire_seq >= 1);
alter table public.pickup_event add constraint pickup_event_retired_reason_chk
  check (retired_reason is null or retired_reason in
    ('night_passed', 'bookings_cancelled', 'manual_price', 'rule_edited', 'self_cancelled', 'legacy'));
alter table public.pickup_event add constraint pickup_event_retired_reason_set_chk
  check ((retired_at is null) = (retired_reason is null));
alter table public.pickup_event add constraint pickup_event_cancel_check_chk
  check (cancel_check in ('none', 'net_units', 'window_bookings', 'either'));
alter table public.pickup_event add constraint pickup_event_cancel_increase_chk
  check (cancel_check = 'none' or action_direction = 'increase');
alter table public.pickup_event add constraint pickup_event_window_chk
  check (
    cancel_check not in ('window_bookings', 'either')
    or (window_from is not null and window_to is not null and window_from <= window_to
        and window_bookings_at_fire is not null and window_expected_at_fire is not null)
  );

-- 1f. The reason on a retirement written by code that predates the column.
--
-- Two writers still set retired_at with no reason, and both mean the same
-- thing: a price was set for the cell.
--
--   * /api/manual-price, between this migration and the app deploy. It writes
--     the manual_price rows, suppresses the ladder rows and only then retires
--     the fires, so pickup_event_retired_reason_set_chk would fail the save
--     after two of its three writes had landed: the owner reads "save failed"
--     however often they retry, the price is set all the same, the cell's
--     fires are still stacked on it, and the route never reaches its
--     republish, so nothing is sent or logged for those nights.
--   * set_manual_prices_from_pms as an older copy of
--     99_supabase_migration_push_guardrails_v1.sql defines it. That file sorts
--     after this one, so replaying the 99_ files in filename order (a fresh
--     staging rebuild, a new region, or running the list again) puts its body
--     back last. Every PMS edit would then fail to be adopted with a 23514,
--     and MAYA would go on publishing and sending its own price over the
--     hotel's change. That file now names the reason itself, so a replay of
--     today's copy is safe on its own; the trigger stays for a checkout that
--     still has the old one, and for the deploy gap above.
--
-- Both write the price first and stamp retired_at with the same instant they
-- wrote its set_at, so the reason can be read off the cell. Everything else
-- that retires without a reason -- above all the old engine's cancellation
-- check, which would wipe fires it can't judge and block their rules for a
-- whole wait -- still fails the check, which is what keeps the gap safe.
--
-- Once the app is deployed every writer names its own reason, so the trigger
-- returns on its first line and does nothing.

create or replace function public.pickup_event_manual_price_reason()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.retired_at is null or new.retired_reason is not null then
    return new;
  end if;
  if exists (
    select 1
      from public.manual_price m
     where m.hotel_id = new.hotel_id
       and m.stay_date = new.stay_date
       and m.room_type_id = new.affected_room_type_id
       and m.cleared_at is null
       and m.set_at = new.retired_at
  ) then
    new.retired_reason := 'manual_price';
  end if;
  return new;
end;
$$;

comment on function public.pickup_event_manual_price_reason() is
  'Names a reason-less retirement made by a manual price save from code that predates '
  'pickup_event.retired_reason (the deploy gap, and a replay of '
  '99_supabase_migration_push_guardrails_v1.sql). Every other reason-less retirement still fails.';

revoke all on function public.pickup_event_manual_price_reason() from public, anon, authenticated;

drop trigger if exists trg_pickup_event_manual_price_reason on public.pickup_event;
create trigger trg_pickup_event_manual_price_reason
  before update on public.pickup_event
  for each row execute function public.pickup_event_manual_price_reason();

-- ----------------------------------------------------------------------------
-- 2. One fire number per (rule, night, room type), several open fires allowed
-- ----------------------------------------------------------------------------

create unique index if not exists uq_pickup_event_fire
  on public.pickup_event (rule_id, stay_date, affected_room_type_id, fire_seq);

drop index if exists public.uq_pickup_event_active_per_rule_stay_room;

-- ----------------------------------------------------------------------------
-- 3. A booking speed rule waits at least a day
-- ----------------------------------------------------------------------------

update public.rule_condition
   set booking_speed_cooldown_days = 1
 where booking_speed_cooldown_days = 0;

alter table public.rule_condition drop constraint if exists rule_condition_bs_cooldown_chk;
-- The inline check's automatic name on a database built from 02.
alter table public.rule_condition drop constraint if exists rule_condition_booking_speed_cooldown_days_check;
alter table public.rule_condition add constraint rule_condition_bs_cooldown_chk
  check (booking_speed_cooldown_days is null or booking_speed_cooldown_days >= 1);

-- ----------------------------------------------------------------------------
-- 4. No trigger turning booking speed rules into ladder rules
-- ----------------------------------------------------------------------------

drop trigger if exists trg_rule_condition_sync_pickup on public.rule_condition;
drop function if exists public.sync_rule_pickup_flag_from_condition();

with flipped as (
  update public.pricing_rules p
     set is_pickup_rule = true
    from public.rule_condition c
   where c.rule_id = p.id
     and not p.is_pickup_rule
     and (c.pickup_operator is not null or c.booking_speed_operator is not null)
  returning p.id, p.hotel_id
),
switched_off as (
  update public.ladder_rule_state s
     set is_active = false,
         deactivated_at = now()
    from flipped f
   where s.rule_id = f.id
     and s.is_active
  returning s.rule_id, s.rule_version, s.stay_date, s.room_type_id,
            s.action_kind, s.action_direction, s.action_value, f.hotel_id
)
insert into public.ladder_transition_event
  (hotel_id, rule_id, rule_version, stay_date, room_type_id, transition, transitioned_at,
   metrics_snapshot, action_kind, action_direction, action_value)
select o.hotel_id, o.rule_id, o.rule_version, o.stay_date, o.room_type_id, 'deactivate', now(),
       jsonb_build_object('reason', 'rule_became_event_rule'),
       o.action_kind, o.action_direction, o.action_value
  from switched_off o;

-- ----------------------------------------------------------------------------
-- 5. Functions
-- ----------------------------------------------------------------------------

create or replace function public.pickup_fire_heads(
  p_hotel_id uuid,
  p_rule_ids uuid[],
  p_from date,
  p_to date
)
returns table(
  rule_id uuid,
  stay_date date,
  affected_room_type_id uuid,
  rule_version integer,
  max_fire_seq integer,
  anchor_at timestamptz,
  counted_fires integer,
  last_counted_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.is_hotel_accessible(p_hotel_id) then
    raise exception 'Not authorized to read rule fires for hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  return query
  select e.rule_id,
         e.stay_date,
         e.affected_room_type_id,
         e.rule_version,
         max(e.fire_seq)::integer,
         max(e.applied_at) filter (
           where e.retired_at is null
              or e.retired_reason in ('bookings_cancelled', 'night_passed', 'legacy')),
         (count(*) filter (
           where e.retired_at is null or e.retired_reason = 'bookings_cancelled'))::integer,
         max(e.applied_at) filter (
           where e.retired_at is null or e.retired_reason = 'bookings_cancelled')
    from public.pickup_event e
   where e.hotel_id = p_hotel_id
     and e.rule_id = any(coalesce(p_rule_ids, '{}'::uuid[]))
     and e.stay_date between p_from and p_to
   group by e.rule_id, e.stay_date, e.affected_room_type_id, e.rule_version;
end;
$$;

revoke all on function public.pickup_fire_heads(uuid, uuid[], date, date) from public, anon;
grant execute on function public.pickup_fire_heads(uuid, uuid[], date, date) to authenticated, service_role;

-- Same as 99_supabase_migration_large_property_scale_v1.sql section 5, without
-- the rows the same-run bug wrote and took off at once.
create or replace function public.rule_fire_counts(p_hotel_id uuid)
returns table(rule_id uuid, fires bigint)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.is_hotel_accessible(p_hotel_id) then
    raise exception 'Not authorized to read rule history for hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  return query
  select f.rule_id, count(*)::bigint
  from (
    select e.rule_id
    from public.ladder_transition_event e
    where e.hotel_id = p_hotel_id and e.transition = 'activate'
    union all
    select p.rule_id
    from public.pickup_event p
    where p.hotel_id = p_hotel_id
      and p.retired_reason is distinct from 'self_cancelled'
  ) f
  group by f.rule_id;
end;
$$;

revoke all on function public.rule_fire_counts(uuid) from public, anon;
grant execute on function public.rule_fire_counts(uuid) to authenticated, service_role;

-- As in 99_supabase_migration_push_guardrails_v1.sql section 8, with the
-- retired fires' reason.
create or replace function public.set_manual_prices_from_pms(
  p_hotel_id uuid,
  p_pms_type public.pms_type,
  p_set_at timestamptz,
  p_cells jsonb
) returns table (cells integer, suppressed_rules integer, retired_pickups integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cells integer;
  v_rules integer;
  v_pickups integer;
begin
  insert into public.manual_price as mp
    (hotel_id, stay_date, room_type_id, price, note, set_by, set_at, cleared_at, cleared_by, source, pms_type)
  select distinct on (c.room_type_id, c.stay_date)
         p_hotel_id, c.stay_date, c.room_type_id, c.price, null, null, p_set_at, null, null, 'pms', p_pms_type
    from jsonb_to_recordset(p_cells) as c(room_type_id uuid, stay_date date, price numeric)
  on conflict (hotel_id, stay_date, room_type_id) do update
     set price = excluded.price,
         note = null,
         set_by = null,
         set_at = excluded.set_at,
         cleared_at = null,
         cleared_by = null,
         source = 'pms',
         pms_type = excluded.pms_type;
  get diagnostics v_cells = row_count;

  update public.ladder_rule_state s
     set suppressed_at = p_set_at
   where s.rule_id in (select r.id from public.pricing_rules r where r.hotel_id = p_hotel_id)
     and (s.room_type_id, s.stay_date) in (
           select c.room_type_id, c.stay_date
             from jsonb_to_recordset(p_cells) as c(room_type_id uuid, stay_date date))
     and s.is_active
     and s.suppressed_at is null;
  get diagnostics v_rules = row_count;

  update public.pickup_event e
     set retired_at = p_set_at,
         retired_reason = 'manual_price'
   where e.hotel_id = p_hotel_id
     and (e.affected_room_type_id, e.stay_date) in (
           select c.room_type_id, c.stay_date
             from jsonb_to_recordset(p_cells) as c(room_type_id uuid, stay_date date))
     and e.retired_at is null;
  get diagnostics v_pickups = row_count;

  return query select v_cells, v_rules, v_pickups;
end;
$$;

revoke all on function public.set_manual_prices_from_pms(uuid, public.pms_type, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.set_manual_prices_from_pms(uuid, public.pms_type, timestamptz, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- 6. Owner alerts when a rule keeps adjusting a night
-- ----------------------------------------------------------------------------
--
-- A night's fire count for a rule is the most fires the rule's current
-- version has on any one of its room types that night, counting fires that
-- are open or were taken off by cancellations. Fires taken off by a manual
-- price, an edit or the night passing don't count, and neither do
-- self_cancelled or legacy rows. When a run leaves the count at 3 or more,
-- the engine (_shared/engine/repeat-alerts.ts) files the night under the
-- rule's open alert, opening one if there is none, and the rule keeps firing
-- as usual. Each later fire on a night nobody has answered updates its row.
--
-- rule_repeat_alerts, one row per episode:
--   rule_version      the version whose fires reached 3. An edit starts the
--                     rule fresh: its unanswered nights close as rule_edited.
--   action_direction  the rule's direction then: decrease cuts, increase raises.
--   opened_at         the run that first filed a night under it.
--   updated_at        the last run that added or updated a night.
--   resolved_at       when no night is waiting on the owner any more.
--   resolution        chosen (the owner answered every night) or closed (at
--                     least one night ended without an answer).
--
-- rule_repeat_alert_nights, one row per (rule, night, rule version):
--   fire_count        the count above at the latest update. 3 or more while a
--                     night is waiting on an answer or carries one; a resumed
--                     night's follows its fires down when a typed price takes
--                     them off (see closed_reason).
--   reached_at        the run that filed it.
--   last_fire_at      the newest fire counted.
--   last_event_id     that fire's pickup_event id.
--   window_days, window_bookings, window_expected
--                     for a rule with a booking speed condition: at the latest
--                     fire, bookings made for the night in the measured
--                     period, and the bookings a night like it usually gets.
--   pickup_metric, pickup_threshold, pickup_window_days, pickup_net
--                     for a rule with a pickup condition: the rule's threshold
--                     and window, and the net pickup (room nights, or revenue
--                     for a revenue rule) measured at the latest fire.
--   room_types        jsonb array, one entry per room type the rule has fired
--                     on that night: {room_type_id, fires, limit,
--                     limit_is_default, price}. limit is the room type's floor
--                     for a cut and its ceiling for a raise, limit_is_default
--                     says it is still 1.00 or 99999.99 (both null for a room
--                     type no longer active), and price is what the run
--                     published for that room type and night (null when the
--                     run did not price it).
--   choice            null until the owner answers: keep_adjusting (no more
--                     alerts for this rule and night) or stop (the rule makes
--                     no more fires on this night; adjustments already made
--                     stay, and raises can still come off for cancellations).
--                     Both apply to this rule version only, and
--                     rule_repeat_alert_resume() takes either one back.
--   chosen_at, chosen_by
--   resumed_at, resumed_by
--                     when rule_repeat_alert_resume() last took an answer off
--                     this night, and who did it. Left there afterwards: the
--                     change log reads them to say a manager let the rule run
--                     again, the way it reads chosen_at for the answer. Only
--                     the latest resume of a night is kept, so a night stopped
--                     and let run twice reads as the second one.
--   closed_at, closed_reason
--                     set when an unanswered night stops needing an answer:
--                     night_passed, rule_edited, price_set (a manual price
--                     took its fires off, so its count fell below 3) or
--                     resumed (the owner took their answer back). A price_set
--                     night opens again, on the rule's open alert, if the rule
--                     stacks its way back to 3 on it: the wait runs from the
--                     price, and after it the rule adjusts the new price the
--                     same way. A resumed night opens again once the rule has
--                     adjusted it 3 more times than the fire_count on its row,
--                     so letting a rule run again does not put the same
--                     question straight back. That fire_count is the fires the
--                     owner has already seen, so a typed price that takes them
--                     off takes it down with them, to the count that is left:
--                     three adjustments on the typed price bring the night
--                     back, not three on top of fires nobody can see any more.
--                     night_passed and rule_edited end a night for good.
--
-- The engine honours a stop from the run after it is made, on every run that
-- prices the night. It never writes a choice.

create table if not exists public.rule_repeat_alerts (
  id               uuid primary key default gen_random_uuid(),
  hotel_id         uuid not null references public.hotels(id) on delete cascade,
  rule_id          uuid not null references public.pricing_rules(id) on delete cascade,
  rule_version     integer not null,
  action_direction text not null check (action_direction in ('increase', 'decrease')),
  opened_at        timestamptz not null,
  updated_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  resolution       text check (resolution in ('chosen', 'closed')),
  created_at       timestamptz not null default now(),
  constraint rule_repeat_alerts_resolution_chk check ((resolved_at is null) = (resolution is null))
);

comment on table public.rule_repeat_alerts is
  'A rule that has adjusted one or more nights 3 times or more, waiting on the owner. '
  'Written by the engine (_shared/engine/repeat-alerts.ts) as the service role.';

-- One open alert per rule, and the engine's read of it.
create unique index if not exists uq_rule_repeat_alerts_open
  on public.rule_repeat_alerts (rule_id)
  where resolved_at is null;
-- A hotel's open alerts, newest first.
create index if not exists idx_rule_repeat_alerts_hotel_open
  on public.rule_repeat_alerts (hotel_id, opened_at desc)
  where resolved_at is null;
-- Deleting a hotel cascades here; the indexes above are partial.
create index if not exists idx_rule_repeat_alerts_hotel
  on public.rule_repeat_alerts (hotel_id);

create table if not exists public.rule_repeat_alert_nights (
  alert_id           uuid not null references public.rule_repeat_alerts(id) on delete cascade,
  hotel_id           uuid not null references public.hotels(id) on delete cascade,
  rule_id            uuid not null references public.pricing_rules(id) on delete cascade,
  rule_version       integer not null,
  stay_date          date not null,
  fire_count         integer not null,
  reached_at         timestamptz not null,
  last_fire_at       timestamptz not null,
  last_event_id      uuid,
  window_days        integer,
  window_bookings    integer,
  window_expected    numeric(10,2),
  pickup_metric      text,
  pickup_threshold   numeric(10,2),
  pickup_window_days integer,
  pickup_net         numeric(12,2),
  room_types         jsonb not null default '[]'::jsonb,
  choice             text check (choice in ('keep_adjusting', 'stop')),
  chosen_at          timestamptz,
  chosen_by          uuid references auth.users(id) on delete set null,
  resumed_at         timestamptz,
  resumed_by         uuid references auth.users(id) on delete set null,
  closed_at          timestamptz,
  closed_reason      text,
  updated_at         timestamptz not null default now(),
  primary key (alert_id, stay_date),
  constraint rule_repeat_alert_nights_choice_chk check ((choice is null) = (chosen_at is null)),
  constraint rule_repeat_alert_nights_closed_chk check ((closed_at is null) = (closed_reason is null)),
  constraint rule_repeat_alert_nights_one_end_chk check (choice is null or closed_at is null)
);

-- A table an earlier copy of this file made has no record of a resume, which
-- is what the change log says "let it run again" from.
alter table public.rule_repeat_alert_nights
  add column if not exists resumed_at timestamptz,
  add column if not exists resumed_by uuid references auth.users(id) on delete set null;

-- Swapped rather than left as the create found it: a table an earlier copy of
-- this file made carries the reasons that copy knew about ('resumed' is new).
-- The second name is what Postgres gave the check when it was written inline
-- in the create, which is how that copy had it.
alter table public.rule_repeat_alert_nights
  drop constraint if exists rule_repeat_alert_nights_closed_reason_chk;
alter table public.rule_repeat_alert_nights
  drop constraint if exists rule_repeat_alert_nights_closed_reason_check;
alter table public.rule_repeat_alert_nights
  add constraint rule_repeat_alert_nights_closed_reason_chk
  check (closed_reason is null or closed_reason in ('night_passed', 'rule_edited', 'price_set', 'resumed'));

-- The same swap for fire_count, which an earlier copy of this file held at 3
-- or more. A night is still filed at 3, but a resumed night's count follows
-- its fires down when a typed price takes them off, which can leave it at 0
-- until the rule fires again.
alter table public.rule_repeat_alert_nights
  drop constraint if exists rule_repeat_alert_nights_fire_count_chk;
alter table public.rule_repeat_alert_nights
  drop constraint if exists rule_repeat_alert_nights_fire_count_check;
alter table public.rule_repeat_alert_nights
  add constraint rule_repeat_alert_nights_fire_count_chk check (fire_count >= 0);

comment on table public.rule_repeat_alert_nights is
  'The nights of a rule_repeat_alerts row, with the numbers behind the latest fire and the owner''s choice. '
  'The engine reads choice = stop to stop the rule on that night.';

-- A night is filed once per rule version, and the engine's read of choices.
create unique index if not exists uq_rule_repeat_alert_nights_rule_night
  on public.rule_repeat_alert_nights (rule_id, stay_date, rule_version);
-- The engine's per-run read over the priced nights, and closing passed nights.
create index if not exists idx_rule_repeat_alert_nights_hotel_stay
  on public.rule_repeat_alert_nights (hotel_id, stay_date);

alter table public.rule_repeat_alerts enable row level security;
alter table public.rule_repeat_alert_nights enable row level security;

revoke all on public.rule_repeat_alerts, public.rule_repeat_alert_nights from anon;
revoke insert, update, delete, truncate
  on public.rule_repeat_alerts, public.rule_repeat_alert_nights
  from authenticated;
grant select on public.rule_repeat_alerts, public.rule_repeat_alert_nights to authenticated;
grant select, insert, update, delete
  on public.rule_repeat_alerts, public.rule_repeat_alert_nights
  to service_role;

drop policy if exists rule_repeat_alerts_read on public.rule_repeat_alerts;
create policy rule_repeat_alerts_read on public.rule_repeat_alerts
  for select to authenticated
  using (public.is_hotel_accessible(hotel_id));

drop policy if exists rule_repeat_alert_nights_read on public.rule_repeat_alert_nights;
create policy rule_repeat_alert_nights_read on public.rule_repeat_alert_nights
  for select to authenticated
  using (public.is_hotel_accessible(hotel_id));

-- A rule manager's answer. p_stay_dates null answers every night still waiting
-- on the owner; named nights can also change an earlier answer (stop a night
-- kept earlier, or let a stopped night adjust again). Closed nights never
-- change. Resolves the alert once no night is waiting. Call it with the
-- signed-in user's session so chosen_by is them. Returns the nights it changed.
create or replace function public.rule_repeat_alert_choose(
  p_alert_id uuid,
  p_choice text,
  p_stay_dates date[] default null
)
returns setof public.rule_repeat_alert_nights
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hotel uuid;
  v_now timestamptz := now();
begin
  if p_choice is null or p_choice not in ('keep_adjusting', 'stop') then
    raise exception 'Unknown choice %', p_choice using errcode = '22023';
  end if;

  select a.hotel_id into v_hotel from public.rule_repeat_alerts a where a.id = p_alert_id;
  if v_hotel is null then
    raise exception 'Alert % not found', p_alert_id using errcode = 'P0002';
  end if;
  if (select auth.role()) is distinct from 'service_role'
     and not public.can_manage_hotel(v_hotel) then
    raise exception 'Not authorized to change rules for hotel %', v_hotel
      using errcode = '42501';
  end if;

  return query
  update public.rule_repeat_alert_nights n
     set choice = p_choice,
         chosen_at = v_now,
         chosen_by = auth.uid(),
         updated_at = v_now
   where n.alert_id = p_alert_id
     and n.closed_at is null
     and n.choice is distinct from p_choice
     and (
       (p_stay_dates is null and n.choice is null)
       or n.stay_date = any(p_stay_dates)
     )
  returning n.*;

  update public.rule_repeat_alerts a
     set resolved_at = v_now,
         resolution = case
           when exists (
             select 1 from public.rule_repeat_alert_nights n
              where n.alert_id = a.id and n.closed_at is not null
           ) then 'closed'
           else 'chosen'
         end,
         updated_at = v_now
   where a.id = p_alert_id
     and a.resolved_at is null
     and not exists (
       select 1 from public.rule_repeat_alert_nights n
        where n.alert_id = a.id and n.choice is null and n.closed_at is null
     );
end;
$$;

revoke all on function public.rule_repeat_alert_choose(uuid, text, date[]) from public, anon;
grant execute on function public.rule_repeat_alert_choose(uuid, text, date[]) to authenticated, service_role;

-- Taking an answer back: the rule runs on those nights again. Answering
-- keep_adjusting cannot do this -- it silences the night for good -- so the
-- rules table's "Let it run again" comes here instead. The answer is cleared
-- and the night is filed as resumed, which means it is not waiting on anyone:
-- the owner has just said what they want, and putting the same question
-- straight back on the same three fires would be no answer at all. The engine
-- opens it again once the rule has adjusted it 3 more times than the
-- fire_count on its row (_shared/engine/repeat-alerts.ts). The row's other
-- numbers are frozen at the resume until then; its fire_count is not, because
-- it stands for the fires the owner has already seen. This function sets it to
-- the fires the rule has really made, which a night answered keep_adjusting
-- outgrew while nobody was updating its row, and which a price typed while the
-- night was stopped took down; the engine brings it down again when a typed
-- price takes fires off after the resume.
--
-- Which night it was, when, and who did it stay on the row (resumed_at,
-- resumed_by) for the change log to read; only the latest resume of a night
-- is kept.
--
-- p_stay_dates null resumes every answered night of the alert. Nights nobody
-- answered, and nights already closed, never change. A resolved alert stays
-- resolved, since nothing is waiting; its resolution becomes 'closed',
-- because a night of it has now ended without an answer. Call it with the
-- signed-in user's session. Returns the nights it changed.
create or replace function public.rule_repeat_alert_resume(
  p_alert_id uuid,
  p_stay_dates date[] default null
)
returns setof public.rule_repeat_alert_nights
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hotel uuid;
  v_now timestamptz := now();
begin
  select a.hotel_id into v_hotel from public.rule_repeat_alerts a where a.id = p_alert_id;
  if v_hotel is null then
    raise exception 'Alert % not found', p_alert_id using errcode = 'P0002';
  end if;
  if (select auth.role()) is distinct from 'service_role'
     and not public.can_manage_hotel(v_hotel) then
    raise exception 'Not authorized to change rules for hotel %', v_hotel
      using errcode = '42501';
  end if;

  return query
  update public.rule_repeat_alert_nights n
     set choice = null,
         chosen_at = null,
         chosen_by = null,
         resumed_at = v_now,
         resumed_by = auth.uid(),
         -- The count on the row stands for the fires the owner has already
         -- seen, and the engine asks again 3 above it. That is the fires the
         -- rule has really made on the night right now: the same count the
         -- engine reads (the most on any one room type, open or taken off for
         -- cancellations). Up, for a night answered keep_adjusting, which went
         -- on firing with its row left where the answer found it. Down, for a
         -- night whose fires a typed price took off while it was stopped: the
         -- owner has seen nothing of what the rule will do to the new price.
         -- A price typed after the resume is the engine's to notice.
         fire_count = (
           select coalesce(max(k.fires), 0)
             from (
               select count(*) as fires
                 from public.pickup_event e
                where e.hotel_id = n.hotel_id
                  and e.rule_id = n.rule_id
                  and e.rule_version = n.rule_version
                  and e.stay_date = n.stay_date
                  and (e.retired_at is null or e.retired_reason = 'bookings_cancelled')
                group by e.affected_room_type_id
             ) k
         ),
         closed_at = v_now,
         closed_reason = 'resumed',
         updated_at = v_now
   where n.alert_id = p_alert_id
     and n.choice is not null
     and (p_stay_dates is null or n.stay_date = any(p_stay_dates))
  returning n.*;

  update public.rule_repeat_alerts a
     set resolution = 'closed',
         updated_at = v_now
   where a.id = p_alert_id
     and a.resolved_at is not null
     and a.resolution = 'chosen'
     and exists (
       select 1 from public.rule_repeat_alert_nights n
        where n.alert_id = a.id and n.closed_at is not null
     );
end;
$$;

revoke all on function public.rule_repeat_alert_resume(uuid, date[]) from public, anon;
grant execute on function public.rule_repeat_alert_resume(uuid, date[]) to authenticated, service_role;

commit;

-- Checks afterwards (read-only):
--
--   -- fire_seq and signal_set_key are NOT NULL, nothing retired lacks a reason:
--   select count(*) filter (where fire_seq is null) as no_fire_seq,
--          count(*) filter (where retired_at is not null and retired_reason is null) as no_reason,
--          count(*) filter (where retired_reason = 'self_cancelled') as self_cancelled
--     from public.pickup_event;
--
--   -- the new index is there and valid, the old one is gone:
--   select c.relname, i.indisvalid
--     from pg_class c join pg_index i on i.indexrelid = c.oid
--    where c.relname in ('uq_pickup_event_fire', 'uq_pickup_event_active_per_rule_stay_room');
--
--   -- the trigger and its function are gone:
--   select tgname from pg_trigger where tgname = 'trg_rule_condition_sync_pickup';
--   select proname from pg_proc where proname = 'sync_rule_pickup_flag_from_condition';
--
--   -- and the one that names a price save's retirement is there:
--   select tgname from pg_trigger where tgname = 'trg_pickup_event_manual_price_reason';
--
--   -- one signature each:
--   select proname, pg_get_function_identity_arguments(oid) from pg_proc
--    where proname in ('pickup_fire_heads', 'rule_repeat_alert_choose',
--                      'rule_repeat_alert_resume', 'set_manual_prices_from_pms');
--
--   -- only SELECT policies on the alert tables:
--   select tablename, policyname, cmd from pg_policies
--    where tablename like 'rule_repeat_alert%' order by tablename;
