-- ============================================================================
-- MAYA large property scale (v1)
--
-- Properties are sold self-serve up to 500 rooms, and a Marketplace signup can
-- bring one in at any time with ten years of history. Reservations are stored
-- per room-night, so a 500-room hotel carries well over a million rows. The
-- engine and a few pages used to pull those rows into memory 1,000 at a time;
-- Booking Speed threw past 100,000 rows and every pricing run failed for a
-- property of roughly 130 rooms or more. The functions below do that grouping
-- in Postgres and hand back one small row per stay date instead.
--
-- Every function is read-only, SECURITY DEFINER with a pinned search_path, and
-- checks access itself: service_role, or a member of the hotel
-- (is_hotel_accessible), the same people the reservations RLS policy lets read
-- these rows today. Execute is revoked from public and anon.
--
-- The app keeps working if this file has not been run: each caller notices the
-- missing function, logs one line naming this file, and takes its old path.
--
-- Run AFTER 02_supabase_schema.sql and every earlier 99_ migration.
-- Safe to re-run (create or replace, if not exists).
--
-- AFTER this file, run each of these on its own, one statement at a time and
-- outside a transaction (CREATE/DROP INDEX CONCURRENTLY cannot run inside one,
-- and the SQL editor wraps a multi-statement run in one):
--
--   create index concurrently if not exists idx_snapshot_cell_ts
--     on public.stay_date_snapshot (hotel_id, stay_date, room_type_id, snapshot_ts desc);
--
-- Nothing here needs folding into 02_supabase_schema.sql for existing
-- databases; fold the functions in when the base schema is next regenerated.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Booking Speed history
--
-- A row's booking window is its own lead time: stay_date - booking_date when
-- booking_date is known, else the stored booking_window_days, else unknown.
-- That is bookingWindowOf in observations/booking-rows.ts. Rows whose room type
-- does not count as a room (p_exclude) are dropped; a row with no room type is
-- kept.
-- ----------------------------------------------------------------------------

-- Per stay date from p_from (through p_to, when given): how many kept rows,
-- how many have a usable (non-negative) window, and the window at each
-- 1-based rank in p_ranks when the usable windows are sorted latest-booked
-- first (null past the end). The caller computes the ranks from its pace
-- milestones, so rounding stays in one place.
create or replace function public.booking_speed_history_summary(
  p_hotel_id uuid,
  p_from date,
  p_to date default null,
  p_exclude uuid[] default '{}',
  p_ranks int[] default '{}'
)
returns table(stay_date date, n int, usable int, rank_windows int[])
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
      case
        when r.booking_date is not null then r.stay_date - r.booking_date
        else r.booking_window_days
      end as bw
    from public.reservations r
    where r.hotel_id = p_hotel_id
      and r.stay_date >= p_from
      and (p_to is null or r.stay_date <= p_to)
      and (r.room_type_id is null or not (r.room_type_id = any (coalesce(p_exclude, '{}'::uuid[]))))
  ),
  per_date as (
    select
      k.stay_date,
      count(*)::int as n,
      count(*) filter (where k.bw >= 0)::int as usable,
      array_agg(k.bw order by k.bw desc) filter (where k.bw >= 0) as sorted
    from kept k
    group by k.stay_date
  )
  select
    d.stay_date,
    d.n,
    d.usable,
    array(
      select d.sorted[x.rnk]
      from unnest(coalesce(p_ranks, '{}'::int[])) with ordinality as x(rnk, ord)
      order by x.ord
    ) as rank_windows
  from per_date d
  order by d.stay_date;
end;
$$;

revoke all on function public.booking_speed_history_summary(uuid, date, date, uuid[], int[]) from public, anon;
grant execute on function public.booking_speed_history_summary(uuid, date, date, uuid[], int[])
  to authenticated, service_role;

-- Grouped windows for exactly the stay dates asked for: one row per date that
-- has kept rows, with its row count and parallel arrays of (window, count),
-- windows ascending and the unknown window last.
create or replace function public.booking_speed_windows(
  p_hotel_id uuid,
  p_dates date[],
  p_exclude uuid[] default '{}'
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
  with grouped as (
    select
      r.stay_date,
      case
        when r.booking_date is not null then r.stay_date - r.booking_date
        else r.booking_window_days
      end as bw,
      count(*)::int as cnt
    from public.reservations r
    where r.hotel_id = p_hotel_id
      and r.stay_date = any (coalesce(p_dates, '{}'::date[]))
      and (r.room_type_id is null or not (r.room_type_id = any (coalesce(p_exclude, '{}'::uuid[]))))
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

revoke all on function public.booking_speed_windows(uuid, date[], uuid[]) from public, anon;
grant execute on function public.booking_speed_windows(uuid, date[], uuid[])
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. Snapshot cells at a timestamp
--
-- The engine's pickup rules read, per (stay date, room type), the latest
-- snapshot at or before a baseline timestamp. Most cells in a run share a few
-- baselines, so each shared one is read for the whole block of cells at once.
-- Cells with no snapshot at or before p_ts are simply absent. Pairs with
-- idx_snapshot_cell_ts (see the header) for one index probe per cell.
-- ----------------------------------------------------------------------------

create or replace function public.snapshot_cells_at(
  p_hotel_id uuid,
  p_ts timestamptz,
  p_from date,
  p_to date,
  p_room_types uuid[]
)
returns table(
  stay_date date,
  room_type_id uuid,
  booked_units int,
  booked_revenue numeric,
  snapshot_ts timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.is_hotel_accessible(p_hotel_id) then
    raise exception 'Not authorized to read snapshots for hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  return query
  select d.day::date, rt.id, s.booked_units, s.booked_revenue, s.snapshot_ts
  from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as d(day)
  cross join unnest(coalesce(p_room_types, '{}'::uuid[])) as rt(id)
  cross join lateral (
    select x.booked_units, x.booked_revenue, x.snapshot_ts
    from public.stay_date_snapshot x
    where x.hotel_id = p_hotel_id
      and x.stay_date = d.day::date
      and x.room_type_id = rt.id
      and x.snapshot_ts <= p_ts
    order by x.snapshot_ts desc
    limit 1
  ) s
  order by 1, 2;
end;
$$;

revoke all on function public.snapshot_cells_at(uuid, timestamptz, date, date, uuid[]) from public, anon;
grant execute on function public.snapshot_cells_at(uuid, timestamptz, date, date, uuid[])
  to authenticated, service_role;

notify pgrst, 'reload schema';
