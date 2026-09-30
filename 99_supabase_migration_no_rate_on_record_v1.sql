-- ============================================================================
-- MAYA: a night with no rate on record from the PMS is not priced (A6), v1
-- ============================================================================
--
-- Decided by Jake on 2026-09-29 (audit item A6): a night that has no rate on
-- record from the property system, and no typed price, stays unpriced and is
-- never sent, until the property system has a rate for it. It must never be
-- priced from what the latest guest paid. The engine and the push do that in
-- code (engine/base-price.ts, pms/push-guardrails.ts). This file gives them
-- the one fact they need that the database did not hold, and shows the
-- result on the Pilot health page.
--
--   1. pms_connections.base_rates_returned_through: the last night the
--      property system actually returned a rate for on its last read of the
--      hotel's own rates (pms/base-rate-calendar.ts). Until now only the last
--      night the read ASKED for was recorded (base_rates_through), so a night
--      the property system has no rate for could keep a base_rate_calendar
--      row from an earlier read and be priced on it. A row past this night is
--      not a rate on record.
--   2. A trigger: when that night moves, the nights between the old and the
--      new value are marked for pricing (pricing_mark_range, the cadence's
--      own queue), so a night that gained or lost its rate is priced, or
--      unpriced, on the next tick rather than on the next daily pass.
--   3. platform_pilot_health() v4: two columns after the ones it had.
--        no_rate_count       room-nights ahead with no rate on record and no
--                            typed price: not priced, not sent.
--        rates_read_through  the night in 1, for the connection in service.
--
-- What counts as a room-night with no rate on record (3):
--   * the property system is one MAYA reads rates from (Cloudbeds,
--     ThinkReservations; a Mews hotel has no rate on record for any night,
--     and saying so on every row would say nothing);
--   * the room type is switched on and not unticked as a room (a parking bay
--     is priced only when a rule names it, and rarely has rates loaded);
--   * the night is after today (UTC) and inside the window the daily pass
--     prices (hotel_pricing_state.pass_horizon_days, 396 when there is none),
--     short by a day at each end so a hotel's own date never puts a night
--     outside the window it is counted in;
--   * base_rate_calendar has no row for it, or the night is past
--     base_rates_returned_through;
--   * nobody has typed a price for it (an open manual_price row is a base of
--     its own).
--
-- No policy or grant on a table changes. pms_connections keeps its row level
-- security. The trigger function runs as SECURITY DEFINER, as the cadence's
-- other marking triggers do, because pricing_mark_range is service-role only
-- and the column is written by the scheduled syncs. The pilot health function
-- stays SECURITY DEFINER with the same check: the caller must be a platform
-- admin or the service role.
--
-- Run AFTER 99_supabase_migration_pricing_cadence_v1.sql and
-- 99_supabase_migration_non_room_types_v1.sql. Safe to run more than once.
-- The edge functions write the new column when it is there and log once per
-- tick when it is not; the app reads the new pilot health columns when they
-- are there and says nothing about them when they are not. Deploy order does
-- not matter.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The last night the property system returned a rate for
-- ----------------------------------------------------------------------------

alter table public.pms_connections
  add column if not exists base_rates_returned_through date;

comment on column public.pms_connections.base_rates_returned_through is
  'The last night the property system returned a rate for on the last full read of the hotel''s own rates (pms/base-rate-calendar.ts). A base_rate_calendar row past it is not a rate on record: the engine does not price the night and the push does not send to it. Null until a read has recorded one. Compare base_rates_through, the last night the read asked for.';

-- ----------------------------------------------------------------------------
-- 2. Marking the nights whose rate on record came or went
-- ----------------------------------------------------------------------------
-- Old X to new Y: every night after the earlier of the two up to the later
-- one changed standing. One of them null (the first read to record it, or a
-- reset): the 400 nights after the other, which covers the whole pricing
-- window from wherever the known value sits. pricing_mark_range clips to
-- yesterday (UTC) .. 800 nights on, and marks nothing for an empty range.

create or replace function public.pms_connections_mark_returned_through()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_from date;
  v_to   date;
begin
  if new.base_rates_returned_through is not distinct from old.base_rates_returned_through then
    return null;
  end if;
  if old.base_rates_returned_through is null then
    v_from := new.base_rates_returned_through + 1;
    v_to   := new.base_rates_returned_through + 400;
  elsif new.base_rates_returned_through is null then
    v_from := old.base_rates_returned_through + 1;
    v_to   := old.base_rates_returned_through + 400;
  else
    v_from := least(old.base_rates_returned_through, new.base_rates_returned_through) + 1;
    v_to   := greatest(old.base_rates_returned_through, new.base_rates_returned_through);
  end if;
  perform public.pricing_mark_range(new.hotel_id, v_from, v_to, 'base_rate');
  return null;
end;
$$;

drop trigger if exists trg_pms_connections_mark_returned_through on public.pms_connections;
create trigger trg_pms_connections_mark_returned_through
  after update of base_rates_returned_through on public.pms_connections
  for each row execute function public.pms_connections_mark_returned_through();

-- ----------------------------------------------------------------------------
-- 3. Pilot health v4
-- ----------------------------------------------------------------------------
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
  rate_read_waiting_since timestamptz,
  -- v4. Room-nights ahead with no rate on record from the property system
  -- and no typed price: not priced, not sent. And the last night the
  -- property system returned a rate for.
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
         and mp.stay_date is null
         and (brc.stay_date is null
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
  'not waiting), and the room-nights ahead with no rate on record. Read by '
  '/admin/pilot-health. Platform admins and the service role only.';

revoke all on function public.platform_pilot_health(boolean) from public, anon;
grant execute on function public.platform_pilot_health(boolean) to authenticated, service_role;

commit;

-- ----------------------------------------------------------------------------
-- Checks
-- ----------------------------------------------------------------------------
-- How far each property's rates were read, and how many room-nights ahead
-- have no rate on record (the SQL editor has no signed-in caller, so it acts
-- as the service role for this one transaction):
--
--   begin;
--   select set_config('request.jwt.claim.role', 'service_role', true);
--   select name, mode, pms_type, rates_read_through, no_rate_count, unsent_count
--     from platform_pilot_health();
--   commit;
--
-- The column is stamped by the next hourly read of each hotel's rates; until
-- then it is null and every base_rate_calendar row counts as before.
