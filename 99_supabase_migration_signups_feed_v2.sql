-- ============================================================================
-- MAYA: the #maya-signups feed, v2
-- ============================================================================
--
-- Two fixes to 99_supabase_migration_signups_feed_v1.sql, both restated whole
-- from that file with only the change below:
--
-- 1. signup_feed_line: a subscription that ends gets its "cancelled" line
--    unless the line for its scheduled cancellation was actually posted.
--    v1 skipped it whenever a cancel_scheduled event existed, so a
--    cancellation scheduled before the feed was set up (no secret in Vault
--    yet, or before v1 ran) never got a line at all.
--
-- 2. signup_feed_test: the test line no longer names the admin who sent it.
--    The feed never carries an email: "Test line from the Command Center.
--    Real signups post here."
--
-- Run after 99_supabase_migration_signups_feed_v1.sql. One transaction.
-- Idempotent: safe to run twice. Nothing in the app changes with it.
-- ============================================================================

begin;

do $$
begin
  if to_regclass('public.signup_feed_posts') is null then
    raise exception 'Run 99_supabase_migration_signups_feed_v1.sql first.';
  end if;
end
$$;

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
--                                 cancel_scheduled line was posted first for it;
--                                 "during the trial" when it was trialing)
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
      -- Said already when the cancellation was scheduled (its line was
      -- posted), unless they took it back or subscribed again since.
      if exists (
        select 1
          from public.product_events s
          join public.signup_feed_posts p on p.event_id = s.id
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

-- One test line to #maya-signups, so someone can see the feed arrive. A
-- platform admin (any sign-in), the service role, or a direct database
-- session (the SQL editor: select public.signup_feed_test();). Answers
-- whether it was queued: state ready (sent), missing (no
-- maya_signups_webhook in Vault), not_https, or post_failed (pg_net refused
-- it). The line names nobody.
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
  v_role text := (select auth.role());
begin
  -- The SQL editor carries no JWT; every PostgREST request does.
  if v_role is not null
     and v_role <> 'service_role'
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

  begin
    select net.http_post(
      url := v_url,
      body := jsonb_build_object('text', 'Test line from the Command Center. Real signups post here.'),
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
  'Posts one test line to #maya-signups (maya_signups_webhook in Vault) through pg_net. Platform admins, '
  'the service role and the SQL editor. Returns {sent, state: ready|missing|not_https|post_failed}.';

revoke all on function public.signup_feed_test() from public, anon;
grant execute on function public.signup_feed_test() to authenticated, service_role;

commit;
