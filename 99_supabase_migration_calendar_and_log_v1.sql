-- ============================================================================
-- MAYA: the calendar's revenue and the change log's rules (audit items A48, A46), v1
-- ============================================================================
--
-- 1. Revenue at the rate a booking has now (A48). A booking's nightly rate is
--    reservations.current_rate, kept up to date by every sync; base_rate is
--    the first rate MAYA ever read for it (the reservations_sync_base_rate
--    trigger never moves it). The calendar's colours (calendar_daily_revenue_v3)
--    and the Command Center's business numbers (staff_hotel_business_numbers)
--    counted each booking at base_rate first, so a booking the hotel moved
--    from $200 to $150 in its property system still added $200 to the day's
--    revenue, ADR and RevPAR, while the engine's revenue counts used $150.
--    Both now count coalesce(current_rate, base_rate, 0): the rate it has
--    now, the first one only when the property system sent none since, else
--    0. The day card does the same in the app (lib/calendar-store.ts,
--    nightlyRoomAmount). Each function is restated whole from its newest
--    definition (99_supabase_migration_signups_feed_v1.sql and
--    99_supabase_migration_staff_roles_v1.sql) with only that change; access
--    checks, grants and comments otherwise as they were.
--
-- 2. The change log tells each rule as its run had it (A46). From this
--    release the engine keeps, on each audit row, the rules the row names as
--    they were (details.rule_snapshots: name, version, the marks of its
--    condition, and what it measures) and the version of the rule behind
--    each fire (details.active_pickup_effects[].rule_version). The change log
--    reads a night's row before a run through audit_rows_before; it now also
--    returns that row's standard rule changes (active_ladder_effects, with
--    the amount each applied) and its rule_snapshots, so a run that took a
--    rule off says the amount it had and the name it had then. The function
--    is dropped and made again (a function's result columns can't change in
--    place); access check and grants exactly as in
--    99_supabase_migration_pickup_wait_v1.sql.
--
-- Run AFTER 99_supabase_migration_billing_watchdog_v1.sql. One transaction,
-- safe to run again. No table, column or policy changes; row level security
-- is untouched. Before this file the app falls back: the change log tells a
-- rule taken off with today's amount, as before.
--
-- Deploy: run this, then deploy cloudbeds-scheduled-sync,
-- think-scheduled-sync and mews-scheduled-sync (one command each; they run
-- the engine that writes the new audit fields), then the app.
--
-- Checking by hand:
--
--   select pg_get_function_result('public.audit_rows_before(uuid, timestamptz, date[], uuid[])'::regprocedure);
--
-- ends with "ladder_effects jsonb, rule_snapshots jsonb".
--
--   select prosrc like '%coalesce(r.current_rate, r.base_rate, 0)%' from pg_proc
--    where proname in ('calendar_daily_revenue_v3', 'staff_hotel_business_numbers');
--
-- Two rows, both true.
-- ============================================================================

begin;

-- ── 1. Revenue at the rate a booking has now ───────────────────────────────

-- Per stay date, the room revenue the day card counts for its RevPAR: the
-- active room types that count as rooms, each booking at the rate it has
-- now, else the first rate MAYA read for it, else 0. Paged by date like v2.
create or replace function public.calendar_daily_revenue_v3(
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
  select r.stay_date,
         coalesce(sum(coalesce(r.current_rate, r.base_rate, 0)) filter (where rt.id is not null), 0)::numeric
    from public.reservations r
    left join public.room_types rt
      on rt.id = r.room_type_id
     and rt.hotel_id = p_hotel_id
     and rt.is_active
     and rt.counts_as_room is distinct from false
   where r.hotel_id = p_hotel_id
     and (p_after is null or r.stay_date > p_after)
   group by r.stay_date
   order by r.stay_date
   limit greatest(1, least(coalesce(p_limit, 1000), 1000));
end;
$$;

comment on function public.calendar_daily_revenue_v3(uuid, date, int) is
  'Per stay date, the room revenue of the active room types that count as rooms, each booking at '
  'coalesce(current_rate, base_rate, 0): what a calendar day divides by its sellable rooms for its RevPAR, '
  'which its colour ranks. Every date with a booking is listed. Paged by date (p_after, at most 1,000).';

revoke all on function public.calendar_daily_revenue_v3(uuid, date, int) from public, anon;
grant execute on function public.calendar_daily_revenue_v3(uuid, date, int) to authenticated, service_role;

-- A property's business numbers, night by night, the way its calendar adds
-- them up (lib/calendar-store.ts): rooms sold and sellable rooms (the active
-- types that count as rooms, less rooms out of service), sellable occupancy,
-- room revenue (every active type, each booking at the rate it has now) and
-- ADR (the types that count as rooms). Totals only: nothing about a booking
-- or a guest. For a platform admin, and for sales at aal2 on a real property
-- only; never a test one.
create or replace function public.staff_hotel_business_numbers(
  p_hotel_id uuid,
  p_from date,
  p_to date
) returns table (
  stay_date date,
  rooms_sold int,
  rooms_available int,
  occupancy_pct numeric,
  room_revenue numeric,
  adr numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_service boolean := (select auth.role()) is not distinct from 'service_role';
  v_is_test boolean;
  v_fallback_rooms int;
begin
  if not v_service and not public.staff_can_read('business_numbers') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select h.is_test, h.total_rooms_per_type into v_is_test, v_fallback_rooms
    from public.hotels h
   where h.id = p_hotel_id;
  if not found then
    raise exception 'No such property %', p_hotel_id using errcode = 'P0002';
  end if;
  if v_is_test and not v_service and not public.is_platform_admin() then
    raise exception 'Business numbers are shown for real properties only.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Ask for up to 401 nights, the first no later than the last.' using errcode = '22023';
  end if;

  return query
  with types as (
    select t.id,
           -- A missing count borrows the property's default, as the calendar does.
           coalesce(t.total_rooms, v_fallback_rooms, 0) as total_rooms,
           t.counts_as_room is distinct from false as counting
      from public.room_types t
     where t.hotel_id = p_hotel_id
       and t.is_active
  ),
  nights as (
    select g.night::date as night
      from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as g(night)
  ),
  sold as (
    select r.stay_date as night,
           r.room_type_id,
           count(*)::int as booked,
           sum(coalesce(r.current_rate, r.base_rate, 0))::numeric as revenue
      from public.reservations r
      join types ty on ty.id = r.room_type_id
     where r.hotel_id = p_hotel_id
       and r.stay_date between p_from and p_to
     group by r.stay_date, r.room_type_id
  ),
  cells as (
    select n.night,
           ty.counting,
           greatest(0, ty.total_rooms - coalesce((
             select sum(o.units)
               from public.room_type_out_of_service o
              where o.hotel_id = p_hotel_id
                and o.room_type_id = ty.id
                and o.cleared_at is null
                and n.night between o.start_date and o.end_date
           ), 0))::int as sellable,
           coalesce(so.booked, 0) as booked,
           coalesce(so.revenue, 0) as revenue
      from nights n
      cross join types ty
      left join sold so on so.night = n.night and so.room_type_id = ty.id
  ),
  totals as (
    select n.night,
           coalesce(sum(c.booked) filter (where c.counting), 0)::int as booked,
           coalesce(sum(c.sellable) filter (where c.counting), 0)::int as sellable,
           coalesce(sum(c.revenue), 0)::numeric as revenue,
           coalesce(sum(c.revenue) filter (where c.counting), 0)::numeric as counted_revenue
      from nights n
      left join cells c on c.night = n.night
     group by n.night
  )
  select tt.night,
         tt.booked,
         tt.sellable,
         case when tt.sellable > 0 then round(100.0 * tt.booked / tt.sellable, 1) end,
         round(tt.revenue, 2),
         case when tt.booked > 0 then round(tt.counted_revenue / tt.booked, 2) end
    from totals tt
   order by tt.night;
end;
$$;

revoke all on function public.staff_hotel_business_numbers(uuid, date, date) from public, anon;
grant execute on function public.staff_hotel_business_numbers(uuid, date, date) to authenticated, service_role;

comment on function public.staff_hotel_business_numbers(uuid, date, date) is
  'Night-by-night rooms sold, sellable rooms, sellable occupancy, room revenue and ADR for one property, '
  'up to 401 nights, each booking at the rate it has now. Totals only. Platform admins; sales at aal2 on real '
  '(not test) properties only.';

-- ── 2. The row before, with its rules and amounts, for the change log ──────

drop function if exists public.audit_rows_before(uuid, timestamptz, date[], uuid[]);

create function public.audit_rows_before(
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
  manual_override jsonb,
  ladder_effects jsonb,
  rule_snapshots jsonb
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
    a.details -> 'manual_override',
    a.details -> 'active_ladder_effects',
    a.details -> 'rule_snapshots'
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

comment on function public.audit_rows_before(uuid, timestamptz, date[], uuid[]) is
  'For each (night, room type) pair, the newest evaluation_audit row before p_before: its prices, what it was '
  'priced on (application_order, base_source, manual_override), its standard rule changes (active_ladder_effects) '
  'and the rules as it kept them (rule_snapshots). Service role, or a member of the hotel.';

commit;
