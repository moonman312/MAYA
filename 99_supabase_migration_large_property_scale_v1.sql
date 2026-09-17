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
-- Optional, when you want the nightly engine sweep to commit per batch (see
-- section 8). Only after this file has run:
--
--   select cron.unschedule('engine-data-sweep');
--   select cron.schedule('engine-data-sweep', '50 8 * * *',
--     $$ call public.engine_data_sweep_proc(); $$);
--
-- never_paid_retention_sweep is left as it is: it holds each property's row
-- lock across that property's deletes, and a commit per batch would release it.
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

-- ----------------------------------------------------------------------------
-- 3. Last audit signature per cell
--
-- The engine skips an audit row when a cell's outcome matches the newest row
-- already written for it. This returns that newest row per (stay date, room
-- type), ties on evaluated_at broken by id, with only the details fields the
-- signature reads. Served by idx_evaluation_audit_cell.
-- ----------------------------------------------------------------------------

create or replace function public.audit_last_signatures(
  p_hotel_id uuid,
  p_from date,
  p_to date
)
returns table(
  stay_date date,
  room_type_id uuid,
  final_price numeric,
  application_order jsonb,
  clamped_by text,
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

  return query
  select distinct on (a.stay_date, a.room_type_id)
    a.stay_date,
    a.room_type_id,
    a.final_price,
    a.details -> 'application_order',
    a.details ->> 'clamped_by',
    a.details ->> 'base_source',
    a.details -> 'manual_override'
  from public.evaluation_audit a
  where a.hotel_id = p_hotel_id
    and a.stay_date >= p_from
    and a.stay_date <= p_to
  order by a.stay_date, a.room_type_id, a.evaluated_at desc, a.id desc;
end;
$$;

revoke all on function public.audit_last_signatures(uuid, date, date) from public, anon;
grant execute on function public.audit_last_signatures(uuid, date, date)
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. Highest rate per room type
--
-- Strategy projection only applies a hotel-wide ceiling to a room type that
-- has never sold above it. Reading the top rates hotel-wide stopped at
-- PostgREST's 1,000 rows, so a type whose best rate fell below that cut looked
-- like it had never sold at all. A type with no rated booking has no row.
-- ----------------------------------------------------------------------------

create or replace function public.room_type_max_rates(p_hotel_id uuid)
returns table(room_type_id uuid, max_rate numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.is_hotel_accessible(p_hotel_id) then
    raise exception 'Not authorized to read rates for hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  return query
  select r.room_type_id, max(r.current_rate)
  from public.reservations r
  where r.hotel_id = p_hotel_id
    and r.room_type_id is not null
    and r.current_rate is not null
  group by r.room_type_id;
end;
$$;

revoke all on function public.room_type_max_rates(uuid) from public, anon;
grant execute on function public.room_type_max_rates(uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. How often each rule has fired
--
-- Ladder activations plus pickup events per rule, for sorting the rules list.
-- Counting them in the app pulled one row per fire and stopped at 1,000.
-- ----------------------------------------------------------------------------

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
  ) f
  group by f.rule_id;
end;
$$;

revoke all on function public.rule_fire_counts(uuid) from public, anon;
grant execute on function public.rule_fire_counts(uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 6. The horizon's reservations per cell, for the engine
--
-- Per (stay date, room type) over the priced horizon: room-nights, the sum of
-- current_rate (a missing rate counts as 0), and the base_rate of the newest
-- row, newest by created_at and then lowest id, the order the engine reads
-- rows in. Rows with no room type are left out, as the engine leaves them out.
-- The engine used to pull every room-night in the horizon twice to work these
-- out.
-- ----------------------------------------------------------------------------

create or replace function public.engine_reservation_cells(
  p_hotel_id uuid,
  p_from date,
  p_to date
)
returns table(
  stay_date date,
  room_type_id uuid,
  units int,
  revenue numeric,
  latest_base_rate numeric,
  latest_created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.is_hotel_accessible(p_hotel_id) then
    raise exception 'Not authorized to read reservations for hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  return query
  with totals as (
    select r.stay_date as sd, r.room_type_id as rt, count(*)::int as n, sum(coalesce(r.current_rate, 0)) as rev
    from public.reservations r
    where r.hotel_id = p_hotel_id
      and r.stay_date >= p_from
      and r.stay_date <= p_to
      and r.room_type_id is not null
    group by r.stay_date, r.room_type_id
  ),
  newest as (
    select distinct on (r.stay_date, r.room_type_id)
      r.stay_date as sd, r.room_type_id as rt, r.base_rate as base, r.created_at as created
    from public.reservations r
    where r.hotel_id = p_hotel_id
      and r.stay_date >= p_from
      and r.stay_date <= p_to
      and r.room_type_id is not null
    order by r.stay_date, r.room_type_id, r.created_at desc, r.id asc
  )
  select t.sd, t.rt, t.n, t.rev, w.base, w.created
  from totals t
  join newest w on w.sd = t.sd and w.rt = t.rt
  order by t.sd, t.rt;
end;
$$;

revoke all on function public.engine_reservation_cells(uuid, date, date) from public, anon;
grant execute on function public.engine_reservation_cells(uuid, date, date) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 7. Calendar revenue series, keyset paged
--
-- calendar_daily_revenue runs as the caller, so the reservations RLS policy is
-- evaluated for every row, over a million on a large property, and each
-- OFFSET page re-aggregated the whole book. This checks access once and pages
-- by stay date: each call returns up to p_limit dates after p_after.
-- ----------------------------------------------------------------------------

create or replace function public.calendar_daily_revenue_v2(
  p_hotel_id uuid,
  p_after date default null,
  p_limit int default 1000
)
returns table(stay_date date, revenue numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.is_hotel_accessible(p_hotel_id) then
    raise exception 'Not authorized to read revenue for hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  return query
  select r.stay_date, sum(coalesce(r.current_rate, 0))::numeric
  from public.reservations r
  where r.hotel_id = p_hotel_id
    and (p_after is null or r.stay_date > p_after)
  group by r.stay_date
  order by r.stay_date
  limit greatest(1, least(coalesce(p_limit, 1000), 1000));
end;
$$;

revoke all on function public.calendar_daily_revenue_v2(uuid, date, int) from public, anon;
grant execute on function public.calendar_daily_revenue_v2(uuid, date, int) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 8. Engine data sweep that commits as it goes
--
-- engine_data_sweep deletes in batches but is one function call, so one
-- transaction: up to 40 x 50,000 rows per table held open until the end. A
-- large property's backlog makes that a long lock and a lot of WAL at once.
-- This procedure does the same deletes and commits after every batch.
--
-- SECURITY INVOKER and no SET clause, on purpose: Postgres refuses COMMIT
-- inside a SECURITY DEFINER procedure or one with a SET clause. Every table is
-- schema-qualified and every function it calls lives in pg_catalog, so no
-- search_path can redirect it. pg_cron runs it as the database owner, and only
-- service_role is granted execute besides.
--
-- Not scheduled by this file. See the header for the cron change.
-- ----------------------------------------------------------------------------

create or replace procedure public.engine_data_sweep_proc(
  p_snapshot_days integer default 60,
  p_audit_days integer default 90,
  p_run_log_days integer default 90,
  p_batch integer default 50000
)
language plpgsql
as $$
declare
  batch_removed integer;
  passes integer;
begin
  passes := 0;
  loop
    delete from public.stay_date_snapshot
     where ctid in (
       select ctid from public.stay_date_snapshot
        where snapshot_ts < now() - make_interval(days => p_snapshot_days)
        limit p_batch
     );
    get diagnostics batch_removed = row_count;
    commit;
    passes := passes + 1;
    exit when batch_removed < p_batch or passes >= 40;
  end loop;

  passes := 0;
  loop
    delete from public.evaluation_audit
     where id in (
       select id from public.evaluation_audit
        where evaluated_at < now() - make_interval(days => p_audit_days)
        order by evaluated_at
        limit p_batch
     );
    get diagnostics batch_removed = row_count;
    commit;
    passes := passes + 1;
    exit when batch_removed < p_batch or passes >= 40;
  end loop;

  passes := 0;
  loop
    delete from public.evaluation_run_log
     where id in (
       select id from public.evaluation_run_log
        where evaluated_at < now() - make_interval(days => p_run_log_days)
        order by evaluated_at
        limit p_batch
     );
    get diagnostics batch_removed = row_count;
    commit;
    passes := passes + 1;
    exit when batch_removed < p_batch or passes >= 40;
  end loop;
end;
$$;

revoke all on procedure public.engine_data_sweep_proc(integer, integer, integer, integer) from public, anon, authenticated;
grant execute on procedure public.engine_data_sweep_proc(integer, integer, integer, integer) to service_role;

notify pgrst, 'reload schema';
