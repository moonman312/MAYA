-- ============================================================================
-- MAYA booking speed counts bookings, not rooms (v1)
-- ============================================================================
--
-- Booking speed used to count reservation rows, and a row is one room on one
-- night. A 20-room wedding reservation therefore read as twenty bookings
-- landing in one day, live on the night it was made and again in every
-- history night it later served as a comparable. Decided 2026-09-20 (Jake):
-- booking speed counts BOOKINGS. A reservation counts once for pace on each
-- of its nights, however many rooms it holds. Occupancy keeps counting rooms,
-- and so does the season model (how full nights got against room capacity).
-- No backfill, no group or block codes, no owner settings; one nullable
-- column on pickup_event (4 below), which nothing fills for the fires that
-- exist.
--
-- 1. booking_key(text): the booking a reservation row belongs to, from its
--    external_reservation_id alone. The one copy of the rule in SQL; the one
--    copy in TypeScript is bookingKeyOf in
--    supabase/functions/_shared/observations/booking-rows.ts, and the PGlite
--    suite holds the two to each other. The id shapes, from the parsers:
--      Think      <reservationId>:<bookingId>   -> the part before the colon
--                 (one row per booking, i.e. room, of the reservation)
--      Cloudbeds  <reservationID>-<n>           -> the part before the hyphen
--                 (one row per room slot), or a bare <reservationID> on rows
--                 written before rooms were keyed, which stays as it is. A
--                 reservationID is a number (6364686337417 on the sandbox),
--                 so only digits, one hyphen, digits is a room suffix.
--      Mews       one reservation per row, GUIDs (four hyphens): never
--                 grouped, a Mews reservation is one room.
--    Anything else is its own booking: the e2e seeds' cb-260920-0001234
--    style ids, and any <word>-<n> id. The rule is deliberately this narrow:
--    keying RES-1234 to RES would fold every reservation of a hotel into one
--    booking and its pace would never move, while leaving an unfamiliar id
--    alone only counts that booking's rooms one by one, as before.
--
-- 2. Open Booking Speed raises from before this file. A raise records the
--    window it counted (window_from, window_to), what it counted there
--    (window_bookings_at_fire) and what a night like it usually gets
--    (window_expected_at_fire: over those days, which before this file was
--    always the rule's whole window), and comes off as
--    bookings_cancelled once the bookings still on the books from that
--    window are back to the expected number (cancellationCrossed in
--    engine/pickup.ts). Every such raise open when this file runs recorded
--    those two numbers in ROOMS, because that is what the engine counted at
--    the fire, while every engine reads the window back in BOOKINGS from
--    here on, which is never more and usually less: a wedding raise frozen
--    at 20 rooms against the 2 a night like it gets would come off on the
--    first run after this file with every room still booked, and the change
--    log would say enough of its bookings cancelled. So this file turns that
--    test off on the open raises it finds: cancel_check 'either' becomes
--    'net_units' (the booked-rooms test still applies) and 'window_bookings'
--    becomes 'none'. Their recorded window and numbers are left as history.
--    Those raises still come off when their night passes, when a price is
--    typed on the cell, when their rule is edited, and (net_units) when the
--    rooms booked on the night are back to where the fire's window opened;
--    they no longer come off for cancellations inside their window. Only the
--    raises made before the unit changed are touched: the update runs only
--    while booking_speed_windows is still the row-counting one (or missing),
--    so a replay after the switch leaves the raises made since, whose
--    numbers are in bookings, exactly as they are.
--
-- 3. booking_speed_windows(hotel, dates, exclude, include, since): the
--    result of 99_supabase_migration_large_property_scale_v1.sql plus a
--    `since` column, and each count is now distinct bookings per stay date
--    and booking window. A booking's window on a night is its earliest
--    booking date across its rooms that night (the longest known lead
--    time), so rooms added to a booking later never read as new bookings.
--    The fifth argument, p_since, is new: one instant per date, and for each
--    (date, instant) pair only the bookings first seen after the instant
--    count (the earliest created_at across a booking's rows on the night),
--    each pair on its own row with the instant in `since`. A Booking Speed
--    rule on a night raised by itself or a stronger rule counts, when it
--    next decides, only what came after the newest such raise: from the
--    raise's day on, and on that day only the
--    bookings that reached MAYA after the raise, so a burst later on the day
--    of a raise is not lost with it (engine/pickup.ts bookingSpeedCountFrom,
--    observations/expected-bookings.ts split). The engine reads every
--    (night, raise) pair a run needs in one call per set of room types,
--    however many raises made them. Without p_since, `since` is null and
--    the query is the plain count. The older four-argument function (and a
--    five-argument one with a single instant, from an earlier copy of this
--    file) is dropped so PostgREST has one to choose; calls that name no
--    p_since get the default. Grants, security definer and search_path are
--    the originals. The definition in the large property file is guarded so
--    a replay of that file cannot put the row count back nor a second
--    overload beside this one.
--
-- 4. pickup_event.window_since (timestamptz, null): a Booking Speed raise
--    that counted its first day (window_from) from its rule's own earlier
--    raise records that raise here, and its frozen window is read back the
--    same way when it is tested for cancellations (bookingsInFrozenWindow):
--    that day counts only the bookings first seen after the earlier raise,
--    as the raise counted it. Null when the day was counted whole, which is
--    every fire from before this file and every cut. Nothing is backfilled:
--    the fires from before this file counted their whole window.
--
-- 5. booking_speed_history_summary and booking_speed_first_stay_date are
--    unchanged. The summary only feeds the season model: n is how many rooms
--    a past night sold, and rank_windows is the lead time at which the night
--    reached each fraction of its ROOM capacity (milestoneRanks in
--    observations/booking-pace.ts). Both measure how full a night got, so
--    rooms are the right unit there. The engine's pre-migration row fallback
--    counts the same way (rooms for the season model, bookings for pace).
--
-- Indexes: none added. The function finds its rows through
-- idx_reservations_hotel_stay_date (hotel_id, stay_date) exactly as before
-- (checked with EXPLAIN VERBOSE in PGlite on a 500-room, ten-year table of
-- 1.24 million rows: the same bitmap index scan, with booking_key expanded
-- to its CASE in the scan's output, then a HashAggregate per booking and
-- one per window). What is new is one more grouping step over the rows
-- already fetched, one row per booking before one per window, plus one
-- string test per row: for 400 stay dates of a full 500-room hotel
-- (134,990 rows) that measured a median of 114 ms over 9 runs in PGlite
-- against about 60 ms for the old row count, once per engine run per chunk
-- of 400 dates and signal set. With booking_key declared STRICT the same
-- query measured 282 ms, because the planner would not inline it and
-- called it once per row; the history summary that scans three years took
-- 150 ms on the same table. An expression index on
-- booking_key(external_reservation_id) would not remove either cost: the
-- grouping is per stay date over rows the date index already narrowed, not
-- a lookup by key, and the index would be maintained on every sync upsert
-- for nothing.
--
-- The engine reads p_since and window_since as soon as it is deployed, so
-- this file must be on the database first: without window_since every fire
-- read fails and the run with it; without p_since the raise's day is read
-- row by row, which works and is slower.
--
-- Run AFTER 99_supabase_migration_large_property_scale_v1.sql. Idempotent,
-- one transaction, safe to replay. Nothing here needs folding into
-- 02_supabase_schema.sql for existing databases.
--
-- Deploy: run this, then deploy cloudbeds-scheduled-sync,
-- mews-scheduled-sync, think-scheduled-sync and onboarding-import-worker
-- (one command each; loops are blocked), then push the app. Every scheduled
-- sync runs the engine, which counts bookings on its own row fallback and
-- reads the same unit from this function. onboarding-import-worker is the
-- only place that writes a new hotel's starter rules and their
-- explanations (_shared/onboarding/generate-rules.ts), which now say that
-- a rule counts only the bookings made since it or a stronger rule last
-- adjusted the night and that the cut rules look at full days only; left
-- on the old bundle, a hotel onboarded in the gap keeps the old text for
-- good. The app runs the same engine (the evaluate button, a typed price's
-- republish, a room type reprice) and carries the "?" panels, the change
-- log, the drill-down and the three-raises alert that now say a booking
-- with several rooms counts once, that a rule counts only the bookings made
-- since it, or a stronger rule that moves the price the same way, last
-- adjusted the night, that a rule that raises on a fast pace needs those
-- bookings alone to beat what a night like it gets in its whole window,
-- and that a rule that cuts reads full days up to yesterday.
-- Between the migration and the deploy, the old engine reads the new
-- counts (one per booking) on every night and comparable, so its pace
-- calls, the fires it makes and the windows it records are in bookings
-- from the first run after this file; the raises it made before are no
-- longer tested on their window (2 above); it names no p_since, writes no
-- window_since and still judges every rule's whole window, today included,
-- as it always has; and nothing else changes. Between the deploy and the
-- migration the new engine would read room counts from the old function
-- and fail every run reading fires (no window_since column), so run the
-- migration first. What an owner may notice: a night raised before this
-- file and holding fewer bookings than rooms in its window is no longer
-- taken back off for cancellations inside that window; the three-raises
-- alert on a night whose newest fire predates this file shows that fire's
-- window numbers in rooms until a newer fire replaces it; once the new
-- engine runs, a rule judges only the bookings made since the newest
-- adjustment of the night by itself or by a stronger rule that moves the
-- price the same way, a paused one included (its adjustment stays on the
-- price), where it used to adjust again every wait on the same bookings.
-- A rule that raises on "at least" a pace (every raise on Faster, Much
-- Faster or Surging the form builds, and the three starter raises) needs
-- those bookings alone to beat what a night like it gets in its whole
-- window, so bookings that only keep the pace up after a raise don't raise
-- it again: after 10 bookings at once raise the rule for 10 in a week, 3
-- more don't raise the rule for 5 and 5 more do. Any other rule compares
-- them with the same days of the nights it is compared with.
-- A weaker rule's adjustment never moves where a stronger rule starts: 5
-- bookings and then 5 more can still be raised twice, the second time on
-- all 10, but bookings a stronger rule raised on are never raised on again
-- by a weaker one, so ten bookings at once under the starter rules end at
-- +25%, not +72%. The stronger rule is the one that changes the price by
-- more; at the same change, one with a Booking Speed condition ahead of one
-- without, then the faster pace for a raise (the slower for a cut), then
-- the pickup condition (a fixed order across kinds, and within one kind the
-- count harder to meet), then the starter rules' own order, then the one
-- with more conditions, then the older rule; the same order picks the rule
-- that adjusts when several match at once. It used to put the starter
-- rules first and then the rule with more conditions, so an owner's rule
-- that changes the price by more than a starter rule now goes ahead of it.
-- A stronger rule that is still waiting holds the night against a weaker
-- rule that moves the price its way only while the bookings it counts
-- since its change would make it adjust again, where it used to hold it
-- while its whole window matched:
-- 10 bookings at once and 5 more later raise the rule for 10, then the
-- rule for 5 on the 5 as they come. Against a rule that moves the price
-- the other way it still holds the night while its whole window matches.
-- A burst that reaches MAYA over several syncs can still
-- be raised again, on the bookings that came after the newest such raise.
-- Cuts work the same way: a stronger cut covers the weaker cut rules, so a
-- night the rescue cut is not trimmed again for the same slow stretch. A
-- pickup count rule's window opens at such an adjustment when that is
-- later than a whole window back, and one that fires on "less than" (or
-- "more than" a number under 0) waits for a whole window after it
-- instead; the three-raises alert then names no pickup window for that
-- fire. A rule that cuts judges full days ending
-- yesterday, and after a cut has nothing to judge until a full day has
-- passed.
--
-- Checking by hand (the SQL editor carries no JWT, so say you are the
-- service role for one transaction):
--
--   begin;
--   select set_config('request.jwt.claims', '{"role":"service_role"}', true);
--   select public.booking_key('6364686337417-2'), public.booking_key('res_1:b1');
--   select * from public.booking_speed_windows('<hotel id>', array[current_date + 30]);
--   select * from public.booking_speed_windows('<hotel id>',
--     array[current_date + 30, current_date + 30], '{}', null,
--     array[now() - interval '7 days', now() - interval '1 day']);
--   commit;
--
-- The first select gives 6364686337417 and res_1. The second's counts on a
-- night with a multi-room reservation are lower than count(*) over its rows,
-- and its `since` is null. The third gives at most one row per instant, in
-- order, the later instant's counts never above the earlier one's.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The booking key
-- ----------------------------------------------------------------------------

-- Plain SQL and immutable so the planner inlines it into the query below.
-- No search_path is pinned on purpose (a pinned one stops the inlining), and
-- neither is STRICT: the planner only inlines a strict SQL function when it
-- can prove every argument non-null, which it never can for a table column,
-- so a strict version ran as a real call per row (EXPLAIN VERBOSE showed
-- booking_key(external_reservation_id) in the scan's output where the CASE
-- below now appears) and cost 2.5x on the query below. A null in still gives
-- null out: every branch of the CASE yields null for a null input. It only
-- uses built-in string functions and operators, and the callers pin their
-- search_path. Execute stays at the default (public): the function reads
-- nothing.
create or replace function public.booking_key(p_external_reservation_id text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when position(':' in p_external_reservation_id) > 0
      then split_part(p_external_reservation_id, ':', 1)
    when p_external_reservation_id ~ '^[0-9]+-[0-9]+$'
      then split_part(p_external_reservation_id, '-', 1)
    else p_external_reservation_id
  end
$$;

comment on function public.booking_key(text) is
  'The booking a reservation row belongs to, from its external_reservation_id: Think <reservation>:<booking> keeps the reservation, Cloudbeds <reservation>-<room> keeps the reservation, anything else (Mews GUIDs, bare ids, seeds) is itself. Same rule as bookingKeyOf in observations/booking-rows.ts.';

-- ----------------------------------------------------------------------------
-- 2. Open raises recorded in rooms
-- ----------------------------------------------------------------------------

-- Before the windows function below is replaced, so the guard can still tell
-- whether the raises on the table were counted in rooms: while
-- booking_speed_windows is the row-counting one from the large property
-- file, or missing (the engine's row fallback counted rooms too), every
-- open Booking Speed raise recorded its window in rooms. Turn the
-- frozen-window cancellation test off on those and keep the rest of the
-- row as history (window_from, window_to and both numbers stay). The
-- stacking checks hold either way: 'net_units' and 'none' need no window,
-- and both are only ever set on a raise. Once a booking_speed_windows that
-- counts bookings is on the database, under either of this file's
-- signatures (an earlier copy of it had no p_since), this block does
-- nothing, so a replay never touches raises made since.
do $rooms$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'booking_speed_windows'
      and p.prosrc like '%booking_key%'
  ) then
    return;
  end if;

  update public.pickup_event
     set cancel_check = case cancel_check when 'either' then 'net_units' else 'none' end
   where retired_at is null
     and action_direction = 'increase'
     and cancel_check in ('window_bookings', 'either');
end
$rooms$;

-- ----------------------------------------------------------------------------
-- 3. The fire a raise's first day was split at
-- ----------------------------------------------------------------------------

alter table public.pickup_event
  add column if not exists window_since timestamptz;

comment on column public.pickup_event.window_since is
  'For a Booking Speed raise that counted window_from''s day from an earlier fire on the cell: that fire''s applied_at. Only the bookings first seen after it on that day were counted, and the frozen window is read back the same way. Null when the day was counted whole.';

-- ----------------------------------------------------------------------------
-- 4. Grouped windows, one count per booking
-- ----------------------------------------------------------------------------

-- Grouped windows for exactly the stay dates asked for: one row per date that
-- has kept rows, with its booking count and parallel arrays of (window,
-- count), windows ascending and the unknown window last. p_include, when
-- given, keeps only rows of those room types instead. A row's window is its
-- own lead time (bookingWindowOf); a booking's is the longest known one
-- across its kept rooms that night, and unknown only when none is known.
--
-- p_since, when given, is one instant per entry of p_dates (the same
-- length, or the call fails): for each (date, instant) pair only the
-- bookings on that date first seen after that instant count, and the pair
-- comes back as its own row with the instant in `since`. A booking's first
-- sight is the earliest created_at across its kept rows on the night, so a
-- room added later to a booking that was already there never makes it a
-- new one. A pair none of whose bookings are first seen after its instant
-- has no row. The engine asks for every raise a reading counts from in one
-- call per set of room types this way, however many raises and nights.
-- Without p_since, `since` is null on every row and the query is the plain
-- count, with no join and no created_at read.
--
-- The older signatures are dropped first: the four-argument one from the
-- large property file, and a five-argument one taking a single instant
-- that an earlier copy of this file defined. Left in place beside this
-- one, PostgREST could not choose between them for a call that names no
-- p_since, and the engine's calls would fail.
drop function if exists public.booking_speed_windows(uuid, date[], uuid[], uuid[]);
drop function if exists public.booking_speed_windows(uuid, date[], uuid[], uuid[], timestamptz);

create or replace function public.booking_speed_windows(
  p_hotel_id uuid,
  p_dates date[],
  p_exclude uuid[] default '{}',
  p_include uuid[] default null,
  p_since timestamptz[] default null
)
returns table(stay_date date, since timestamptz, n int, bws int[], counts int[])
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.is_hotel_accessible(p_hotel_id) then
    raise exception 'Not authorized to read booking history for hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  if p_since is null then
    return query
    with kept as (
      select
        r.stay_date,
        -- A row with no id, or an empty one (the schema only says not null,
        -- and the parsers skip empty ids, so none exist; but the function
        -- must never fold every such row on a night into one booking) is
        -- its own booking, as it is in StayDateWindowsBuilder.
        coalesce(public.booking_key(nullif(r.external_reservation_id, '')), r.id::text) as booking,
        case
          when r.booking_date is not null then r.stay_date - r.booking_date
          else r.booking_window_days
        end as bw
      from public.reservations r
      where r.hotel_id = p_hotel_id
        and r.stay_date = any (coalesce(p_dates, '{}'::date[]))
        and (
          case
            when p_include is null then
              r.room_type_id is null or not (r.room_type_id = any (coalesce(p_exclude, '{}'::uuid[])))
            else r.room_type_id = any (p_include)
          end
        )
    ),
    per_booking as (
      -- max ignores nulls: the longest known lead time, null only when no
      -- room of the booking has one.
      select k.stay_date, k.booking, max(k.bw) as bw
      from kept k
      group by 1, 2
    ),
    grouped as (
      select b.stay_date, b.bw, count(*)::int as cnt
      from per_booking b
      group by 1, 2
    )
    select
      g.stay_date,
      null::timestamptz,
      sum(g.cnt)::int,
      array_agg(g.bw order by g.bw asc nulls last),
      array_agg(g.cnt order by g.bw asc nulls last)
    from grouped g
    group by g.stay_date
    order by g.stay_date;
    return;
  end if;

  if coalesce(array_length(p_since, 1), 0) <> coalesce(array_length(p_dates, 1), 0) then
    raise exception 'p_since needs one instant per date: % dates, % instants',
      coalesce(array_length(p_dates, 1), 0), coalesce(array_length(p_since, 1), 0)
      using errcode = '22023';
  end if;

  return query
  with asked as (
    select distinct a.d as stay_date, a.s as since
    from unnest(p_dates, p_since) as a(d, s)
    where a.d is not null and a.s is not null
  ),
  kept as (
    select
      r.stay_date,
      coalesce(public.booking_key(nullif(r.external_reservation_id, '')), r.id::text) as booking,
      case
        when r.booking_date is not null then r.stay_date - r.booking_date
        else r.booking_window_days
      end as bw,
      r.created_at
    from public.reservations r
    where r.hotel_id = p_hotel_id
      and r.stay_date = any (p_dates)
      and (
        case
          when p_include is null then
            r.room_type_id is null or not (r.room_type_id = any (coalesce(p_exclude, '{}'::uuid[])))
          else r.room_type_id = any (p_include)
        end
      )
  ),
  per_booking as (
    -- min(created_at): when the booking was first seen on the night.
    select k.stay_date, k.booking, max(k.bw) as bw, min(k.created_at) as first_seen
    from kept k
    group by 1, 2
  ),
  grouped as (
    select a.stay_date, a.since, b.bw, count(*)::int as cnt
    from asked a
    join per_booking b on b.stay_date = a.stay_date
    where b.first_seen > a.since
    group by 1, 2, 3
  )
  select
    g.stay_date,
    g.since,
    sum(g.cnt)::int,
    array_agg(g.bw order by g.bw asc nulls last),
    array_agg(g.cnt order by g.bw asc nulls last)
  from grouped g
  group by g.stay_date, g.since
  order by g.stay_date, g.since;
end;
$$;

revoke all on function public.booking_speed_windows(uuid, date[], uuid[], uuid[], timestamptz[]) from public, anon;
grant execute on function public.booking_speed_windows(uuid, date[], uuid[], uuid[], timestamptz[])
  to authenticated, service_role;

commit;
