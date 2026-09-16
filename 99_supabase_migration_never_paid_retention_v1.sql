-- ============================================================================
-- NEVER-PAID RETENTION — what happens to a claimed property that never pays
-- ============================================================================
--
-- A Marketplace property imports its booking history as soon as its owner
-- claims it (99_supabase_migration_import_at_claim_v1.sql), before anyone has
-- paid. Most will pay. The ones that do not leave behind seven years of their
-- bookings, a working PMS credential and a connection row, forever. Storage
-- is cheap and re-syncing is not, so the rule is to delete only what a
-- returning owner can get back by importing again, and to keep everything
-- they would otherwise have to set up again by hand.
--
-- never_paid_retention_sweep() does that, 180 days after the property last
-- saw a person.
--
-- WHICH PROPERTIES. All of these, checked again under a row lock just before
-- anything is deleted:
--   * a redeemed pms_marketplace_claims row points at the hotel;
--   * it has never paid: no hotel_subscriptions.first_paid_at
--     (99_supabase_migration_first_paid_at_v1.sql);
--   * it is not paying now: no subscription in trialing, active or past_due;
--   * it is not ours: no internal plan;
--   * it is not a live hotel with no subscription row at all (a hand-made or
--     keyless install, which billing never judges and neither does this);
--   * its last activity is more than 180 days ago, where last activity is the
--     latest of
--       - hotels.created_at,
--       - the claim's claimed_at,
--       - product_events caused by a person (product_event_by_person below:
--         anything from the browser, and the trigger events only a person can
--         cause, such as a claim, "Not now", a rule edit, a typed price, a
--         room answer, an invite, a checkout),
--       - platform_audit_events with an actor (actor_user_id, or the
--         detail.actor_user_id that service-role writes carry for the person
--         who asked).
--     Nothing a background job writes counts: syncs, imports, the analysis,
--     Stripe's own status changes, room truing and this sweep all leave the
--     clock alone, or it would never run out;
--   * it has not already been swept since that activity (hotels.data_purged_at);
--   * nothing is working on it right now: no import job holding a live lease
--     and no sync holding the connection's lease. Such a property is left for
--     tomorrow's run.
-- A property that is paying, trialing, past due, or has ever paid is never
-- touched, however long it has been quiet.
--
-- WHAT IS DELETED (re-fetchable by one import, or holding a credential):
--   reservations                   the imported booking history
--   published_price, occupancy_metrics, rule_applications,
--   ladder_rule_state              engine rows derived from it
--   import_jobs                    the import runs themselves
--   onboarding_findings            OPEN ones only (status 'proposed')
--   pms_connection_secrets         the stored credential, through
--                                  pms_secret_delete, which also removes the
--                                  Vault secret
--   pms_connections                the connection row
--   pending_memberships            invites nobody accepted (they hold emails)
--
-- WHAT IS KEPT, so a returning owner never onboards again:
--   hotels (the row, its name, timezone, currency, external_enterprise_id,
--   which is the reconnect key), hotel_memberships, accepted invites,
--   hotel_settings (strategy answers, simulation mode), pricing_rules and
--   their conditions and room-type scopes, room_types (every column,
--   counts_as_room and who answered it included), hotel_closed_periods,
--   assumption_challenges, manual_price, room_type_out_of_service,
--   base_rate_calendar, room_constraints, market_events, onboarding_states,
--   onboarding_findings the owner answered, the redeemed
--   pms_marketplace_claims row (activation needs it), hotel_subscriptions,
--   signup_code_redemptions, hotel_metrics_daily, platform_audit_events,
--   audit_events and product_events.
-- The time-limited engine tables (stay_date_snapshot, evaluation_audit,
-- evaluation_run_log, pms_request_log) are left to the sweeps that already
-- own them.
--
-- IN WHAT ORDER, per property, in one transaction:
--   1. product_events 'property.data_purged' (source 'sweep') with what is
--      about to go, BEFORE any delete. Keyed on the activity it measured from,
--      so a run that resumes a half-finished property does not record it
--      twice. If the event cannot be written, that property is skipped.
--   2. the credential, then the connection, then the import jobs (a worker
--      that still holds one loses its lease and stops writing).
--   3. open findings, unaccepted invites, derived engine rows.
--   4. reservations, in batches of p_batch with at most 40 batches a property,
--      so one enormous history cannot hold its locks for minutes; anything
--      left finishes tomorrow.
--   5. hotels.data_purged_at, LAST, and only once no reservation is left. A
--      property without it is not finished and is picked up again.
-- At most p_max_properties properties a run.
--
-- CONCURRENCY. The hotel row is locked FOR UPDATE SKIP LOCKED first, which is
-- the row activation's compare-and-set writes: a payment that is activating
-- the property right now wins and the sweep moves on; one that lands after the
-- lock waits for the sweep. The paid checks are re-read after the lock. What
-- remains is a first payment whose subscription row is written in the same
-- instant as a property's day-180 purge: it is recorded, the property goes
-- live, and its owner reconnects from the Marketplace to import again. Only
-- one sweep runs at a time (advisory lock).
--
-- LEFT BEHIND AT CLOUDBEDS: the app-state webhook subscription, for the same
-- reason the claim sweep leaves it (see its header): removing it needs the
-- credential this deletes, and Cloudbeds answers a delete without deleting. A
-- later uninstall POST finds no connection row and does nothing.
--
-- A RETURNING OWNER signs in to the same property with the same rules. Their
-- next Marketplace connect takes the reconnect branch (they are still a
-- member), stores a new credential, and the import is queued again when the
-- property is shown on the subscribe screen, or when it is paid for.
--
-- Service role only. Dry run lists what would go and writes nothing:
--   select public.never_paid_retention_sweep(p_dry_run => true);
--
-- Run AFTER 99_supabase_migration_product_events_v1.sql,
-- 99_supabase_migration_first_paid_at_v1.sql and
-- 99_supabase_migration_internal_plan_v1.sql. Idempotent.
-- Schedule with maya-rms/supabase/cron/never-paid-retention-sweep.sql.example.
--
-- Deploy order: independent of the app. Nothing in the app reads
-- data_purged_at; the sweep only acts on properties quiet for 180 days, so the
-- first real deletions are six months after eager import ships. Run the dry
-- run before scheduling it.
--
-- NOT mirrored into 02_supabase_schema.sql yet — fold it in on the next
-- schema consolidation pass.

begin;

alter table public.hotels
  add column if not exists data_purged_at timestamptz;

comment on column public.hotels.data_purged_at is
  'When never_paid_retention_sweep last finished deleting this never-paid property''s imported data. '
  'Written last, so null on a property whose sweep is still part-way through.';

-- Whether a product_events row was caused by a person rather than by a job.
-- The log's user_id cannot answer that: for system events it holds the
-- property's owner. Listed by name so a new event counts only once someone
-- decides it should.
create or replace function public.product_event_by_person(p_event text, p_source text, p_properties jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    -- /api/events: a signed-in browser session.
    when p_source = 'app' then true
    when p_source = 'sweep' then false
    when p_event in (
      'marketplace.claim_redeemed', 'marketplace.deferred', 'marketplace.resumed',
      'onboarding.path_chosen', 'onboarding.questions_completed', 'onboarding.review_completed',
      'property.went_live', 'property.back_to_simulation',
      'rule.enabled', 'rule.disabled', 'rule.edited', 'rule.deleted',
      'manual_price.set', 'manual_price.cleared',
      'room_type.classified', 'room_type.out_of_service_added', 'room_type.out_of_service_cleared',
      'team.invited', 'team.invite_revoked', 'team.member_joined', 'team.member_removed',
      'signup_code.redeemed', 'subscription.created',
      'subscription.cancel_scheduled', 'subscription.cancel_withdrawn'
    ) then true
    -- Starter rules are written by the import worker; the rest by a person.
    when p_event = 'rule.created' then coalesce(p_properties->>'origin', '') in ('owner', 'suggestion')
    else false
  end
$$;

-- The last time a person did anything with the property. Never earlier than
-- when it was created or claimed.
create or replace function public.never_paid_last_activity(p_hotel_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select greatest(
    h.created_at,
    (select max(mc.claimed_at) from public.pms_marketplace_claims mc where mc.hotel_id = h.id),
    (select max(e.occurred_at)
       from public.product_events e
      where e.hotel_id = h.id
        and public.product_event_by_person(e.event, e.source, e.properties)),
    (select max(a.created_at)
       from public.platform_audit_events a
      where a.hotel_id = h.id
        and (a.actor_user_id is not null or nullif(a.detail->>'actor_user_id', '') is not null))
  )
    from public.hotels h
   where h.id = p_hotel_id
$$;

-- Why a property is not due, or null when it is. The same test picks the work
-- list and re-checks each property under its lock.
create or replace function public.never_paid_retention_hold(p_hotel_id uuid, p_idle interval)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  h record;
  v_last timestamptz;
begin
  select id, is_active, data_purged_at into h from public.hotels where id = p_hotel_id;
  if not found then
    return 'gone';
  end if;
  if not exists (
    select 1 from public.pms_marketplace_claims mc
     where mc.hotel_id = h.id and mc.claimed_at is not null
  ) then
    return 'not_claimed_marketplace';
  end if;
  if exists (
    select 1 from public.hotel_subscriptions s
     where s.hotel_id = h.id
       and (s.first_paid_at is not null
            or s.status in ('trialing', 'active', 'past_due')
            or s.plan_kind = 'internal')
  ) then
    return 'paid';
  end if;
  if h.is_active and not exists (select 1 from public.hotel_subscriptions s where s.hotel_id = h.id) then
    return 'live_without_billing';
  end if;
  v_last := public.never_paid_last_activity(h.id);
  if v_last >= now() - p_idle then
    return 'recent_activity';
  end if;
  if h.data_purged_at is not null and h.data_purged_at >= v_last then
    return 'already_purged';
  end if;
  if exists (
    select 1 from public.import_jobs j
     where j.hotel_id = h.id and j.status = 'running' and j.lease_expires_at > now()
  ) then
    return 'import_running';
  end if;
  if exists (
    select 1 from public.pms_connections c
     where c.hotel_id = h.id and c.sync_lease_until > now()
  ) then
    return 'sync_running';
  end if;
  return null;
end;
$$;

-- What a purge of this property would delete, table by table.
create or replace function public.never_paid_retention_counts(p_hotel_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'reservations', (select count(*) from public.reservations where hotel_id = p_hotel_id),
    'published_price', (select count(*) from public.published_price where hotel_id = p_hotel_id),
    'occupancy_metrics', (select count(*) from public.occupancy_metrics where hotel_id = p_hotel_id),
    'rule_applications', (select count(*) from public.rule_applications where hotel_id = p_hotel_id),
    'ladder_rule_state', (select count(*) from public.ladder_rule_state l
                           where l.rule_id in (select r.id from public.pricing_rules r where r.hotel_id = p_hotel_id)),
    'import_jobs', (select count(*) from public.import_jobs where hotel_id = p_hotel_id),
    'open_findings', (select count(*) from public.onboarding_findings
                       where hotel_id = p_hotel_id and status = 'proposed'),
    'credentials', (select count(*) from public.pms_connection_secrets where hotel_id = p_hotel_id),
    'connections', (select count(*) from public.pms_connections where hotel_id = p_hotel_id),
    'unaccepted_invites', (select count(*) from public.pending_memberships
                            where hotel_id = p_hotel_id and status <> 'accepted')
  )
$$;

-- Deletes one due property's Tier 2 data. The caller holds the hotel row lock.
create or replace function public.never_paid_retention_purge(
  p_hotel_id uuid,
  p_last_activity timestamptz,
  p_batch integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prev_role text := current_setting('request.jwt.claim.role', true);
  v_counts jsonb := public.never_paid_retention_counts(p_hotel_id);
  v_key text := 'property.data_purged:' || p_hotel_id || ':'
    || to_char(p_last_activity at time zone 'UTC', 'YYYYMMDDHH24MISSUS');
  v_hotel record;
  v_sub record;
  v_pms public.pms_type;
  v_n integer;
  v_passes integer := 0;
  v_left bigint;
begin
  select is_active, created_at into v_hotel from public.hotels where id = p_hotel_id;
  select status into v_sub from public.hotel_subscriptions where hotel_id = p_hotel_id;

  if public.product_event_emit(
       'property.data_purged', p_hotel_id, null,
       jsonb_build_object(
         'last_activity_at', p_last_activity,
         'idle_days', round((extract(epoch from (now() - p_last_activity)) / 86400)::numeric, 1),
         'was_active', v_hotel.is_active,
         'subscription_status', v_sub.status,
         'deleted', v_counts
       ),
       'sweep', now(), v_key
     ) is null
     and not exists (select 1 from public.product_events where dedupe_key = v_key) then
    return jsonb_build_object('skipped', 'event_not_recorded');
  end if;

  -- pms_secret_delete answers only to the service role, and cron runs with no
  -- JWT at all, so the role is set for the call and put back straight after.
  perform set_config('request.jwt.claim.role', 'service_role', true);
  for v_pms in
    select s.pms_type from public.pms_connection_secrets s where s.hotel_id = p_hotel_id
  loop
    perform public.pms_secret_delete(p_hotel_id, v_pms);
  end loop;
  perform set_config('request.jwt.claim.role', coalesce(v_prev_role, ''), true);

  delete from public.pms_connections where hotel_id = p_hotel_id;
  delete from public.import_jobs where hotel_id = p_hotel_id;
  delete from public.onboarding_findings where hotel_id = p_hotel_id and status = 'proposed';
  delete from public.pending_memberships where hotel_id = p_hotel_id and status <> 'accepted';
  delete from public.ladder_rule_state
   where rule_id in (select r.id from public.pricing_rules r where r.hotel_id = p_hotel_id);
  delete from public.rule_applications where hotel_id = p_hotel_id;
  delete from public.occupancy_metrics where hotel_id = p_hotel_id;
  delete from public.published_price where hotel_id = p_hotel_id;

  loop
    delete from public.reservations
     where id in (
       select r.id from public.reservations r where r.hotel_id = p_hotel_id limit p_batch
     );
    get diagnostics v_n = row_count;
    v_passes := v_passes + 1;
    exit when v_n < p_batch or v_passes >= 40;
  end loop;

  select count(*) into v_left from public.reservations where hotel_id = p_hotel_id;
  if v_left > 0 then
    return jsonb_build_object('deleted', v_counts, 'finished', false, 'reservations_left', v_left);
  end if;

  update public.hotels set data_purged_at = now() where id = p_hotel_id;
  return jsonb_build_object('deleted', v_counts, 'finished', true);
end;
$$;

create or replace function public.never_paid_retention_sweep(
  p_idle interval default interval '180 days',
  p_dry_run boolean default false,
  p_batch integer default 50000,
  p_max_properties integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hotel uuid;
  v_hold text;
  v_last timestamptz;
  v_result jsonb;
  v_due jsonb := '[]'::jsonb;
  v_purged jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
begin
  -- A typo here deletes a live property's history, so the window has a floor.
  if p_idle is null or p_idle < interval '30 days' then
    raise exception 'idle window must be at least 30 days' using errcode = '22023';
  end if;
  if p_batch is null or p_batch < 1 or p_max_properties is null or p_max_properties < 1 then
    raise exception 'batch and max properties must be positive' using errcode = '22023';
  end if;

  if not pg_try_advisory_xact_lock(hashtext('public.never_paid_retention_sweep')) then
    return jsonb_build_object('dry_run', p_dry_run, 'skipped', 'another sweep is running');
  end if;

  perform set_config('maya.event_source', 'sweep', true);

  for v_hotel, v_last in
    select h.id, public.never_paid_last_activity(h.id) as last_activity
      from public.hotels h
     where exists (
             select 1 from public.pms_marketplace_claims mc
              where mc.hotel_id = h.id and mc.claimed_at is not null
           )
       and public.never_paid_retention_hold(h.id, p_idle) is null
     order by 2
     limit p_max_properties
  loop
    if p_dry_run then
      v_due := v_due || jsonb_build_object(
        'hotel_id', v_hotel,
        'last_activity_at', v_last,
        'would_delete', public.never_paid_retention_counts(v_hotel)
      );
      continue;
    end if;

    -- Whoever holds the row (an activation, say) wins; this property waits.
    perform 1 from public.hotels where id = v_hotel for update skip locked;
    if not found then
      v_skipped := v_skipped || jsonb_build_object('hotel_id', v_hotel, 'reason', 'locked');
      continue;
    end if;
    v_hold := public.never_paid_retention_hold(v_hotel, p_idle);
    if v_hold is not null then
      v_skipped := v_skipped || jsonb_build_object('hotel_id', v_hotel, 'reason', v_hold);
      continue;
    end if;

    v_result := public.never_paid_retention_purge(v_hotel, public.never_paid_last_activity(v_hotel), p_batch);
    if v_result ? 'skipped' then
      v_skipped := v_skipped || jsonb_build_object('hotel_id', v_hotel, 'reason', v_result->>'skipped');
    else
      v_purged := v_purged || (jsonb_build_object('hotel_id', v_hotel) || v_result);
    end if;
  end loop;

  return jsonb_strip_nulls(jsonb_build_object(
    'dry_run', p_dry_run,
    'idle', p_idle::text,
    'would_purge', case when p_dry_run then v_due end,
    'purged', case when not p_dry_run then v_purged end,
    'skipped', case when not p_dry_run then v_skipped end
  ));
end;
$$;

revoke all on function public.product_event_by_person(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.never_paid_last_activity(uuid) from public, anon, authenticated;
revoke all on function public.never_paid_retention_hold(uuid, interval) from public, anon, authenticated;
revoke all on function public.never_paid_retention_counts(uuid) from public, anon, authenticated;
revoke all on function public.never_paid_retention_purge(uuid, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.never_paid_retention_sweep(interval, boolean, integer, integer) from public, anon, authenticated;
grant execute on function public.never_paid_retention_sweep(interval, boolean, integer, integer) to service_role;

commit;

-- Preview, deleting and recording nothing:
--
--   select public.never_paid_retention_sweep(p_dry_run => true);
--
-- Why one property is or is not due (null = due):
--
--   select public.never_paid_retention_hold('<hotel id>', interval '180 days'),
--          public.never_paid_last_activity('<hotel id>');
--
-- What was swept:
--
--   select occurred_at, property_name, properties
--     from product_events where event = 'property.data_purged'
--    order by occurred_at desc limit 20;
