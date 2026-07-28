-- MAYA Calendar Revenue v1 Migration
--
-- Fixes a real perf regression: the calendar's property-relative RevPAR
-- coloring was pulling EVERY reservation row a hotel has ever had (paginated
-- 1000 at a time) into Node and summing them in JS, just to get one number
-- per distinct stay date. On a hotel with ~13k reservation rows this took
-- ~2.8s and 14 round-trips, and it re-runs on every calendar load — including
-- the new realtime-triggered refreshes. This RPC does the grouping in
-- Postgres (which already has an index on (hotel_id, stay_date)) and returns
-- one row per distinct stay date instead of one row per reservation.
--
-- Run AFTER 02_supabase_schema.sql. Safe to re-run (create or replace).
-- Also folded into 02_supabase_schema.sql.

-- security invoker (the default — no `security definer` here) means this
-- runs as the calling user, so the existing RLS policy on `reservations`
-- (is_hotel_accessible(hotel_id)) is enforced exactly as it is for a normal
-- .from("reservations").select(...) call. No new access is granted.
create or replace function public.calendar_daily_revenue(p_hotel_id uuid)
returns table(stay_date date, revenue numeric)
language sql
stable
set search_path = public, pg_temp
as $$
  select r.stay_date, sum(coalesce(r.current_rate, 0))::numeric as revenue
  from reservations r
  where r.hotel_id = p_hotel_id
  group by r.stay_date
  order by r.stay_date;
$$;

grant execute on function public.calendar_daily_revenue(uuid) to authenticated;
