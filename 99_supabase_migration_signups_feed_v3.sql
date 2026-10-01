-- ============================================================================
-- MAYA: the #maya-signups feed, v3
-- ============================================================================
--
-- Audit A20 follow-up (Jake, 2026-09-30: only dollar, euro and pound style
-- currencies connect for now). An owner who signs up on maya-rms.com pays at
-- checkout BEFORE connecting their property system. When that system turns
-- out to use a currency MAYA doesn't price in, the connect stops with a plain
-- message and nothing is set up, but the subscription is already paid (or in
-- its trial, which will charge). The only trace was a product analytics
-- event, pms.currency_refused, that nobody is prompted by. Now it posts a
-- line to #maya-signups when the property had paid, so someone refunds or
-- cancels it in Stripe:
--
--   Juniper Lodge (Cloudbeds) was stopped at connect: its system uses JPY,
--   which MAYA doesn't price in yet. They have already paid: refund or cancel
--   it in Stripe.
--
-- The app sends the event (src/lib/onboarding/currency-gate.ts) with
-- properties { currency, via, paid }. paid is true only on the maya-rms.com
-- path with a checkout behind it; a Marketplace connect pays after
-- connecting, so it has nothing to refund and posts nothing.
--
-- What changes:
--
-- 1. signup_feed_line: restated whole from 99_supabase_migration_signups_feed_v2.sql
--    with one more case, pms.currency_refused. Nothing else in it changes.
--
-- 2. trg_signup_feed: restated from 99_supabase_migration_signups_feed_v1.sql
--    so it also fires for a pms.currency_refused row the app wrote with paid
--    true. Every other event still needs source 'trigger', as before, so a
--    milestone the app also records never posts twice.
--
-- signup_feed_post and signup_feed_test are unchanged. Run after
-- 99_supabase_migration_room_type_limit_removals_v1.sql. One transaction.
-- Idempotent: safe to run twice. The app works before it; the refusal then
-- posts nothing, as today.
-- ============================================================================

begin;

do $$
begin
  if to_regprocedure('public.signup_feed_staff_domains()') is null then
    raise exception 'Run 99_supabase_migration_signups_feed_v2.sql first.';
  end if;
end
$$;

-- The line #maya-signups gets for this event, or null when it gets none:
--
--   account.created               New account: email confirmed.
--                                 New account: joined Harbour Inn.  (an
--                                 invitation to a property, accepted)
--                                 (nothing on MAYA's own email domains)
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
--   pms.currency_refused          Harbour Inn (Cloudbeds) was stopped at connect: its
--                                 system uses JPY, which MAYA doesn't price in yet.
--                                 They have already paid: refund or cancel it in
--                                 Stripe.  (v3; only when the event says paid)
--
-- A property still on checkout's placeholder name reads "A new signup".
-- Nothing for a test event, any event of a property on MAYA's internal
-- plan, or any other event. A property's owner (a + address, MAYA staff)
-- never silences it: only the property's test flag or plan does. Plain SQL,
-- so the owner can preview lines: select public.signup_feed_line(e)
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
  -- v2: a property on MAYA's internal plan posts nothing, whatever the event.
  if p_event.hotel_id is not null and public.signup_feed_internal_plan(p_event.hotel_id) then
    return null;
  end if;

  if p_event.event = 'account.created' then
    -- v2: MAYA's own people, by email domain (signup_feed_staff_domains).
    if public.signup_feed_staff_email(p_event.user_id) then
      return null;
    end if;
    -- An invitation accepted: the person already belongs to a property. Only
    -- to test or internal-plan properties: not a customer, nothing to say.
    select h.name into v_joined
      from public.hotel_memberships hm
      join public.hotels h on h.id = hm.hotel_id
     where hm.user_id = p_event.user_id
       and hm.status = 'active'
       and not h.is_test
       and not public.signup_feed_internal_plan(h.id)
     order by hm.created_at
     limit 1;
    if v_joined is null and exists (
      select 1 from public.hotel_memberships hm
        join public.hotels h on h.id = hm.hotel_id
       where hm.user_id = p_event.user_id and hm.status = 'active' and (h.is_test or public.signup_feed_internal_plan(h.id))
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

    -- v3: a property stopped at connect for its currency, after paying.
    when 'pms.currency_refused' then
      if coalesce(v_props->>'paid', '') <> 'true' then
        return null;
      end if;
      return v_who || ' was stopped at connect: its system uses '
          || coalesce(public.signup_feed_escape(nullif(v_props->>'currency', '')), 'a currency')
          || ', which MAYA doesn''t price in yet. They have already paid: refund or cancel it in Stripe.';

    else
      return null;
  end case;
end;
$$;

comment on function public.signup_feed_line(public.product_events) is
  'The line #maya-signups gets for a product event, or null: a real account, trial, payment, connection, '
  'first go-live, cancellation, or a paid property stopped at connect for its currency. Nothing for MAYA''s '
  'own email domains or a property on the internal plan. Never an email, a guest or a card. See signup_feed_post.';

revoke all on function public.signup_feed_line(public.product_events) from public, anon, authenticated;
grant execute on function public.signup_feed_line(public.product_events) to service_role;

-- The trigger, as v1 made it, with the paid currency refusal let through.
drop trigger if exists trg_signup_feed on public.product_events;
create trigger trg_signup_feed
  after insert on public.product_events
  for each row
  when (
    not new.is_test
    and (
      (new.source = 'trigger'
       and new.event in ('account.created', 'subscription.trialing', 'subscription.active', 'pms.connected',
                         'property.went_live', 'subscription.cancel_scheduled', 'subscription.canceled'))
      or (new.event = 'pms.currency_refused' and new.properties->>'paid' = 'true')
    )
  )
  execute function public.signup_feed_post();

commit;

-- After running, preview the lines the feed would post for the newest events:
--   select e.event, public.signup_feed_line(e) from public.product_events e order by e.id desc limit 20;
