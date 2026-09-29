-- ============================================================================
-- MAYA pilot health: one row per live or simulating property (v1)
-- ============================================================================
--
-- The Command Center's Pilot health page (/admin/pilot-health) reads one
-- function, platform_pilot_health(p_include_test), and gets for every active,
-- entitled property where its connection, pricing, sending and rules stand
-- right now: the last successful read, how far today's daily pass has got,
-- how many nights wait in the touched-nights queue, prices sent in the last
-- 24 hours, open sending problems, active rules and rule changes. The page
-- decides what looks wrong (src/lib/admin/pilot-health-assess.ts); this file
-- only gathers the facts, one indexed read per table, as lateral subqueries.
--
-- Two of the tables it reads (hotel_pricing_state, pricing_dirty_nights) are
-- service-role only, which is why this is a SECURITY DEFINER function and not
-- a page query: the caller must be a platform admin or the service role, the
-- same check as platform_list_hotels.
--
-- A property is listed when it is active (hotels.is_active), not a checkout
-- placeholder (setup_pending_at is null), not purged (data_purged_at is
-- null), and entitled: no subscription row, or one whose status is trialing,
-- active or past_due, whichever plan_kind. Test properties are left out
-- unless asked for. A hotel with more than one connection row reports the
-- connected one, else the newest.
--
-- Run AFTER 99_supabase_migration_pricing_cadence_v1.sql and
-- 99_supabase_migration_push_guardrails_v1.sql. Idempotent.

begin;

-- The 24-hour sent count. rate_updates has (hotel_id, stay_date) and
-- (hotel_id, status) and nothing on pushed_at, so without this the count
-- reads every sent row the hotel ever had.
create index if not exists idx_rate_updates_hotel_sent_at
  on public.rate_updates (hotel_id, pushed_at desc)
  where status = 'sent';

-- Dropped first so a changed column list can be re-run over an earlier copy;
-- the grants are restated below.
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
  rule_changes_24h int
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
      pe.rule_changes_24h
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
  'sending and rules stand right now. Read by /admin/pilot-health. Platform '
  'admins and the service role only.';

revoke all on function public.platform_pilot_health(boolean) from public, anon;
grant execute on function public.platform_pilot_health(boolean) to authenticated, service_role;

commit;

-- At a prompt (the SQL editor has no signed-in caller, so it acts as the
-- service role for this one transaction):
--
--   begin;
--   select set_config('request.jwt.claim.role', 'service_role', true);
--   select name, mode, pms_status, last_sync_at, pass_date, pass_cursor,
--          dirty_count, sent_24h, open_incidents, open_incident_causes
--     from platform_pilot_health();
--   commit;
