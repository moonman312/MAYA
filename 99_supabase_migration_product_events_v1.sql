-- ============================================================================
-- PRODUCT EVENTS — the durable record of what happened, for analytics
-- ============================================================================
--
-- The business questions ("how many connected and walked away this week",
-- "how long from connect to live", "why did they cancel") need history that
-- the operational tables do not keep:
--
--   * Rows are upserted in place. hotel_subscriptions remembers today's status,
--     not that it was trialing last week.
--   * Rows are deleted. A Marketplace property that is never claimed gets swept
--     (99_supabase_migration_marketplace_claim_sweep_v1.sql), and every table
--     hanging off hotels cascades with it. The one fact analytics most needs
--     about that property, that it connected and walked away, would go too.
--
-- So this is an append-only log with NO foreign keys. hotel_id is a plain uuid
-- and the property's PMS, PMS property id and name are copied onto the row at
-- the time, so an event still reads correctly after the hotel is gone.
-- user_id is a plain uuid for the same reason. Nothing here ever carries an
-- email, a person's name, or anything from a reservation.
--
-- Capture is by trigger, not application code, so every write path is covered
-- the same way: Next routes, the Deno workers, the Stripe webhook, Command
-- Center and hand-run SQL. The triggers are AFTER triggers that catch their own
-- errors and only raise a WARNING: analytics must never fail or roll back the
-- write it describes.
--
-- Events with no database write of their own (a screen viewed, "How did we
-- know?" opened) arrive through /api/events, which calls product_event_emit on
-- the service role against a strict allowlist. See maya-rms/docs/analytics.md
-- for the taxonomy, what each property means, and the metric definitions.
--
-- The backfill at the bottom seeds history from the tables and the platform
-- audit log so the panel is not empty on day one. Those rows have
-- source = 'backfill', and wherever the true moment is not recorded anywhere
-- the row says approximate = true in its properties.
--
-- Run AFTER (all already in the repo): billing_v1, billing_v2_pending_hotel,
-- internal_plan_v1, business_metrics_v1, test_hotels_v1, onboarding_v1,
-- roles_v2_part2, marketplace_flow_a_v1, marketplace_groups_v1,
-- setup_deferred_v1, manual_price_v1, room_type_counts_as_room_v1,
-- room_type_out_of_service_v1. Idempotent: every backfilled row carries a
-- dedupe key, so re-running inserts nothing twice.

begin;

-- ── 1. The table ────────────────────────────────────────────────────────────

create table if not exists public.product_events (
  id               bigint generated always as identity primary key,
  -- When it happened. For backfilled rows this is the best evidence available,
  -- which recorded_at makes distinguishable from when the row was written.
  occurred_at      timestamptz not null default now(),
  recorded_at      timestamptz not null default now(),
  event            text not null,
  hotel_id         uuid,
  pms_type         text,
  pms_property_id  text,
  property_name    text,
  user_id          uuid,
  properties       jsonb not null default '{}'::jsonb,
  source           text not null,
  -- hotels.is_test at the time. Queries prefer the live flag while the hotel
  -- exists and fall back to this once it does not.
  is_test          boolean not null default false,
  -- Set only where a retry or a re-run must not write the same fact twice
  -- (backfill, the claim sweep, one manual-price save that fires two
  -- statement triggers). Null everywhere else, and nulls never collide.
  dedupe_key       text,
  constraint product_events_event_shape check (event ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
  constraint product_events_source check (source in ('trigger', 'app', 'sweep', 'backfill'))
);

create unique index if not exists uq_product_events_dedupe
  on public.product_events (dedupe_key);
create index if not exists idx_product_events_event_time
  on public.product_events (event, occurred_at desc);
create index if not exists idx_product_events_hotel_time
  on public.product_events (hotel_id, occurred_at desc);
-- A swept property comes back under a new hotel id when it reconnects, so the
-- walked-away queries follow the PMS property, not the hotel row.
create index if not exists idx_product_events_property
  on public.product_events (pms_type, pms_property_id, occurred_at)
  where pms_property_id is not null;

comment on table public.product_events is
  'Append-only product analytics log. No foreign keys on purpose: rows outlive the hotel and user they describe. '
  'Written by AFTER triggers (source=trigger), /api/events (app), the Marketplace claim sweep (sweep) and the '
  'one-time backfill (backfill). Never carries emails, names of people, or reservation data. '
  'Taxonomy: maya-rms/docs/analytics.md.';
comment on column public.product_events.user_id is
  'The person the event is about: the actor for things a person did; the property owner (earliest active '
  'hotel_admin) for system-driven billing, PMS and import events. Plain uuid, survives user deletion.';

alter table public.product_events enable row level security;

-- Platform admins read; nobody writes except through the SECURITY DEFINER
-- paths below. service_role gets insert for /api/events and no update or
-- delete at all, which is what makes the log append-only in practice.
revoke all on public.product_events from public, anon, authenticated, service_role;
grant select on public.product_events to authenticated;
grant select, insert on public.product_events to service_role;

drop policy if exists product_events_platform_read on public.product_events;
create policy product_events_platform_read
  on public.product_events for select
  using (public.is_platform_admin());

-- ── 2. Cancellation reasons, which only Stripe knows ────────────────────────
--
-- Stripe's cancellation_details on the subscription, copied by the webhook
-- projection (lib/billing/sync.ts). Only the two enums, never the free-text
-- comment: that is whatever the owner typed and has no business in analytics.

alter table public.hotel_subscriptions
  add column if not exists cancellation_reason text,
  add column if not exists cancellation_feedback text;

comment on column public.hotel_subscriptions.cancellation_reason is
  'Stripe cancellation_details.reason: cancellation_requested | payment_failed | payment_disputed. Null when not cancelled.';
comment on column public.hotel_subscriptions.cancellation_feedback is
  'Stripe cancellation_details.feedback, as picked in the customer portal (too_expensive, missing_features, '
  'switched_service, unused, customer_service, too_complex, low_quality, other). Null when not given.';

-- ── 3. Emitting ─────────────────────────────────────────────────────────────

-- The property's identity as analytics wants it. external_enterprise_id is
-- namespaced ("cloudbeds:320691") for Marketplace arrivals and a bare
-- enterprise id for Mews; anything else has no PMS property id outside the
-- Vault, which is never read here.
create or replace function public.product_event_hotel_context(p_hotel_id uuid)
returns table (pms_type text, pms_property_id text, property_name text, is_test boolean, owner_user_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce(
      (select c.pms_type::text from public.pms_connections c
        where c.hotel_id = h.id order by c.updated_at desc limit 1),
      case when h.external_enterprise_id like '%:%' then split_part(h.external_enterprise_id, ':', 1) end
    ),
    case
      when h.external_enterprise_id like '%:%'
        then substr(h.external_enterprise_id, strpos(h.external_enterprise_id, ':') + 1)
      else h.external_enterprise_id
    end,
    h.name,
    h.is_test,
    (select hm.user_id from public.hotel_memberships hm
      where hm.hotel_id = h.id and hm.role = 'hotel_admin' and hm.status = 'active'
      order by hm.created_at asc limit 1)
  from public.hotels h
  where h.id = p_hotel_id
$$;

revoke all on function public.product_event_hotel_context(uuid) from public, anon, authenticated;
grant execute on function public.product_event_hotel_context(uuid) to service_role;

-- The one way a row gets written. Never raises: a trigger that calls this
-- must not be able to fail the write it is describing, and /api/events treats
-- a null return as "not recorded" rather than an error to show anyone.
--
-- p_source 'trigger' is overridden by the maya.event_source setting when a
-- caller sets it for its transaction, so rows the claim sweep causes (the
-- property.deleted a hotel delete fires, say) say they came from the sweep.
create or replace function public.product_event_emit(
  p_event text,
  p_hotel_id uuid default null,
  p_user_id uuid default null,
  p_properties jsonb default '{}'::jsonb,
  p_source text default 'trigger',
  p_occurred_at timestamptz default null,
  p_dedupe_key text default null,
  p_pms_type text default null,
  p_pms_property_id text default null,
  p_property_name text default null,
  p_is_test boolean default null
) returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pms_type text;
  v_pms_property_id text;
  v_property_name text;
  v_is_test boolean;
  v_owner uuid;
  v_id bigint;
  v_source text := p_source;
begin
  if p_source = 'trigger' then
    v_source := coalesce(nullif(current_setting('maya.event_source', true), ''), 'trigger');
  end if;

  if p_hotel_id is not null then
    select c.pms_type, c.pms_property_id, c.property_name, c.is_test, c.owner_user_id
      into v_pms_type, v_pms_property_id, v_property_name, v_is_test, v_owner
      from public.product_event_hotel_context(p_hotel_id) c;
  end if;

  insert into public.product_events (
    occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
    user_id, properties, source, is_test, dedupe_key
  ) values (
    coalesce(p_occurred_at, now()),
    p_event,
    p_hotel_id,
    coalesce(p_pms_type, v_pms_type),
    coalesce(p_pms_property_id, v_pms_property_id),
    coalesce(p_property_name, v_property_name),
    coalesce(p_user_id, v_owner),
    jsonb_strip_nulls(coalesce(p_properties, '{}'::jsonb)),
    v_source,
    coalesce(p_is_test, v_is_test, false),
    p_dedupe_key
  )
  on conflict (dedupe_key) do nothing
  returning id into v_id;

  return v_id;
exception when others then
  raise warning 'product_event_emit(%) not recorded: % [%]', p_event, sqlerrm, sqlstate;
  return null;
end;
$$;

revoke all on function public.product_event_emit(text, uuid, uuid, jsonb, text, timestamptz, text, text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.product_event_emit(text, uuid, uuid, jsonb, text, timestamptz, text, text, text, text, boolean)
  to service_role;

-- A PMS or import failure message can quote whatever the vendor sent back, so
-- the text itself never leaves import_jobs. The class of failure is what the
-- failure-rate questions need.
create or replace function public.product_event_error_kind(p_message text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_message is null or btrim(p_message) = '' then null
    when p_message ~* '(401|403|unauthori|forbidden|invalid_grant|revoked|not connected|not available to be connected)' then 'auth'
    when p_message ~* '(429|rate.?limit|too many requests)' then 'rate_limit'
    when p_message ~* '(timeout|timed out|aborted|ETIMEDOUT)' then 'timeout'
    when p_message ~* '(5[0-9][0-9]|bad gateway|service unavailable|internal server error)' then 'vendor_error'
    when p_message ~* '(row_cap|cap reached|too many rows)' then 'row_cap'
    else 'other'
  end
$$;

-- ── 4. Triggers ─────────────────────────────────────────────────────────────
--
-- Every function below is AFTER, SECURITY DEFINER (the writer may be a hotel
-- member who cannot read the log it is writing to) and wraps its whole body
-- in an exception block. Each checks that the column it cares about actually
-- changed: several of these tables are upserted wholesale every few minutes.

-- Marketplace connect and claim ------------------------------------------------

create or replace function public.product_events_marketplace_claims()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_property_id text;
  v_group_size int;
begin
  begin
    v_property_id := substr(new.external_property_id, strpos(new.external_property_id, ':') + 1);
    v_group_size := case when new.group_key is not null
      then array_length(string_to_array(split_part(new.group_key, ':group:', 2), ','), 1) end;

    if tg_op = 'INSERT' then
      perform public.product_event_emit(
        'marketplace.connected', new.hotel_id, null,
        jsonb_build_object(
          'group_key', new.group_key,
          'group_size', v_group_size,
          'expires_at', new.expires_at,
          -- Reviewers and owners click Connect App twice; the cohort counts the
          -- property once, from its first click.
          'repeat', exists (
            select 1 from public.product_events e
             where e.event = 'marketplace.connected'
               and e.pms_type = new.pms_type::text
               and e.pms_property_id = v_property_id
          )
        ),
        'trigger', new.created_at, null, new.pms_type::text, v_property_id, new.property_name
      );
    elsif tg_op = 'UPDATE' and old.claimed_at is null and new.claimed_at is not null then
      perform public.product_event_emit(
        'marketplace.claim_redeemed', new.hotel_id, new.claimed_by,
        jsonb_build_object(
          'group_key', new.group_key,
          'group_size', v_group_size,
          'hours_since_connect', round((extract(epoch from (new.claimed_at - new.created_at)) / 3600)::numeric, 2)
        ),
        'trigger', new.claimed_at, null, new.pms_type::text, v_property_id, new.property_name
      );
    end if;
  exception when others then
    raise warning 'product_events_marketplace_claims: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

drop trigger if exists trg_product_events_marketplace_claims on public.pms_marketplace_claims;
create trigger trg_product_events_marketplace_claims
  after insert or update of claimed_at on public.pms_marketplace_claims
  for each row execute function public.product_events_marketplace_claims();

-- Accounts and the onboarding path ---------------------------------------------

create or replace function public.product_events_profiles()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_test boolean;
  v_hotel uuid;
begin
  begin
    -- An account exists before any hotel does, so the only test signal is the
    -- +suffix address convention the analytics panel already uses.
    select coalesce(u.email, '') like '%+%' into v_is_test from auth.users u where u.id = new.id;

    if tg_op = 'INSERT' then
      perform public.product_event_emit(
        'account.created', null, new.id, '{}'::jsonb, 'trigger', new.created_at,
        null, null, null, null, coalesce(v_is_test, false)
      );
    end if;

    if new.onboarding_path is not null
       and (tg_op = 'INSERT' or new.onboarding_path is distinct from old.onboarding_path) then
      -- The choice is per user; it is only pinned to a property when the user
      -- has exactly one, which is the case for everyone mid-onboarding.
      select min(hm.hotel_id::text)::uuid into v_hotel
        from public.hotel_memberships hm
       where hm.user_id = new.id and hm.status = 'active'
      having count(*) = 1;
      perform public.product_event_emit(
        'onboarding.path_chosen', v_hotel, new.id,
        jsonb_build_object('path', new.onboarding_path::text),
        'trigger', null, null, null, null, null,
        case when v_hotel is null then coalesce(v_is_test, false) end
      );
    end if;
  exception when others then
    raise warning 'product_events_profiles: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

drop trigger if exists trg_product_events_profiles on public.profiles;
create trigger trg_product_events_profiles
  after insert or update of onboarding_path on public.profiles
  for each row execute function public.product_events_profiles();

-- Properties: created, activated, deferred, deleted ----------------------------

create or replace function public.product_events_hotels()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_via text;
begin
  begin
    if tg_op = 'INSERT' then
      perform public.product_event_emit(
        'property.created', new.id, auth.uid(),
        jsonb_build_object('kind', case
          when new.setup_pending_at is not null and new.external_enterprise_id like '%:%' then 'marketplace_parked'
          when new.setup_pending_at is not null then 'checkout_placeholder'
          when new.is_active then 'active'
          else 'inactive'
        end),
        'trigger', new.created_at
      );
      if new.is_active then
        perform public.product_event_emit(
          'property.activated', new.id, auth.uid(), jsonb_build_object('via', 'created'),
          'trigger', new.created_at
        );
      end if;

    elsif tg_op = 'UPDATE' then
      if new.is_active and not old.is_active then
        v_via := case
          when exists (select 1 from public.pms_marketplace_claims c
                        where c.hotel_id = new.id and c.claimed_at is not null) then 'marketplace'
          when old.setup_pending_at is not null then 'checkout'
          else 'reactivated'
        end;
        perform public.product_event_emit(
          'property.activated', new.id, auth.uid(),
          jsonb_build_object(
            'via', v_via,
            'hours_since_created', round((extract(epoch from (now() - new.created_at)) / 3600)::numeric, 2)
          )
        );
      elsif old.is_active and not new.is_active then
        perform public.product_event_emit('property.deactivated', new.id, auth.uid(), '{}'::jsonb);
      end if;

      if new.setup_deferred_at is not null and old.setup_deferred_at is null then
        perform public.product_event_emit(
          'marketplace.deferred', new.id, coalesce(new.setup_deferred_by, auth.uid()), '{}'::jsonb,
          'trigger', new.setup_deferred_at
        );
      elsif new.setup_deferred_at is null and old.setup_deferred_at is not null then
        perform public.product_event_emit(
          'marketplace.resumed', new.id, coalesce(auth.uid(), old.setup_deferred_by),
          jsonb_build_object(
            'days_deferred', round((extract(epoch from (now() - old.setup_deferred_at)) / 86400)::numeric, 2)
          )
        );
      end if;

    elsif tg_op = 'DELETE' then
      perform public.product_event_emit(
        'property.deleted', old.id, auth.uid(),
        jsonb_build_object(
          'was_active', old.is_active,
          'was_parked', old.setup_pending_at is not null,
          'days_since_created', round((extract(epoch from (now() - old.created_at)) / 86400)::numeric, 2)
        ),
        'trigger', null, null,
        case when old.external_enterprise_id like '%:%' then split_part(old.external_enterprise_id, ':', 1) end,
        case when old.external_enterprise_id like '%:%'
          then substr(old.external_enterprise_id, strpos(old.external_enterprise_id, ':') + 1)
          else old.external_enterprise_id end,
        old.name,
        old.is_test
      );
    end if;
  exception when others then
    raise warning 'product_events_hotels: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

drop trigger if exists trg_product_events_hotels_insert on public.hotels;
create trigger trg_product_events_hotels_insert
  after insert on public.hotels
  for each row execute function public.product_events_hotels();

drop trigger if exists trg_product_events_hotels_update on public.hotels;
create trigger trg_product_events_hotels_update
  after update of is_active, setup_deferred_at on public.hotels
  for each row execute function public.product_events_hotels();

drop trigger if exists trg_product_events_hotels_delete on public.hotels;
create trigger trg_product_events_hotels_delete
  after delete on public.hotels
  for each row execute function public.product_events_hotels();

-- Signup codes ------------------------------------------------------------------

create or replace function public.product_events_code_redemptions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    -- The redemption row carries the redeemer's email; only the code and what
    -- it granted come across.
    perform public.product_event_emit(
      'signup_code.redeemed', new.hotel_id, new.user_id,
      (select jsonb_build_object(
                'code_id', sc.id, 'code', sc.code, 'kind', sc.kind::text,
                'percent_off', sc.percent_off, 'amount_off_cents', sc.amount_off_cents,
                'trial_days', sc.trial_days)
         from public.signup_codes sc where sc.id = new.code_id),
      'trigger', new.redeemed_at
    );
  exception when others then
    raise warning 'product_events_code_redemptions: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

drop trigger if exists trg_product_events_code_redemptions on public.signup_code_redemptions;
create trigger trg_product_events_code_redemptions
  after insert on public.signup_code_redemptions
  for each row execute function public.product_events_code_redemptions();

-- Subscriptions -----------------------------------------------------------------

create or replace function public.product_events_subscriptions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_props jsonb;
  v_new_sub boolean;
begin
  begin
    v_props := jsonb_build_object(
      'plan_kind', new.plan_kind,
      'billing_interval', new.billing_interval,
      'billed_rooms', new.billed_rooms,
      'trial_end', new.trial_end,
      'current_period_end', new.current_period_end,
      'signup_code_id', new.signup_code_id,
      'cancellation_reason', new.cancellation_reason,
      'cancellation_feedback', new.cancellation_feedback
    );

    -- The row is keyed by hotel and reused on a re-subscribe, so a changed
    -- Stripe subscription id is a new subscription, not an update.
    v_new_sub := tg_op = 'INSERT'
      or (old.stripe_subscription_id is not null
          and new.stripe_subscription_id is distinct from old.stripe_subscription_id);

    if v_new_sub then
      perform public.product_event_emit(
        'subscription.created', new.hotel_id, null,
        v_props || jsonb_build_object('status', new.status, 'resubscribe', tg_op = 'UPDATE'),
        'trigger', case when tg_op = 'INSERT' then new.created_at end
      );
    end if;

    if v_new_sub or new.status is distinct from old.status then
      perform public.product_event_emit(
        'subscription.' || regexp_replace(lower(new.status), '[^a-z_]', '_', 'g'),
        new.hotel_id, null,
        v_props || jsonb_build_object('from_status', case when tg_op = 'UPDATE' then old.status end),
        'trigger', case when tg_op = 'INSERT' then new.created_at end
      );
    end if;

    if tg_op = 'UPDATE' and not v_new_sub then
      if new.cancel_at_period_end and not old.cancel_at_period_end then
        perform public.product_event_emit(
          'subscription.cancel_scheduled', new.hotel_id, null, v_props || jsonb_build_object('status', new.status)
        );
      elsif old.cancel_at_period_end and not new.cancel_at_period_end and new.status <> 'canceled' then
        perform public.product_event_emit(
          'subscription.cancel_withdrawn', new.hotel_id, null, v_props || jsonb_build_object('status', new.status)
        );
      end if;

      if new.billed_rooms is distinct from old.billed_rooms
         or new.billing_interval is distinct from old.billing_interval then
        perform public.product_event_emit(
          'subscription.plan_changed', new.hotel_id, null,
          v_props || jsonb_build_object(
            'status', new.status,
            'previous_billed_rooms', old.billed_rooms,
            'previous_billing_interval', old.billing_interval
          )
        );
      end if;
    end if;
  exception when others then
    raise warning 'product_events_subscriptions: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

drop trigger if exists trg_product_events_subscriptions on public.hotel_subscriptions;
create trigger trg_product_events_subscriptions
  after insert or update on public.hotel_subscriptions
  for each row execute function public.product_events_subscriptions();

-- Going live --------------------------------------------------------------------

create or replace function public.product_events_hotel_settings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    if old.simulation_mode and not new.simulation_mode then
      perform public.product_event_emit(
        'property.went_live', new.hotel_id, auth.uid(),
        jsonb_build_object('first_time', not exists (
          select 1 from public.product_events e
           where e.hotel_id = new.hotel_id and e.event = 'property.went_live'
        ))
      );
    elsif new.simulation_mode and not old.simulation_mode then
      perform public.product_event_emit('property.back_to_simulation', new.hotel_id, auth.uid(), '{}'::jsonb);
    end if;
  exception when others then
    raise warning 'product_events_hotel_settings: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

drop trigger if exists trg_product_events_hotel_settings on public.hotel_settings;
create trigger trg_product_events_hotel_settings
  after update of simulation_mode on public.hotel_settings
  for each row execute function public.product_events_hotel_settings();

-- Onboarding milestones ---------------------------------------------------------

create or replace function public.product_events_onboarding_states()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    if new.questions_completed_at is not null
       and (tg_op = 'INSERT' or old.questions_completed_at is null) then
      perform public.product_event_emit(
        'onboarding.questions_completed', new.hotel_id, auth.uid(),
        jsonb_build_object('path', new.path::text), 'trigger', new.questions_completed_at
      );
    end if;
    if new.review_completed_at is not null
       and (tg_op = 'INSERT' or old.review_completed_at is null) then
      perform public.product_event_emit(
        'onboarding.review_completed', new.hotel_id, auth.uid(),
        jsonb_build_object('path', new.path::text), 'trigger', new.review_completed_at
      );
    end if;
  exception when others then
    raise warning 'product_events_onboarding_states: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

drop trigger if exists trg_product_events_onboarding_states on public.onboarding_states;
create trigger trg_product_events_onboarding_states
  after insert or update of questions_completed_at, review_completed_at on public.onboarding_states
  for each row execute function public.product_events_onboarding_states();

-- PMS connection health ---------------------------------------------------------
--
-- The sync stamps this row every few minutes and oauth-credentials flips a
-- working connection to 'degraded' and straight back within one sync, so the
-- flappy states (degraded, error, and recovering from either) are recorded at
-- most once per property per day. connected, disconnected and reconnected are
-- deliberate and always recorded.

create or replace function public.product_events_pms_connections()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_from text;
  v_to text;
  v_event text;
begin
  begin
    v_from := case when tg_op = 'UPDATE' then old.status::text end;
    v_to := new.status::text;
    if tg_op = 'UPDATE' and v_from = v_to then
      return null;
    end if;

    v_event := case
      when v_to = 'connected' and v_from is null then 'pms.connected'
      when v_to = 'connected' and v_from = 'pending' then 'pms.connected'
      when v_to = 'connected' and v_from = 'disconnected' then 'pms.reconnected'
      when v_to = 'connected' and v_from in ('degraded', 'error') then 'pms.recovered'
      when v_to = 'degraded' then 'pms.degraded'
      when v_to = 'error' then 'pms.error'
      when v_to = 'disconnected' then 'pms.disconnected'
    end;
    if v_event is null then
      return null;
    end if;

    if v_event in ('pms.degraded', 'pms.error', 'pms.recovered') and exists (
      select 1 from public.product_events e
       where e.hotel_id = new.hotel_id
         and e.event = v_event
         and e.occurred_at > now() - interval '24 hours'
    ) then
      return null;
    end if;

    perform public.product_event_emit(
      v_event, new.hotel_id, auth.uid(),
      jsonb_build_object('from_status', v_from, 'to_status', v_to),
      'trigger', null, null, new.pms_type::text
    );
  exception when others then
    raise warning 'product_events_pms_connections: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

drop trigger if exists trg_product_events_pms_connections on public.pms_connections;
create trigger trg_product_events_pms_connections
  after insert or update of status on public.pms_connections
  for each row execute function public.product_events_pms_connections();

-- History imports ---------------------------------------------------------------

create or replace function public.product_events_import_jobs()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_props jsonb;
begin
  begin
    v_props := jsonb_build_object(
      'job_id', new.id,
      'kind', case when exists (
        select 1 from public.import_jobs j
         where j.hotel_id = new.hotel_id and j.id <> new.id and j.created_at < new.created_at
      ) then 'refresh' else 'initial' end,
      'phase', new.phase,
      'attempts', new.attempts
    );

    if new.started_at is not null and (tg_op = 'INSERT' or old.started_at is null) then
      perform public.product_event_emit(
        'import.started', new.hotel_id, new.requested_by,
        v_props || jsonb_build_object(
          'queued_seconds', round(extract(epoch from (new.started_at - new.created_at))::numeric)
        ),
        'trigger', new.started_at, null, new.pms_type::text
      );
    end if;

    if new.status::text in ('completed', 'failed', 'canceled')
       and (tg_op = 'INSERT' or new.status is distinct from old.status) then
      perform public.product_event_emit(
        'import.' || new.status::text, new.hotel_id, new.requested_by,
        v_props || jsonb_build_object(
          'duration_seconds', case when new.started_at is not null then
            round(extract(epoch from (coalesce(new.finished_at, now()) - new.started_at))::numeric) end,
          'rows_upserted', new.rows_upserted,
          'reservations_enumerated', new.reservations_enumerated,
          'windows_completed', new.windows_completed,
          'error_kind', case when new.status::text = 'failed'
            then coalesce(public.product_event_error_kind(new.last_error), 'other') end
        ),
        'trigger', new.finished_at, null, new.pms_type::text
      );
    end if;
  exception when others then
    raise warning 'product_events_import_jobs: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

drop trigger if exists trg_product_events_import_jobs on public.import_jobs;
create trigger trg_product_events_import_jobs
  after insert or update of status, started_at on public.import_jobs
  for each row execute function public.product_events_import_jobs();

-- Pricing rules -----------------------------------------------------------------
--
-- Origin, where it can be told:
--   starter     written by the import worker (service role, no user) while it
--               builds the starter ladder
--   suggestion  written by a signed-in owner accepting a rule suggestion on
--               the review screen moments earlier
--   owner       written by a signed-in person any other way (the rules page,
--               the simulator's "Save This Rule")
--   system      anything else with no user (seeds, hand-run SQL)

create or replace function public.product_events_pricing_rules()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rule public.pricing_rules%rowtype;
  v_origin text;
begin
  begin
    if tg_op = 'DELETE' then
      v_rule := old;
      -- A hotel delete cascades here; that is the property going, not a rule.
      if not exists (select 1 from public.hotels h where h.id = old.hotel_id) then
        return null;
      end if;
    else
      v_rule := new;
    end if;

    if tg_op = 'INSERT' then
      v_origin := case
        when auth.uid() is null
             and (auth.role() = 'service_role' or auth.role() is null)
             and (new.name in ('Slow-date rescue', 'Slow-date trim', 'Warm-date bump', 'Hot-week surge', 'Sudden-spike catcher')
                  or exists (select 1 from public.import_jobs j
                              where j.hotel_id = new.hotel_id and j.status = 'running'))
          then 'starter'
        when auth.uid() is null then 'system'
        when exists (
          select 1 from public.onboarding_findings f
           where f.hotel_id = new.hotel_id
             and f.kind = 'rule_suggestion'
             and f.status = 'confirmed'
             and f.resolved_by = auth.uid()
             and f.resolved_at > now() - interval '5 minutes'
             and f.payload->'spec'->>'name' = new.name
        ) then 'suggestion'
        else 'owner'
      end;
    else
      select e.properties->>'origin' into v_origin
        from public.product_events e
       where e.hotel_id = v_rule.hotel_id
         and e.event = 'rule.created'
         and e.properties->>'rule_id' = v_rule.id::text
       order by e.occurred_at asc
       limit 1;
    end if;

    if tg_op = 'INSERT' then
      perform public.product_event_emit(
        'rule.created', new.hotel_id, coalesce(auth.uid(), new.created_by),
        jsonb_build_object(
          'rule_id', new.id, 'origin', v_origin, 'is_active', new.is_active,
          'is_pickup_rule', new.is_pickup_rule,
          'action_type', new.action_type, 'action_direction', new.action_direction
        ),
        'trigger', new.created_at
      );
    elsif tg_op = 'UPDATE' then
      if new.is_active is distinct from old.is_active then
        perform public.product_event_emit(
          case when new.is_active then 'rule.enabled' else 'rule.disabled' end,
          new.hotel_id, auth.uid(),
          jsonb_build_object('rule_id', new.id, 'origin', v_origin)
        );
      end if;
      if new.version > old.version then
        perform public.product_event_emit(
          'rule.edited', new.hotel_id, auth.uid(),
          jsonb_build_object('rule_id', new.id, 'origin', v_origin, 'version', new.version)
        );
      end if;
    else
      perform public.product_event_emit(
        'rule.deleted', old.hotel_id, auth.uid(),
        jsonb_build_object(
          'rule_id', old.id, 'origin', v_origin, 'was_active', old.is_active,
          'age_days', round((extract(epoch from (now() - old.created_at)) / 86400)::numeric, 2)
        )
      );
    end if;
  exception when others then
    raise warning 'product_events_pricing_rules: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

drop trigger if exists trg_product_events_pricing_rules_insert on public.pricing_rules;
create trigger trg_product_events_pricing_rules_insert
  after insert on public.pricing_rules
  for each row execute function public.product_events_pricing_rules();

drop trigger if exists trg_product_events_pricing_rules_update on public.pricing_rules;
create trigger trg_product_events_pricing_rules_update
  after update of is_active, version on public.pricing_rules
  for each row execute function public.product_events_pricing_rules();

drop trigger if exists trg_product_events_pricing_rules_delete on public.pricing_rules;
create trigger trg_product_events_pricing_rules_delete
  after delete on public.pricing_rules
  for each row execute function public.product_events_pricing_rules();

-- Manual prices -----------------------------------------------------------------
--
-- One save writes a row per night in the range, as a single upsert. That is
-- one action to an owner, so these are statement triggers that record one
-- event per (property, room type, save). An upsert that both inserts and
-- updates fires the INSERT and the UPDATE statement trigger; both count the
-- whole save from the table and share a dedupe key, so it is recorded once.

create or replace function public.product_events_manual_price_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  begin
    for r in
      select n.hotel_id, n.room_type_id, n.set_at, max(n.set_by::text)::uuid as set_by
        from new_rows n
       where n.cleared_at is null
       group by n.hotel_id, n.room_type_id, n.set_at
    loop
      perform public.product_events_manual_price_set(r.hotel_id, r.room_type_id, r.set_at, r.set_by);
    end loop;
  exception when others then
    raise warning 'product_events_manual_price_insert: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

create or replace function public.product_events_manual_price_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  begin
    for r in
      select n.hotel_id, n.room_type_id, n.set_at, max(n.set_by::text)::uuid as set_by
        from new_rows n
        join old_rows o using (hotel_id, stay_date, room_type_id)
       where n.cleared_at is null
         and (o.cleared_at is not null or n.set_at is distinct from o.set_at)
       group by n.hotel_id, n.room_type_id, n.set_at
    loop
      perform public.product_events_manual_price_set(r.hotel_id, r.room_type_id, r.set_at, r.set_by);
    end loop;

    for r in
      select n.hotel_id, n.room_type_id, n.cleared_at, max(n.cleared_by::text)::uuid as cleared_by,
             count(*) as nights, min(n.stay_date) as first_night, max(n.stay_date) as last_night
        from new_rows n
        join old_rows o using (hotel_id, stay_date, room_type_id)
       where o.cleared_at is null and n.cleared_at is not null
       group by n.hotel_id, n.room_type_id, n.cleared_at
    loop
      perform public.product_event_emit(
        'manual_price.cleared', r.hotel_id, r.cleared_by,
        jsonb_build_object(
          'room_type_id', r.room_type_id, 'nights', r.nights,
          'first_night', r.first_night, 'last_night', r.last_night
        ),
        'trigger', r.cleared_at,
        'manual_price.cleared:' || r.hotel_id || ':' || r.room_type_id || ':'
          || to_char(r.cleared_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')
      );
    end loop;
  exception when others then
    raise warning 'product_events_manual_price_update: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

create or replace function public.product_events_manual_price_set(
  p_hotel_id uuid, p_room_type_id uuid, p_set_at timestamptz, p_set_by uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_nights int;
  v_first date;
  v_last date;
begin
  select count(*), min(mp.stay_date), max(mp.stay_date)
    into v_nights, v_first, v_last
    from public.manual_price mp
   where mp.hotel_id = p_hotel_id
     and mp.room_type_id = p_room_type_id
     and mp.set_at = p_set_at
     and mp.cleared_at is null;

  perform public.product_event_emit(
    'manual_price.set', p_hotel_id, p_set_by,
    jsonb_build_object(
      'room_type_id', p_room_type_id, 'nights', v_nights,
      'first_night', v_first, 'last_night', v_last,
      'lead_days', v_first - (p_set_at at time zone 'UTC')::date
    ),
    'trigger', p_set_at,
    'manual_price.set:' || p_hotel_id || ':' || p_room_type_id || ':'
      || to_char(p_set_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')
  );
end;
$$;

revoke all on function public.product_events_manual_price_set(uuid, uuid, timestamptz, uuid) from public, anon, authenticated;

drop trigger if exists trg_product_events_manual_price_insert on public.manual_price;
create trigger trg_product_events_manual_price_insert
  after insert on public.manual_price
  referencing new table as new_rows
  for each statement execute function public.product_events_manual_price_insert();

drop trigger if exists trg_product_events_manual_price_update on public.manual_price;
create trigger trg_product_events_manual_price_update
  after update on public.manual_price
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.product_events_manual_price_update();

-- Room types: classified, and units out of service -------------------------------

create or replace function public.product_events_room_types()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    -- Only a person's answer. The import heuristic writes with set_by null and
    -- proposes on every sync; recording that would drown the owner's choices.
    if new.counts_as_room_set_by is not null
       and new.counts_as_room is not null
       and (new.counts_as_room is distinct from old.counts_as_room
            or old.counts_as_room_set_by is null) then
      perform public.product_event_emit(
        'room_type.classified', new.hotel_id, new.counts_as_room_set_by,
        jsonb_build_object(
          'room_type_id', new.id,
          'counts_as_room', new.counts_as_room,
          'previous', old.counts_as_room,
          'confirmed_guess', new.counts_as_room is not distinct from old.counts_as_room
        )
      );
    end if;
  exception when others then
    raise warning 'product_events_room_types: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

drop trigger if exists trg_product_events_room_types on public.room_types;
create trigger trg_product_events_room_types
  after update of counts_as_room, counts_as_room_set_by on public.room_types
  for each row execute function public.product_events_room_types();

create or replace function public.product_events_out_of_service()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    if tg_op = 'INSERT' then
      perform public.product_event_emit(
        'room_type.out_of_service_added', new.hotel_id, new.created_by,
        jsonb_build_object(
          'room_type_id', new.room_type_id, 'units', new.units,
          'nights', new.end_date - new.start_date + 1,
          'starts_in_days', new.start_date - (new.created_at at time zone 'UTC')::date
        ),
        'trigger', new.created_at
      );
    elsif old.cleared_at is null and new.cleared_at is not null then
      perform public.product_event_emit(
        'room_type.out_of_service_cleared', new.hotel_id, new.cleared_by,
        jsonb_build_object(
          'room_type_id', new.room_type_id, 'units', new.units,
          'cleared_early', (new.cleared_at at time zone 'UTC')::date < new.end_date
        ),
        'trigger', new.cleared_at
      );
    end if;
  exception when others then
    raise warning 'product_events_out_of_service: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

drop trigger if exists trg_product_events_out_of_service on public.room_type_out_of_service;
create trigger trg_product_events_out_of_service
  after insert or update of cleared_at on public.room_type_out_of_service
  for each row execute function public.product_events_out_of_service();

-- Team --------------------------------------------------------------------------

create or replace function public.product_events_pending_memberships()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    -- The invitee's email stays on the invite. Role is all that comes across.
    if new.status = 'pending' and (tg_op = 'INSERT' or old.status is distinct from 'pending') then
      perform public.product_event_emit(
        'team.invited', new.hotel_id, coalesce(new.invited_by, auth.uid()),
        jsonb_build_object('role', new.role::text, 'reinvite', tg_op = 'UPDATE')
      );
    elsif tg_op = 'UPDATE' and new.status = 'revoked' and old.status is distinct from 'revoked' then
      perform public.product_event_emit(
        'team.invite_revoked', new.hotel_id, auth.uid(), jsonb_build_object('role', new.role::text)
      );
    end if;
  exception when others then
    raise warning 'product_events_pending_memberships: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

drop trigger if exists trg_product_events_pending_memberships on public.pending_memberships;
create trigger trg_product_events_pending_memberships
  after insert or update of status on public.pending_memberships
  for each row execute function public.product_events_pending_memberships();

create or replace function public.product_events_hotel_memberships()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    if tg_op = 'INSERT' then
      perform public.product_event_emit(
        'team.member_joined', new.hotel_id, new.user_id,
        jsonb_build_object(
          'role', new.role::text,
          'first_member', not exists (
            select 1 from public.hotel_memberships hm
             where hm.hotel_id = new.hotel_id and hm.id <> new.id
          ),
          'via_invite', exists (
            select 1 from public.pending_memberships pm
              join auth.users u on u.id = new.user_id
             where pm.hotel_id = new.hotel_id and pm.email = u.email::citext
          )
        ),
        'trigger', new.created_at
      );
    else
      -- A hotel delete cascades here; that is the property going, not a team change.
      if not exists (select 1 from public.hotels h where h.id = old.hotel_id) then
        return null;
      end if;
      perform public.product_event_emit(
        'team.member_removed', old.hotel_id, old.user_id,
        jsonb_build_object('role', old.role::text, 'removed_by', auth.uid())
      );
    end if;
  exception when others then
    raise warning 'product_events_hotel_memberships: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

drop trigger if exists trg_product_events_hotel_memberships on public.hotel_memberships;
create trigger trg_product_events_hotel_memberships
  after insert or delete on public.hotel_memberships
  for each row execute function public.product_events_hotel_memberships();

-- None of the trigger functions is meant to be called directly.
do $$
declare
  f text;
begin
  foreach f in array array[
    'product_events_marketplace_claims()', 'product_events_profiles()', 'product_events_hotels()',
    'product_events_code_redemptions()', 'product_events_subscriptions()',
    'product_events_hotel_settings()', 'product_events_onboarding_states()',
    'product_events_pms_connections()', 'product_events_import_jobs()',
    'product_events_pricing_rules()', 'product_events_manual_price_insert()',
    'product_events_manual_price_update()', 'product_events_room_types()',
    'product_events_out_of_service()', 'product_events_pending_memberships()',
    'product_events_hotel_memberships()'
  ]
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

-- ── 5. Backfill ─────────────────────────────────────────────────────────────
--
-- Written straight into the table rather than through product_event_emit: it
-- is one pass, and a failure here should fail the migration loudly instead of
-- turning into a warning nobody reads. Every row's dedupe key starts with
-- 'backfill:', so the live triggers can never collide with it, and the whole
-- pass is skipped once anything else has been recorded.

do $backfill$
begin
  -- Once, into a log that has only ever been backfilled. The triggers above
  -- start recording in this same transaction, so a re-run after any real
  -- traffic would write a second copy of facts they already hold.
  if exists (select 1 from public.product_events where source <> 'backfill') then
    raise notice 'product_events already has live rows; backfill skipped';
    return;
  end if;

  -- Hotel context for rows whose hotel still exists.
  create temporary table _pe_ctx on commit drop as
  select h.id as hotel_id, c.*
    from public.hotels h
    cross join lateral public.product_event_hotel_context(h.id) c;

  -- Accounts.
  insert into public.product_events (occurred_at, event, user_id, source, is_test, dedupe_key, properties)
  select p.created_at, 'account.created', p.id, 'backfill',
         coalesce(u.email, '') like '%+%',
         'backfill:account.created:' || p.id,
         '{}'::jsonb
    from public.profiles p
    left join auth.users u on u.id = p.id
  on conflict (dedupe_key) do nothing;

  -- Onboarding path: the choice is recorded, the moment is not.
  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select coalesce(p.onboarding_dismissed_at, p.created_at), 'onboarding.path_chosen',
         sole.hotel_id, ctx.pms_type, ctx.pms_property_id, ctx.property_name, p.id,
         jsonb_build_object('path', p.onboarding_path::text, 'approximate', true),
         'backfill', coalesce(ctx.is_test, coalesce(u.email, '') like '%+%'),
         'backfill:onboarding.path_chosen:' || p.id
    from public.profiles p
    left join auth.users u on u.id = p.id
    left join lateral (
      select min(hm.hotel_id::text)::uuid as hotel_id
        from public.hotel_memberships hm
       where hm.user_id = p.id and hm.status = 'active'
      having count(*) = 1
    ) sole on true
    left join _pe_ctx ctx on ctx.hotel_id = sole.hotel_id
   where p.onboarding_path is not null
  on conflict (dedupe_key) do nothing;

  -- Marketplace connects. Every connect has logged pms.marketplace_pending since
  -- Flow A shipped, and the audit log keeps the row after the hotel is gone, so
  -- it is the better source; a claim with no audit row fills the gap.
  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select a.created_at, 'marketplace.connected', a.hid,
         coalesce(a.detail->>'pms_type', 'cloudbeds'),
         a.detail->>'property_id',
         coalesce(ctx.property_name, claim.property_name),
         null,
         jsonb_build_object(
           'group_key', a.detail->>'group_key',
           'group_size', (a.detail->>'group_properties')::int,
           -- The ticket lifetime in lib/pms/marketplace-connect.ts.
           'expires_at', a.created_at + interval '24 hours',
           'repeat', row_number() over (
             partition by coalesce(a.detail->>'pms_type', 'cloudbeds'), coalesce(a.detail->>'property_id', a.hid::text)
             order by a.created_at, a.id) > 1
         ),
         'backfill', coalesce(ctx.is_test, false),
         'backfill:marketplace.connected:audit:' || a.id
    from (
      select pae.*, case when pae.entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                         then pae.entity_id::uuid else pae.hotel_id end as hid
        from public.platform_audit_events pae
       where pae.event_type = 'pms.marketplace_pending'
    ) a
    left join _pe_ctx ctx on ctx.hotel_id = a.hid
    left join public.pms_marketplace_claims claim on claim.hotel_id = a.hid
  on conflict (dedupe_key) do nothing;

  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     properties, source, is_test, dedupe_key)
  select c.created_at, 'marketplace.connected', c.hotel_id, c.pms_type::text,
         substr(c.external_property_id, strpos(c.external_property_id, ':') + 1),
         c.property_name,
         jsonb_build_object(
           'group_key', c.group_key,
           'group_size', case when c.group_key is not null
             then array_length(string_to_array(split_part(c.group_key, ':group:', 2), ','), 1) end,
           'expires_at', c.expires_at,
           'repeat', false
         ),
         'backfill', coalesce(ctx.is_test, false),
         'backfill:marketplace.connected:claim:' || c.hotel_id || ':'
           || to_char(c.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')
    from public.pms_marketplace_claims c
    left join _pe_ctx ctx on ctx.hotel_id = c.hotel_id
   where not exists (
     select 1 from public.platform_audit_events a
      where a.event_type = 'pms.marketplace_pending' and a.entity_id = c.hotel_id::text
   )
  on conflict (dedupe_key) do nothing;

  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select c.claimed_at, 'marketplace.claim_redeemed', c.hotel_id, c.pms_type::text,
         substr(c.external_property_id, strpos(c.external_property_id, ':') + 1),
         coalesce(c.property_name, ctx.property_name), c.claimed_by,
         jsonb_build_object(
           'group_key', c.group_key,
           'group_size', case when c.group_key is not null
             then array_length(string_to_array(split_part(c.group_key, ':group:', 2), ','), 1) end,
           'hours_since_connect', round((extract(epoch from (c.claimed_at - c.created_at)) / 3600)::numeric, 2)
         ),
         'backfill', coalesce(ctx.is_test, false),
         'backfill:marketplace.claim_redeemed:' || c.hotel_id || ':' || c.pms_type::text
    from public.pms_marketplace_claims c
    left join _pe_ctx ctx on ctx.hotel_id = c.hotel_id
   where c.claimed_at is not null
  on conflict (dedupe_key) do nothing;

  -- Deferrals, disconnects, reconnects, classifications and removals only ever
  -- happened in the audit log.
  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select a.created_at,
         case a.event_type
           when 'pms.marketplace_deferred' then 'marketplace.deferred'
           when 'pms.marketplace_resumed' then 'marketplace.resumed'
           when 'pms.disconnected' then 'pms.disconnected'
           when 'pms.connected' then 'pms.reconnected'
           when 'room_type.classified' then 'room_type.classified'
           when 'membership.removed' then 'team.member_removed'
           when 'invite.revoked' then 'team.invite_revoked'
         end,
         a.hotel_id, coalesce(ctx.pms_type, a.detail->>'pms_type'), ctx.pms_property_id, ctx.property_name,
         case a.event_type
           when 'membership.removed' then (a.detail->>'user_id')::uuid
           when 'room_type.classified' then coalesce(a.actor_user_id, (a.detail->>'actor_user_id')::uuid)
           else coalesce(a.actor_user_id, (a.detail->>'actor_user_id')::uuid)
         end,
         case a.event_type
           when 'room_type.classified' then jsonb_build_object(
             'room_type_id', a.detail->>'room_type_id',
             'counts_as_room', (a.detail->>'after')::boolean,
             'previous', (a.detail->>'before')::boolean)
           when 'pms.disconnected' then jsonb_build_object('to_status', 'disconnected')
           when 'pms.connected' then jsonb_build_object('to_status', 'connected', 'via', a.detail->>'via')
           else '{}'::jsonb
         end,
         'backfill', coalesce(ctx.is_test, false),
         'backfill:audit:' || a.id
    from public.platform_audit_events a
    left join _pe_ctx ctx on ctx.hotel_id = a.hotel_id
   where a.event_type in ('pms.marketplace_deferred', 'pms.marketplace_resumed', 'pms.disconnected',
                          'room_type.classified', 'membership.removed', 'invite.revoked')
      or (a.event_type = 'pms.connected' and (a.detail->>'reconnect')::boolean is true)
  on conflict (dedupe_key) do nothing;

  -- A disconnected connection with no audit trail still left the property.
  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select c.updated_at, 'pms.disconnected', c.hotel_id, c.pms_type::text, ctx.pms_property_id, ctx.property_name,
         ctx.owner_user_id,
         jsonb_build_object('to_status', 'disconnected', 'approximate', true),
         'backfill', coalesce(ctx.is_test, false),
         'backfill:pms.disconnected:' || c.id
    from public.pms_connections c
    join _pe_ctx ctx on ctx.hotel_id = c.hotel_id
   where c.status = 'disconnected'
     and not exists (select 1 from public.product_events e
                      where e.hotel_id = c.hotel_id and e.event = 'pms.disconnected')
  on conflict (dedupe_key) do nothing;

  -- Properties: created, activated (Flow A logs the moment; otherwise the
  -- onboarding connect is the best evidence), went live.
  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select h.created_at, 'property.created', h.id, ctx.pms_type, ctx.pms_property_id, ctx.property_name,
         ctx.owner_user_id,
         jsonb_build_object('kind', case
           when h.external_enterprise_id like '%:%' and exists (
             select 1 from public.pms_marketplace_claims c where c.hotel_id = h.id) then 'marketplace_parked'
           when h.setup_pending_at is not null then 'checkout_placeholder'
           when exists (select 1 from public.hotel_subscriptions s
                         where s.hotel_id = h.id and s.plan_kind = 'stripe') then 'checkout_placeholder'
           else 'active'
         end, 'approximate', true),
         'backfill', ctx.is_test,
         'backfill:property.created:' || h.id
    from public.hotels h
    join _pe_ctx ctx on ctx.hotel_id = h.id
  on conflict (dedupe_key) do nothing;

  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select coalesce(act.created_at, os.connected_at, h.created_at), 'property.activated',
         h.id, ctx.pms_type, ctx.pms_property_id, ctx.property_name, ctx.owner_user_id,
         jsonb_build_object(
           'via', case
             when act.id is not null then 'marketplace'
             when os.connected_at is not null then 'checkout'
             else 'created' end,
           'approximate', act.id is null),
         'backfill', ctx.is_test,
         'backfill:property.activated:' || h.id
    from public.hotels h
    join _pe_ctx ctx on ctx.hotel_id = h.id
    left join public.onboarding_states os on os.hotel_id = h.id
    left join lateral (
      select a.id, a.created_at from public.platform_audit_events a
       where a.event_type = 'pms.marketplace_activated' and a.entity_id = h.id::text
       order by a.created_at asc limit 1
    ) act on true
   where h.is_active
  on conflict (dedupe_key) do nothing;

  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select hs.updated_at, 'property.went_live', hs.hotel_id, ctx.pms_type, ctx.pms_property_id, ctx.property_name,
         ctx.owner_user_id,
         jsonb_build_object('first_time', true, 'approximate', true),
         'backfill', ctx.is_test,
         'backfill:property.went_live:' || hs.hotel_id
    from public.hotel_settings hs
    join public.hotels h on h.id = hs.hotel_id and h.is_active
    join _pe_ctx ctx on ctx.hotel_id = hs.hotel_id
   where hs.simulation_mode = false
  on conflict (dedupe_key) do nothing;

  -- First PMS connection, from the onboarding record every connect path writes.
  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select os.connected_at, 'pms.connected', os.hotel_id, ctx.pms_type, ctx.pms_property_id, ctx.property_name,
         ctx.owner_user_id,
         jsonb_build_object('to_status', 'connected'),
         'backfill', ctx.is_test,
         'backfill:pms.connected:' || os.hotel_id
    from public.onboarding_states os
    join _pe_ctx ctx on ctx.hotel_id = os.hotel_id
   where os.connected_at is not null
  on conflict (dedupe_key) do nothing;

  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select m.at, m.event, os.hotel_id, ctx.pms_type, ctx.pms_property_id, ctx.property_name, ctx.owner_user_id,
         jsonb_build_object('path', os.path::text),
         'backfill', ctx.is_test,
         'backfill:' || m.event || ':' || os.hotel_id
    from public.onboarding_states os
    join _pe_ctx ctx on ctx.hotel_id = os.hotel_id
    cross join lateral (values
      ('onboarding.questions_completed', os.questions_completed_at),
      ('onboarding.review_completed', os.review_completed_at)
    ) as m(event, at)
   where m.at is not null
  on conflict (dedupe_key) do nothing;

  -- Signup codes.
  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select r.redeemed_at, 'signup_code.redeemed', r.hotel_id, ctx.pms_type, ctx.pms_property_id, ctx.property_name,
         r.user_id,
         jsonb_strip_nulls(jsonb_build_object(
           'code_id', sc.id, 'code', sc.code, 'kind', sc.kind::text,
           'percent_off', sc.percent_off, 'amount_off_cents', sc.amount_off_cents, 'trial_days', sc.trial_days)),
         'backfill', coalesce(ctx.is_test, false),
         'backfill:signup_code.redeemed:' || r.id
    from public.signup_code_redemptions r
    join public.signup_codes sc on sc.id = r.code_id
    left join _pe_ctx ctx on ctx.hotel_id = r.hotel_id
  on conflict (dedupe_key) do nothing;

  -- Subscriptions. The row only remembers where it is now; the nightly
  -- snapshot (hotel_metrics_daily) remembers one status per day since it
  -- started. The timeline is: what it was created as, each day the snapshot saw
  -- a different status, and where it is now. Everything but creation is
  -- approximate to the day.
  --
  -- What it was created as is not stored either. Checkout only makes a
  -- subscription once the card form is done, so it starts trialing when it has
  -- a trial and active when it does not; incomplete is the one start that says
  -- so for itself.
  create or replace function pg_temp.backfill_initial_status(p_status text, p_trial_end timestamptz, p_created timestamptz)
  returns text language sql immutable as $fn$
    select case
      when p_trial_end is not null and p_trial_end > p_created then 'trialing'
      when p_status in ('incomplete', 'incomplete_expired') then p_status
      else 'active'
    end
  $fn$;

  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select s.created_at, 'subscription.created', s.hotel_id, ctx.pms_type, ctx.pms_property_id, ctx.property_name,
         ctx.owner_user_id,
         jsonb_strip_nulls(jsonb_build_object(
           'status', pg_temp.backfill_initial_status(s.status, s.trial_end, s.created_at),
           'resubscribe', false,
           'plan_kind', s.plan_kind, 'billing_interval', s.billing_interval, 'billed_rooms', s.billed_rooms,
           'trial_end', s.trial_end, 'signup_code_id', s.signup_code_id)),
         'backfill', ctx.is_test,
         'backfill:subscription.created:' || s.hotel_id
    from public.hotel_subscriptions s
    join _pe_ctx ctx on ctx.hotel_id = s.hotel_id
  on conflict (dedupe_key) do nothing;

  with timeline as (
    select s.hotel_id, s.created_at as at,
           pg_temp.backfill_initial_status(s.status, s.trial_end, s.created_at) as status,
           0 as ord, false as approximate
      from public.hotel_subscriptions s
    union all
    select d.hotel_id, d.day::timestamptz, d.status, 1, true
      from public.hotel_metrics_daily d
      join public.hotel_subscriptions s on s.hotel_id = d.hotel_id
     where d.day::timestamptz >= date_trunc('day', s.created_at)
    union all
    -- A trial that has ended and is being paid for turned active when it ended.
    select s.hotel_id, s.trial_end, 'active', 2, true
      from public.hotel_subscriptions s
     where s.trial_end is not null and s.trial_end > s.created_at and s.trial_end <= now()
       and s.status in ('active', 'past_due')
       and not exists (select 1 from public.hotel_metrics_daily d where d.hotel_id = s.hotel_id)
    union all
    select s.hotel_id, greatest(s.updated_at, s.created_at), s.status, 3, true
      from public.hotel_subscriptions s
  ),
  ordered as (
    select t.*, lag(t.status) over (partition by t.hotel_id order by t.at, t.ord) as prev_status
      from timeline t
  )
  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select o.at, 'subscription.' || regexp_replace(lower(o.status), '[^a-z_]', '_', 'g'),
         o.hotel_id, ctx.pms_type, ctx.pms_property_id, ctx.property_name, ctx.owner_user_id,
         jsonb_strip_nulls(jsonb_build_object(
           'from_status', o.prev_status,
           'plan_kind', s.plan_kind, 'billing_interval', s.billing_interval, 'billed_rooms', s.billed_rooms,
           'trial_end', s.trial_end, 'signup_code_id', s.signup_code_id,
           'approximate', o.approximate)),
         'backfill', ctx.is_test,
         'backfill:subscription.status:' || o.hotel_id || ':' || o.status || ':'
           || to_char(o.at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')
    from ordered o
    join public.hotel_subscriptions s on s.hotel_id = o.hotel_id
    join _pe_ctx ctx on ctx.hotel_id = o.hotel_id
   where o.prev_status is null or o.prev_status <> o.status
  on conflict (dedupe_key) do nothing;

  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select s.updated_at, 'subscription.cancel_scheduled', s.hotel_id, ctx.pms_type, ctx.pms_property_id,
         ctx.property_name, ctx.owner_user_id,
         jsonb_strip_nulls(jsonb_build_object(
           'status', s.status, 'plan_kind', s.plan_kind, 'billed_rooms', s.billed_rooms,
           'current_period_end', s.current_period_end, 'approximate', true)),
         'backfill', ctx.is_test,
         'backfill:subscription.cancel_scheduled:' || s.hotel_id
    from public.hotel_subscriptions s
    join _pe_ctx ctx on ctx.hotel_id = s.hotel_id
   where s.cancel_at_period_end and s.status <> 'canceled'
  on conflict (dedupe_key) do nothing;

  -- Imports.
  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select m.at, m.event, j.hotel_id, j.pms_type::text, ctx.pms_property_id, ctx.property_name,
         coalesce(j.requested_by, ctx.owner_user_id),
         jsonb_strip_nulls(jsonb_build_object(
           'job_id', j.id,
           'kind', case when j.nth = 1 then 'initial' else 'refresh' end,
           'phase', j.phase, 'attempts', j.attempts,
           'duration_seconds', case when m.event <> 'import.started' and j.started_at is not null
             then round(extract(epoch from (coalesce(j.finished_at, j.updated_at) - j.started_at))::numeric) end,
           'rows_upserted', case when m.event <> 'import.started' then j.rows_upserted end,
           'reservations_enumerated', case when m.event <> 'import.started' then j.reservations_enumerated end,
           'windows_completed', case when m.event <> 'import.started' then j.windows_completed end,
           'error_kind', case when m.event = 'import.failed'
             then coalesce(public.product_event_error_kind(j.last_error), 'other') end)),
         'backfill', ctx.is_test,
         'backfill:' || m.event || ':' || j.id
    from (
      select ij.*, row_number() over (partition by ij.hotel_id order by ij.created_at, ij.id) as nth
        from public.import_jobs ij
    ) j
    join _pe_ctx ctx on ctx.hotel_id = j.hotel_id
    cross join lateral (values
      ('import.started', j.started_at),
      ('import.' || j.status::text,
       case when j.status::text in ('completed', 'failed', 'canceled') then coalesce(j.finished_at, j.updated_at) end)
    ) as m(event, at)
   where m.at is not null
  on conflict (dedupe_key) do nothing;

  -- Rules as they stand. Origin is inferred from the starter ladder's names.
  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select r.created_at, 'rule.created', r.hotel_id, ctx.pms_type, ctx.pms_property_id, ctx.property_name,
         r.created_by,
         jsonb_build_object(
           'rule_id', r.id,
           'origin', case when r.name in ('Slow-date rescue', 'Slow-date trim', 'Warm-date bump',
                                          'Hot-week surge', 'Sudden-spike catcher')
                          then 'starter' else 'owner' end,
           'is_active', r.is_active, 'is_pickup_rule', r.is_pickup_rule,
           'action_type', r.action_type, 'action_direction', r.action_direction,
           'approximate', true),
         'backfill', ctx.is_test,
         'backfill:rule.created:' || r.id
    from public.pricing_rules r
    join _pe_ctx ctx on ctx.hotel_id = r.hotel_id
  on conflict (dedupe_key) do nothing;

  -- Manual prices: one event per save, the same grain the statement triggers use.
  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select g.set_at, 'manual_price.set', g.hotel_id, ctx.pms_type, ctx.pms_property_id, ctx.property_name, g.set_by,
         jsonb_build_object('room_type_id', g.room_type_id, 'nights', g.nights,
                            'first_night', g.first_night, 'last_night', g.last_night,
                            'lead_days', g.first_night - (g.set_at at time zone 'UTC')::date),
         'backfill', ctx.is_test,
         'backfill:manual_price.set:' || g.hotel_id || ':' || g.room_type_id || ':'
           || to_char(g.set_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')
    from (
      select hotel_id, room_type_id, set_at, max(set_by::text)::uuid as set_by, count(*) as nights,
             min(stay_date) as first_night, max(stay_date) as last_night
        from public.manual_price
       group by hotel_id, room_type_id, set_at
    ) g
    join _pe_ctx ctx on ctx.hotel_id = g.hotel_id
  on conflict (dedupe_key) do nothing;

  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select g.cleared_at, 'manual_price.cleared', g.hotel_id, ctx.pms_type, ctx.pms_property_id, ctx.property_name,
         g.cleared_by,
         jsonb_build_object('room_type_id', g.room_type_id, 'nights', g.nights,
                            'first_night', g.first_night, 'last_night', g.last_night),
         'backfill', ctx.is_test,
         'backfill:manual_price.cleared:' || g.hotel_id || ':' || g.room_type_id || ':'
           || to_char(g.cleared_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')
    from (
      select hotel_id, room_type_id, cleared_at, max(cleared_by::text)::uuid as cleared_by, count(*) as nights,
             min(stay_date) as first_night, max(stay_date) as last_night
        from public.manual_price
       where cleared_at is not null
       group by hotel_id, room_type_id, cleared_at
    ) g
    join _pe_ctx ctx on ctx.hotel_id = g.hotel_id
  on conflict (dedupe_key) do nothing;

  -- Units out of service.
  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select m.at, m.event, o.hotel_id, ctx.pms_type, ctx.pms_property_id, ctx.property_name, m.user_id,
         m.props, 'backfill', ctx.is_test, 'backfill:' || m.event || ':' || o.id
    from public.room_type_out_of_service o
    join _pe_ctx ctx on ctx.hotel_id = o.hotel_id
    cross join lateral (values
      ('room_type.out_of_service_added', o.created_at, o.created_by,
       jsonb_build_object('room_type_id', o.room_type_id, 'units', o.units,
                          'nights', o.end_date - o.start_date + 1,
                          'starts_in_days', o.start_date - (o.created_at at time zone 'UTC')::date)),
      ('room_type.out_of_service_cleared', o.cleared_at, o.cleared_by,
       jsonb_build_object('room_type_id', o.room_type_id, 'units', o.units,
                          'cleared_early', (o.cleared_at at time zone 'UTC')::date < o.end_date))
    ) as m(event, at, user_id, props)
   where m.at is not null
  on conflict (dedupe_key) do nothing;

  -- Team.
  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select pm.invited_at, 'team.invited', pm.hotel_id, ctx.pms_type, ctx.pms_property_id, ctx.property_name,
         pm.invited_by, jsonb_build_object('role', pm.role::text, 'reinvite', false),
         'backfill', ctx.is_test, 'backfill:team.invited:' || pm.id
    from public.pending_memberships pm
    join _pe_ctx ctx on ctx.hotel_id = pm.hotel_id
  on conflict (dedupe_key) do nothing;

  insert into public.product_events (occurred_at, event, hotel_id, pms_type, pms_property_id, property_name,
                                     user_id, properties, source, is_test, dedupe_key)
  select hm.created_at, 'team.member_joined', hm.hotel_id, ctx.pms_type, ctx.pms_property_id, ctx.property_name,
         hm.user_id,
         jsonb_build_object(
           'role', hm.role::text,
           'first_member', row_number() over (partition by hm.hotel_id order by hm.created_at, hm.id) = 1,
           'via_invite', exists (
             select 1 from public.pending_memberships pm
              where pm.hotel_id = hm.hotel_id and pm.accepted_by = hm.user_id)),
         'backfill', ctx.is_test, 'backfill:team.member_joined:' || hm.id
    from public.hotel_memberships hm
    join _pe_ctx ctx on ctx.hotel_id = hm.hotel_id
  on conflict (dedupe_key) do nothing;
end
$backfill$;

commit;

-- Check afterwards:
--
--   select source, event, count(*), min(occurred_at), max(occurred_at)
--     from product_events group by 1, 2 order by 1, 2;
--
-- And that nothing an owner types leaked in (must return 0):
--
--   select count(*) from product_events
--    where properties::text ~* '@|"email"|"comment"|"note"|"reason_text"';
