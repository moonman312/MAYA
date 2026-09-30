-- ============================================================================
-- MAYA: room types that are not rooms and the hotel-wide floor answer
-- ============================================================================
--
-- The five questions ask for the lowest rate the owner would take for a ROOM.
-- The answer used to be written as the floor of every active room type, a
-- $15 parking bay or a meeting room included, and the engine then priced the
-- parking at the room floor. On a live hotel that price would have been sent
-- to the property system. The code no longer writes the answer onto a type
-- unticked as a room (project-strategy.ts), and the send step holds back a
-- price for such a type unless a rule of the hotel's names it under "Change"
-- (guardrail:not_a_room, rate-push.ts). This file puts right what the old
-- code already wrote, and teaches Pilot health about the new hold.
--
-- 1. Floors the answer wrote onto non-rooms are put back to the default.
--    A room type is put back when, and only when, all of these hold:
--      * the owner (or the import's proposal) has it unticked as a room
--        (room_types.counts_as_room = false);
--      * its floor equals the hotel's saved floor answer
--        (hotel_settings.strategy_floor), and is not already the 1.00 default;
--      * no floor suggestion card was accepted for it (onboarding_findings,
--        kind guardrail_suggestion, status confirmed, field floor_price):
--        that card offers the owner's answer, and accepting it is the owner
--        setting the floor on purpose.
--    There is no floor editor in the app, so a floor equal to the answer on a
--    type nobody counts as a room came from the answer, with one exception
--    this file cannot see: a floor set by hand in the SQL editor to exactly
--    the hotel-wide answer. Each change is written to platform_audit_events
--    as room_type.floor_cleared with the value it had, so any one of them
--    can be put back by hand. A notice says how many rows changed.
--    Ceilings are left alone: a hotel-wide ceiling on a parking bay never
--    raises its price. The room_types update fires the cadence trigger, so
--    each hotel touched is priced again on its next tick.
--
-- 2. platform_pilot_health() (v3) leaves the nights held as
--    guardrail:not_a_room out of unsent_count: the property system keeps its
--    own rate for such a type, so nothing is waiting to be sent. Same
--    columns, same check (platform admin or the service role), same grants.
--
-- 3. A notice per room type unticked as a room that MAYA has already sent a
--    rate to for a night from today on (rate_updates: sent, or tried at
--    least once), with the hotel, the nights and the last rate sent. The hold
--    keeps every further send for such a type back, so a rate MAYA sent
--    before this stays in the property system until somebody sets it back
--    there by hand: this names them. Reads only.
--
-- What an owner may notice: a parking bay, court or meeting room that was
-- shown at the room floor in the Rate Simulator goes back to its own rate on
-- the next pricing run. Nothing is sent to the property system for it.
--
-- Run AFTER 99_supabase_migration_pilot_health_v2.sql and
-- 99_supabase_migration_room_type_counts_as_room_v1.sql. One transaction.
-- Idempotent: a second run finds no floor to clear and recreates the same
-- function. Deploy the app and the scheduled syncs before or after; the
-- function's columns do not change.
-- ============================================================================

begin;

-- 1. Floors the hotel-wide answer wrote onto types that are not rooms.
do $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select rt.id, rt.hotel_id, rt.name, rt.display_name, rt.floor_price, hs.strategy_floor
      from public.room_types rt
      join public.hotel_settings hs on hs.hotel_id = rt.hotel_id
     where rt.counts_as_room = false
       and hs.strategy_floor is not null
       and rt.floor_price = hs.strategy_floor
       and rt.floor_price <> 1.00
       and not exists (
         select 1
           from public.onboarding_findings f
          where f.hotel_id = rt.hotel_id
            and f.kind = 'guardrail_suggestion'
            and f.status = 'confirmed'
            and f.payload->>'room_type_id' = rt.id::text
            and f.payload->>'field' = 'floor_price'
       )
     order by rt.hotel_id, rt.id
  loop
    update public.room_types set floor_price = 1.00 where id = r.id;
    insert into public.platform_audit_events
      (actor_user_id, event_type, entity_type, entity_id, hotel_id, detail)
    values (
      null,
      'room_type.floor_cleared',
      'room_type',
      r.id::text,
      r.hotel_id,
      jsonb_build_object(
        'room_type_id', r.id,
        'name', coalesce(r.display_name, r.name, ''),
        'before', r.floor_price,
        'after', 1.00,
        'strategy_floor', r.strategy_floor,
        'reason', 'the hotel-wide floor answer had been written onto a room type unticked as a room',
        'via', '99_supabase_migration_non_room_types_v1.sql'
      )
    );
    n := n + 1;
  end loop;
  raise notice 'non_room_types_v1: put % floor(s) on room types unticked as rooms back to the 1.00 default', n;
end $$;

-- 2. Pilot health v3: the nights held as guardrail:not_a_room are not waiting.
-- Dropped first: a function's column list cannot be changed in place. The
-- grants are restated below.
drop function if exists public.platform_pilot_health(boolean);

create function public.platform_pilot_health(
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
  rate_read_waiting_since timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.is_platform_admin() then
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
      rr.rate_read_waiting_since
    from public.hotels h
    left join public.hotel_settings hs on hs.hotel_id = h.id
    left join public.hotel_subscriptions s on s.hotel_id = h.id
    left join lateral (
      select c.pms_type, c.status, c.last_sync_at, c.down_since, c.sync_failures
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
  'rule names are not waiting). Read by /admin/pilot-health. Platform admins '
  'and the service role only.';

revoke all on function public.platform_pilot_health(boolean) from public, anon;
grant execute on function public.platform_pilot_health(boolean) to authenticated, service_role;

-- 3. What this file cannot put right: a rate MAYA already sent to the property
--    system for a type unticked as a room (the room floor on a parking bay,
--    say). The hold from here on keeps every further send for that type back,
--    so the rate MAYA sent stays in the property system until a person sets
--    it back. One notice per such type, for the person running this file to
--    check in the property system and set by hand. Reads only; nothing
--    changes.
do $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select h.name as hotel_name, rt.hotel_id, rt.id, coalesce(rt.display_name, rt.name, '') as type_name,
           ru.pms_type,
           count(*) as nights,
           min(ru.stay_date) as first_night,
           max(ru.stay_date) as last_night,
           max(ru.pushed_at) as last_sent_at,
           (array_agg(ru.price order by ru.pushed_at desc nulls last))[1] as last_price
      from public.rate_updates ru
      join public.room_types rt on rt.id = ru.room_type_id
      join public.hotels h on h.id = rt.hotel_id
     where rt.counts_as_room = false
       and ru.stay_date >= current_date
       and (ru.status = 'sent' or ru.attempts >= 1)
     group by h.name, rt.hotel_id, rt.id, rt.display_name, rt.name, ru.pms_type
     order by h.name, type_name
  loop
    raise notice 'non_room_types_v1: MAYA has sent a rate to "%" (%, not a room, %) for % night(s) from % to %, last % at %: check its rate in the property system and set it back by hand',
      r.type_name, r.hotel_name, r.pms_type, r.nights, r.first_night, r.last_night, r.last_price, r.last_sent_at;
    n := n + 1;
  end loop;
  raise notice 'non_room_types_v1: % room type(s) unticked as rooms hold a rate MAYA sent, for nights from today on', n;
end $$;

commit;

-- At a prompt (the SQL editor has no signed-in caller, so it acts as the
-- service role for this one transaction):
--
--   begin;
--   select set_config('request.jwt.claim.role', 'service_role', true);
--   select name, mode, pms_type, sent_24h, unsent_count, unsent_since
--     from platform_pilot_health();
--   commit;
--
-- What was put back, and to what:
--
--   select hotel_id, entity_id as room_type_id, detail->>'name' as name,
--          detail->>'before' as floor_before, created_at
--     from platform_audit_events
--    where event_type = 'room_type.floor_cleared'
--    order by created_at desc;
