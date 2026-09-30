-- ============================================================================
-- MAYA pilot health: prices published and not sent (v2)
-- ============================================================================
--
-- The Pilot health page could read "Looks fine" for a Live hotel that was
-- being sent nothing: connected, read three minutes ago, today's pass done,
-- 0 sent in 24 hours. Nothing on the row said prices were waiting. That is
-- what happens when MAYA_PUSH_RATES is not true in the function settings,
-- when the send step keeps failing before it records anything, and when every
-- night is held until the hotel's own rates can be read.
--
-- platform_pilot_health() gains four columns, after the ones it had:
--
--   unsent_count             Published prices of a Live hotel that have waited
--                            over an hour with no sent record at that price.
--   unsent_since             How long the oldest of them has waited.
--   rate_read_waiting        Nights held until the hotel's own rates have been
--                            read (the open nights of an awaiting_rate_read
--                            sending problem).
--   rate_read_waiting_since  When the first of them was held.
--
-- The page decides what is a problem (src/lib/admin/pilot-health-assess.ts);
-- this file only gathers the facts.
--
-- What counts as a published price waiting to be sent:
--   * the hotel is Live, and its property system is one MAYA sends to
--     (Cloudbeds, ThinkReservations; a Mews hotel is never sent anything);
--   * the room type is switched on (a switched-off type's leftover rows are
--     held for good, on purpose);
--   * the price is above 0 (a comp night's 0 is not sent, and the owner is
--     told so when they save it);
--   * the night is after today (UTC) and inside the window the daily pass
--     prices (hotel_pricing_state.pass_horizon_days, 396 when there is none),
--     short by a day at each end so a hotel's own date never puts a night
--     outside the window it is counted in;
--   * it has waited over an hour, counted from when it was published or from
--     when the hotel last went Live (hotel_settings.live_since), whichever is
--     later: a price published in simulation only starts waiting at go-live;
--   * rate_updates has no row for the night and room type that is a send at
--     this price. A failed send, a night MAYA holds back and a night nobody
--     has tried all count: the hotel's system does not have the price.
--
-- Both new reads go by an index that is already there: published_price by
-- its primary key (hotel_id, stay_date, room_type_id), rate_updates by its
-- unique key (hotel_id, room_type_id, stay_date), the incident cells by
-- idx_rate_push_incident_cells_hotel.
--
-- No table is created or altered, and no policy or grant on a table changes.
-- The function stays SECURITY DEFINER with the same check: the caller must be
-- a platform admin or the service role.
--
-- Run AFTER 99_supabase_migration_pilot_health_v1.sql and
-- 99_supabase_migration_push_guardrails_v1.sql. Safe to run more than once.
-- The app reads the new columns when they are there and says nothing about
-- them when they are not, so it can be deployed before or after this file.

begin;

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
  -- record at that price, and since when the oldest has waited.
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
  'an hour to be sent included. Read by /admin/pilot-health. Platform admins '
  'and the service role only.';

revoke all on function public.platform_pilot_health(boolean) from public, anon;
grant execute on function public.platform_pilot_health(boolean) to authenticated, service_role;

commit;

-- At a prompt (the SQL editor has no signed-in caller, so it acts as the
-- service role for this one transaction):
--
--   begin;
--   select set_config('request.jwt.claim.role', 'service_role', true);
--   select name, mode, pms_type, sent_24h, unsent_count, unsent_since,
--          rate_read_waiting, rate_read_waiting_since
--     from platform_pilot_health();
--   commit;
