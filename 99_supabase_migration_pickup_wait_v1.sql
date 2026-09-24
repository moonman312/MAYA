-- ============================================================================
-- MAYA pickup count rules get a wait of their own (v1)
-- ============================================================================
--
-- After a pickup count rule adjusts a night and room type, it waits before it
-- may adjust them again. Until now that wait was always its lookback window
-- (pickup_window_days: 1, 3 or 7 days) and nothing on screen said so, while a
-- booking speed rule already had its own "(advanced)" wait. Decided
-- 2026-09-24 (Jake): the rule builder offers a pickup count rule the same
-- choice, starting on "Same as the lookback window".
--
-- 1. rule_condition.pickup_cooldown_days (integer, null): the days a pickup
--    count rule waits on a night and room type after it fires there. Null
--    means "same as the lookback window", which is what every rule that
--    exists keeps: nothing is backfilled, so no rule waits differently the
--    day this runs. Two named checks:
--      rule_condition_pickup_cooldown_chk         at least 1 day, like the
--                                                 booking speed wait: with
--                                                 fires stacking, 0 would
--                                                 raise or cut every run.
--      rule_condition_pickup_cooldown_family_chk  null when the rule has no
--                                                 pickup condition, the way
--                                                 booking_speed_cooldown_days
--                                                 is null without a booking
--                                                 speed condition.
--    02_supabase_schema.sql creates the same column and checks, by the same
--    names, for a fresh install.
--
-- 2. audit_rows_before(hotel, before, stay dates, room types): for each
--    (night, room type) pair given, the newest evaluation_audit row written
--    before `before`, with its prices and the details fields that say what
--    it was priced on (application_order, base_source, manual_override).
--    The change log (GET /api/changelog) asks it once per pricing run it
--    reads, for the nights that run left at their base with nothing on
--    them. The engine only writes an audit row when a night's outcome
--    changes, so such a row nearly always means the price moved back to
--    base: a rule came off, a raise came off for cancellations, a typed
--    price was cleared. Before this, the log compared those rows with the
--    base, found no difference and called the run "nothing needed to
--    change". With the row before, it shows the run and the price the night
--    moved from. It probes idx_evaluation_audit_cell once per pair, the way
--    audit_last_signatures does, and only for pairs the caller names.
--    Security definer with the same check as audit_last_signatures: the
--    service role, or a member of the hotel. Pairs are two arrays of equal
--    length (22023 otherwise).
--
-- What the engine does with it (engine/pickup.ts, both copies): a pickup
-- count rule waits pickup_cooldown_days when it is set, else its window; a
-- rule with a booking speed condition as well still waits the longer of its
-- two waits (ruleWaitDays). Where its count starts is what
-- 99_supabase_migration_booking_speed_counts_bookings_v1.sql describes: the
-- newest adjustment of the night and room type by the rule itself or by a
-- stronger rule that moves the price the same way, a paused one included,
-- current rule versions only, when that is later than a whole window back
-- (countFromFireAt, pickupWindowOpensAt). With a wait shorter than the
-- window, the rule's own last adjustment is still inside its window when
-- the wait ends, so it counts only what came in since and never raises
-- twice on one burst. A count on low pickup ("less than", or "more than" a
-- number under 0) has nothing to judge until a whole window has passed that
-- adjustment (pickupJudgesShortStretch), so such a rule never adjusts a
-- night again sooner than its window, whatever wait it has; the builder
-- says so beside the choice. For every pickup count, chosen wait or not, a
-- raise taken off because its bookings cancelled no longer opens the count
-- (openFireHeads): its run's snapshot still holds the bookings that
-- cancelled, so new bookings were being netted against them. It still
-- starts the rule's wait, counts toward the three-raises alert, and starts
-- a Booking Speed count, which counts the bookings made after it. A fire
-- made before the open manual price on the night is ignored: after a typed
-- price the rule waits from the price and then counts its whole window. The
-- run that made a fire wrote a snapshot at that very instant (snapshot_ts =
-- the fire's applied_at, for every counting room type on every night it
-- priced), so the count finds its starting point there, well inside the
-- 12-hour staleness guard and the snapshot retention (longest window plus
-- 7 days). The engine reads those snapshots by their exact instants, many
-- nights to a request (stay_date_snapshot's primary key starts hotel_id,
-- snapshot_ts), not one read per night and room type.
--
-- The engine reads pickup_cooldown_days as soon as it is deployed. Before
-- this file it re-reads the rules without the column, logs once per run
-- naming this file, and every pickup count rule waits its window, which is
-- how it priced before; the cancelled raise change works either way. The
-- app reads and writes the column with no such fallback: the Rules tab
-- would fail to load and a rule saved with a chosen wait would be refused.
-- So run this first. (Without audit_rows_before the change log logs once
-- and shows only the runs that took a raise off, as before, rather than
-- failing.)
--
-- Run AFTER 99_supabase_migration_booking_speed_counts_bookings_v1.sql.
-- Idempotent, one transaction, safe to replay.
--
-- Deploy: run this, then deploy cloudbeds-scheduled-sync,
-- mews-scheduled-sync and think-scheduled-sync (one command each; loops are
-- blocked), then push the app. Every scheduled sync runs the engine, whose
-- wait and cancelled-raise handling changed; the app runs the same engine
-- and carries the rule builder's new dropdown and "?", the rules table
-- text, the three-raises alert sentence that says a pickup count ran since
-- it or a stronger rule last raised or cut the night, and the change log's
-- runs that moved a price back to base.
-- Between the migration and the deploy, the old engine ignores the column
-- (nobody can have set it yet: the old app has no way to) and prices as
-- before. What an owner may notice once the new engine runs: after a raise
-- comes off because its bookings cancelled, a pickup count rule counts the
-- bookings that came in since as new, where it used to net them against
-- the ones that cancelled until its window had passed that raise. Rules
-- left on "Same as the lookback window" wait as they always have.
--
-- Checking by hand:
--
--   select pickup_window_days, pickup_cooldown_days, count(*)
--     from public.rule_condition
--    where pickup_operator is not null
--    group by 1, 2;
--
-- Right after this file, pickup_cooldown_days is null on every row.
--
--   select proname, pg_get_function_identity_arguments(oid)
--     from pg_proc where proname = 'audit_rows_before';
--
-- One row: p_hotel_id uuid, p_before timestamp with time zone,
-- p_stay_dates date[], p_room_type_ids uuid[].
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. A pickup count rule's own wait
-- ----------------------------------------------------------------------------

alter table public.rule_condition
  add column if not exists pickup_cooldown_days integer;

comment on column public.rule_condition.pickup_cooldown_days is
  'Days a pickup count rule waits on a night and room type after it fires there. Null waits its lookback window (pickup_window_days). At least 1; null without a pickup condition.';

alter table public.rule_condition drop constraint if exists rule_condition_pickup_cooldown_chk;
alter table public.rule_condition add constraint rule_condition_pickup_cooldown_chk
  check (pickup_cooldown_days is null or pickup_cooldown_days >= 1);

alter table public.rule_condition drop constraint if exists rule_condition_pickup_cooldown_family_chk;
alter table public.rule_condition add constraint rule_condition_pickup_cooldown_family_chk
  check (pickup_cooldown_days is null or pickup_operator is not null);

-- ----------------------------------------------------------------------------
-- 2. The row before, per night, for the change log
-- ----------------------------------------------------------------------------

create or replace function public.audit_rows_before(
  p_hotel_id uuid,
  p_before timestamptz,
  p_stay_dates date[],
  p_room_type_ids uuid[]
)
returns table(
  stay_date date,
  room_type_id uuid,
  evaluated_at timestamptz,
  base_price numeric,
  final_price numeric,
  application_order jsonb,
  base_source text,
  manual_override jsonb
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.is_hotel_accessible(p_hotel_id) then
    raise exception 'Not authorized to read the audit trail for hotel %', p_hotel_id
      using errcode = '42501';
  end if;
  if coalesce(cardinality(p_stay_dates), 0) <> coalesce(cardinality(p_room_type_ids), 0) then
    raise exception 'p_stay_dates and p_room_type_ids pair up: one room type per night'
      using errcode = '22023';
  end if;

  return query
  select
    c.d,
    c.t,
    a.evaluated_at,
    a.base_price,
    a.final_price,
    a.details -> 'application_order',
    a.details ->> 'base_source',
    a.details -> 'manual_override'
  from (
    select distinct u.d, u.t
    from unnest(coalesce(p_stay_dates, '{}'::date[]), coalesce(p_room_type_ids, '{}'::uuid[])) as u(d, t)
  ) c
  cross join lateral (
    select x.evaluated_at, x.base_price, x.final_price, x.details
    from public.evaluation_audit x
    where x.hotel_id = p_hotel_id
      and x.stay_date = c.d
      and x.room_type_id = c.t
      and x.evaluated_at < p_before
    order by x.evaluated_at desc, x.id desc
    limit 1
  ) a
  order by 1, 2;
end;
$$;

revoke all on function public.audit_rows_before(uuid, timestamptz, date[], uuid[]) from public, anon;
grant execute on function public.audit_rows_before(uuid, timestamptz, date[], uuid[])
  to authenticated, service_role;

commit;
