-- ============================================================================
-- COMMAND CENTER SPEED v1: the analytics page's revenue half in two calls
-- ============================================================================
--
-- /admin/analytics used to work out its revenue half in the app, reading the
-- live tables one request after another: about 26 in a row on every load, one
-- of them paging through every engine run of the last 90 days (every hotel,
-- test ones too) just to find each hotel's first run, and another paging
-- through every login in auth 200 at a time to leave out the "+" test
-- accounts. The SQL was never slow; the waiting was. These functions answer
-- the same questions in one call each:
--
--   analytics_now(p_include_test)                 what is true right now
--   analytics_range(p_from, p_to, p_include_test) how it changed in a window
--   analytics_owner_emails(p_user_ids)            the follow-up list's owner
--                                                 emails, read fresh on every
--                                                 load (the app keeps the
--                                                 list's other numbers a few
--                                                 minutes, never the emails)
--   platform_count_users(p_search)                how many logins there are
--                                                 (the Users tile and page
--                                                 stopped at the first 100)
--
-- The numbers are the ones the app worked out before, proven equal on a seeded
-- database in lib/admin/command-center-speed-migration-sql.test.ts, with two
-- deliberate differences:
--
--   * An account counts once its email address is confirmed, on the day it
--     was confirmed (auth.users.email_confirmed_at), the way account.created
--     does since 99_supabase_migration_confirmed_signups_v1.sql. The app
--     counted profiles created in the window, which with "Confirm email" on
--     includes addresses typed in and never confirmed.
--   * A window is [p_from, p_to + 1) in UTC like every other analytics_*
--     function (the app dropped the last second of the last day for accounts,
--     checkouts and PMS connects, and the first second of the first day for
--     the first engine run).
--
-- Money. analytics_now returns each subscription's facts (plan, status,
-- interval, rooms, the code's discount), never a price: the price brackets are
-- lib/billing/tiers.ts, the same ones pushed to Stripe, and a second copy here
-- is how the two would drift. The app prices them. analytics_range only reads
-- hotel_metrics_daily, whose money the nightly snapshot priced with those
-- same brackets.
--
-- Test properties are left out unless p_include_test: hotels.is_test for the
-- live tables, the flag copied onto each snapshot row for the history, and
-- the "+" email convention for accounts, which have no hotel.
--
-- Who may call: analytics_now, analytics_range and analytics_owner_emails
-- check the caller the way every analytics_* function does (analytics_assert_reader: a platform admin
-- through the app, the service role, or a direct database session);
-- platform_count_users the way platform_list_users does. None of them can be
-- executed by anon.
--
-- Run AFTER 99_supabase_migration_definer_lockdown_v1.sql. Idempotent, one
-- transaction.

begin;

-- analytics_range looks up each hotel's last snapshot row before the window
-- and whether it ever paid before it; the primary key leads with day.
create index if not exists idx_hotel_metrics_daily_hotel_day
  on public.hotel_metrics_daily (hotel_id, day);

-- Dropped first so a changed signature can be re-run over an earlier copy;
-- every grant is restated below each function.
drop function if exists public.analytics_now(boolean);
drop function if exists public.analytics_range(date, date, boolean);
drop function if exists public.analytics_owner_emails(uuid[]);
drop function if exists public.platform_count_users(text);

-- ── Right now ───────────────────────────────────────────────────────────────
--
-- subs            every Stripe-plan subscription of a counted hotel, with its
--                 code's discount and whether the hotel is simulating (a
--                 hotel with no settings row counts as live, as the app did)
-- card_trouble    a subscription still served (trialing, active, past due)
--                 whose card failed its re-check, internal plans included
-- room_shortfall  billing fewer rooms than the property runs
-- sync_broken     a PMS connection in any state but connected
-- engine_silent   a Stripe plan still served with no engine run in 24 hours
--
-- Every list is in name order.

create function public.analytics_now(
  p_include_test boolean default false
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_out jsonb;
begin
  perform public.analytics_assert_reader();

  with scoped as (
    select h.id, h.name from public.hotels h where p_include_test or not h.is_test
  ),
  subs as (
    select s.hotel_id, h.name, s.status, s.billing_interval, s.billed_rooms, s.plan_kind,
           s.signup_code_id, s.card_verify_failed_at, s.room_shortfall_since
      from public.hotel_subscriptions s
      join scoped h on h.id = s.hotel_id
  ),
  stripe as (
    select s.hotel_id, s.name, s.status, s.billing_interval, s.billed_rooms,
           c.kind::text as code_kind, c.percent_off, c.amount_off_cents,
           coalesce(hs.simulation_mode, false) as simulating
      from subs s
      left join public.signup_codes c on c.id = s.signup_code_id
      left join public.hotel_settings hs on hs.hotel_id = s.hotel_id
     where s.plan_kind is distinct from 'internal'
  )
  select jsonb_build_object(
    'subs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'hotel_id', st.hotel_id,
               'status', st.status,
               'billing_interval', st.billing_interval,
               'billed_rooms', st.billed_rooms,
               'code_kind', st.code_kind,
               'percent_off', st.percent_off,
               'amount_off_cents', st.amount_off_cents,
               'simulating', st.simulating)
             order by st.name, st.hotel_id)
        from stripe st), '[]'::jsonb),
    'card_trouble', coalesce((
      select jsonb_agg(jsonb_build_object('hotel_id', s.hotel_id, 'name', s.name) order by s.name, s.hotel_id)
        from subs s
       where s.card_verify_failed_at is not null
         and s.status in ('trialing', 'active', 'past_due')), '[]'::jsonb),
    'room_shortfall', coalesce((
      select jsonb_agg(jsonb_build_object('hotel_id', s.hotel_id, 'name', s.name) order by s.name, s.hotel_id)
        from subs s
       where s.room_shortfall_since is not null), '[]'::jsonb),
    'sync_broken', coalesce((
      select jsonb_agg(jsonb_build_object(
               'hotel_id', pc.hotel_id, 'name', h.name,
               'pms_type', pc.pms_type::text, 'status', pc.status::text)
             order by h.name, pc.hotel_id, pc.pms_type::text)
        from public.pms_connections pc
        join scoped h on h.id = pc.hotel_id
       where pc.status::text is distinct from 'connected'), '[]'::jsonb),
    'engine_silent', coalesce((
      select jsonb_agg(jsonb_build_object('hotel_id', st.hotel_id, 'name', st.name) order by st.name, st.hotel_id)
        from stripe st
       where st.status in ('trialing', 'active', 'past_due')
         and not exists (
           select 1 from public.evaluation_run_log r
            where r.hotel_id = st.hotel_id
              and r.evaluated_at >= now() - interval '24 hours')), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;

revoke all on function public.analytics_now(boolean) from public, anon;
grant execute on function public.analytics_now(boolean) to authenticated, service_role;

-- ── A window ────────────────────────────────────────────────────────────────
--
-- series      one point per snapshot day in the window: paying (served and
--             past its trial) count and money, and trialing count
-- new_paying  a hotel's first paying day ever, in the window
-- won_back    paying again after a day that was not, having paid before
-- churned     a day not paying straight after a paying one
--
--             Judged on each hotel's consecutive snapshot days, including the
--             days before the window, so a long-standing customer's first day
--             inside it is not "new". The table's first day ever is a census
--             of who already existed, not a day everyone signed up, so nobody
--             is new or won back on it.
--
-- accounts    logins whose email address was confirmed in the window ("+"
--             addresses left out). Read from auth.users alone, so a login
--             counts on the day it was confirmed, profile row or not, and an
--             address never confirmed never counts.
-- paid        subscriptions created in the window
-- connected   PMS connected in the window (onboarding_states.connected_at)
-- finished    onboarding questions finished in the window
-- median_hours_to_live
--             median hours from PMS connect to the hotel's first engine run,
--             over hotels whose first run landed in the window (the price
--             table keeps no timestamps; the first run is when pricing began)
--
-- Event lists are in day, then name order.

create function public.analytics_range(
  p_from date,
  p_to date,
  p_include_test boolean default false
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz := (p_from::timestamp at time zone 'UTC');
  v_to timestamptz := ((p_to + 1)::timestamp at time zone 'UTC');
  v_census date;
  v_hours double precision[];
  v_n int;
  v_median double precision;
  v_out jsonb;
begin
  perform public.analytics_assert_reader();

  select min(d.day) into v_census
    from public.hotel_metrics_daily d
   where d.day <= p_to
     and (p_include_test or not d.is_test);

  -- First engine run per counted hotel that has connected, in hours after
  -- the connect, kept when the run landed in the window and not before the
  -- connect. Milliseconds first, as the app counted them.
  select array_agg(x.hours order by x.hours) into v_hours
    from (
      select (extract(epoch from (fr.first_run - o.connected_at)) * 1000)::double precision / 3600000 as hours
        from public.onboarding_states o
        join public.hotels h on h.id = o.hotel_id and (p_include_test or not h.is_test)
        cross join lateral (
          select min(r.evaluated_at) as first_run
            from public.evaluation_run_log r
           where r.hotel_id = o.hotel_id
        ) fr
       where o.connected_at is not null
         and fr.first_run >= v_from
         and fr.first_run < v_to
         and fr.first_run >= o.connected_at
    ) x;
  v_n := coalesce(array_length(v_hours, 1), 0);
  v_median := case
    when v_n = 0 then null
    when v_n % 2 = 1 then v_hours[(v_n + 1) / 2]
    else (v_hours[v_n / 2] + v_hours[v_n / 2 + 1]) / 2
  end;

  with scoped as (
    select h.id, h.name from public.hotels h where p_include_test or not h.is_test
  ),
  in_range as (
    select d.day, d.hotel_id, d.status, d.list_mrr_cents, d.net_mrr_cents,
           (d.entitled and d.status <> 'trialing') as paying
      from public.hotel_metrics_daily d
     where d.day >= p_from
       and d.day <= p_to
       and (p_include_test or not d.is_test)
  ),
  series as (
    select r.day,
           coalesce(sum(r.list_mrr_cents) filter (where r.paying), 0) as list_mrr_cents,
           coalesce(sum(r.net_mrr_cents) filter (where r.paying), 0) as net_mrr_cents,
           count(*) filter (where r.paying) as paying,
           count(*) filter (where r.status = 'trialing') as trialing
      from in_range r
     group by r.day
  ),
  -- Each hotel's standing on the eve of the window, worked out once per hotel
  -- (materialized, or the planner repeats the lookups for every row).
  before_window as materialized (
    select ih.hotel_id,
           (select d.entitled and d.status <> 'trialing'
              from public.hotel_metrics_daily d
             where d.hotel_id = ih.hotel_id
               and d.day < p_from
               and (p_include_test or not d.is_test)
             order by d.day desc
             limit 1) as last_paying,
           -- The hotel's first paying day before the window, walked from its
           -- oldest row on the (hotel_id, day) index, rather than an EXISTS
           -- the planner turns into a scan of the whole table.
           coalesce((
             select true
               from public.hotel_metrics_daily d
              where d.hotel_id = ih.hotel_id
                and d.day < p_from
                and (p_include_test or not d.is_test)
                and d.entitled
                and d.status <> 'trialing'
              order by d.day
              limit 1), false) as ever_paid
      from (select distinct r.hotel_id from in_range r) ih
  ),
  -- Each day against the one before it, and whether the hotel had paid on
  -- any day up to and including it.
  running as (
    select r.day, r.hotel_id, r.paying,
           lag(r.paying) over w as prev_in_window,
           bool_or(r.paying) over w as paid_through
      from in_range r
    window w as (partition by r.hotel_id order by r.day)
  ),
  steps as (
    select u.day, u.hotel_id, u.paying,
           coalesce(u.prev_in_window, b.last_paying, false) as prev_paying,
           b.ever_paid
             or coalesce(lag(u.paid_through) over (partition by u.hotel_id order by u.day), false) as ever_before
      from running u
      join before_window b on b.hotel_id = u.hotel_id
  ),
  events as (
    select s.day, s.hotel_id, coalesce(h.name, s.hotel_id::text) as name,
           case
             when s.paying and not s.prev_paying and s.day is distinct from v_census
               then case when s.ever_before then 'won_back' else 'new_paying' end
             when not s.paying and s.prev_paying
               then 'churned'
           end as kind
      from steps s
      left join scoped h on h.id = s.hotel_id
  )
  select jsonb_build_object(
    'series', coalesce((
      select jsonb_agg(jsonb_build_object(
               'day', se.day,
               'list_mrr_cents', se.list_mrr_cents,
               'net_mrr_cents', se.net_mrr_cents,
               'paying', se.paying,
               'trialing', se.trialing)
             order by se.day)
        from series se), '[]'::jsonb),
    'new_paying', coalesce((
      select jsonb_agg(jsonb_build_object('hotel_id', e.hotel_id, 'name', e.name, 'day', e.day) order by e.day, e.name, e.hotel_id)
        from events e where e.kind = 'new_paying'), '[]'::jsonb),
    'won_back', coalesce((
      select jsonb_agg(jsonb_build_object('hotel_id', e.hotel_id, 'name', e.name, 'day', e.day) order by e.day, e.name, e.hotel_id)
        from events e where e.kind = 'won_back'), '[]'::jsonb),
    'churned', coalesce((
      select jsonb_agg(jsonb_build_object('hotel_id', e.hotel_id, 'name', e.name, 'day', e.day) order by e.day, e.name, e.hotel_id)
        from events e where e.kind = 'churned'), '[]'::jsonb),
    'accounts', (
      select count(*)
        from auth.users u
       where u.email_confirmed_at >= v_from
         and u.email_confirmed_at < v_to
         and (p_include_test or strpos(coalesce(u.email::text, ''), '+') = 0)),
    'paid', (
      select count(*)
        from public.hotel_subscriptions s
        join scoped h on h.id = s.hotel_id
       where s.created_at >= v_from
         and s.created_at < v_to),
    'connected', (
      select count(*)
        from public.onboarding_states o
        join scoped h on h.id = o.hotel_id
       where o.connected_at >= v_from
         and o.connected_at < v_to),
    'finished', (
      select count(*)
        from public.onboarding_states o
        join scoped h on h.id = o.hotel_id
       where o.questions_completed_at >= v_from
         and o.questions_completed_at < v_to),
    'median_hours_to_live', v_median
  ) into v_out;

  return v_out;
end;
$$;

revoke all on function public.analytics_range(date, date, boolean) from public, anon;
grant execute on function public.analytics_range(date, date, boolean) to authenticated, service_role;

-- ── The follow-up list's emails ─────────────────────────────────────────────
--
-- The walked-away list names each property's owner by email. The app keeps
-- that list for a few minutes in Next's data cache, which every server shares
-- and which forgets on its own schedule, so it keeps it without the emails and
-- asks here for them on each load: one primary key lookup in auth.users per
-- owner on screen. An id with no login left answers nothing.

create function public.analytics_owner_emails(
  p_user_ids uuid[]
) returns table (user_id uuid, email text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.analytics_assert_reader();

  return query
    select u.id, u.email::text
      from auth.users u
     where u.id = any (p_user_ids)
       and u.email is not null;
end;
$$;

revoke all on function public.analytics_owner_emails(uuid[]) from public, anon;
grant execute on function public.analytics_owner_emails(uuid[]) to authenticated, service_role;

-- ── How many logins ─────────────────────────────────────────────────────────
--
-- The same people and the same search as platform_list_users, counted, so
-- the Users tile and the Users page's pages have a total past the first 100.

create function public.platform_count_users(
  p_search text default null
) returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return (
    select count(*)::int
      from auth.users u
      left join public.profiles p on p.id = u.id
     where p_search is null
        or u.email::text ilike '%' || p_search || '%'
        or coalesce(p.full_name, '') ilike '%' || p_search || '%'
  );
end;
$$;

revoke all on function public.platform_count_users(text) from public, anon;
grant execute on function public.platform_count_users(text) to authenticated, service_role;

commit;

-- The numbers the page shows, by hand (the SQL editor is a direct session):
--
--   select analytics_now(false);
--   select analytics_range(current_date - 29, current_date, false);
--   select * from analytics_owner_emails(array[]::uuid[]);
--   select platform_count_users();  -- needs a platform admin's session
