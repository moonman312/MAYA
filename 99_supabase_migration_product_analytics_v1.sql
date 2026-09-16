-- ============================================================================
-- PRODUCT ANALYTICS — the questions, answered from product_events
-- ============================================================================
--
-- Read-only SECURITY DEFINER functions over product_events (and, for what is
-- true right now, the live tables). Definitions of every metric are in
-- maya-rms/docs/analytics.md; the comments here only say why a query is shaped
-- the way it is.
--
-- Every function takes the same window, p_from and p_to as inclusive UTC days,
-- matching /admin/analytics, and p_include_test, off by default: sandbox, e2e
-- and walkthrough properties are not customers. A property's live is_test flag
-- wins while the hotel exists; the flag copied onto the event is the fallback
-- once it does not.
--
-- Who may call: platform admins through the app, the service role, and a
-- direct database session (the SQL editor, psql). The last one is how an
-- operator answers a question at a prompt, and anyone with a direct session
-- already has the data. Only requests through the API gateway are checked.
--
-- Run AFTER 99_supabase_migration_product_events_v1.sql. Idempotent.

begin;

-- Dropped first so a changed column list can be re-run over an earlier copy;
-- every grant is restated below each function.
drop function if exists public.analytics_walked_away_summary(date, date, boolean);
drop function if exists public.analytics_walked_away(date, date, boolean);
drop function if exists public.analytics_funnel(date, date, boolean);
drop function if exists public.analytics_time_to_value(date, date, boolean);
drop function if exists public.analytics_trial_conversion(date, date, boolean);
drop function if exists public.analytics_retention(date, date, boolean);
drop function if exists public.analytics_cancellations(date, date, boolean);
drop function if exists public.analytics_acquisition(date, date, boolean);
drop function if exists public.analytics_event_counts(date, date, boolean);
drop function if exists public.analytics_pms_health(date, date, boolean);
drop function if exists public.analytics_groups(date, date, boolean);
drop function if exists public.analytics_book(boolean);

create or replace function public.analytics_assert_reader()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.is_platform_admin()
     and session_user = 'authenticator' then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.analytics_assert_reader() from public, anon;
grant execute on function public.analytics_assert_reader() to authenticated, service_role;

-- ── Connected and walked away ───────────────────────────────────────────────
--
-- The cohort is every PMS property whose FIRST Marketplace connect falls in
-- the window, followed to wherever it has got to now. Followed by PMS
-- property rather than hotel row, because the sweep deletes an unclaimed hotel
-- and a later reconnect makes a new one: that is the same property coming
-- back, not a new arrival.
--
-- Each property lands in exactly one outcome, judged at its furthest stage:
--
--   connected_never_claimed    ticket expired, never redeemed
--   claimed_never_checkout     claimed, never sent to Stripe, quiet for 48h
--                              (includes "Not now"; see deferred)
--   checkout_never_subscribed  sent to Stripe, no subscription, 24h on (a
--                              Checkout session's own lifetime), or a
--                              subscription that never completed
--   trialed_never_paid         trial ended canceled, unpaid or paused, a
--                              cancellation scheduled, or the app
--                              uninstalled, without ever paying
--   paid_then_left             paid at least once, then canceled, unpaid,
--                              paused, cancellation scheduled, or disconnected
--                              and not reconnected
--   in_flight                  not yet any of the above
--   converted                  paying now
--
-- A stage an owner reached is reached even when the instrumentation for it
-- arrived later: a property with a subscription started checkout, whether or
-- not its checkout_started event exists.

create or replace function public.analytics_walked_away(
  p_from date,
  p_to date,
  p_include_test boolean default false
) returns table (
  property_key text,
  hotel_id uuid,
  -- False once the claim sweep has removed the parked hotel.
  hotel_exists boolean,
  property_name text,
  pms_type text,
  pms_property_id text,
  connected_at timestamptz,
  connects int,
  furthest_stage text,
  outcome text,
  walked_away_stage text,
  deferred boolean,
  subscription_status text,
  group_key text,
  group_size int,
  owner_user_id uuid,
  owner_email text,
  last_activity_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz := (p_from::timestamp at time zone 'UTC');
  v_to timestamptz := ((p_to + 1)::timestamp at time zone 'UTC');
begin
  perform public.analytics_assert_reader();

  return query
  with ev as (
    select e.*,
           coalesce(e.pms_type || ':' || e.pms_property_id, e.hotel_id::text) as pkey
      from public.product_events e
      left join public.hotels h on h.id = e.hotel_id
     where (p_include_test or not coalesce(h.is_test, e.is_test))
       and (e.hotel_id is not null or e.pms_property_id is not null)
  ),
  cohort as (
    select ev.pkey, min(ev.occurred_at) as connected_at, count(*)::int as connects
      from ev
     where ev.event = 'marketplace.connected'
     group by ev.pkey
    having min(ev.occurred_at) >= v_from and min(ev.occurred_at) < v_to
  ),
  facts as (
    select
      c.pkey, c.connected_at, c.connects,
      (array_agg(ev.hotel_id order by ev.occurred_at desc) filter (where ev.hotel_id is not null))[1] as hotel_id,
      (array_agg(ev.property_name order by ev.occurred_at desc) filter (where ev.property_name is not null))[1] as property_name,
      (array_agg(ev.pms_type order by ev.occurred_at desc) filter (where ev.pms_type is not null))[1] as pms_type,
      (array_agg(ev.pms_property_id order by ev.occurred_at desc) filter (where ev.pms_property_id is not null))[1] as pms_property_id,
      max((ev.properties->>'expires_at')::timestamptz) filter (where ev.event = 'marketplace.connected') as ticket_expires_at,
      (array_agg(ev.properties->>'group_key' order by ev.occurred_at desc)
         filter (where ev.event = 'marketplace.connected' and ev.properties ? 'group_key'))[1] as group_key,
      max((ev.properties->>'group_size')::int) filter (where ev.event = 'marketplace.connected') as group_size,
      min(ev.occurred_at) filter (where ev.event = 'marketplace.claim_redeemed') as claimed_at,
      (array_agg(ev.user_id order by ev.occurred_at desc) filter (where ev.event = 'marketplace.claim_redeemed'))[1] as owner_user_id,
      max(ev.occurred_at) filter (where ev.event = 'billing.checkout_started') as checkout_at,
      min(ev.occurred_at) filter (where ev.event = 'subscription.created') as subscribed_at,
      bool_or(ev.event = 'subscription.trialing') as trialed,
      min(ev.occurred_at) filter (where ev.event = 'subscription.active') as paid_at,
      (array_agg(substr(ev.event, 14) order by ev.occurred_at desc, ev.id desc)
         filter (where ev.event like 'subscription.%'
                   and ev.event not in ('subscription.created', 'subscription.plan_changed',
                                        'subscription.cancel_scheduled', 'subscription.cancel_withdrawn')))[1] as sub_status,
      (array_agg(ev.event order by ev.occurred_at desc, ev.id desc)
         filter (where ev.event in ('subscription.cancel_scheduled', 'subscription.cancel_withdrawn',
                                    'subscription.created')))[1] = 'subscription.cancel_scheduled' as cancel_scheduled,
      (array_agg(ev.event order by ev.occurred_at desc, ev.id desc)
         filter (where ev.event in ('pms.connected', 'pms.reconnected', 'pms.disconnected')))[1] = 'pms.disconnected' as disconnected,
      coalesce((array_agg(ev.event order by ev.occurred_at desc, ev.id desc)
         filter (where ev.event in ('marketplace.deferred', 'marketplace.resumed')))[1] = 'marketplace.deferred', false) as deferred,
      max(ev.occurred_at) as last_activity_at
    from cohort c
    join ev on ev.pkey = c.pkey
    group by c.pkey, c.connected_at, c.connects
  ),
  judged as (
    select f.*,
      case
        when f.paid_at is not null then 'paying'
        when f.subscribed_at is not null and f.trialed then 'trialing'
        when f.subscribed_at is not null then 'subscribed'
        when f.checkout_at is not null then 'checkout_started'
        when f.claimed_at is not null then 'claimed'
        else 'connected'
      end as furthest,
      f.sub_status in ('canceled', 'unpaid', 'paused', 'incomplete_expired') as sub_ended
    from facts f
  )
  select
    j.pkey, j.hotel_id, exists (select 1 from public.hotels hx where hx.id = j.hotel_id),
    j.property_name, j.pms_type, j.pms_property_id,
    j.connected_at, j.connects, j.furthest,
    case when w.stage is not null then 'walked_away'
         when j.furthest = 'paying' then 'converted'
         else 'in_flight' end,
    w.stage,
    j.deferred,
    j.sub_status,
    j.group_key,
    j.group_size,
    j.owner_user_id,
    u.email::text,
    j.last_activity_at
  from judged j
  cross join lateral (
    select case
      when j.furthest = 'paying' then
        case when j.sub_ended or coalesce(j.cancel_scheduled, false) or coalesce(j.disconnected, false)
             then 'paid_then_left' end
      when j.furthest = 'trialing' then
        case when j.sub_ended or coalesce(j.cancel_scheduled, false) or coalesce(j.disconnected, false)
             then 'trialed_never_paid' end
      when j.furthest = 'subscribed' then
        case when j.sub_ended then 'checkout_never_subscribed' end
      when j.furthest = 'checkout_started' then
        case when j.checkout_at < now() - interval '24 hours' and j.last_activity_at < now() - interval '24 hours'
             then 'checkout_never_subscribed' end
      when j.furthest = 'claimed' then
        case when j.last_activity_at < now() - interval '48 hours' then 'claimed_never_checkout' end
      else
        case when j.ticket_expires_at < now() then 'connected_never_claimed' end
    end as stage
  ) w
  left join auth.users u on u.id = j.owner_user_id
  order by j.connected_at desc;
end;
$$;

revoke all on function public.analytics_walked_away(date, date, boolean) from public, anon;
grant execute on function public.analytics_walked_away(date, date, boolean) to authenticated, service_role;

-- The same cohort as counts: one row per outcome and per walked-away stage,
-- always all of them, in funnel order, so an empty stage reads 0 rather than
-- going missing.
create or replace function public.analytics_walked_away_summary(
  p_from date,
  p_to date,
  p_include_test boolean default false
) returns table (
  sort int,
  stage text,
  properties int,
  deferred int,
  in_groups int
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.analytics_assert_reader();

  return query
  with rows as (
    select * from public.analytics_walked_away(p_from, p_to, p_include_test)
  ),
  stages(sort, stage) as (
    values (0, 'connected'), (1, 'walked_away'),
           (2, 'connected_never_claimed'), (3, 'claimed_never_checkout'),
           (4, 'checkout_never_subscribed'), (5, 'trialed_never_paid'), (6, 'paid_then_left'),
           (7, 'in_flight'), (8, 'converted')
  )
  select s.sort, s.stage,
         count(r.property_key)::int,
         count(r.property_key) filter (where r.deferred)::int,
         count(r.property_key) filter (where r.group_key is not null)::int
    from stages s
    left join rows r on s.stage = 'connected'
                     or r.outcome = s.stage
                     or r.walked_away_stage = s.stage
   group by s.sort, s.stage
   order by s.sort;
end;
$$;

revoke all on function public.analytics_walked_away_summary(date, date, boolean) from public, anon;
grant execute on function public.analytics_walked_away_summary(date, date, boolean) to authenticated, service_role;

-- ── Funnels ─────────────────────────────────────────────────────────────────
--
-- Two front doors, two funnels. Marketplace follows PMS properties whose first
-- connect is in the window; direct follows accounts created in the window
-- that never claimed a Marketplace property. Both follow the cohort to where
-- it is now, and each stage counts only those that reached it AND every stage
-- before it, so the bars always narrow.

create or replace function public.analytics_funnel(
  p_from date,
  p_to date,
  p_include_test boolean default false
) returns table (
  path text,
  step int,
  stage text,
  entered int,
  pct_of_previous numeric,
  pct_of_first numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz := (p_from::timestamp at time zone 'UTC');
  v_to timestamptz := ((p_to + 1)::timestamp at time zone 'UTC');
begin
  perform public.analytics_assert_reader();

  return query
  with ev as (
    select e.*
      from public.product_events e
      left join public.hotels h on h.id = e.hotel_id
     where p_include_test or not coalesce(h.is_test, e.is_test)
  ),
  -- Marketplace: stages by property.
  mp_props as (
    select coalesce(ev.pms_type || ':' || ev.pms_property_id, ev.hotel_id::text) as pkey
      from ev
     where ev.event = 'marketplace.connected'
     group by 1
    having min(ev.occurred_at) >= v_from and min(ev.occurred_at) < v_to
  ),
  mp as (
    select p.pkey,
           bool_or(ev.event = 'marketplace.claim_redeemed') as claimed,
           bool_or(ev.event = 'billing.checkout_started') as checkout,
           bool_or(ev.event = 'subscription.created' and coalesce(ev.properties->>'plan_kind', 'stripe') = 'stripe') as subscribed,
           bool_or(ev.event = 'import.completed') as imported,
           bool_or(ev.event = 'property.went_live') as live,
           bool_or(ev.event = 'subscription.active' and coalesce(ev.properties->>'plan_kind', 'stripe') = 'stripe') as paying
      from mp_props p
      join ev on coalesce(ev.pms_type || ':' || ev.pms_property_id, ev.hotel_id::text) = p.pkey
     group by p.pkey
  ),
  mp_steps as (
    select 'marketplace'::text as path, s.step, s.stage, s.entered
      from (
        select 1 as step, 'connected' as stage, count(*) as entered from mp
        union all select 2, 'claimed', count(*) filter (where claimed or checkout or subscribed) from mp
        union all select 3, 'started_checkout', count(*) filter (where (claimed or checkout or subscribed) and (checkout or subscribed)) from mp
        union all select 4, 'subscribed', count(*) filter (where subscribed) from mp
        union all select 5, 'history_imported', count(*) filter (where subscribed and imported) from mp
        union all select 6, 'went_live', count(*) filter (where subscribed and imported and live) from mp
        union all select 7, 'paying', count(*) filter (where subscribed and imported and live and paying) from mp
      ) s
  ),
  -- Direct: stages by account, then by the properties that account subscribed.
  accounts as (
    select ev.user_id
      from ev
     where ev.event = 'account.created'
       and ev.occurred_at >= v_from and ev.occurred_at < v_to
       and not exists (select 1 from ev c where c.event = 'marketplace.claim_redeemed' and c.user_id = ev.user_id)
     group by ev.user_id
  ),
  owned as (
    select distinct a.user_id, ev.hotel_id
      from accounts a
      join ev on ev.event = 'subscription.created' and ev.user_id = a.user_id
               and coalesce(ev.properties->>'plan_kind', 'stripe') = 'stripe'
  ),
  dr as (
    select a.user_id,
           bool_or(ev.event = 'billing.subscribe_viewed') as viewed,
           bool_or(ev.event = 'billing.checkout_started') as checkout,
           exists (select 1 from owned o where o.user_id = a.user_id) as subscribed,
           exists (select 1 from owned o join ev x on x.hotel_id = o.hotel_id
                    where o.user_id = a.user_id and x.event in ('pms.connected', 'import.started')) as connected,
           exists (select 1 from owned o join ev x on x.hotel_id = o.hotel_id
                    where o.user_id = a.user_id and x.event = 'import.completed') as imported,
           exists (select 1 from owned o join ev x on x.hotel_id = o.hotel_id
                    where o.user_id = a.user_id and x.event = 'property.went_live') as live,
           exists (select 1 from owned o join ev x on x.hotel_id = o.hotel_id
                    where o.user_id = a.user_id and x.event = 'subscription.active'
                      and coalesce(x.properties->>'plan_kind', 'stripe') = 'stripe') as paying
      from accounts a
      left join ev on ev.user_id = a.user_id and ev.event in ('billing.subscribe_viewed', 'billing.checkout_started')
     group by a.user_id
  ),
  dr_steps as (
    select 'direct'::text as path, s.step, s.stage, s.entered
      from (
        select 1 as step, 'account_created' as stage, count(*) as entered from dr
        union all select 2, 'saw_pricing', count(*) filter (where viewed or checkout or subscribed) from dr
        union all select 3, 'started_checkout', count(*) filter (where checkout or subscribed) from dr
        union all select 4, 'subscribed', count(*) filter (where subscribed) from dr
        union all select 5, 'pms_connected', count(*) filter (where subscribed and connected) from dr
        union all select 6, 'history_imported', count(*) filter (where subscribed and connected and imported) from dr
        union all select 7, 'went_live', count(*) filter (where subscribed and connected and imported and live) from dr
        union all select 8, 'paying', count(*) filter (where subscribed and connected and imported and live and paying) from dr
      ) s
  ),
  steps as (
    select * from mp_steps union all select * from dr_steps
  )
  select s.path, s.step, s.stage, s.entered::int,
         case when lag(s.entered) over w > 0
              then round(100.0 * s.entered / lag(s.entered) over w, 1) end,
         case when first_value(s.entered) over w > 0
              then round(100.0 * s.entered / first_value(s.entered) over w, 1) end
    from steps s
  window w as (partition by s.path order by s.step)
   order by s.path desc, s.step;
end;
$$;

revoke all on function public.analytics_funnel(date, date, boolean) from public, anon;
grant execute on function public.analytics_funnel(date, date, boolean) to authenticated, service_role;

-- ── Time to value ───────────────────────────────────────────────────────────
--
-- Each step is measured per property from the first time it did the earlier
-- thing to the first time it did the later one, and counted in the window the
-- later one landed in: "how long did this week's go-lives take".

create or replace function public.analytics_time_to_value(
  p_from date,
  p_to date,
  p_include_test boolean default false
) returns table (
  sort int,
  step text,
  properties int,
  median_hours numeric,
  p75_hours numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz := (p_from::timestamp at time zone 'UTC');
  v_to timestamptz := ((p_to + 1)::timestamp at time zone 'UTC');
begin
  perform public.analytics_assert_reader();

  return query
  with ev as (
    select e.*
      from public.product_events e
      left join public.hotels h on h.id = e.hotel_id
     where e.hotel_id is not null
       and (p_include_test or not coalesce(h.is_test, e.is_test))
  ),
  firsts as (
    select ev.hotel_id,
           min(ev.occurred_at) filter (where ev.event = 'marketplace.connected') as connected,
           min(ev.occurred_at) filter (where ev.event = 'marketplace.claim_redeemed') as claimed,
           min(ev.occurred_at) filter (where ev.event = 'subscription.created'
                                         and coalesce(ev.properties->>'plan_kind', 'stripe') = 'stripe') as subscribed,
           min(ev.occurred_at) filter (where ev.event = 'pms.connected') as pms_connected,
           min(ev.occurred_at) filter (where ev.event = 'import.completed') as imported,
           min(ev.occurred_at) filter (where ev.event = 'property.went_live') as live
      from ev
     group by ev.hotel_id
  ),
  pairs as (
    select 1 as sort, 'connect_to_claim' as step, f.connected as a, f.claimed as b from firsts f
    union all select 2, 'claim_to_subscribe', f.claimed, f.subscribed from firsts f
    union all select 3, 'subscribe_to_pms_connected', f.subscribed, f.pms_connected from firsts f
      where f.connected is null
    union all select 4, 'subscribe_to_import_complete', f.subscribed, f.imported from firsts f
    union all select 5, 'import_to_live', f.imported, f.live from firsts f
    union all select 6, 'connect_to_live', f.connected, f.live from firsts f
    union all select 7, 'subscribe_to_live', f.subscribed, f.live from firsts f
  ),
  measured as (
    select p.sort, p.step, extract(epoch from (p.b - p.a)) / 3600.0 as hours
      from pairs p
     where p.a is not null and p.b is not null and p.b >= p.a
       and p.b >= v_from and p.b < v_to
  ),
  steps(sort, step) as (
    values (1, 'connect_to_claim'), (2, 'claim_to_subscribe'), (3, 'subscribe_to_pms_connected'),
           (4, 'subscribe_to_import_complete'), (5, 'import_to_live'), (6, 'connect_to_live'),
           (7, 'subscribe_to_live')
  )
  select s.sort, s.step, count(m.hours)::int,
         round((percentile_cont(0.5) within group (order by m.hours))::numeric, 1),
         round((percentile_cont(0.75) within group (order by m.hours))::numeric, 1)
    from steps s
    left join measured m on m.sort = s.sort
   group by s.sort, s.step
   order by s.sort;
end;
$$;

revoke all on function public.analytics_time_to_value(date, date, boolean) from public, anon;
grant execute on function public.analytics_time_to_value(date, date, boolean) to authenticated, service_role;

-- ── Trials ──────────────────────────────────────────────────────────────────
--
-- Trials whose end date fell in the window, by where they came from. The end
-- date is the one on the subscription when it started trialing; a trial that
-- is still running is not in anyone's denominator yet.

create or replace function public.analytics_trial_conversion(
  p_from date,
  p_to date,
  p_include_test boolean default false
) returns table (
  segment text,
  trials_ended int,
  converted int,
  lost int,
  undecided int,
  conversion_pct numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz := (p_from::timestamp at time zone 'UTC');
  v_to timestamptz := least(((p_to + 1)::timestamp at time zone 'UTC'), now());
begin
  perform public.analytics_assert_reader();

  return query
  with ev as (
    select e.*
      from public.product_events e
      left join public.hotels h on h.id = e.hotel_id
     where e.hotel_id is not null
       and (p_include_test or not coalesce(h.is_test, e.is_test))
  ),
  trials as (
    select ev.hotel_id,
           min(ev.occurred_at) as trial_started,
           max((ev.properties->>'trial_end')::timestamptz) as trial_end
      from ev
     where ev.event = 'subscription.trialing'
       and coalesce(ev.properties->>'plan_kind', 'stripe') = 'stripe'
     group by ev.hotel_id
  ),
  judged as (
    select t.hotel_id,
           case when exists (select 1 from ev m where m.hotel_id = t.hotel_id and m.event like 'marketplace.%')
                then 'marketplace' else 'direct' end as segment,
           exists (select 1 from ev a where a.hotel_id = t.hotel_id and a.event = 'subscription.active'
                     and a.occurred_at >= t.trial_started) as converted,
           (select substr(s.event, 14) from ev s
             where s.hotel_id = t.hotel_id and s.event like 'subscription.%'
               and s.event not in ('subscription.created', 'subscription.plan_changed',
                                   'subscription.cancel_scheduled', 'subscription.cancel_withdrawn')
             order by s.occurred_at desc, s.id desc limit 1) as status_now
      from trials t
     where t.trial_end >= v_from and t.trial_end < v_to
  ),
  segments(segment) as (values ('all'), ('marketplace'), ('direct'))
  select s.segment,
         count(j.hotel_id)::int,
         count(j.hotel_id) filter (where j.converted)::int,
         count(j.hotel_id) filter (where not j.converted
                                     and j.status_now in ('canceled', 'unpaid', 'paused', 'incomplete_expired'))::int,
         count(j.hotel_id) filter (where not j.converted
                                     and j.status_now not in ('canceled', 'unpaid', 'paused', 'incomplete_expired'))::int,
         case when count(j.hotel_id) > 0
              then round(100.0 * count(j.hotel_id) filter (where j.converted) / count(j.hotel_id), 1) end
    from segments s
    left join judged j on s.segment = 'all' or j.segment = s.segment
   group by s.segment
   order by case s.segment when 'all' then 0 when 'marketplace' then 1 else 2 end;
end;
$$;

revoke all on function public.analytics_trial_conversion(date, date, boolean) from public, anon;
grant execute on function public.analytics_trial_conversion(date, date, boolean) to authenticated, service_role;

-- ── Retention: paying base, churn, win-backs, disconnects ───────────────────
--
-- "Paying" is a Stripe plan whose latest status is active or past_due. A trial
-- collects nothing and an internal plan is ours, so neither is in the base.

create or replace function public.analytics_retention(
  p_from date,
  p_to date,
  p_include_test boolean default false
) returns table (
  paying_at_start int,
  new_paying int,
  won_back int,
  churned int,
  paying_at_end int,
  churn_pct numeric,
  cancel_scheduled int,
  cancel_withdrawn int,
  disconnected int,
  reconnected int,
  still_disconnected int,
  rooms_churned int
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz := (p_from::timestamp at time zone 'UTC');
  v_to timestamptz := ((p_to + 1)::timestamp at time zone 'UTC');
begin
  perform public.analytics_assert_reader();

  return query
  with ev as (
    select e.*
      from public.product_events e
      left join public.hotels h on h.id = e.hotel_id
     where e.hotel_id is not null
       and (p_include_test or not coalesce(h.is_test, e.is_test))
  ),
  statuses as (
    select ev.hotel_id, ev.occurred_at, ev.id, substr(ev.event, 14) as status,
           (ev.properties->>'billed_rooms')::int as rooms
      from ev
     where ev.event like 'subscription.%'
       and ev.event not in ('subscription.created', 'subscription.plan_changed',
                            'subscription.cancel_scheduled', 'subscription.cancel_withdrawn')
       and coalesce(ev.properties->>'plan_kind', 'stripe') = 'stripe'
  ),
  at_start as (
    select distinct on (s.hotel_id) s.hotel_id, s.status in ('active', 'past_due') as paying
      from statuses s where s.occurred_at < v_from
     order by s.hotel_id, s.occurred_at desc, s.id desc
  ),
  at_end as (
    select distinct on (s.hotel_id) s.hotel_id, s.status in ('active', 'past_due') as paying
      from statuses s where s.occurred_at < v_to
     order by s.hotel_id, s.occurred_at desc, s.id desc
  ),
  moves as (
    select s.*,
           lag(s.status) over (partition by s.hotel_id order by s.occurred_at, s.id) as prev,
           bool_or(s.status = 'active') over (partition by s.hotel_id order by s.occurred_at, s.id
                                              rows between unbounded preceding and 1 preceding) as paid_before,
           bool_or(s.status in ('canceled', 'unpaid', 'paused')) over (
             partition by s.hotel_id order by s.occurred_at, s.id
             rows between unbounded preceding and 1 preceding) as lost_before
      from statuses s
  ),
  in_range as (
    select * from moves m where m.occurred_at >= v_from and m.occurred_at < v_to
  ),
  pms as (
    select ev.hotel_id, ev.event, ev.occurred_at, ev.id from ev
     where ev.event in ('pms.connected', 'pms.reconnected', 'pms.disconnected')
  ),
  disc as (
    select distinct on (d.hotel_id) d.hotel_id, d.occurred_at as last_disconnect, d.id as last_id
      from pms d
     where d.event = 'pms.disconnected' and d.occurred_at >= v_from and d.occurred_at < v_to
     order by d.hotel_id, d.occurred_at desc, d.id desc
  ),
  churned as (
    select distinct r.hotel_id, r.rooms
      from in_range r
     where r.status in ('canceled', 'unpaid', 'paused') and r.prev in ('active', 'past_due')
  )
  select
    (select count(*) from at_start where paying)::int,
    (select count(distinct r.hotel_id) from in_range r
      where r.status = 'active' and not coalesce(r.paid_before, false))::int,
    (select count(distinct r.hotel_id) from in_range r
      where r.status = 'active' and coalesce(r.paid_before, false) and coalesce(r.lost_before, false)
        and r.prev in ('canceled', 'unpaid', 'paused'))::int,
    (select count(distinct c.hotel_id) from churned c)::int,
    (select count(*) from at_end where paying)::int,
    -- Of the base the window started with, not of everyone who came and went
    -- inside it: a property that signed up and left within the window is in
    -- churned, but it was never in the denominator.
    case when (select count(*) from at_start where paying) > 0 then
      round(100.0 * (select count(distinct c.hotel_id) from churned c
                      join at_start s on s.hotel_id = c.hotel_id and s.paying)
            / (select count(*) from at_start where paying), 1) end,
    (select count(distinct ev.hotel_id) from ev
      where ev.event = 'subscription.cancel_scheduled' and ev.occurred_at >= v_from and ev.occurred_at < v_to)::int,
    (select count(distinct ev.hotel_id) from ev
      where ev.event = 'subscription.cancel_withdrawn' and ev.occurred_at >= v_from and ev.occurred_at < v_to)::int,
    (select count(*) from disc)::int,
    (select count(distinct p.hotel_id) from pms p
      where p.event = 'pms.reconnected' and p.occurred_at >= v_from and p.occurred_at < v_to)::int,
    (select count(*) from disc d
      where not exists (select 1 from pms p where p.hotel_id = d.hotel_id
                          and p.event in ('pms.reconnected', 'pms.connected')
                          and (p.occurred_at, p.id) > (d.last_disconnect, d.last_id)))::int,
    (select coalesce(sum(c.rooms), 0) from churned c)::int;
end;
$$;

revoke all on function public.analytics_retention(date, date, boolean) from public, anon;
grant execute on function public.analytics_retention(date, date, boolean) to authenticated, service_role;

-- ── Why they cancel ─────────────────────────────────────────────────────────

create or replace function public.analytics_cancellations(
  p_from date,
  p_to date,
  p_include_test boolean default false
) returns table (
  kind text,
  was_paying boolean,
  reason text,
  feedback text,
  properties int,
  billed_rooms int
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz := (p_from::timestamp at time zone 'UTC');
  v_to timestamptz := ((p_to + 1)::timestamp at time zone 'UTC');
begin
  perform public.analytics_assert_reader();

  return query
  with ev as (
    select e.*
      from public.product_events e
      left join public.hotels h on h.id = e.hotel_id
     where e.hotel_id is not null
       and (p_include_test or not coalesce(h.is_test, e.is_test))
  ),
  hits as (
    select distinct on (ev.hotel_id, ev.event)
           substr(ev.event, 14) as kind,
           exists (select 1 from ev a where a.hotel_id = ev.hotel_id and a.event = 'subscription.active'
                     and a.occurred_at <= ev.occurred_at) as was_paying,
           coalesce(ev.properties->>'cancellation_reason', 'not_given') as reason,
           coalesce(ev.properties->>'cancellation_feedback', 'not_given') as feedback,
           ev.hotel_id,
           (ev.properties->>'billed_rooms')::int as rooms
      from ev
     where ev.event in ('subscription.cancel_scheduled', 'subscription.canceled', 'subscription.unpaid',
                        'subscription.paused')
       and coalesce(ev.properties->>'plan_kind', 'stripe') = 'stripe'
       and ev.occurred_at >= v_from and ev.occurred_at < v_to
     order by ev.hotel_id, ev.event, ev.occurred_at desc
  )
  select h.kind, h.was_paying, h.reason, h.feedback, count(*)::int, coalesce(sum(h.rooms), 0)::int
    from hits h
   group by h.kind, h.was_paying, h.reason, h.feedback
   order by count(*) desc, h.kind;
end;
$$;

revoke all on function public.analytics_cancellations(date, date, boolean) from public, anon;
grant execute on function public.analytics_cancellations(date, date, boolean) to authenticated, service_role;

-- ── Where subscriptions came from ───────────────────────────────────────────

create or replace function public.analytics_acquisition(
  p_from date,
  p_to date,
  p_include_test boolean default false
) returns table (
  channel text,
  code text,
  subscriptions int,
  trialing_now int,
  paying_now int,
  lost_now int,
  billed_rooms int
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz := (p_from::timestamp at time zone 'UTC');
  v_to timestamptz := ((p_to + 1)::timestamp at time zone 'UTC');
begin
  perform public.analytics_assert_reader();

  return query
  with ev as (
    select e.*
      from public.product_events e
      left join public.hotels h on h.id = e.hotel_id
     where e.hotel_id is not null
       and (p_include_test or not coalesce(h.is_test, e.is_test))
  ),
  subs as (
    select distinct on (ev.hotel_id)
           ev.hotel_id,
           ev.properties->>'signup_code_id' as code_id,
           (ev.properties->>'billed_rooms')::int as rooms
      from ev
     where ev.event = 'subscription.created'
       and coalesce(ev.properties->>'plan_kind', 'stripe') = 'stripe'
       and ev.occurred_at >= v_from and ev.occurred_at < v_to
     order by ev.hotel_id, ev.occurred_at
  ),
  judged as (
    select s.*,
           case when exists (select 1 from ev m where m.hotel_id = s.hotel_id and m.event like 'marketplace.%')
                then 'marketplace' else 'direct' end as channel,
           coalesce(sc.code,
                    (select r.properties->>'code' from ev r
                      where r.hotel_id = s.hotel_id and r.event = 'signup_code.redeemed'
                      order by r.occurred_at desc limit 1),
                    case when s.code_id is not null then 'deleted code' end,
                    '(no code)') as code,
           (select substr(x.event, 14) from ev x
             where x.hotel_id = s.hotel_id and x.event like 'subscription.%'
               and x.event not in ('subscription.created', 'subscription.plan_changed',
                                   'subscription.cancel_scheduled', 'subscription.cancel_withdrawn')
             order by x.occurred_at desc, x.id desc limit 1) as status_now
      from subs s
      left join public.signup_codes sc on sc.id::text = s.code_id
  )
  select j.channel, j.code, count(*)::int,
         count(*) filter (where j.status_now = 'trialing')::int,
         count(*) filter (where j.status_now in ('active', 'past_due'))::int,
         count(*) filter (where j.status_now in ('canceled', 'unpaid', 'paused', 'incomplete_expired'))::int,
         coalesce(sum(j.rooms), 0)::int
    from judged j
   group by j.channel, j.code
   order by count(*) desc, j.channel, j.code;
end;
$$;

revoke all on function public.analytics_acquisition(date, date, boolean) from public, anon;
grant execute on function public.analytics_acquisition(date, date, boolean) to authenticated, service_role;

-- ── Every event, counted ────────────────────────────────────────────────────
--
-- The long tail (rules, manual prices, the simulator, the change log, team,
-- imports, PMS health) is one grouping with a detail column that splits the
-- families where the split is the question: rules by origin, tabs by name,
-- failed imports by kind of failure, and so on.

create or replace function public.analytics_event_counts(
  p_from date,
  p_to date,
  p_include_test boolean default false
) returns table (
  event text,
  detail text,
  occurrences int,
  properties int,
  users int,
  quantity bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz := (p_from::timestamp at time zone 'UTC');
  v_to timestamptz := ((p_to + 1)::timestamp at time zone 'UTC');
begin
  perform public.analytics_assert_reader();

  -- Each event also gets a row with detail '(all)': distinct properties do
  -- not add up across details, so the total has to be counted, not summed.
  return query
  select x.event,
         case when grouping(x.detail) = 1 then '(all)' else x.detail end,
         count(*)::int,
         count(distinct x.hotel_id)::int,
         count(distinct x.user_id)::int,
         sum(x.quantity)::bigint
    from (
      select e.event, e.hotel_id, e.user_id,
             case
               when e.event like 'rule.%' then e.properties->>'origin'
               when e.event = 'dashboard.tab_opened' then e.properties->>'tab'
               when e.event = 'onboarding.path_chosen' then e.properties->>'path'
               when e.event = 'import.failed' then e.properties->>'error_kind'
               when e.event like 'import.%' then e.properties->>'kind'
               when e.event = 'room_type.classified' then
                 case when (e.properties->>'counts_as_room')::boolean then 'room' else 'not_a_room' end
               when e.event = 'team.member_joined' and (e.properties->>'first_member')::boolean then 'first_member'
               when e.event like 'team.%' then e.properties->>'role'
               when e.event = 'signup_code.redeemed' then e.properties->>'code'
               when e.event = 'property.activated' then e.properties->>'via'
               when e.event like 'subscription.%' then e.properties->>'plan_kind'
             end as detail,
             case
               when e.event like 'manual_price.%' then (e.properties->>'nights')::bigint
               when e.event = 'room_type.out_of_service_added' then (e.properties->>'units')::bigint
               when e.event = 'import.completed' then (e.properties->>'rows_upserted')::bigint
             end as quantity
        from public.product_events e
        left join public.hotels h on h.id = e.hotel_id
       where e.occurred_at >= v_from and e.occurred_at < v_to
         and (p_include_test or not coalesce(h.is_test, e.is_test))
    ) x
   group by grouping sets ((x.event, x.detail), (x.event))
   order by 1, 2;
end;
$$;

revoke all on function public.analytics_event_counts(date, date, boolean) from public, anon;
grant execute on function public.analytics_event_counts(date, date, boolean) to authenticated, service_role;

-- ── Imports and PMS health ──────────────────────────────────────────────────
--
-- Rates from the events, plus request-level failure from pms_request_log,
-- which only keeps seven days: that part covers the window's overlap with the
-- last week and says how many days it saw.

create or replace function public.analytics_pms_health(
  p_from date,
  p_to date,
  p_include_test boolean default false
) returns table (
  metric text,
  occurrences int,
  properties int,
  rate_pct numeric,
  median_minutes numeric,
  median_rows numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz := (p_from::timestamp at time zone 'UTC');
  v_to timestamptz := ((p_to + 1)::timestamp at time zone 'UTC');
  v_log_from timestamptz := greatest((p_from::timestamp at time zone 'UTC'), now() - interval '7 days');
begin
  perform public.analytics_assert_reader();

  return query
  with ev as (
    select e.*
      from public.product_events e
      left join public.hotels h on h.id = e.hotel_id
     where e.hotel_id is not null
       and e.occurred_at >= v_from and e.occurred_at < v_to
       and (p_include_test or not coalesce(h.is_test, e.is_test))
  ),
  imports as (
    select
      count(*) filter (where ev.event = 'import.started') as started,
      count(*) filter (where ev.event = 'import.completed') as completed,
      count(*) filter (where ev.event = 'import.failed') as failed,
      count(distinct ev.hotel_id) filter (where ev.event = 'import.failed') as failed_props,
      count(distinct ev.hotel_id) filter (where ev.event = 'import.completed') as completed_props,
      count(distinct ev.hotel_id) filter (where ev.event = 'import.started') as started_props,
      percentile_cont(0.5) within group (order by (ev.properties->>'duration_seconds')::numeric)
        filter (where ev.event = 'import.completed') / 60.0 as med_minutes,
      percentile_cont(0.5) within group (order by (ev.properties->>'rows_upserted')::numeric)
        filter (where ev.event = 'import.completed') as med_rows
    from ev
  ),
  logs as (
    select count(*) as requests,
           count(*) filter (where not l.ok) as failures,
           count(distinct l.hotel_id) as props
      from public.pms_request_log l
      left join public.hotels h on h.id = l.hotel_id
     where l.created_at >= v_log_from and l.created_at < v_to
       and (p_include_test or not coalesce(h.is_test, false))
  )
  select 'import.started', i.started::int, i.started_props::int, null::numeric, null::numeric, null::numeric from imports i
  union all
  select 'import.completed', i.completed::int, i.completed_props::int, null,
         round(i.med_minutes::numeric, 1), round(i.med_rows::numeric, 0) from imports i
  union all
  select 'import.failed', i.failed::int, i.failed_props::int,
         case when i.completed + i.failed > 0 then round(100.0 * i.failed / (i.completed + i.failed), 1) end,
         null, null from imports i
  union all
  select 'import.failed:' || coalesce(ev.properties->>'error_kind', 'other'), count(*)::int,
         count(distinct ev.hotel_id)::int, null, null, null
    from ev where ev.event = 'import.failed' group by ev.properties->>'error_kind'
  union all
  select m.event, count(ev.id)::int, count(distinct ev.hotel_id)::int, null, null, null
    from (values ('pms.connected'), ('pms.reconnected'), ('pms.disconnected'),
                 ('pms.degraded'), ('pms.error'), ('pms.recovered')) as m(event)
    left join ev on ev.event = m.event
   group by m.event
  union all
  select 'sync.requests_last_' || greatest(1, round(extract(epoch from (least(v_to, now()) - v_log_from)) / 86400))::int || 'd',
         l.requests::int, l.props::int,
         case when l.requests > 0 then round(100.0 * l.failures / l.requests, 2) end, null, null
    from logs l
   where v_log_from < v_to;
end;
$$;

revoke all on function public.analytics_pms_health(date, date, boolean) from public, anon;
grant execute on function public.analytics_pms_health(date, date, boolean) to authenticated, service_role;

-- ── Groups and "Not now" ────────────────────────────────────────────────────

create or replace function public.analytics_groups(
  p_from date,
  p_to date,
  p_include_test boolean default false
) returns table (
  group_key text,
  first_property_name text,
  group_size int,
  connected_at timestamptz,
  properties_connected int,
  claimed int,
  subscribed int,
  deferred_now int,
  expired_unclaimed int
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz := (p_from::timestamp at time zone 'UTC');
  v_to timestamptz := ((p_to + 1)::timestamp at time zone 'UTC');
begin
  perform public.analytics_assert_reader();

  return query
  with ev as (
    select e.*, coalesce(e.pms_type || ':' || e.pms_property_id, e.hotel_id::text) as pkey
      from public.product_events e
      left join public.hotels h on h.id = e.hotel_id
     where (p_include_test or not coalesce(h.is_test, e.is_test))
  ),
  members as (
    select ev.properties->>'group_key' as gkey, ev.pkey,
           min(ev.occurred_at) as connected_at,
           max((ev.properties->>'group_size')::int) as gsize,
           (array_agg(ev.property_name order by ev.occurred_at) filter (where ev.property_name is not null))[1] as pname,
           max((ev.properties->>'expires_at')::timestamptz) as expires_at
      from ev
     where ev.event = 'marketplace.connected' and ev.properties ? 'group_key'
     group by 1, 2
  ),
  bundles as (
    select m.gkey from members m group by m.gkey
    having min(m.connected_at) >= v_from and min(m.connected_at) < v_to
  ),
  per_prop as (
    select m.gkey, m.pkey, m.connected_at, m.gsize, m.pname, m.expires_at,
           bool_or(ev.event = 'marketplace.claim_redeemed') as claimed,
           bool_or(ev.event = 'subscription.created') as subscribed,
           coalesce((array_agg(ev.event order by ev.occurred_at desc)
             filter (where ev.event in ('marketplace.deferred', 'marketplace.resumed')))[1] = 'marketplace.deferred', false) as deferred
      from members m
      join bundles b on b.gkey = m.gkey
      left join ev on ev.pkey = m.pkey
     group by m.gkey, m.pkey, m.connected_at, m.gsize, m.pname, m.expires_at
  )
  select p.gkey,
         (array_agg(p.pname order by p.connected_at, p.pname))[1],
         max(p.gsize)::int,
         min(p.connected_at),
         count(*)::int,
         count(*) filter (where p.claimed)::int,
         count(*) filter (where p.subscribed)::int,
         count(*) filter (where p.deferred)::int,
         count(*) filter (where not p.claimed and p.expires_at < now())::int
    from per_prop p
   group by p.gkey
   order by min(p.connected_at) desc;
end;
$$;

revoke all on function public.analytics_groups(date, date, boolean) from public, anon;
grant execute on function public.analytics_groups(date, date, boolean) to authenticated, service_role;

-- ── Right now ───────────────────────────────────────────────────────────────
--
-- The book as it stands, from the live tables. Money comes from the newest
-- hotel_metrics_daily snapshot rather than being re-derived here: the price
-- brackets live in lib/billing/tiers.ts and are pushed to Stripe from there,
-- and a second copy in SQL is how the two would drift. So this is list and
-- net MRR as the snapshot computed them (month-equivalent, code discounts
-- netted off), not cash collected; Stripe's invoices are the only record of
-- that and are not mirrored here.

create or replace function public.analytics_book(
  p_include_test boolean default false
) returns table (
  active_properties int,
  paying int,
  trialing int,
  past_due int,
  internal_plans int,
  live int,
  simulating int,
  billed_rooms_paying int,
  billed_rooms_trialing int,
  measured_rooms_active int,
  awaiting_claim int,
  expired_awaiting_sweep int,
  deferred int,
  mrr_snapshot_day date,
  list_mrr_cents bigint,
  net_mrr_cents bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_day date;
begin
  perform public.analytics_assert_reader();

  select max(d.day) into v_day from public.hotel_metrics_daily d;

  return query
  with scoped as (
    select h.* from public.hotels h where p_include_test or not h.is_test
  ),
  subs as (
    select s.* from public.hotel_subscriptions s join scoped h on h.id = s.hotel_id
  ),
  entitled as (
    select s.hotel_id from subs s
     where s.plan_kind = 'stripe' and s.status in ('trialing', 'active', 'past_due')
  )
  select
    (select count(*) from scoped where is_active)::int,
    (select count(*) from subs where plan_kind = 'stripe' and status in ('active', 'past_due'))::int,
    (select count(*) from subs where plan_kind = 'stripe' and status = 'trialing')::int,
    (select count(*) from subs where plan_kind = 'stripe' and status = 'past_due')::int,
    (select count(*) from subs where plan_kind = 'internal')::int,
    (select count(*) from entitled e join public.hotel_settings hs on hs.hotel_id = e.hotel_id
      where hs.simulation_mode = false)::int,
    (select count(*) from entitled e left join public.hotel_settings hs on hs.hotel_id = e.hotel_id
      where coalesce(hs.simulation_mode, true))::int,
    (select coalesce(sum(billed_rooms), 0) from subs
      where plan_kind = 'stripe' and status in ('active', 'past_due'))::int,
    (select coalesce(sum(billed_rooms), 0) from subs where plan_kind = 'stripe' and status = 'trialing')::int,
    (select coalesce(sum(rt.total_rooms), 0) from public.room_types rt join scoped h on h.id = rt.hotel_id
      where h.is_active and rt.is_active and rt.counts_as_room is distinct from false)::int,
    (select count(*) from public.pms_marketplace_claims mc join scoped h on h.id = mc.hotel_id
      where mc.claimed_at is null and mc.expires_at >= now())::int,
    (select count(*) from public.pms_marketplace_claims mc join scoped h on h.id = mc.hotel_id
      where mc.claimed_at is null and mc.expires_at < now())::int,
    (select count(*) from scoped where setup_deferred_at is not null)::int,
    v_day,
    (select sum(d.list_mrr_cents) from public.hotel_metrics_daily d
      where d.day = v_day and (p_include_test or not d.is_test)),
    (select sum(d.net_mrr_cents) from public.hotel_metrics_daily d
      where d.day = v_day and (p_include_test or not d.is_test));
end;
$$;

revoke all on function public.analytics_book(boolean) from public, anon;
grant execute on function public.analytics_book(boolean) to authenticated, service_role;

commit;

-- How many connected and walked away this week (Monday to today, UTC):
--
--   select stage, properties, deferred
--     from analytics_walked_away_summary(date_trunc('week', now())::date, current_date);
--
-- Who, so someone can follow up:
--
--   select property_name, pms_type, connected_at, furthest_stage, walked_away_stage,
--          owner_email, last_activity_at
--     from analytics_walked_away(date_trunc('week', now())::date, current_date)
--    where outcome = 'walked_away';
