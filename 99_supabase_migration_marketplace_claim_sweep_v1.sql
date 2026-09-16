-- ============================================================================
-- MARKETPLACE CLAIM SWEEP — clear away connections nobody ever claimed
-- ============================================================================
--
-- A Cloudbeds Marketplace connect parks a property before anyone owns it: a
-- hotel row (is_active false, setup_pending_at set), the OAuth grant in the
-- Vault, a 'pending' pms_connections row, and a claim ticket that expires
-- after 24 hours (lib/pms/marketplace-connect.ts). When nobody redeems the
-- ticket, all of that stays forever: an unowned, working credential for
-- someone else's property, and a hotel row in every admin list.
--
-- marketplace_claim_sweep() removes it, one expired unredeemed claim at a time:
--
--   1. Records marketplace.claim_expired in product_events FIRST, carrying what
--      the walked-away metrics need (when it connected, when the ticket
--      expired, the group it belonged to), so the fact outlives the delete.
--   2. Finds the parked hotels that connect created: the claim's own hotel,
--      plus every group sibling, found through the group key (which lists the
--      group's property ids) because a sibling whose claim insert failed has
--      no claim row of its own to be found by.
--   3. Deletes each of those hotels ONLY if it is still untouched: still
--      parked; no membership, invite, subscription or import job; no claim on
--      it that is redeemed or not yet past the grace period; and neither the
--      hotel nor its connection created or written inside the grace period.
--      The credential goes through pms_secret_delete, then its pms_connections
--      rows, its claims, and the hotel, whose delete cascades the rest.
--   4. Separately, a parked Marketplace hotel with no claim row at all (its
--      claim insert failed at connect time, so it could never be claimed) is
--      removed on the same test once it is older than the grace period.
--
-- A claim whose own hotel is touched is left exactly as it is, event aside.
-- That should not happen, since a membership is what redeeming writes, so the
-- summary names the hotel for a person to look at.
--
-- WHY A 3-DAY GRACE after the ticket's own 24 hours:
--   * Weekends. A Friday-evening connect expires on Saturday; the owner who
--     comes back on Monday should find the connection as they left it, and
--     whoever follows up on this week's walk-aways should still see it.
--   * Races. Redeeming checks expiry against the app server's clock and the
--     sweep checks it against the database's. A margin of days rather than
--     minutes makes clock skew and a claim in flight at the boundary moot.
--   * No longer than that, because what is being kept is a working OAuth
--     grant to a property no MAYA user owns. Four days end to end is long
--     enough to be kind and short enough to be tidy.
--   Pass another interval to change it for one run.
--
-- WHAT IS LEFT BEHIND: the Cloudbeds app-state webhook subscription connect
-- registered (lib/pms/cloudbeds-webhooks.ts). It holds no data; it is
-- Cloudbeds' promise to POST us if the property uninstalls the app. After the
-- sweep that POST reaches /api/pms/cloudbeds/webhook/<deleted hotel id>,
-- passes the signature check (the HMAC is over the id, not the row), and
-- finds no connection to mark, which markConnectionDisconnected treats as
-- nothing to do: no update, no alert, no audit line. A property that
-- reconnects gets a new hotel id and a new subscription; the old URL is just
-- never called again. Removing the subscription too cannot happen in SQL,
-- because it needs the grant this deletes: a server-side job would have to
-- read the credential first, call cloudbedsDeleteWebhook (object integration,
-- action appstate_changed, the signed URL for that hotel id), and only then
-- let the sweep run. Even that is a request rather than a guarantee, since
-- Cloudbeds' deleteWebhook answers success without deleting (see its note in
-- _shared/cloudbeds/client.ts).
--
-- Service role only. Idempotent: a swept claim is gone, a skipped one
-- re-emits nothing (the event has a dedupe key), and a run is one transaction.
--
-- Run AFTER 99_supabase_migration_product_events_v1.sql. Schedule with
-- maya-rms/supabase/cron/marketplace-claim-sweep.sql.example.

begin;

-- Whether a parked hotel can be removed without taking anything anyone made.
-- Every clause is a way a property could have been touched by a person or by
-- a payment; the time clauses keep a connect that is running right now out.
create or replace function public.marketplace_claim_sweep_untouched(p_hotel_id uuid, p_cutoff timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.hotels h
     where h.id = p_hotel_id
       and h.setup_pending_at is not null
       and h.is_active = false
       and h.created_at < p_cutoff
       and h.updated_at < p_cutoff
       and not exists (select 1 from public.hotel_memberships m where m.hotel_id = h.id)
       and not exists (select 1 from public.pending_memberships pm where pm.hotel_id = h.id)
       and not exists (select 1 from public.hotel_subscriptions s where s.hotel_id = h.id)
       and not exists (select 1 from public.import_jobs j where j.hotel_id = h.id)
       and not exists (
         select 1 from public.pms_marketplace_claims mc
          where mc.hotel_id = h.id
            and (mc.claimed_at is not null or mc.expires_at >= p_cutoff)
       )
       and not exists (
         select 1 from public.pms_connections pc
          where pc.hotel_id = h.id
            and (pc.updated_at >= p_cutoff or pc.created_at >= p_cutoff)
       )
  )
$$;

-- The fact the walked-away metrics need, written before anything is deleted.
-- One per claim, keyed so a re-run or a second path to the same claim (the
-- claim's own row, or a sibling's removal) records it once.
create or replace function public.marketplace_claim_sweep_record(p_token text, p_removed boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id bigint;
begin
  select public.product_event_emit(
           'marketplace.claim_expired', mc.hotel_id, null,
           jsonb_build_object(
             'connected_at', mc.created_at,
             'expires_at', mc.expires_at,
             'group_key', mc.group_key,
             'group_size', case when mc.group_key is not null
               then array_length(string_to_array(split_part(mc.group_key, ':group:', 2), ','), 1) end,
             'removed', p_removed
           ),
           'sweep', mc.expires_at,
           'marketplace.claim_expired:' || mc.hotel_id || ':'
             || to_char(mc.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
           mc.pms_type::text,
           substr(mc.external_property_id, strpos(mc.external_property_id, ':') + 1),
           mc.property_name
         )
    into v_id
    from public.pms_marketplace_claims mc
   where mc.token = p_token;
  return v_id is not null;
end;
$$;

-- Removes one hotel the untouched test passed, credential first. Returns what
-- it removed. pms_secret_delete only answers to the service role, and a cron
-- job runs as the database owner with no JWT at all, so the role is set for
-- the call and put back straight after.
create or replace function public.marketplace_claim_sweep_remove(p_hotel_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prev_role text := current_setting('request.jwt.claim.role', true);
  v_pms public.pms_type;
  v_token text;
  v_events int := 0;
  v_credentials int := 0;
  v_connections int := 0;
  v_claims int := 0;
  v_hotels int := 0;
begin
  -- Locked before anything is removed; a writer already holding it wins.
  perform 1 from public.hotels where id = p_hotel_id for update skip locked;
  if not found then
    return jsonb_build_object('hotels', 0);
  end if;

  for v_token in
    select mc.token from public.pms_marketplace_claims mc where mc.hotel_id = p_hotel_id
  loop
    if public.marketplace_claim_sweep_record(v_token, true) then
      v_events := v_events + 1;
    end if;
  end loop;

  perform set_config('request.jwt.claim.role', 'service_role', true);
  for v_pms in
    select s.pms_type from public.pms_connection_secrets s where s.hotel_id = p_hotel_id
  loop
    if public.pms_secret_delete(p_hotel_id, v_pms) then
      v_credentials := v_credentials + 1;
    end if;
  end loop;
  perform set_config('request.jwt.claim.role', coalesce(v_prev_role, ''), true);

  delete from public.pms_connections where hotel_id = p_hotel_id;
  get diagnostics v_connections = row_count;
  delete from public.pms_marketplace_claims where hotel_id = p_hotel_id;
  get diagnostics v_claims = row_count;
  delete from public.hotels where id = p_hotel_id;
  get diagnostics v_hotels = row_count;

  return jsonb_build_object(
    'hotels', v_hotels, 'events', v_events, 'credentials', v_credentials,
    'connections', v_connections, 'claims', v_claims
  );
end;
$$;

create or replace function public.marketplace_claim_sweep(
  p_grace interval default interval '3 days',
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cutoff timestamptz;
  v_tokens text[];
  v_token text;
  c record;
  v_hotel uuid;
  v_removed jsonb;
  v_expired int := 0;
  v_events int := 0;
  v_hotels_deleted int := 0;
  v_siblings_deleted int := 0;
  v_orphans_deleted int := 0;
  v_credentials int := 0;
  v_connections int := 0;
  v_claims int := 0;
  v_would_delete jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
begin
  if p_grace is null or p_grace < interval '0' then
    raise exception 'grace must be zero or more' using errcode = '22023';
  end if;
  v_cutoff := now() - p_grace;

  -- Rows the deletes themselves cause (property.deleted) say where they came from.
  perform set_config('maya.event_source', 'sweep', true);

  -- The work list is fixed up front. Removing a group sibling deletes that
  -- sibling's own claim, so a later entry may already be gone by its turn,
  -- which the per-claim re-read below simply finds.
  select coalesce(array_agg(mc.token order by mc.expires_at), '{}')
    into v_tokens
    from public.pms_marketplace_claims mc
   where mc.claimed_at is null
     and mc.expires_at < v_cutoff;

  foreach v_token in array v_tokens loop
    -- A connect running right now deletes and re-inserts its claim. Never
    -- wait on it and never sweep what it is holding.
    select mc.token, mc.hotel_id, mc.pms_type, mc.group_key
      into c
      from public.pms_marketplace_claims mc
     where mc.token = v_token
       and mc.claimed_at is null
       and mc.expires_at < v_cutoff
       for update skip locked;
    if not found then
      continue;
    end if;
    v_expired := v_expired + 1;

    if not public.marketplace_claim_sweep_untouched(c.hotel_id, v_cutoff) then
      if not p_dry_run and public.marketplace_claim_sweep_record(c.token, false) then
        v_events := v_events + 1;
      end if;
      v_skipped := v_skipped || jsonb_build_object('hotel_id', c.hotel_id, 'reason', 'touched');
      continue;
    end if;

    -- The claim's own hotel, then its group siblings by property id.
    for v_hotel in
      select c.hotel_id
      union
      select hs.id
        from public.hotels hs
       where c.group_key is not null
         and hs.id <> c.hotel_id
         and hs.external_enterprise_id in (
           select c.pms_type::text || ':' || btrim(pid)
             from unnest(string_to_array(split_part(c.group_key, ':group:', 2), ',')) as pid
         )
    loop
      if not public.marketplace_claim_sweep_untouched(v_hotel, v_cutoff) then
        v_skipped := v_skipped || jsonb_build_object('hotel_id', v_hotel, 'reason', 'sibling_touched');
        continue;
      end if;
      if p_dry_run then
        v_would_delete := v_would_delete || to_jsonb(v_hotel);
        continue;
      end if;
      v_removed := public.marketplace_claim_sweep_remove(v_hotel);
      if coalesce((v_removed->>'hotels')::int, 0) > 0 then
        if v_hotel = c.hotel_id then
          v_hotels_deleted := v_hotels_deleted + 1;
        else
          v_siblings_deleted := v_siblings_deleted + 1;
        end if;
      end if;
      v_events := v_events + coalesce((v_removed->>'events')::int, 0);
      v_credentials := v_credentials + coalesce((v_removed->>'credentials')::int, 0);
      v_connections := v_connections + coalesce((v_removed->>'connections')::int, 0);
      v_claims := v_claims + coalesce((v_removed->>'claims')::int, 0);
    end loop;
  end loop;

  -- Parked Marketplace hotels no claim points at. Only the namespaced
  -- external id marks a Marketplace arrival; Flow B's checkout placeholder has
  -- none and is never touched here.
  for v_hotel in
    select h.id
      from public.hotels h
     where h.setup_pending_at is not null
       and h.is_active = false
       and h.external_enterprise_id like '%:%'
       and not exists (select 1 from public.pms_marketplace_claims mc where mc.hotel_id = h.id)
     order by h.created_at
  loop
    if not public.marketplace_claim_sweep_untouched(v_hotel, v_cutoff) then
      continue;
    end if;
    if p_dry_run then
      -- A group sibling with no claim of its own was already listed above.
      if not v_would_delete ? v_hotel::text then
        v_would_delete := v_would_delete || to_jsonb(v_hotel);
      end if;
      continue;
    end if;
    v_removed := public.marketplace_claim_sweep_remove(v_hotel);
    v_orphans_deleted := v_orphans_deleted + coalesce((v_removed->>'hotels')::int, 0);
    v_credentials := v_credentials + coalesce((v_removed->>'credentials')::int, 0);
    v_connections := v_connections + coalesce((v_removed->>'connections')::int, 0);
  end loop;

  return jsonb_strip_nulls(jsonb_build_object(
    'dry_run', p_dry_run,
    'grace', p_grace::text,
    'expired_claims', v_expired,
    'events_recorded', v_events,
    'hotels_deleted', v_hotels_deleted,
    'siblings_deleted', v_siblings_deleted,
    'orphans_deleted', v_orphans_deleted,
    'credentials_deleted', v_credentials,
    'connections_deleted', v_connections,
    'claims_deleted', v_claims,
    'would_delete', case when p_dry_run then v_would_delete end,
    'skipped', v_skipped
  ));
end;
$$;

revoke all on function public.marketplace_claim_sweep_untouched(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.marketplace_claim_sweep_record(text, boolean) from public, anon, authenticated;
revoke all on function public.marketplace_claim_sweep_remove(uuid) from public, anon, authenticated;
revoke all on function public.marketplace_claim_sweep(interval, boolean) from public, anon, authenticated;
grant execute on function public.marketplace_claim_sweep(interval, boolean) to service_role;

commit;

-- Preview without deleting or recording anything:
--
--   select public.marketplace_claim_sweep(interval '3 days', true);
