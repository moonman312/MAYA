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
-- Nothing else: no new columns, no backfill, no group or block codes, no
-- owner settings.
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
-- 2. booking_speed_windows(hotel, dates, exclude, include): the same
--    signature and result shape as in
--    99_supabase_migration_large_property_scale_v1.sql, but each count is
--    now distinct bookings per stay date and booking window. A booking's
--    window on a night is its earliest booking date across its rooms that
--    night (the longest known lead time), so rooms added to a booking later
--    never read as new bookings. Grants, security definer and search_path
--    are the originals. The definition in the large property file is now
--    guarded so a replay of that file cannot put the room count back.
--
-- 3. booking_speed_history_summary and booking_speed_first_stay_date are
--    unchanged. The summary only feeds the season model: n is how many rooms
--    a past night sold, and rank_windows is the lead time at which the night
--    reached each fraction of its ROOM capacity (milestoneRanks in
--    observations/booking-pace.ts). Both measure how full a night got, so
--    rooms are the right unit there. The engine's pre-migration row fallback
--    counts the same way (rooms for the season model, bookings for pace).
--
-- Indexes: none added. The function finds its rows through
-- idx_reservations_hotel_stay_date (hotel_id, stay_date) exactly as before
-- (checked with EXPLAIN in PGlite on a 500-room, ten-year table of 1.28
-- million rows: the same bitmap index scan, then the grouping). What is new
-- is one more grouping step over the rows already fetched, one row per
-- booking before one per window, plus one string test per row: for 400
-- stay dates of a full 500-room hotel (140,000 rows) that measured about
-- 290 ms in PGlite against about 80 ms before, once per engine run per
-- chunk of 400 dates, and the history summary that scans three years took
-- 150 ms on the same table. An expression index on
-- booking_key(external_reservation_id) would not remove either cost: the
-- grouping is per stay date over rows the date index already narrowed, not
-- a lookup by key, and the index would be maintained on every sync upsert
-- for nothing.
--
-- Run AFTER 99_supabase_migration_large_property_scale_v1.sql. Idempotent,
-- one transaction, safe to replay. Nothing here needs folding into
-- 02_supabase_schema.sql for existing databases.
--
-- Deploy: run this, then deploy cloudbeds-scheduled-sync,
-- mews-scheduled-sync and think-scheduled-sync (one command each; loops
-- are blocked), then push the app. Every scheduled sync runs the engine,
-- which counts bookings on its own row fallback and reads the same unit
-- from this function; the app carries the "?" panels and the drill-down
-- that now say a booking with several rooms counts once. Between the
-- migration and the deploy, the old engine reads the new counts (one per
-- booking) and nothing else changes; between the deploy and the migration
-- the new engine would read room counts from the old function, so run the
-- migration first.
--
-- Checking by hand (the SQL editor carries no JWT, so say you are the
-- service role for one transaction):
--
--   begin;
--   select set_config('request.jwt.claims', '{"role":"service_role"}', true);
--   select public.booking_key('6364686337417-2'), public.booking_key('res_1:b1');
--   select * from public.booking_speed_windows('<hotel id>', array[current_date + 30]);
--   commit;
--
-- The first select gives 6364686337417 and res_1. The second's counts on a
-- night with a multi-room reservation are lower than count(*) over its rows.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The booking key
-- ----------------------------------------------------------------------------

-- Plain SQL and immutable so the planner inlines it into the query below.
-- No search_path is pinned on purpose (a pinned one stops the inlining); it
-- only uses built-in string functions and operators, and the callers pin
-- theirs. Execute stays at the default (public): the function reads nothing.
create or replace function public.booking_key(p_external_reservation_id text)
returns text
language sql
immutable
strict
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
-- 2. Grouped windows, one count per booking
-- ----------------------------------------------------------------------------

-- Grouped windows for exactly the stay dates asked for: one row per date that
-- has kept rows, with its booking count and parallel arrays of (window,
-- count), windows ascending and the unknown window last. p_include, when
-- given, keeps only rows of those room types instead. A row's window is its
-- own lead time (bookingWindowOf); a booking's is the longest known one
-- across its kept rooms that night, and unknown only when none is known.
create or replace function public.booking_speed_windows(
  p_hotel_id uuid,
  p_dates date[],
  p_exclude uuid[] default '{}',
  p_include uuid[] default null
)
returns table(stay_date date, n int, bws int[], counts int[])
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

  return query
  with kept as (
    select
      r.stay_date,
      -- A row with no id (none exist under the schema's not-null, but the
      -- function must not fold them into one booking) is its own booking.
      coalesce(public.booking_key(r.external_reservation_id), r.id::text) as booking,
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
    -- max ignores nulls: the longest known lead time, null only when no room
    -- of the booking has one.
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
    sum(g.cnt)::int as n,
    array_agg(g.bw order by g.bw asc nulls last) as bws,
    array_agg(g.cnt order by g.bw asc nulls last) as counts
  from grouped g
  group by g.stay_date
  order by g.stay_date;
end;
$$;

revoke all on function public.booking_speed_windows(uuid, date[], uuid[], uuid[]) from public, anon;
grant execute on function public.booking_speed_windows(uuid, date[], uuid[], uuid[])
  to authenticated, service_role;

commit;
