-- ============================================================================
-- MAYA: the #maya-signups feed, test-property signup codes, Pilot Health's
-- removed rates, and the calendar colours' RevPAR, v1
-- ============================================================================
--
-- Approved by Jake on 2026-09-30. Four small things, one file:
--
-- 1. Calendar colours (calendar_daily_revenue_v3). A day's colour ranks its
--    RevPAR against the property's other nights. It used every room type's
--    revenue (each booking's latest rate) over the physical rooms, while the
--    RevPAR a day shows counts only the room types that count as rooms (the
--    rate imported with each booking, else its latest rate, else 0) over the
--    rooms you can sell that night. v3 gives the colours the day's own
--    revenue: per stay date, the active room types that count as rooms only,
--    each booking at coalesce(base_rate, current_rate, 0), the same as the
--    day card (lib/calendar-store.ts, nightlyRoomAmount). Every date with a
--    booking is still listed (at 0 when none of its bookings counts), so the
--    calendar's navigable range is as before. The app divides by the rooms
--    you can sell each night (rooms out of service taken off), as the day
--    does, and falls back to v2 while this file has not run.
--
-- 2. Pilot Health (platform_pilot_health, v5). no_rate_count also counts the
--    room-nights whose rate the property system removed after MAYA sent to
--    them (base_rate_calendar.pms_removed_at, 99_supabase_migration_pms_rate_changes_v1.sql),
--    unless a price was typed after the removal, the way the engine reads
--    them (evaluate.ts): not priced and not sent. Restated whole from its
--    newest definition (99_supabase_migration_staff_roles_v1.sql) with only
--    that change; the staff roles access check is exactly as it was.
--
-- 3. Test-property signup codes. signup_codes.test_property: a property that
--    signs up with such a code is flagged hotels.is_test = true the moment
--    the code is bound to it, by either of the two places that happens:
--    the redemption row (signup_code_redemptions, written by the Stripe
--    webhook) and the subscription's code (hotel_subscriptions.signup_code_id,
--    from the subscription's metadata), whichever lands first. Each trigger
--    is named to fire before the product events trigger on its table, so
--    the subscription's own events are already test ones. Nothing un-flags
--    a property; the Command Center toggle still can.
--    And whatever flags or un-flags a property (the code, the toggle, a hand
--    edit), its product events and its daily snapshots (hotel_metrics_daily)
--    now follow in the same statement, so a property flagged today also
--    leaves last week's events and charts. Only platform admins create codes
--    (signup_codes is theirs alone under RLS, as before); nothing here lets a
--    developer or sales login read one.
--
-- 4. The #maya-signups Slack feed. An AFTER INSERT trigger on product_events
--    posts one short line for each real signup milestone: an account created
--    (email confirmed), a trial or payment started, a property connected,
--    gone live (the first time) and cancelled. Only events that are not test
--    (product_events.is_test is false: no test property, no + address, no
--    MAYA staff) and written by a trigger (never a backfill or the sweep).
--    Never for MAYA's internal plan. It posts through pg_net to the Slack
--    incoming webhook in Vault under the name maya_signups_webhook, the
--    same way pricing_watchdog posts to maya_alert_webhook. No secret, or
--    one that is not https://, posts nothing; nothing it does can fail the
--    insert (every error is a WARNING). One line per event row at most
--    (signup_feed_posts). Lines carry the property's name, its system and,
--    for billing lines, the rooms, monthly or yearly, the trial's days and a
--    cancellation's end date and reason; never an email, a guest or a card.
--    signup_feed_line(event) says what would be posted for any event, and
--    signup_feed_test() posts one test line (platform admins, the service
--    role).
--
-- Run after 99_supabase_migration_staff_roles_v1.sql. One transaction.
-- Idempotent: safe to run twice. The app reads every new column and function
-- when it is there and works as before when it is not, so deploy order does
-- not matter. pg_net must be enabled (it already is for the watchdog).
--
-- Then, in Supabase: Vault, add a secret named maya_signups_webhook holding
-- the #maya-signups incoming webhook address. Until it is there the feed is
-- silent.
-- ============================================================================

begin;

do $$
begin
  if to_regprocedure('public.staff_can_read(text)') is null
     or to_regclass('public.product_events') is null
     or to_regprocedure('public.product_event_emit(text, uuid, uuid, jsonb, text, timestamptz, text, text, text, text, boolean)') is null
     or to_regclass('public.signup_codes') is null
     or to_regclass('public.signup_code_redemptions') is null
     or to_regclass('public.hotel_metrics_daily') is null
     or to_regclass('public.room_type_out_of_service') is null
     or to_regprocedure('public.calendar_daily_revenue_v2(uuid, date, integer)') is null then
    raise exception 'Run every migration before 99_supabase_migration_signups_feed_v1.sql first';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'base_rate_calendar' and column_name = 'pms_removed_at'
  ) then
    raise exception 'Run 99_supabase_migration_pms_rate_changes_v1.sql first';
  end if;
end $$;

-- ── 1. The calendar colours' revenue ───────────────────────────────────────

-- Per stay date, the room revenue the day card counts for its RevPAR: the
-- active room types that count as rooms, each booking at the rate imported
-- with it, else its latest rate, else 0. Paged by date like v2.
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
         coalesce(sum(coalesce(r.base_rate, r.current_rate, 0)) filter (where rt.id is not null), 0)::numeric
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
  'coalesce(base_rate, current_rate, 0): what a calendar day divides by its sellable rooms for its RevPAR, '
  'which its colour ranks. Every date with a booking is listed. Paged by date (p_after, at most 1,000).';

revoke all on function public.calendar_daily_revenue_v3(uuid, date, int) from public, anon;
grant execute on function public.calendar_daily_revenue_v3(uuid, date, int) to authenticated, service_role;

-- ── 2. Pilot Health: nights whose rate was removed in the PMS ──────────────

-- Pilot Health (staff_roles_v1; v5 counts removed rates under no_rate_count,
-- otherwise unchanged).
create or replace function public.platform_pilot_health(
  p_include_test boolean default false
) returns table (
  hotel_id uuid,
  name text,
  timezone text,
  is_test boolean,
  -- 'live' when hotel_settings.simulation_mode is false, else 'simulation'
  -- (a missing settings row counts as simulation, as lib/admin/hotels.ts reads it).
  mode text,
  subscription_status text,
  pms_type public.pms_type,
  pms_status public.connection_status,
  -- Stamped at the end of a successful sync: the last successful read.
  last_sync_at timestamptz,
  down_since timestamptz,
  sync_failures int,
  -- hotel_pricing_state: the last tick that priced without an error, and
  -- where the daily pass has got to.
  last_ok_run_at timestamptz,
  pass_date date,
  pass_cursor date,
  pass_started_at timestamptz,
  pass_completed_at timestamptz,
  pass_horizon_days int,
  -- pricing_dirty_nights: nights waiting, and how long the oldest has waited.
  dirty_count int,
  dirty_oldest_marked_at timestamptz,
  -- rate_updates sent in the last 24 hours.
  sent_24h int,
  -- rate_push_incidents still open: the ones an owner may be told about,
  -- when the oldest opened, and MAYA's own holds (admin_only) counted apart.
  open_incidents int,
  open_incidents_since timestamptz,
  open_incidents_admin_only int,
  open_incident_causes text[],
  active_rules int,
  -- product_events in the last 24 hours that changed a rule: created,
  -- edited, enabled, disabled, deleted, undo ticked or unticked. Opening the
  -- editor or the activation popup, a preview, and the popup's choice are
  -- rule.* events too, and change nothing on their own.
  rule_changes_24h int,
  -- v2. Published prices of a Live hotel waiting over an hour with no sent
  -- record at that price, and since when the oldest has waited. v3 leaves
  -- out the nights of a type unticked as a room that no rule names.
  unsent_count int,
  unsent_since timestamptz,
  -- v2. Nights held until the hotel's own rates have been read, and since when.
  rate_read_waiting int,
  rate_read_waiting_since timestamptz,
  -- v4. Room-nights ahead with no rate on record from the property system
  -- and no typed price: not priced, not sent. And the last night the
  -- property system returned a rate for. v5 counts a rate removed in the
  -- property system too, unless a price was typed after the removal.
  no_rate_count int,
  rates_read_through date
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.staff_can_read('pilot_health') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
    select
      h.id,
      h.name,
      h.timezone,
      h.is_test,
      case when hs.simulation_mode = false then 'live' else 'simulation' end,
      s.status,
      pc.pms_type,
      pc.status,
      pc.last_sync_at,
      pc.down_since,
      pc.sync_failures,
      ps.last_ok_run_at,
      ps.pass_date,
      ps.pass_cursor,
      ps.pass_started_at,
      ps.pass_completed_at,
      ps.pass_horizon_days,
      dn.dirty_count,
      dn.oldest_marked_at,
      su.sent_24h,
      inc.open_incidents,
      inc.open_since,
      inc.open_admin_only,
      inc.causes,
      pr.active_rules,
      pe.rule_changes_24h,
      un.unsent_count,
      un.unsent_since,
      rr.rate_read_waiting,
      rr.rate_read_waiting_since,
      nr.no_rate_count,
      pc.base_rates_returned_through
    from public.hotels h
    left join public.hotel_settings hs on hs.hotel_id = h.id
    left join public.hotel_subscriptions s on s.hotel_id = h.id
    left join lateral (
      select c.pms_type, c.status, c.last_sync_at, c.down_since, c.sync_failures, c.base_rates_returned_through
        from public.pms_connections c
       where c.hotel_id = h.id
       order by (c.status = 'connected') desc, c.updated_at desc, c.created_at desc
       limit 1
    ) pc on true
    left join public.hotel_pricing_state ps on ps.hotel_id = h.id
    left join lateral (
      select count(*)::int as dirty_count, min(d.first_marked_at) as oldest_marked_at
        from public.pricing_dirty_nights d
       where d.hotel_id = h.id
    ) dn on true
    left join lateral (
      select count(*)::int as sent_24h
        from public.rate_updates ru
       where ru.hotel_id = h.id
         and ru.status = 'sent'
         and ru.pushed_at >= now() - interval '24 hours'
    ) su on true
    left join lateral (
      select count(*) filter (where not i.admin_only)::int as open_incidents,
             min(i.opened_at) filter (where not i.admin_only) as open_since,
             count(*) filter (where i.admin_only)::int as open_admin_only,
             coalesce(array_agg(i.cause order by i.opened_at) filter (where not i.admin_only), '{}'::text[]) as causes
        from public.rate_push_incidents i
       where i.hotel_id = h.id
         and i.resolved_at is null
    ) inc on true
    left join lateral (
      select count(*)::int as active_rules
        from public.pricing_rules r
       where r.hotel_id = h.id
         and r.is_active
    ) pr on true
    left join lateral (
      select count(*)::int as rule_changes_24h
        from public.product_events e
       where e.hotel_id = h.id
         and e.event in ('rule.created', 'rule.edited', 'rule.enabled', 'rule.disabled',
                         'rule.deleted', 'rule.undo_ticked', 'rule.undo_unticked')
         and e.occurred_at >= now() - interval '24 hours'
    ) pe on true
    left join lateral (
      select count(*)::int as unsent_count,
             min(greatest(pp.computed_at, coalesce(hs.live_since, pp.computed_at))) as unsent_since
        from public.published_price pp
        join public.room_types rt
          on rt.id = pp.room_type_id
         and rt.is_active
        left join public.rate_updates ru
          on ru.hotel_id = pp.hotel_id
         and ru.room_type_id = pp.room_type_id
         and ru.stay_date = pp.stay_date
       where pp.hotel_id = h.id
         and hs.simulation_mode = false
         and pc.pms_type in ('cloudbeds', 'think')
         and pp.price > 0
         and pp.stay_date > (now() at time zone 'utc')::date
         and pp.stay_date < (now() at time zone 'utc')::date + (coalesce(ps.pass_horizon_days, 396) - 1)
         and greatest(pp.computed_at, coalesce(hs.live_since, pp.computed_at)) < now() - interval '1 hour'
         and (ru.id is null or ru.status <> 'sent' or ru.price is distinct from pp.price)
         -- v3. A type unticked as a room that no rule names is held on
         -- purpose (guardrail:not_a_room, rate-push.ts): the PMS keeps its
         -- own rate for it, and nothing is waiting.
         and (ru.id is null or ru.status <> 'skipped' or ru.error is distinct from 'guardrail:not_a_room')
         -- v4. A night the property system has no rate on record for is
         -- held on purpose too (guardrail:no_rate_on_record), and counted
         -- under no_rate_count instead.
         and (ru.id is null or ru.status <> 'skipped' or ru.error is distinct from 'guardrail:no_rate_on_record')
    ) un on true
    left join lateral (
      select count(*)::int as rate_read_waiting,
             min(c.first_attempt_at) as rate_read_waiting_since
        from public.rate_push_incident_cells c
        join public.rate_push_incidents i on i.id = c.incident_id
       where c.hotel_id = h.id
         and c.state = 'open'
         and i.resolved_at is null
         and i.cause = 'awaiting_rate_read'
    ) rr on true
    left join lateral (
      select count(*)::int as no_rate_count
        from generate_series(
               ((now() at time zone 'utc')::date + 1)::timestamp,
               ((now() at time zone 'utc')::date + (coalesce(ps.pass_horizon_days, 396) - 2))::timestamp,
               interval '1 day'
             ) as g(d)
        cross join public.room_types rt
        left join public.base_rate_calendar brc
          on brc.hotel_id = h.id
         and brc.room_type_id = rt.id
         and brc.stay_date = g.d::date
        left join public.manual_price mp
          on mp.hotel_id = h.id
         and mp.room_type_id = rt.id
         and mp.stay_date = g.d::date
         and mp.cleared_at is null
       where pc.pms_type in ('cloudbeds', 'think')
         and rt.hotel_id = h.id
         and rt.is_active
         and rt.counts_as_room is distinct from false
         -- v5. A typed price stands, unless the property system removed the
         -- night's rate after it was typed (evaluate.ts, removedInPmsAt).
         and (mp.stay_date is null
              or (brc.pms_removed_at is not null and mp.set_at <= brc.pms_removed_at))
         and (brc.stay_date is null
              -- v5. A rate the property system removed after MAYA sent to
              -- the night (pms_rate_changes_v1) is no rate on record.
              or brc.pms_removed_at is not null
              or (pc.base_rates_returned_through is not null and g.d::date > pc.base_rates_returned_through))
    ) nr on true
    where h.is_active
      and h.setup_pending_at is null
      and h.data_purged_at is null
      and (p_include_test or not h.is_test)
      and (s.hotel_id is null or s.status in ('trialing', 'active', 'past_due'))
    order by h.name;
end;
$$;

comment on function public.platform_pilot_health(boolean) is
  'One row per active, entitled property with where its connection, pricing, '
  'sending and rules stand right now, published prices that have waited over '
  'an hour to be sent included (nights of a type unticked as a room that no '
  'rule names, and nights the property system has no rate on record for, are '
  'not waiting), and the room-nights ahead with no rate on record (a rate removed '
  'in the property system included). Read by '
  '/admin/pilot-health. Platform admins, staff at aal2 with the pilot_health '
  'section, and the service role.';

revoke all on function public.platform_pilot_health(boolean) from public, anon;
grant execute on function public.platform_pilot_health(boolean) to authenticated, service_role;


-- ── 3. Test-property signup codes ──────────────────────────────────────────

alter table public.signup_codes
  add column if not exists test_property boolean not null default false;

comment on column public.signup_codes.test_property is
  'A property that signs up with this code is flagged hotels.is_test (left out of analytics) as soon as the '
  'code is bound to it: its redemption row or its subscription''s signup_code_id. Set by a platform admin '
  'when the code is created.';

-- Flags the property a test-property code was just bound to. Called by the
-- two triggers below; never raises (a warning instead): a Stripe webhook's
-- write must not fail over analytics.
create or replace function public.signup_code_flag_test_property()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code uuid;
begin
  begin
    if tg_table_name = 'signup_code_redemptions' then
      v_code := new.code_id;
    else
      if tg_op = 'UPDATE' and new.signup_code_id is not distinct from old.signup_code_id then
        return null;
      end if;
      v_code := new.signup_code_id;
    end if;
    if v_code is null or new.hotel_id is null then
      return null;
    end if;
    if exists (select 1 from public.signup_codes c where c.id = v_code and c.test_property) then
      update public.hotels set is_test = true where id = new.hotel_id and not is_test;
    end if;
  exception when others then
    raise warning 'signup_code_flag_test_property: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

revoke all on function public.signup_code_flag_test_property() from public, anon, authenticated;

-- Named to sort before trg_product_events_code_redemptions and
-- trg_product_events_subscriptions: triggers on one table fire in name
-- order, so the events those write already see the property as a test one.
drop trigger if exists trg_code_test_property on public.signup_code_redemptions;
create trigger trg_code_test_property
  after insert on public.signup_code_redemptions
  for each row execute function public.signup_code_flag_test_property();

drop trigger if exists trg_hotel_subscriptions_code_test_property on public.hotel_subscriptions;
create trigger trg_hotel_subscriptions_code_test_property
  after insert or update of signup_code_id on public.hotel_subscriptions
  for each row execute function public.signup_code_flag_test_property();

-- A property's events and daily snapshots follow its flag, both ways,
-- whoever changes it. Events inside a property always followed its live
-- flag in analytics; now the copy on each row does too, and stays right
-- after the property is gone.
create or replace function public.hotels_test_flag_follows()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    update public.product_events
       set is_test = new.is_test
     where hotel_id = new.id
       and is_test is distinct from new.is_test;
    update public.hotel_metrics_daily
       set is_test = new.is_test
     where hotel_id = new.id
       and is_test is distinct from new.is_test;
  exception when others then
    raise warning 'hotels_test_flag_follows: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

revoke all on function public.hotels_test_flag_follows() from public, anon, authenticated;

drop trigger if exists trg_hotels_test_flag_follows on public.hotels;
create trigger trg_hotels_test_flag_follows
  after update of is_test on public.hotels
  for each row
  when (old.is_test is distinct from new.is_test)
  execute function public.hotels_test_flag_follows();

-- ── 4. The #maya-signups feed ──────────────────────────────────────────────

-- One row per product event posted, so no event is posted twice. Written
-- only by the feed's trigger; the service role may read it.
create table if not exists public.signup_feed_posts (
  event_id   bigint primary key,
  event      text not null,
  hotel_id   uuid,
  posted_at  timestamptz not null default now(),
  -- pg_net's request id: net._http_response says what Slack answered.
  request_id bigint
);

comment on table public.signup_feed_posts is
  'Product events posted to #maya-signups (signup_feed_post), one row each, so none is posted twice. '
  'request_id is pg_net''s (net._http_response). Service role reads; only the trigger writes.';

alter table public.signup_feed_posts enable row level security;
revoke all on public.signup_feed_posts from public, anon, authenticated, service_role;
grant select on public.signup_feed_posts to service_role;

-- The channel: the #maya-signups webhook from Vault, or null. Vault missing
-- or unreadable is the same as no secret. Nobody signed in can call it.
create or replace function public.signup_feed_webhook()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_url text;
begin
  begin
    select s.decrypted_secret into v_url
      from vault.decrypted_secrets s
     where s.name = 'maya_signups_webhook'
     order by s.created_at desc nulls last
     limit 1;
  exception when others then
    v_url := null;
  end;
  return nullif(btrim(coalesce(v_url, '')), '');
end;
$$;

revoke all on function public.signup_feed_webhook() from public, anon, authenticated, service_role;

-- Slack reads <, > and & as markup; a property's name is shown as typed.
create or replace function public.signup_feed_escape(p_text text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select replace(replace(replace(p_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
$$;

revoke all on function public.signup_feed_escape(text) from public, anon, authenticated;
grant execute on function public.signup_feed_escape(text) to service_role;

-- The line #maya-signups gets for this event, or null when it gets none:
--
--   account.created               New account: email confirmed.
--                                 New account: joined Harbour Inn.  (an
--                                 invitation to a property, accepted)
--   subscription.trialing         Harbour Inn (Cloudbeds) started a 14-day trial: 24 rooms, monthly.
--   subscription.active           Harbour Inn (Cloudbeds) started paying: 24 rooms, monthly.
--                                 ... moved from the trial to paying: ...
--                                 (not a return from past_due, unpaid or paused)
--   pms.connected                 Harbour Inn connected Cloudbeds.
--   property.went_live            Harbour Inn (Cloudbeds) went live.  (first time only)
--   subscription.cancel_scheduled Harbour Inn (Cloudbeds) cancelled. Ends Oct 30, 2026. Reason: too expensive.
--   subscription.canceled         Harbour Inn (Cloudbeds) cancelled.  (only when no
--                                 cancel_scheduled line came first for it; "during
--                                 the trial" when it was trialing)
--
-- A property still on checkout's placeholder name reads "A new signup".
-- Nothing for a test event, MAYA's internal plan, or any other event. Plain
-- SQL, so the owner can preview lines: select public.signup_feed_line(e)
-- from public.product_events e order by e.id desc limit 20;
create or replace function public.signup_feed_line(p_event public.product_events)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_props jsonb := coalesce(p_event.properties, '{}'::jsonb);
  v_from text := v_props->>'from_status';
  v_live_name text;
  v_name text;
  v_pms_type text;
  v_pms text;
  v_who text;
  v_rooms int;
  v_plan text;
  v_days int;
  v_why text;
  v_ends text;
  v_joined text;
begin
  if p_event.is_test then
    return null;
  end if;
  if p_event.event like 'subscription.%' and v_props->>'plan_kind' = 'internal' then
    return null;
  end if;

  if p_event.event = 'account.created' then
    -- An invitation accepted: the person already belongs to a property. Only
    -- to test properties: not a customer, nothing to say.
    select h.name into v_joined
      from public.hotel_memberships hm
      join public.hotels h on h.id = hm.hotel_id
     where hm.user_id = p_event.user_id
       and hm.status = 'active'
       and not h.is_test
     order by hm.created_at
     limit 1;
    if v_joined is null and exists (
      select 1 from public.hotel_memberships hm
        join public.hotels h on h.id = hm.hotel_id
       where hm.user_id = p_event.user_id and hm.status = 'active' and h.is_test
    ) then
      return null;
    end if;
    if v_joined is null or v_joined like 'Pending setup %' then
      return 'New account: email confirmed.';
    end if;
    return 'New account: joined ' || public.signup_feed_escape(v_joined) || '.';
  end if;

  if p_event.hotel_id is not null then
    select h.name into v_live_name from public.hotels h where h.id = p_event.hotel_id;
  end if;
  v_name := case
    when v_live_name is not null and v_live_name not like 'Pending setup %' then v_live_name
    when p_event.property_name is not null and p_event.property_name not like 'Pending setup %' then p_event.property_name
  end;
  v_pms_type := coalesce(
    p_event.pms_type,
    (select c.pms_type::text from public.pms_connections c
      where c.hotel_id = p_event.hotel_id order by c.updated_at desc limit 1)
  );
  v_pms := case v_pms_type
    when 'cloudbeds' then 'Cloudbeds'
    when 'think' then 'ThinkReservations'
    when 'mews' then 'Mews'
  end;
  v_who := coalesce(public.signup_feed_escape(v_name), 'A new signup')
        || case when v_pms is not null then ' (' || v_pms || ')' else '' end;

  v_rooms := nullif(v_props->>'billed_rooms', '')::int;
  v_plan := concat_ws(', ',
    case when v_rooms is not null then v_rooms || case when v_rooms = 1 then ' room' else ' rooms' end end,
    case v_props->>'billing_interval' when 'month' then 'monthly' when 'year' then 'yearly' end
  );
  v_plan := case when v_plan = '' then '' else ': ' || v_plan end;

  v_why := case
    when v_props->>'cancellation_reason' = 'payment_failed' then 'payment failed'
    when v_props->>'cancellation_reason' = 'payment_disputed' then 'payment disputed'
    else case v_props->>'cancellation_feedback'
      when 'too_expensive' then 'too expensive'
      when 'missing_features' then 'missing features'
      when 'switched_service' then 'switched to another service'
      when 'unused' then 'not using it'
      when 'customer_service' then 'customer service'
      when 'too_complex' then 'too complex'
      when 'low_quality' then 'quality'
      when 'other' then 'other'
    end
  end;
  v_why := case when v_why is null then '' else ' Reason: ' || v_why || '.' end;

  case p_event.event
    when 'subscription.trialing' then
      v_days := round(extract(epoch from ((v_props->>'trial_end')::timestamptz - p_event.occurred_at)) / 86400)::int;
      return v_who || ' started a '
          || case when v_days is not null and v_days > 0 then v_days || '-day ' else '' end
          || 'trial' || v_plan || '.';

    when 'subscription.active' then
      if v_from in ('active', 'past_due', 'unpaid', 'paused') then
        return null;
      end if;
      if v_from = 'trialing' then
        return v_who || ' moved from the trial to paying' || v_plan || '.';
      end if;
      return v_who || ' started paying' || v_plan || '.';

    when 'pms.connected' then
      return coalesce(public.signup_feed_escape(v_name), 'A new signup')
          || ' connected ' || coalesce(v_pms, 'a property system') || '.';

    when 'property.went_live' then
      if (v_props->>'first_time') = 'false' then
        return null;
      end if;
      return v_who || ' went live.';

    when 'subscription.cancel_scheduled' then
      v_ends := case when v_props->>'current_period_end' is not null
        then ' Ends ' || to_char((v_props->>'current_period_end')::timestamptz at time zone 'UTC', 'Mon FMDD, YYYY') || '.'
        else '' end;
      return v_who || ' cancelled.' || v_ends || v_why;

    when 'subscription.canceled' then
      -- Said already when the cancellation was scheduled, unless they took it
      -- back or subscribed again since.
      if exists (
        select 1
          from public.product_events s
         where s.hotel_id = p_event.hotel_id
           and s.event = 'subscription.cancel_scheduled'
           and s.id < p_event.id
           and not s.is_test
           and not exists (
             select 1 from public.product_events w
              where w.hotel_id = p_event.hotel_id
                and w.event in ('subscription.cancel_withdrawn', 'subscription.created')
                and w.id > s.id
                and w.id < p_event.id
           )
      ) then
        return null;
      end if;
      return v_who || ' cancelled' || case when v_from = 'trialing' then ' during the trial' else '' end || '.' || v_why;

    else
      return null;
  end case;
end;
$$;

comment on function public.signup_feed_line(public.product_events) is
  'The line #maya-signups gets for a product event, or null: a real account, trial, payment, connection, '
  'first go-live or cancellation. Never an email, a guest or a card. See signup_feed_post.';

revoke all on function public.signup_feed_line(public.product_events) from public, anon, authenticated;
grant execute on function public.signup_feed_line(public.product_events) to service_role;

-- The trigger: the line, through pg_net, once per event row. Never fails the
-- insert. pg_net queues the request with the transaction, so a write that
-- rolls back posts nothing.
create or replace function public.signup_feed_post()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_url text;
  v_text text;
  v_request bigint;
begin
  begin
    v_url := public.signup_feed_webhook();
    if v_url is null or v_url not like 'https://%' then
      return null;
    end if;
    v_text := public.signup_feed_line(new);
    if v_text is null then
      return null;
    end if;
    insert into public.signup_feed_posts (event_id, event, hotel_id)
    values (new.id, new.event, new.hotel_id)
    on conflict (event_id) do nothing;
    if not found then
      return null;
    end if;
    select net.http_post(
      url := v_url,
      body := jsonb_build_object('text', v_text),
      headers := '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds := 8000
    ) into v_request;
    update public.signup_feed_posts set request_id = v_request where event_id = new.id;
  exception when others then
    raise warning 'signup_feed_post(%): % [%]', new.event, sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

revoke all on function public.signup_feed_post() from public, anon, authenticated;

drop trigger if exists trg_signup_feed on public.product_events;
create trigger trg_signup_feed
  after insert on public.product_events
  for each row
  when (
    not new.is_test
    and new.source = 'trigger'
    and new.event in ('account.created', 'subscription.trialing', 'subscription.active', 'pms.connected',
                      'property.went_live', 'subscription.cancel_scheduled', 'subscription.canceled')
  )
  execute function public.signup_feed_post();

-- One test line to #maya-signups, so someone can see the feed arrive. A
-- platform admin (any sign-in) or the service role. Answers whether it was
-- queued: state ready (sent), missing (no maya_signups_webhook in Vault),
-- not_https, or post_failed (pg_net refused it).
create or replace function public.signup_feed_test()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_url text;
  v_state text;
  v_request bigint;
  v_by text;
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.is_platform_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  v_url := public.signup_feed_webhook();
  v_state := case
    when v_url is null then 'missing'
    when v_url not like 'https://%' then 'not_https'
    else 'ready'
  end;
  if v_state <> 'ready' then
    return jsonb_build_object('sent', false, 'state', v_state);
  end if;

  select u.email into v_by from auth.users u where u.id = auth.uid();
  begin
    select net.http_post(
      url := v_url,
      body := jsonb_build_object('text',
        'Test line from the Command Center' || coalesce(', sent by ' || public.signup_feed_escape(v_by), '')
        || '. Real signups post here.'),
      headers := '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds := 8000
    ) into v_request;
  exception when others then
    return jsonb_build_object('sent', false, 'state', 'post_failed', 'error', sqlerrm);
  end;
  return jsonb_build_object('sent', true, 'state', 'ready', 'request_id', v_request);
end;
$$;

comment on function public.signup_feed_test() is
  'Posts one test line to #maya-signups (maya_signups_webhook in Vault) through pg_net. Platform admins and '
  'the service role. Returns {sent, state: ready|missing|not_https|post_failed}.';

revoke all on function public.signup_feed_test() from public, anon;
grant execute on function public.signup_feed_test() to authenticated, service_role;

commit;
