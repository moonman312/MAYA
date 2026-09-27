-- ============================================================================
-- MAYA undo on cancellation: one box per rule (v1)
-- ============================================================================
--
-- Decided 2026-09-24 and 2026-09-25 (Jake): every rule gets one option,
-- "Undo this change if cancellations mean the rule is no longer true". New
-- rules start ticked, and every rule that exists is ticked by this file. It
-- works the same way for a raise and a cut, and for every kind of rule:
-- booking speed, pickup count, occupancy, days before arrival, or any mix.
--
-- What it replaces. Until now what cancellations did depended on the kind
-- of rule:
--   * an occupancy (or days before arrival) rule switched off whenever its
--     conditions stopped matching;
--   * a booking speed raise came off once the bookings still on the books
--     from its window were back to what a night like it usually gets;
--   * a pickup count raise came off once net bookings were back to where
--     its count opened;
--   * a cut never came off for cancellations;
--   * and 99_supabase_migration_booking_speed_counts_bookings_v1.sql turned
--     the window test off on the raises it found recorded in rooms.
--
-- Now there is one check (cancellationFinding and cancellablePartsHold in
-- engine/pickup.ts, both copies), in two halves. On every run, for each
-- change still on a night that is still to come, made by a rule whose box
-- is ticked, once a room booked on that night when the change was made has
-- cancelled, first recount what the change counted, inside the window
-- stored with it, less what has cancelled since, and judge the rule again
-- against the "usual" frozen at the change:
--   * a booking speed condition counts the bookings (not rooms) the change
--     counted in its own window that are still booked on the rule's room
--     types (window_booking_keys, below; for a change from before them, the
--     window's bookings the change saw, from window_from, window_to and
--     window_since when its first day was split), against
--     window_expected_at_fire;
--   * a pickup count condition takes the net pickup the change judged, less
--     the bookings that came in during its window and have cancelled since
--     (pickup_units_arrived_at_fire, below), in room nights or revenue as
--     the rule counts;
--   * an occupancy condition reads the night's sellable occupancy now.
-- Only what cancellations can make false is judged: occupancy "more than",
-- pickup "more than", a pace of "at least" a level, or exactly a level for
-- a raise. Days before arrival, anything "less than" and a pace of "at
-- most" a level only get truer as bookings cancel. Older bookings
-- cancelling don't touch a pickup or booking speed count, and a rate
-- changed on a booking still there doesn't either. If what the change
-- counted still holds, it stays. If not, the second half judges the rule
-- the way it would count once the change is off: from the newest other
-- change still on the night by itself or a stronger rule adjusting the
-- same way, else its whole window, so bookings made since the change count
-- too. Only if the rule is not true that way either does the change come
-- off (retired_reason 'bookings_cancelled'): the condition that led to it
-- is no longer met. Otherwise it stays and its numbers are taken again from
-- that count, at that run (baseline_end_ts is then that run's instant, and
-- the rules count on from there), so the bookings that kept it on are not
-- counted again for the next change. Only open changes on nights still
-- ahead are looked at, each with one probe of
-- idx_reservations_hotel_stay_date (4 below); the night's bookings are read
-- again only for a change something it saw has cancelled on.
--
-- Unticked, cancellations never take a change off. For a rule that holds
-- while its conditions hold (occupancy and days before arrival only) that
-- is a real change: unticked, an occupancy drop no longer switches it off,
-- while a days-before-arrival condition still runs out with time, and new
-- bookings still end an "occupancy less than" rule. Ticked, such a rule
-- behaves as it always has.
--
-- After an undo the rule's normal wait still applies, counted from the
-- change that came off, so a night on the edge can't go up and down every
-- run; when the wait ends and the rule is true again, it adjusts again. A
-- rule with no wait (occupancy and days before arrival only) switches back
-- on as soon as it is true again. A change that came off no longer covers
-- the weaker rules (they count from the newest change still on the price),
-- and no longer counts toward the three-changes alert, which warns how far
-- the price may go. Every change still comes off when its night passes,
-- when a price is set on the night by hand or in the PMS, and when its rule
-- is edited. Pausing a rule still freezes its changes: they stay, and are
-- not checked while it is paused.
--
-- 1. pricing_rules.undo_on_cancellation (boolean, not null, default true).
--    Adding the column fills every existing rule with true, which is the
--    only time this file sets it: a replay never touches it, so a box an
--    owner has unticked since stays unticked. Changing the box is not an
--    edit: the rule keeps its version and its changes, and from the next
--    run its changes are checked (ticked) or not (unticked). The column
--    lives on pricing_rules, whose row policies (pricing_rules_read: members
--    of the hotel read, is_hotel_accessible; pricing_rules_update: managers
--    write, can_manage_hotel; both from
--    99_supabase_migration_rls_hardening_v1.sql) and table grants already
--    cover it; nothing is added for it. 02_supabase_schema.sql has the same column for
--    a fresh install.
--
-- 2. pickup_event gets what the one check needs that it did not store:
--      pickup_units_arrived_at_fire    for a rule with a pickup condition,
--      pickup_revenue_arrived_at_fire  the room nights and revenue on its
--                                      room types first seen after the
--                                      count opened and by the change,
--                                      still booked at the change. Null
--                                      without a pickup condition, and on
--                                      every change from before this file:
--                                      those count what came in during
--                                      their window and is still booked,
--                                      which is never less than the right
--                                      number, so in doubt a change stays.
--      window_booking_keys             for a rule with a booking speed
--                                      condition cancellations can make
--                                      false: the bookings its window
--                                      counted, by booking key (booking_key()
--                                      from the counts-bookings file; a row
--                                      with no PMS id is 'row <id>'), so
--                                      the check recounts exactly those
--                                      still booked: a group whose first
--                                      rooms cancel while rooms added after
--                                      the change stay is still one of
--                                      them. Null on every change from
--                                      before this file, which is recounted
--                                      from its window as before.
--    Both arrivals null or at least 0 (pickup_event_arrivals_chk). cancel_check gains
--    'recount', which every change the new engine makes carries, raise or
--    cut: all of its stored numbers can be recounted. A cut may now carry
--    it (pickup_event_cancel_increase_chk). The old values stay legal for
--    the changes made before, and by an engine from before, this file.
--
-- 3. The open changes are converted. Every open change whose stored numbers
--    can all be recounted gets 'recount': the ones the old window test
--    trusted ('window_bookings', 'either': windows counted in bookings), and
--    every one with no booking speed window at all (pickup, occupancy or
--    days before arrival: nothing stored depends on the unit). What is
--    left is an open change with a booking speed window marked 'none' or
--    'net_units'. Some of those were recorded in rooms (the counts-bookings
--    file turned their test off), and nothing stored tells them apart from
--    a cut or a slow raise recorded in bookings since, so their booking
--    speed part is judged as it was at the change: it keeps them on. Their
--    occupancy and pickup parts are checked like any other. No change is
--    taken off here, no number on a change is rewritten, and retired rows
--    are history. The arrivals of open changes are left null (2).
--
-- 4. engine_booked_before(hotel, stay dates, instants): for each (night,
--    instant) pair, per room type, the rows on the night still booked whose
--    created_at (when MAYA first saw the row; a cancelled room's row is
--    deleted, a changed one keeps it) is at or before the instant, and the
--    sum of their current_rate. The engine reads it once per run for every
--    change it checks (at the change's own instant, and where a pickup
--    count opened) and for every pickup count that may fire (the same two
--    instants, which is how the arrivals in 2 are counted). Each pair is one
--    lateral probe of idx_reservations_hotel_stay_date (hotel_id,
--    stay_date), and only for pairs the caller names. Security definer with
--    the same check as booking_speed_windows: the service role, or a member
--    of the hotel. Pairs are two arrays of equal length (22023 otherwise).
--    Before this file the engine reads the nights' rows and sums them
--    itself, which gives the same answer, logged once per run.
--
-- 5. The three-changes alert counts changes still on the price:
--      rule_repeat_alert_nights.closed_reason gains 'bookings_cancelled': an
--        unanswered night whose count fell under three because cancellations
--        took changes off. Like 'price_set', it opens again if the rule
--        stacks its way back to three.
--      pickup_fire_heads counts (counted_fires, last_counted_at) only the
--        open fires of each rule version, last_counted_at to the newest
--        instant one counted to (baseline_end_ts). The anchor its wait runs
--        from (anchor_at) still includes one taken off for cancellations.
--        The engine works the same counts out itself after its own
--        retirements, so this only matters to an engine from before this
--        file.
--      rule_repeat_alert_resume_many sets a resumed night's fire_count from
--        the open fires only, the count the engine asks again above.
--    Everything else in those functions is as
--    99_supabase_migration_pickup_event_stacking_v1.sql made it.
--
-- 6. Product analytics see the box (product_events_pricing_rules, replaced
--    whole, and its update trigger): rule.created carries
--    undo_on_cancellation, so a rule saved unticked shows, and ticking or
--    unticking it later writes rule.undo_ticked or rule.undo_unticked
--    (rule_id, origin), the way switching a rule on or off writes
--    rule.enabled or rule.disabled. The update trigger now also fires on the
--    box. Everything else is as 99_supabase_migration_product_events_v1.sql
--    made it; replaying that file after this one would put its older
--    trigger back, so run this one again after it.
--
-- Run AFTER 99_supabase_migration_booking_speed_counts_bookings_v1.sql and
-- 99_supabase_migration_pickup_wait_v1.sql (and so after
-- 99_supabase_migration_pickup_event_stacking_v1.sql). It touches nothing
-- those two made except the functions in 5, which it replaces whole.
-- Idempotent, one transaction, safe to replay.
--
-- Deploy: run this, then deploy cloudbeds-scheduled-sync,
-- mews-scheduled-sync, think-scheduled-sync and onboarding-import-worker
-- (one command each; loops are blocked), then push the app. Every scheduled
-- sync runs the engine, which now makes the one check and writes the new
-- columns. onboarding-import-worker writes a new hotel's starter rules and
-- their explanations (_shared/onboarding/generate-rules.ts), which now say
-- a change comes off when cancellations make its rule no longer true;
-- left on the old bundle, a hotel onboarded in the gap keeps the old text
-- for good. The app runs the same engine and carries the box in the rule
-- builder and the rules table, its "?", the change log's and drill-down's
-- "Cancellations meant ... was no longer true" line, the three-changes
-- alert's text, and the rules animation.
--
-- Between the migration and the deploy, the old engine reads rules without
-- the column (its select names its columns) and treats every rule the old
-- way; its checks don't know 'recount', so the changes converted in 3 are
-- not taken off for cancellations until the new engine runs, while the ones
-- it makes itself get its old tests. Between a deploy and the migration,
-- the new engine reads the rules again without the column (every rule
-- ticked, logged once per run), writes its changes the old way ('none', no
-- arrivals, logged once), and reads the nights' rows for its check; the app
-- would fail to load the Rules tab and to save a rule. So run this first.
--
-- What an owner may notice once the new engine runs:
--   * a cut can now come off when cancellations make its rule no longer
--     true (a cut on "occupancy more than 20%" whose night falls to 18%);
--   * a booking speed raise comes off once what is left of its window no
--     longer reads its pace, not only once it is back to the usual number;
--   * a pickup raise comes off once its count falls to its threshold, not
--     only once it is back to where its count opened;
--   * neither comes off while bookings made since keep its rule true;
--   * after an undo the rule waits its wait before it adjusts that night
--     again, from the change that came off;
--   * a change that came off no longer holds back the weaker rules, and no
--     longer counts toward "adjusted this night 3 times";
--   * an unticked occupancy rule keeps its change when the night's
--     occupancy falls;
--   * an occupancy or days-before-arrival rule that is edited is judged on
--     every condition of the edited rule, ticked or not: its change comes
--     off if they don't hold, and if they do it stays with the edited
--     adjustment (it used to keep the old one until it went off and on).
-- Occupancy rules left ticked and unedited behave as before.
--
-- Checking by hand (the SQL editor carries no JWT, so say you are the
-- service role for one transaction):
--
--   select undo_on_cancellation, count(*) from public.pricing_rules group by 1;
--
-- Right after this file, every row says true.
--
--   select cancel_check, action_direction, window_from is not null as has_window, count(*)
--     from public.pickup_event where retired_at is null group by 1, 2, 3 order by 1, 2, 3;
--
-- Open changes are 'recount', except ones with a window marked 'none' or
-- 'net_units'.
--
--   begin;
--   select set_config('request.jwt.claims', '{"role":"service_role"}', true);
--   select * from public.engine_booked_before('<hotel id>',
--     array[current_date + 30, current_date + 30], array[now() - interval '7 days', now()]);
--   commit;
--
-- Per room type, the later instant's units are never below the earlier's,
-- and at now() they are the night's booked rooms.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The box, ticked on every rule
-- ----------------------------------------------------------------------------

alter table public.pricing_rules
  add column if not exists undo_on_cancellation boolean not null default true;

comment on column public.pricing_rules.undo_on_cancellation is
  'Undo this change if cancellations mean the rule is no longer true. True unless the owner unticks it. '
  'Changing it is not an edit: the version and the rule''s changes stay.';

-- ----------------------------------------------------------------------------
-- 2. What the one check needs on each change
-- ----------------------------------------------------------------------------

alter table public.pickup_event
  add column if not exists pickup_units_arrived_at_fire integer,
  add column if not exists pickup_revenue_arrived_at_fire numeric(12,2),
  add column if not exists window_booking_keys text[];

comment on column public.pickup_event.pickup_units_arrived_at_fire is
  'For a rule with a pickup condition: room nights on its room types first seen after the count opened '
  '(baseline_start_ts) and by the change (applied_at), still booked then. Null without a pickup condition '
  'and on changes from before 99_supabase_migration_undo_on_cancellation_v1.sql.';
comment on column public.pickup_event.pickup_revenue_arrived_at_fire is
  'The same bookings'' current_rate summed, for a rule that counts pickup in revenue.';
comment on column public.pickup_event.window_booking_keys is
  'For a rule with a booking speed condition cancellations can make false: the bookings its window counted '
  '(window_bookings_at_fire of them), by booking key. Null on changes from before '
  '99_supabase_migration_undo_on_cancellation_v1.sql, and when the keys read did not come to that count.';
comment on column public.pickup_event.baseline_end_ts is
  'When the change''s numbers were taken: applied_at, or a later run''s instant when cancellations left its rule '
  'still true and its numbers were taken again. Rules count from here.';
comment on column public.pickup_event.cancel_check is
  'recount: every stored number can be recounted when cancellations are checked (every change since '
  '99_supabase_migration_undo_on_cancellation_v1.sql, raise or cut). none | net_units | window_bookings | either: '
  'from before it; a booking speed window is recounted only on window_bookings and either.';

alter table public.pickup_event drop constraint if exists pickup_event_arrivals_chk;
alter table public.pickup_event add constraint pickup_event_arrivals_chk
  check (
    (pickup_units_arrived_at_fire is null or pickup_units_arrived_at_fire >= 0)
    and (pickup_revenue_arrived_at_fire is null or pickup_revenue_arrived_at_fire >= 0)
  );

alter table public.pickup_event drop constraint if exists pickup_event_cancel_check_chk;
alter table public.pickup_event add constraint pickup_event_cancel_check_chk
  check (cancel_check in ('none', 'net_units', 'window_bookings', 'either', 'recount'));

alter table public.pickup_event drop constraint if exists pickup_event_cancel_increase_chk;
alter table public.pickup_event add constraint pickup_event_cancel_increase_chk
  check (cancel_check in ('none', 'recount') or action_direction = 'increase');

-- ----------------------------------------------------------------------------
-- 3. Open changes whose numbers can all be recounted
-- ----------------------------------------------------------------------------

update public.pickup_event
   set cancel_check = 'recount'
 where retired_at is null
   and cancel_check <> 'recount'
   and (cancel_check in ('window_bookings', 'either') or window_from is null);

-- ----------------------------------------------------------------------------
-- 4. Rows first seen by an instant, per night and room type
-- ----------------------------------------------------------------------------

create or replace function public.engine_booked_before(
  p_hotel_id uuid,
  p_stay_dates date[],
  p_at timestamptz[]
)
returns table(stay_date date, as_of timestamptz, room_type_id uuid, units integer, revenue numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.is_hotel_accessible(p_hotel_id) then
    raise exception 'Not authorized to read bookings for hotel %', p_hotel_id
      using errcode = '42501';
  end if;
  if coalesce(cardinality(p_stay_dates), 0) <> coalesce(cardinality(p_at), 0) then
    raise exception 'p_stay_dates and p_at pair up: one instant per night'
      using errcode = '22023';
  end if;

  return query
  select a.d, a.t, x.room_type_id, x.units, x.revenue
  from (
    select distinct u.d, u.t
    from unnest(coalesce(p_stay_dates, '{}'::date[]), coalesce(p_at, '{}'::timestamptz[])) as u(d, t)
    where u.d is not null and u.t is not null
  ) a
  cross join lateral (
    select r.room_type_id,
           count(*)::integer as units,
           coalesce(sum(r.current_rate), 0)::numeric as revenue
      from public.reservations r
     where r.hotel_id = p_hotel_id
       and r.stay_date = a.d
       and r.created_at <= a.t
       and r.room_type_id is not null
     group by r.room_type_id
  ) x
  order by 1, 2, 3;
end;
$$;

comment on function public.engine_booked_before(uuid, date[], timestamptz[]) is
  'Per (night, instant) pair and room type: rows on the night still booked whose created_at is at or before '
  'the instant, and their current_rate summed. The engine''s cancellation check and pickup arrivals.';

revoke all on function public.engine_booked_before(uuid, date[], timestamptz[]) from public, anon;
grant execute on function public.engine_booked_before(uuid, date[], timestamptz[])
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. The three-changes alert counts changes still on the price
-- ----------------------------------------------------------------------------

alter table public.rule_repeat_alert_nights
  drop constraint if exists rule_repeat_alert_nights_closed_reason_chk;
alter table public.rule_repeat_alert_nights
  add constraint rule_repeat_alert_nights_closed_reason_chk
  check (closed_reason is null or closed_reason in
    ('night_passed', 'rule_edited', 'price_set', 'bookings_cancelled', 'resumed'));

-- As in 99_supabase_migration_pickup_event_stacking_v1.sql section 5, with
-- counted_fires and last_counted_at over the open fires only, last_counted_at
-- to the newest instant one counted to.
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
         (count(*) filter (where e.retired_at is null))::integer,
         max(coalesce(e.baseline_end_ts, e.applied_at)) filter (where e.retired_at is null)
    from public.pickup_event e
   where e.hotel_id = p_hotel_id
     and e.rule_id = any(coalesce(p_rule_ids, '{}'::uuid[]))
     and e.stay_date between p_from and p_to
   group by e.rule_id, e.stay_date, e.affected_room_type_id, e.rule_version;
end;
$$;

revoke all on function public.pickup_fire_heads(uuid, uuid[], date, date) from public, anon;
grant execute on function public.pickup_fire_heads(uuid, uuid[], date, date) to authenticated, service_role;

-- As in 99_supabase_migration_pickup_event_stacking_v1.sql section 6, with
-- a resumed night's fire_count over the open fires only.
create or replace function public.rule_repeat_alert_resume_many(
  p_alert_ids uuid[],
  p_stay_dates date[] default null
)
returns setof public.rule_repeat_alert_nights
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[] := coalesce(p_alert_ids, '{}'::uuid[]);
  v_missing uuid;
  v_hotel uuid;
  v_now timestamptz := now();
begin
  select u.id into v_missing
    from unnest(v_ids) as u(id)
   where not exists (select 1 from public.rule_repeat_alerts a where a.id = u.id)
   limit 1;
  if found then
    raise exception 'Alert % not found', v_missing using errcode = 'P0002';
  end if;
  if (select auth.role()) is distinct from 'service_role' then
    for v_hotel in
      select distinct a.hotel_id from public.rule_repeat_alerts a where a.id = any(v_ids)
    loop
      if not public.can_manage_hotel(v_hotel) then
        raise exception 'Not authorized to change rules for hotel %', v_hotel
          using errcode = '42501';
      end if;
    end loop;
  end if;

  return query
  update public.rule_repeat_alert_nights n
     set choice = null,
         chosen_at = null,
         chosen_by = null,
         resumed_at = case when n.stay_date >= (v_now at time zone coalesce(h.timezone, 'UTC'))::date
                           then v_now else n.resumed_at end,
         resumed_by = case when n.stay_date >= (v_now at time zone coalesce(h.timezone, 'UTC'))::date
                           then auth.uid() else n.resumed_by end,
         -- The changes the rule has on the night right now, still on the
         -- price: the most on any one room type, the count the engine reads.
         fire_count = (
           select coalesce(max(k.fires), 0)
             from (
               select count(*) as fires
                 from public.pickup_event e
                where e.hotel_id = n.hotel_id
                  and e.rule_id = n.rule_id
                  and e.rule_version = n.rule_version
                  and e.stay_date = n.stay_date
                  and e.retired_at is null
                group by e.affected_room_type_id
             ) k
         ),
         closed_at = v_now,
         closed_reason = 'resumed',
         updated_at = v_now
    from public.hotels h
   where h.id = n.hotel_id
     and n.alert_id = any(v_ids)
     and n.choice is not null
     and (p_stay_dates is null or n.stay_date = any(p_stay_dates))
  returning n.*;

  update public.rule_repeat_alerts a
     set resolution = 'closed',
         updated_at = v_now
   where a.id = any(v_ids)
     and a.resolved_at is not null
     and a.resolution = 'chosen'
     and exists (
       select 1 from public.rule_repeat_alert_nights n
        where n.alert_id = a.id and n.closed_at is not null
     );
end;
$$;

revoke all on function public.rule_repeat_alert_resume_many(uuid[], date[]) from public, anon;
grant execute on function public.rule_repeat_alert_resume_many(uuid[], date[]) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 6. Product analytics see the box
-- ----------------------------------------------------------------------------

-- As in 99_supabase_migration_product_events_v1.sql, with the box on
-- rule.created and an event when it changes.
create or replace function public.product_events_pricing_rules()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rule public.pricing_rules%rowtype;
  v_origin text;
begin
  begin
    if tg_op = 'DELETE' then
      v_rule := old;
      -- A hotel delete cascades here; that is the property going, not a rule.
      if not exists (select 1 from public.hotels h where h.id = old.hotel_id) then
        return null;
      end if;
    else
      v_rule := new;
    end if;

    if tg_op = 'INSERT' then
      v_origin := case
        when auth.uid() is null
             and (auth.role() = 'service_role' or auth.role() is null)
             and (new.name in ('Slow-date rescue', 'Slow-date trim', 'Warm-date bump', 'Hot-week surge', 'Sudden-spike catcher')
                  or exists (select 1 from public.import_jobs j
                              where j.hotel_id = new.hotel_id and j.status = 'running'))
          then 'starter'
        when auth.uid() is null then 'system'
        when exists (
          select 1 from public.onboarding_findings f
           where f.hotel_id = new.hotel_id
             and f.kind = 'rule_suggestion'
             and f.status = 'confirmed'
             and f.resolved_by = auth.uid()
             and f.resolved_at > now() - interval '5 minutes'
             and f.payload->'spec'->>'name' = new.name
        ) then 'suggestion'
        else 'owner'
      end;
    else
      select e.properties->>'origin' into v_origin
        from public.product_events e
       where e.hotel_id = v_rule.hotel_id
         and e.event = 'rule.created'
         and e.properties->>'rule_id' = v_rule.id::text
       order by e.occurred_at asc
       limit 1;
    end if;

    if tg_op = 'INSERT' then
      perform public.product_event_emit(
        'rule.created', new.hotel_id, coalesce(auth.uid(), new.created_by),
        jsonb_build_object(
          'rule_id', new.id, 'origin', v_origin, 'is_active', new.is_active,
          'is_pickup_rule', new.is_pickup_rule,
          'action_type', new.action_type, 'action_direction', new.action_direction,
          'undo_on_cancellation', new.undo_on_cancellation
        ),
        'trigger', new.created_at
      );
    elsif tg_op = 'UPDATE' then
      if new.is_active is distinct from old.is_active then
        perform public.product_event_emit(
          case when new.is_active then 'rule.enabled' else 'rule.disabled' end,
          new.hotel_id, auth.uid(),
          jsonb_build_object('rule_id', new.id, 'origin', v_origin)
        );
      end if;
      if new.version > old.version then
        perform public.product_event_emit(
          'rule.edited', new.hotel_id, auth.uid(),
          jsonb_build_object('rule_id', new.id, 'origin', v_origin, 'version', new.version)
        );
      end if;
      if new.undo_on_cancellation is distinct from old.undo_on_cancellation then
        perform public.product_event_emit(
          case when new.undo_on_cancellation then 'rule.undo_ticked' else 'rule.undo_unticked' end,
          new.hotel_id, auth.uid(),
          jsonb_build_object('rule_id', new.id, 'origin', v_origin)
        );
      end if;
    else
      perform public.product_event_emit(
        'rule.deleted', old.hotel_id, auth.uid(),
        jsonb_build_object(
          'rule_id', old.id, 'origin', v_origin, 'was_active', old.is_active,
          'age_days', round((extract(epoch from (now() - old.created_at)) / 86400)::numeric, 2)
        )
      );
    end if;
  exception when others then
    raise warning 'product_events_pricing_rules: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

drop trigger if exists trg_product_events_pricing_rules_update on public.pricing_rules;
create trigger trg_product_events_pricing_rules_update
  after update of is_active, version, undo_on_cancellation on public.pricing_rules
  for each row execute function public.product_events_pricing_rules();

commit;
