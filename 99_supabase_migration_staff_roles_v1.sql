-- ============================================================================
-- STAFF ROLES: two limited MAYA staff logins, Developer and Sales, that read
-- parts of the Command Center and change nothing
-- ============================================================================
--
-- Until now app_roles had one role that meant anything, platform_admin, and
-- every Command Center read checked is_platform_admin(). This file adds two
-- more (decided 2026-09-30):
--
--   developer  reads Docs Questions, Users, PMS Access, Pilot Health, and the
--              Hotels list and each property's page with its team. No money
--              figures, no analytics, no stalled signups, no signup codes, no
--              pending invites.
--   sales      reads Analytics (money included), Stalled Signups, Pilot
--              Health, Docs Questions, the Hotels list, and occupancy, ADR
--              and revenue night by night for real (not test) properties. No
--              team lists, no users, no PMS Access, no pending invites, and
--              no signup codes (a stalled signup's code is left blank).
--
-- Neither is platform_admin, so nothing that checks is_platform_admin() on
-- its own lets them through: God Mode (god_mode_start and god_mode_active
-- still require the platform_admin role itself, and are not touched here),
-- every write policy, every function that changes something,
-- is_hotel_accessible (the read policy of every hotel table, reservations and
-- their guest data included) and can_manage_hotel. Both keep ordinary use of
-- a property they are a member of, through that membership, as before.
--
-- 1. The roles. 'developer' and 'sales' join the app_role enum. A value
--    added in a transaction cannot be used as an enum literal until it
--    commits, so everything below compares role::text.
--
-- 2. Sections, and the one check. staff_role_sections(role) is the map of
--    what each role may read. staff_can_read(section) is true for a platform
--    admin (any sign-in, as today) and for a developer or sales login only
--    when its token is aal2: a code from an authenticator app (Supabase Auth
--    MFA, the same TOTP God Mode uses). staff_access() gives the app the
--    caller's role, aal and sections in one call.
--
-- 3. Reads, each widened to exactly its section. docs_questions and
--    docs_ask_tally (docs_questions); platform_list_users and
--    platform_count_users (users); platform_pilot_health and the alert
--    channel rows of platform_audit_events (pilot_health); pms_signup_gates
--    (pms_access); platform_list_hotels (hotels, its money columns only for
--    business_numbers); platform_list_hotel_users (hotel_team);
--    platform_list_stalled_signups (stalled_signups, the signup code for a
--    platform admin only); analytics_assert_reader, which every analytics_*
--    function calls (analytics). New: staff_hotel_business_numbers
--    (business_numbers). Every other use of is_platform_admin() is exactly as
--    it was. Pending invites, signup codes, support sessions and changes,
--    product_events and the rest of platform_audit_events stay admin only.
--
-- 4. Setting someone's role. platform_set_staff_role(user, role) with role
--    'none', 'developer', 'sales' or 'platform_admin' leaves the person with
--    exactly that one staff role. Like platform_grant_role it needs a
--    platform admin in God Mode (or the service role), and every change is an
--    app_role.granted or app_role.revoked line in platform_audit_events.
--    Nobody can remove the last platform admin, here or through
--    platform_revoke_role, whoever asks.
--
-- 5. Analytics. MAYA staff are not customers. product_event_emit records an
--    event as a test one when its person is staff (platform_admin, developer
--    or sales) and it is not tied to a property; inside a real property (an
--    admin in God Mode, say) it is as before. The backfill below flags the
--    events already recorded, making someone staff flags theirs, and
--    analytics_range's account count leaves staff logins out the way it
--    leaves out + addresses.
--
-- Run after 99_supabase_migration_pms_rate_changes_v1.sql. One transaction.
-- Idempotent: safe to run twice.
-- Supabase dashboard: Authentication -> Multi-Factor Authentication -> TOTP
-- on (God Mode needs it already), or a staff login can never reach aal2.

begin;

do $$
begin
  if to_regprocedure('public.god_mode_active()') is null
     or to_regclass('public.support_sessions') is null then
    raise exception 'Run 99_supabase_migration_god_mode_v1.sql first';
  end if;
  if to_regclass('public.docs_questions') is null
     or to_regclass('public.docs_ask_tally') is null
     or to_regclass('public.pms_signup_gates') is null
     or to_regclass('public.hotel_pricing_state') is null
     or to_regclass('public.hotel_metrics_daily') is null
     or to_regclass('public.room_type_out_of_service') is null
     or to_regprocedure('public.analytics_range(date, date, boolean)') is null
     or to_regprocedure('public.product_event_emit(text, uuid, uuid, jsonb, text, timestamptz, text, text, text, text, boolean)') is null then
    raise exception 'Run every migration before 99_supabase_migration_staff_roles_v1.sql first';
  end if;
end $$;

-- ── 1. The roles ───────────────────────────────────────────────────────────

alter type public.app_role add value if not exists 'developer';
alter type public.app_role add value if not exists 'sales';

comment on type public.app_role is
  'MAYA staff roles in app_roles. platform_admin: everything, and God Mode. developer and sales: read-only '
  'parts of the Command Center at aal2 (staff_role_sections). platform_support: unused.';

-- ── 2. Sections, and the one check ─────────────────────────────────────────

-- What each role may read. Pages of the Command Center, plus two that are
-- parts of a page: hotel_team (a property's team list) and business_numbers
-- (money: MRR, and a property's occupancy, ADR and revenue). A platform admin
-- has them all. Kept in step with STAFF_ROLE_SECTIONS in
-- maya-rms/src/lib/admin/staff-sections.ts (a test reads both).
create or replace function public.staff_role_sections(p_role text)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_role
    when 'platform_admin' then array[
      'analytics', 'business_numbers', 'docs_questions', 'home', 'hotel_create', 'hotel_team', 'hotels',
      'pending_invites', 'pilot_health', 'pms_access', 'signup_codes', 'stalled_signups', 'users']
    when 'developer' then array[
      'docs_questions', 'home', 'hotel_team', 'hotels', 'pilot_health', 'pms_access', 'users']
    when 'sales' then array[
      'analytics', 'business_numbers', 'docs_questions', 'home', 'hotels', 'pilot_health', 'stalled_signups']
    else array[]::text[]
  end
$$;

revoke all on function public.staff_role_sections(text) from public, anon;
grant execute on function public.staff_role_sections(text) to authenticated, service_role;

-- Whether the caller holds this role. Only ever about the caller, like
-- is_platform_admin(): nobody can ask it about someone else.
create or replace function public.has_app_role(p_role text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.app_roles ar
     where ar.user_id = auth.uid()
       and ar.role::text = p_role
  )
$$;

revoke all on function public.has_app_role(text) from public, anon;
grant execute on function public.has_app_role(text) to authenticated, service_role;

-- The caller's staff role, the strongest one they hold: platform_admin, then
-- developer, then sales. Null for everyone else.
create or replace function public.staff_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when bool_or(ar.role::text = 'platform_admin') then 'platform_admin'
    when bool_or(ar.role::text = 'developer') then 'developer'
    when bool_or(ar.role::text = 'sales') then 'sales'
  end
  from public.app_roles ar
  where ar.user_id = auth.uid()
$$;

revoke all on function public.staff_role() from public, anon;
grant execute on function public.staff_role() to authenticated, service_role;

-- The sections the caller may read right now. A platform admin: all of them,
-- as today. A developer or sales login: its role's, only once the token is
-- aal2; before the code, none.
create or replace function public.staff_sections()
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when public.is_platform_admin() then public.staff_role_sections('platform_admin')
    else coalesce((
      select array_agg(distinct s.section order by s.section)
        from public.app_roles ar
        cross join lateral unnest(public.staff_role_sections(ar.role::text)) as s(section)
       where ar.user_id = auth.uid()
         and ar.role::text in ('developer', 'sales')
         and coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
    ), array[]::text[])
  end
$$;

revoke all on function public.staff_sections() from public, anon;
grant execute on function public.staff_sections() to authenticated, service_role;

-- The check every staff read below uses. False under the service role
-- (auth.uid() is null there); the functions that allow the service role say
-- so themselves.
create or replace function public.staff_can_read(p_section text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_platform_admin()
      or (
        coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
        and exists (
          select 1
            from public.app_roles ar
           where ar.user_id = auth.uid()
             and ar.role::text in ('developer', 'sales')
             and p_section = any (public.staff_role_sections(ar.role::text))
        )
      )
$$;

revoke all on function public.staff_can_read(text) from public, anon;
grant execute on function public.staff_can_read(text) to authenticated, service_role;

-- For the app: one call per request says who is looking. mfa_required is
-- true for a developer or sales login whose token is not aal2 yet, which is
-- when the app sends them to the code step instead of the Command Center.
create or replace function public.staff_access()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'role', r.role,
    'aal', r.aal,
    'mfa_required', coalesce(r.role in ('developer', 'sales') and r.aal <> 'aal2', false),
    'sections', to_jsonb(public.staff_sections())
  )
  from (
    select public.staff_role() as role,
           coalesce(nullif(auth.jwt() ->> 'aal', ''), 'aal1') as aal
  ) r
$$;

revoke all on function public.staff_access() from public, anon;
grant execute on function public.staff_access() to authenticated, service_role;

comment on function public.staff_can_read(text) is
  'True for a platform admin, and for a developer or sales login at aal2 whose role includes the section '
  '(staff_role_sections). What every staff-readable policy and function checks.';
comment on function public.staff_access() is
  'The caller''s staff role (platform_admin, developer, sales or null), token aal, whether a code is still '
  'needed, and the sections they may read now. Read once per request by lib/admin/staff-session.ts.';

-- ── 3. Reads, each to exactly its section ──────────────────────────────────

-- Docs Questions: what readers sent, and the helper's weekly tally.
drop policy if exists docs_questions_platform_read on public.docs_questions;
drop policy if exists docs_questions_staff_read on public.docs_questions;
create policy docs_questions_staff_read on public.docs_questions
  for select using ((select public.staff_can_read('docs_questions')));

drop policy if exists docs_ask_tally_platform_read on public.docs_ask_tally;
drop policy if exists docs_ask_tally_staff_read on public.docs_ask_tally;
create policy docs_ask_tally_staff_read on public.docs_ask_tally
  for select using ((select public.staff_can_read('docs_questions')));

-- Pilot Health reads what the sync functions say about their alert channel
-- from the audit log. Only those two kinds of line: the rest of the log
-- (invites, roles, God Mode) stays with platform_audit_events_read.
drop policy if exists platform_audit_events_staff_alert_read on public.platform_audit_events;
create policy platform_audit_events_staff_alert_read on public.platform_audit_events
  for select using (
    event_type in ('alert.channel', 'alert.channel_test')
    and (select public.staff_can_read('pilot_health'))
  );

-- PMS Access: which integrations need an access code to sign up. Read only;
-- writes stay with the service role behind /api/admin/pms-gates.
grant select on public.pms_signup_gates to authenticated;
drop policy if exists pms_signup_gates_staff_read on public.pms_signup_gates;
create policy pms_signup_gates_staff_read on public.pms_signup_gates
  for select using ((select public.staff_can_read('pms_access')));

-- Users (command_center_v3, otherwise unchanged).
create or replace function public.platform_list_users(
  p_search text default null,
  p_limit int default 100,
  p_offset int default 0
) returns table (
  id uuid,
  email text,
  full_name text,
  is_active boolean,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  platform_roles text[],
  hotel_count int
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.staff_can_read('users') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
    select
      v.id,
      v.email,
      v.full_name,
      v.is_active,
      v.created_at,
      v.last_sign_in_at,
      v.platform_roles,
      (select count(*)::int from public.hotel_memberships hm where hm.user_id = v.id) as hotel_count
    from public.platform_users_view v
    where p_search is null
       or v.email ilike '%' || p_search || '%'
       or coalesce(v.full_name, '') ilike '%' || p_search || '%'
    order by v.created_at desc
    limit greatest(1, least(p_limit, 500))
    offset greatest(0, p_offset);
end;
$$;

revoke all on function public.platform_list_users(text, int, int) from public, anon;
grant execute on function public.platform_list_users(text, int, int) to authenticated, service_role;

-- The Users count (command_center_speed_v1, otherwise unchanged).
create or replace function public.platform_count_users(
  p_search text default null
) returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.staff_can_read('users') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return (
    select count(*)::int
      from auth.users u
      left join public.profiles p on p.id = u.id
     where p_search is null
        or u.email::text ilike '%' || p_search || '%'
        or coalesce(p.full_name, '') ilike '%' || p_search || '%'
  );
end;
$$;

revoke all on function public.platform_count_users(text) from public, anon;
grant execute on function public.platform_count_users(text) to authenticated, service_role;

-- A property's team (command_center_v3, otherwise unchanged). A property's
-- own managers still read it through can_manage_hotel.
create or replace function public.platform_list_hotel_users(
  p_hotel_id uuid
) returns table (
  membership_id uuid,
  user_id uuid,
  email text,
  full_name text,
  role public.hotel_membership_role,
  status public.membership_status,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not (public.staff_can_read('hotel_team') or public.can_manage_hotel(p_hotel_id)) then
    raise exception 'Not authorized for hotel %', p_hotel_id using errcode = '42501';
  end if;

  return query
    select
      hm.id,
      hm.user_id,
      u.email::text,
      p.full_name,
      hm.role,
      hm.status,
      hm.created_at
    from public.hotel_memberships hm
    join auth.users u on u.id = hm.user_id
    left join public.profiles p on p.id = hm.user_id
    where hm.hotel_id = p_hotel_id
    order by hm.created_at asc;
end;
$$;

revoke all on function public.platform_list_hotel_users(uuid) from public, anon;
grant execute on function public.platform_list_hotel_users(uuid) to authenticated, service_role;

-- The Hotels list and each property's page. The first fifteen columns are as
-- test_hotels_v1 left them. After them, what a property's page and the list
-- show without the service role: pricing mode and window, and the plan and
-- billing status in words. The money columns (the newest hotel_metrics_daily
-- MRR) are null unless the caller may read business_numbers, and for anyone
-- but a platform admin also null on a test property. Dropped first: a
-- function's column list cannot be changed in place.
drop function if exists public.platform_list_hotels(text);

create function public.platform_list_hotels(
  p_search text default null
) returns table (
  id uuid,
  name text,
  timezone text,
  currency text,
  is_active boolean,
  setup_pending_at timestamptz,
  is_test boolean,
  total_rooms_per_type int,
  external_enterprise_id text,
  created_at timestamptz,
  updated_at timestamptz,
  pms_type public.pms_type,
  pms_status public.connection_status,
  pms_last_sync_at timestamptz,
  membership_count int,
  -- hotel_settings.simulation_mode; no settings row reads as simulation.
  simulation_mode boolean,
  -- hotel_pricing_state.pass_horizon_days: the window the last daily pass used.
  pricing_horizon_days int,
  -- hotel_subscriptions, in words: status (trialing, active, past_due, ...),
  -- plan_kind (stripe or internal), billing_interval, billed_rooms.
  billing_status text,
  plan_kind text,
  billing_interval text,
  billed_rooms int,
  trial_end timestamptz,
  cancel_at_period_end boolean,
  -- Rooms of the active types that count as rooms.
  measured_rooms int,
  -- Money, for business_numbers only.
  list_mrr_cents int,
  net_mrr_cents int,
  mrr_day date
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_service boolean := (select auth.role()) is not distinct from 'service_role';
  v_money boolean;
  v_admin boolean;
begin
  if not v_service and not public.staff_can_read('hotels') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  v_money := v_service or public.staff_can_read('business_numbers');
  v_admin := v_service or public.is_platform_admin();

  return query
    select
      h.id,
      h.name,
      h.timezone,
      h.currency,
      h.is_active,
      h.setup_pending_at,
      h.is_test,
      h.total_rooms_per_type,
      h.external_enterprise_id,
      h.created_at,
      h.updated_at,
      pc.pms_type,
      pc.status,
      pc.last_sync_at,
      (select count(*)::int from public.hotel_memberships hm where hm.hotel_id = h.id),
      coalesce(hs.simulation_mode, true),
      ps.pass_horizon_days,
      s.status,
      s.plan_kind,
      s.billing_interval,
      s.billed_rooms,
      s.trial_end,
      s.cancel_at_period_end,
      (select coalesce(sum(rt.total_rooms), 0)::int
         from public.room_types rt
        where rt.hotel_id = h.id
          and rt.is_active
          and rt.counts_as_room is distinct from false),
      case when v_money and (v_admin or not h.is_test) then m.list_mrr_cents end,
      case when v_money and (v_admin or not h.is_test) then m.net_mrr_cents end,
      case when v_money and (v_admin or not h.is_test) then m.day end
    from public.hotels h
    left join public.pms_connections pc on pc.hotel_id = h.id
    left join public.hotel_settings hs on hs.hotel_id = h.id
    left join public.hotel_pricing_state ps on ps.hotel_id = h.id
    left join public.hotel_subscriptions s on s.hotel_id = h.id
    left join lateral (
      select d.day, d.list_mrr_cents, d.net_mrr_cents
        from public.hotel_metrics_daily d
       where d.hotel_id = h.id
       order by d.day desc
       limit 1
    ) m on true
    where p_search is null
       or h.name ilike '%' || p_search || '%'
    order by h.created_at desc;
end;
$$;

revoke all on function public.platform_list_hotels(text) from public, anon;
grant execute on function public.platform_list_hotels(text) to authenticated, service_role;

comment on function public.platform_list_hotels(text) is
  'Every property for the Command Center: identity, PMS, pricing mode and window, plan and billing status. '
  'MRR columns only for business_numbers (platform admin, or sales at aal2 on a real property). '
  'Staff at aal2 with the hotels section, platform admins and the service role.';

-- Pilot Health (no_rate_on_record_v1, v4, otherwise unchanged).
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
  '/admin/pilot-health. Platform admins, staff at aal2 with the pilot_health '
  'section, and the service role.';

revoke all on function public.platform_pilot_health(boolean) from public, anon;
grant execute on function public.platform_pilot_health(boolean) to authenticated, service_role;

-- Stalled Signups (stalled_signups_v1, otherwise unchanged).
create or replace function public.platform_list_stalled_signups(
  p_min_hours int default 24,
  p_include_abandoned boolean default false
) returns table (
  hotel_id uuid,
  hotel_name text,
  -- Which step they never got past.
  stage text,
  -- When they arrived at that step. Each stage counts from its own clock, so
  -- "12 days" always means 12 days at THIS step, not 12 days since signing up.
  stuck_since timestamptz,
  stuck_hours int,
  -- Who to email, and whether that address was ever proven to exist. An
  -- unconfirmed one is likely a typo, which is its own explanation for silence.
  admin_email text,
  admin_name text,
  email_confirmed boolean,
  last_sign_in_at timestamptz,
  -- What they are being charged for something they aren't using.
  status text,
  billing_interval text,
  billed_rooms int,
  trial_end timestamptz,
  current_period_end timestamptz,
  -- Billing periods elapsed since the first real charge. Derived from the
  -- period, not from Stripe's invoice list, so it is an estimate — but it is the
  -- number that decides whether an email is overdue or premature.
  periods_billed int,
  -- A signup whose card also died needs a different conversation.
  card_verify_failed_at timestamptz,
  card_verify_last_code text,
  signup_code text,
  pms_type text,
  pms_status text,
  import_status text,
  import_phase text,
  import_error text,
  rooms_measured int,
  signup_abandoned_at timestamptz,
  signup_abandoned_note text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cutoff timestamptz := now() - make_interval(hours => greatest(0, p_min_hours));
  -- staff_roles_v1: the code a signup used is for a platform admin's eyes only.
  v_show_code boolean := public.is_platform_admin();
begin
  if not public.staff_can_read('stalled_signups') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
  with sub as (
    select
      s.hotel_id,
      s.status,
      s.billing_interval,
      s.billed_rooms,
      s.trial_end,
      s.current_period_end,
      s.card_verify_failed_at,
      s.card_verify_last_code,
      s.signup_code_id,
      s.created_at,
      -- The subscription's own idea of when money started moving.
      coalesce(s.trial_end, s.created_at) as charging_since
    from hotel_subscriptions s
    where s.status <> 'canceled'
  ),
  -- The hotel's admin: the earliest active hotel_admin, which for a self-serve
  -- signup is the person who paid. Earliest rather than any, so the row doesn't
  -- change identity when they invite a colleague.
  hotel_owner as (
    select distinct on (hm.hotel_id)
      hm.hotel_id,
      hm.user_id,
      u.email::text as email,
      u.email_confirmed_at,
      u.last_sign_in_at,
      p.full_name,
      p.onboarding_path,
      p.onboarding_dismissed_at
    from hotel_memberships hm
    join auth.users u on u.id = hm.user_id
    left join profiles p on p.id = hm.user_id
    where hm.status = 'active'
      and hm.role = 'hotel_admin'
    order by hm.hotel_id, hm.created_at asc
  ),
  conn as (
    select distinct on (c.hotel_id)
      c.hotel_id, c.pms_type, c.status, c.updated_at
    from pms_connections c
    order by c.hotel_id, c.updated_at desc
  ),
  staged as (
    select
      h.id as hotel_id,
      h.name as hotel_name,
      h.setup_pending_at,
      h.signup_abandoned_at,
      h.signup_abandoned_note,
      sub.status, sub.billing_interval, sub.billed_rooms, sub.trial_end,
      sub.current_period_end, sub.card_verify_failed_at, sub.card_verify_last_code,
      sub.signup_code_id, sub.created_at, sub.charging_since,
      -- Whole billing months since money started moving, counted the way a
      -- monthly anniversary actually works: the month is not complete until the
      -- day-of-month comes round again.
      ((extract(year from now()) - extract(year from sub.charging_since)) * 12
       + (extract(month from now()) - extract(month from sub.charging_since))
       - case
           when extract(day from now()) < extract(day from sub.charging_since) then 1
           else 0
         end)::int as months_elapsed,
      ho.email, ho.full_name, ho.email_confirmed_at, ho.last_sign_in_at,
      ho.onboarding_path, ho.onboarding_dismissed_at,
      j.status as job_status, j.phase as job_phase, j.last_error as job_error,
      j.finished_at as job_finished_at, j.updated_at as job_updated_at,
      conn.pms_type, conn.status as conn_status, conn.updated_at as conn_updated_at,
      os.connected_at, os.review_completed_at, os.payment_tier_rooms,
      -- Ordered by how early in the flow the step sits, so a hotel that is stuck
      -- in more than one way is reported at the FIRST thing blocking it — which
      -- is the only one worth acting on.
      case
        when sub.status in ('incomplete', 'incomplete_expired', 'unpaid') then 'payment_incomplete'
        when h.setup_pending_at is not null then 'no_pms'
        when j.status = 'failed' then 'import_failed'
        when j.status in ('queued', 'running') then 'import_stuck'
        when ho.onboarding_path is null and ho.onboarding_dismissed_at is null then 'no_path'
        when ho.onboarding_path = 'guided' and os.review_completed_at is null then 'review_pending'
      end as stage,
      case
        when sub.status in ('incomplete', 'incomplete_expired', 'unpaid') then sub.created_at
        when h.setup_pending_at is not null then h.setup_pending_at
        when j.status = 'failed' then coalesce(j.finished_at, j.updated_at)
        when j.status in ('queued', 'running') then j.updated_at
        else coalesce(os.connected_at, conn.updated_at, sub.created_at)
      end as stuck_since
    from hotels h
    join sub on sub.hotel_id = h.id
    left join hotel_owner ho on ho.hotel_id = h.id
    left join conn on conn.hotel_id = h.id
    left join onboarding_states os on os.hotel_id = h.id
    -- Specifically the job onboarding is waiting on, NOT the hotel's most recent
    -- one. Revenue managers can trigger a PMS sync by hand, and a live property
    -- part-way through a routine re-import is not a stalled signup.
    left join import_jobs j on j.id = os.import_job_id
  )
  select
    st.hotel_id,
    -- The placeholder name checkout invents is noise in a list; the email below
    -- is the identity for a signup that never reached its PMS.
    case when st.setup_pending_at is not null then null else st.hotel_name end,
    st.stage,
    st.stuck_since,
    (extract(epoch from (now() - st.stuck_since)) / 3600)::int,
    st.email,
    st.full_name,
    st.email_confirmed_at is not null,
    st.last_sign_in_at,
    st.status,
    st.billing_interval,
    st.billed_rooms,
    st.trial_end,
    st.current_period_end,
    -- The charge at charging_since itself is payment one, so a subscription in
    -- its first month reads 1 rather than 0. A trial still running reads 0,
    -- because nothing has been taken.
    case
      when st.charging_since >= now() then 0
      when st.billing_interval = 'year' then greatest(0, st.months_elapsed) / 12 + 1
      else greatest(0, st.months_elapsed) + 1
    end,
    st.card_verify_failed_at,
    st.card_verify_last_code,
    case when v_show_code then sc.code end,
    st.pms_type::text,
    st.conn_status::text,
    st.job_status::text,
    st.job_phase,
    st.job_error,
    st.payment_tier_rooms,
    st.signup_abandoned_at,
    st.signup_abandoned_note,
    st.created_at
  from staged st
  left join signup_codes sc on sc.id = st.signup_code_id
  where st.stage is not null
    and st.stuck_since <= v_cutoff
    and (p_include_abandoned or st.signup_abandoned_at is null)
  -- Longest-stuck first: that is both the most money already taken and the
  -- closest to asking for it back.
  order by st.stuck_since asc;
end;
$$;

revoke all on function public.platform_list_stalled_signups(int, boolean) from public, anon;
grant execute on function public.platform_list_stalled_signups(int, boolean) to authenticated, service_role;

-- Analytics: every analytics_* function starts with this. A direct database
-- session (the SQL editor) is still let through, as before.
create or replace function public.analytics_assert_reader()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.staff_can_read('analytics')
     and session_user = 'authenticator' then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.analytics_assert_reader() from public, anon;
grant execute on function public.analytics_assert_reader() to authenticated, service_role;

-- A property's business numbers, night by night, the way its calendar adds
-- them up (lib/calendar-store.ts): rooms sold and sellable rooms (the active
-- types that count as rooms, less rooms out of service), sellable occupancy,
-- room revenue (every active type) and ADR (the types that count as rooms).
-- Totals only: nothing about a booking or a guest. For a platform admin, and
-- for sales at aal2 on a real property only; never a test one.
create or replace function public.staff_hotel_business_numbers(
  p_hotel_id uuid,
  p_from date,
  p_to date
) returns table (
  stay_date date,
  rooms_sold int,
  rooms_available int,
  occupancy_pct numeric,
  room_revenue numeric,
  adr numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_service boolean := (select auth.role()) is not distinct from 'service_role';
  v_is_test boolean;
  v_fallback_rooms int;
begin
  if not v_service and not public.staff_can_read('business_numbers') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select h.is_test, h.total_rooms_per_type into v_is_test, v_fallback_rooms
    from public.hotels h
   where h.id = p_hotel_id;
  if not found then
    raise exception 'No such property %', p_hotel_id using errcode = 'P0002';
  end if;
  if v_is_test and not v_service and not public.is_platform_admin() then
    raise exception 'Business numbers are shown for real properties only.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Ask for up to 401 nights, the first no later than the last.' using errcode = '22023';
  end if;

  return query
  with types as (
    select t.id,
           -- A missing count borrows the property's default, as the calendar does.
           coalesce(t.total_rooms, v_fallback_rooms, 0) as total_rooms,
           t.counts_as_room is distinct from false as counting
      from public.room_types t
     where t.hotel_id = p_hotel_id
       and t.is_active
  ),
  nights as (
    select g.night::date as night
      from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as g(night)
  ),
  sold as (
    select r.stay_date as night,
           r.room_type_id,
           count(*)::int as booked,
           sum(coalesce(r.base_rate, r.current_rate, 0))::numeric as revenue
      from public.reservations r
      join types ty on ty.id = r.room_type_id
     where r.hotel_id = p_hotel_id
       and r.stay_date between p_from and p_to
     group by r.stay_date, r.room_type_id
  ),
  cells as (
    select n.night,
           ty.counting,
           greatest(0, ty.total_rooms - coalesce((
             select sum(o.units)
               from public.room_type_out_of_service o
              where o.hotel_id = p_hotel_id
                and o.room_type_id = ty.id
                and o.cleared_at is null
                and n.night between o.start_date and o.end_date
           ), 0))::int as sellable,
           coalesce(so.booked, 0) as booked,
           coalesce(so.revenue, 0) as revenue
      from nights n
      cross join types ty
      left join sold so on so.night = n.night and so.room_type_id = ty.id
  ),
  totals as (
    select n.night,
           coalesce(sum(c.booked) filter (where c.counting), 0)::int as booked,
           coalesce(sum(c.sellable) filter (where c.counting), 0)::int as sellable,
           coalesce(sum(c.revenue), 0)::numeric as revenue,
           coalesce(sum(c.revenue) filter (where c.counting), 0)::numeric as counted_revenue
      from nights n
      left join cells c on c.night = n.night
     group by n.night
  )
  select tt.night,
         tt.booked,
         tt.sellable,
         case when tt.sellable > 0 then round(100.0 * tt.booked / tt.sellable, 1) end,
         round(tt.revenue, 2),
         case when tt.booked > 0 then round(tt.counted_revenue / tt.booked, 2) end
    from totals tt
   order by tt.night;
end;
$$;

revoke all on function public.staff_hotel_business_numbers(uuid, date, date) from public, anon;
grant execute on function public.staff_hotel_business_numbers(uuid, date, date) to authenticated, service_role;

comment on function public.staff_hotel_business_numbers(uuid, date, date) is
  'Night-by-night rooms sold, sellable rooms, sellable occupancy, room revenue and ADR for one property, '
  'up to 401 nights. Totals only. Platform admins; sales at aal2 on real (not test) properties only.';

-- ── 4. Setting someone's role ──────────────────────────────────────────────

-- The person's events that are not tied to a property, marked as test ones.
-- Called when someone is made MAYA staff; nobody signed in can call it.
create or replace function public.staff_flag_test_events(p_user_id uuid)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  with flagged as (
    update public.product_events e
       set is_test = true
     where e.user_id = p_user_id
       and e.hotel_id is null
       and not e.is_test
       and exists (
         select 1
           from public.app_roles ar
          where ar.user_id = p_user_id
            and ar.role::text in ('platform_admin', 'developer', 'sales')
       )
    returning 1
  )
  select count(*)::int from flagged
$$;

revoke all on function public.staff_flag_test_events(uuid) from public, anon, authenticated, service_role;

-- The Users page's role picker: None, Developer, Sales or Platform admin.
-- Leaves the person with exactly the one chosen (platform_support, unused,
-- is left alone). A platform admin in God Mode, as for platform_grant_role:
-- a new platform admin can open God Mode, and a developer or sales login
-- reads every login's email or the business's money. One change to app_roles
-- at a time, so two admins taking each other's role at once cannot leave
-- MAYA with none.
create or replace function public.platform_set_staff_role(
  p_user_id uuid,
  p_role text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := lower(btrim(coalesce(p_role, '')));
  v_before text[];
  v_after text[];
  v_removed text;
begin
  if (select auth.role()) is distinct from 'service_role'
     and not (public.is_platform_admin() and public.god_mode_active()) then
    raise exception 'Only a platform admin in God Mode can change who is MAYA staff.' using errcode = '42501';
  end if;
  if v_role not in ('none', 'developer', 'sales', 'platform_admin') then
    raise exception 'A staff role is none, developer, sales or platform_admin, not "%".', p_role using errcode = '22023';
  end if;
  if p_user_id is null or not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'No such user %', p_user_id using errcode = 'P0002';
  end if;

  lock table public.app_roles in share row exclusive mode;

  select coalesce(array_agg(ar.role::text order by ar.role::text), array[]::text[]) into v_before
    from public.app_roles ar
   where ar.user_id = p_user_id
     and ar.role::text in ('platform_admin', 'developer', 'sales');

  if 'platform_admin' = any (v_before)
     and v_role <> 'platform_admin'
     and (select count(*) from public.app_roles ar where ar.role = 'platform_admin') <= 1 then
    raise exception 'MAYA needs at least one platform admin. Make someone else a platform admin first.'
      using errcode = '23514';
  end if;

  for v_removed in
    delete from public.app_roles ar
     where ar.user_id = p_user_id
       and ar.role::text in ('platform_admin', 'developer', 'sales')
       and ar.role::text <> v_role
    returning ar.role::text
  loop
    insert into public.platform_audit_events (actor_user_id, event_type, entity_type, entity_id, detail)
    values (auth.uid(), 'app_role.revoked', 'app_role', p_user_id::text,
            jsonb_build_object('user_id', p_user_id, 'role', v_removed, 'via', 'staff_role'));
  end loop;

  if v_role <> 'none' and not (v_role = any (v_before)) then
    insert into public.app_roles (user_id, role, granted_by)
    values (p_user_id, v_role::public.app_role, auth.uid());
    insert into public.platform_audit_events (actor_user_id, event_type, entity_type, entity_id, detail)
    values (auth.uid(), 'app_role.granted', 'app_role', p_user_id::text,
            jsonb_build_object('user_id', p_user_id, 'role', v_role, 'via', 'staff_role'));
    perform public.staff_flag_test_events(p_user_id);
  end if;

  v_after := case when v_role = 'none' then array[]::text[] else array[v_role] end;
  return jsonb_build_object(
    'user_id', p_user_id,
    'role', v_role,
    'previous', to_jsonb(v_before),
    'changed', v_before is distinct from v_after
  );
end;
$$;

revoke all on function public.platform_set_staff_role(uuid, text) from public, anon;
grant execute on function public.platform_set_staff_role(uuid, text) to authenticated, service_role;

comment on function public.platform_set_staff_role(uuid, text) is
  'Sets a login''s MAYA staff role to none, developer, sales or platform_admin (exactly one). Platform admin '
  'in God Mode or the service role. Logged as app_role.granted / app_role.revoked. Refuses to remove the last '
  'platform admin.';

-- Making someone staff one role at a time (god_mode_v1, otherwise
-- unchanged): a staff role now also marks their events outside a property as
-- test ones.
create or replace function public.platform_grant_role(
  p_user_id uuid,
  p_role public.app_role
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not (public.is_platform_admin() and public.god_mode_active()) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  insert into public.app_roles (user_id, role, granted_by)
  values (p_user_id, p_role, auth.uid())
  on conflict (user_id, role) do nothing;

  insert into public.platform_audit_events (actor_user_id, event_type, entity_type, entity_id, detail)
  values (auth.uid(), 'app_role.granted', 'app_role', p_user_id::text,
          jsonb_build_object('user_id', p_user_id, 'role', p_role::text));

  if p_role::text in ('platform_admin', 'developer', 'sales') then
    perform public.staff_flag_test_events(p_user_id);
  end if;
end;
$$;

-- Taking a role away (god_mode_v1). The last platform admin could only not
-- remove themselves; now nobody removes the last one, the service role
-- included.
create or replace function public.platform_revoke_role(
  p_user_id uuid,
  p_role public.app_role
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not (public.is_platform_admin() and public.god_mode_active()) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  lock table public.app_roles in share row exclusive mode;

  if p_role = 'platform_admin'
     and exists (select 1 from public.app_roles where user_id = p_user_id and role = 'platform_admin')
     and (select count(*) from public.app_roles where role = 'platform_admin') <= 1 then
    raise exception 'Cannot revoke the last platform_admin' using errcode = '23514';
  end if;

  delete from public.app_roles where user_id = p_user_id and role = p_role;

  insert into public.platform_audit_events (actor_user_id, event_type, entity_type, entity_id, detail)
  values (auth.uid(), 'app_role.revoked', 'app_role', p_user_id::text,
          jsonb_build_object('user_id', p_user_id, 'role', p_role::text));
end;
$$;

revoke all on function public.platform_grant_role(uuid, public.app_role) from public, anon;
grant execute on function public.platform_grant_role(uuid, public.app_role) to authenticated, service_role;
revoke all on function public.platform_revoke_role(uuid, public.app_role) from public, anon;
grant execute on function public.platform_revoke_role(uuid, public.app_role) to authenticated, service_role;

-- ── 5. Analytics: MAYA staff are not customers ─────────────────────────────

-- How a window changed (command_center_speed_v1, otherwise unchanged): its
-- account count leaves staff logins out, as it leaves out + addresses.
create or replace function public.analytics_range(
  p_from date,
  p_to date,
  p_include_test boolean default false
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz := (p_from::timestamp at time zone 'UTC');
  v_to timestamptz := ((p_to + 1)::timestamp at time zone 'UTC');
  v_census date;
  v_hours double precision[];
  v_n int;
  v_median double precision;
  v_out jsonb;
begin
  perform public.analytics_assert_reader();

  select min(d.day) into v_census
    from public.hotel_metrics_daily d
   where d.day <= p_to
     and (p_include_test or not d.is_test);

  -- First engine run per counted hotel that has connected, in hours after
  -- the connect, kept when the run landed in the window and not before the
  -- connect. Milliseconds first, as the app counted them.
  select array_agg(x.hours order by x.hours) into v_hours
    from (
      select (extract(epoch from (fr.first_run - o.connected_at)) * 1000)::double precision / 3600000 as hours
        from public.onboarding_states o
        join public.hotels h on h.id = o.hotel_id and (p_include_test or not h.is_test)
        cross join lateral (
          select min(r.evaluated_at) as first_run
            from public.evaluation_run_log r
           where r.hotel_id = o.hotel_id
        ) fr
       where o.connected_at is not null
         and fr.first_run >= v_from
         and fr.first_run < v_to
         and fr.first_run >= o.connected_at
    ) x;
  v_n := coalesce(array_length(v_hours, 1), 0);
  v_median := case
    when v_n = 0 then null
    when v_n % 2 = 1 then v_hours[(v_n + 1) / 2]
    else (v_hours[v_n / 2] + v_hours[v_n / 2 + 1]) / 2
  end;

  with scoped as (
    select h.id, h.name from public.hotels h where p_include_test or not h.is_test
  ),
  in_range as (
    select d.day, d.hotel_id, d.status, d.list_mrr_cents, d.net_mrr_cents,
           (d.entitled and d.status <> 'trialing') as paying
      from public.hotel_metrics_daily d
     where d.day >= p_from
       and d.day <= p_to
       and (p_include_test or not d.is_test)
  ),
  series as (
    select r.day,
           coalesce(sum(r.list_mrr_cents) filter (where r.paying), 0) as list_mrr_cents,
           coalesce(sum(r.net_mrr_cents) filter (where r.paying), 0) as net_mrr_cents,
           count(*) filter (where r.paying) as paying,
           count(*) filter (where r.status = 'trialing') as trialing
      from in_range r
     group by r.day
  ),
  -- Each hotel's standing on the eve of the window, worked out once per hotel
  -- (materialized, or the planner repeats the lookups for every row).
  before_window as materialized (
    select ih.hotel_id,
           (select d.entitled and d.status <> 'trialing'
              from public.hotel_metrics_daily d
             where d.hotel_id = ih.hotel_id
               and d.day < p_from
               and (p_include_test or not d.is_test)
             order by d.day desc
             limit 1) as last_paying,
           -- The hotel's first paying day before the window, walked from its
           -- oldest row on the (hotel_id, day) index, rather than an EXISTS
           -- the planner turns into a scan of the whole table.
           coalesce((
             select true
               from public.hotel_metrics_daily d
              where d.hotel_id = ih.hotel_id
                and d.day < p_from
                and (p_include_test or not d.is_test)
                and d.entitled
                and d.status <> 'trialing'
              order by d.day
              limit 1), false) as ever_paid
      from (select distinct r.hotel_id from in_range r) ih
  ),
  -- Each day against the one before it, and whether the hotel had paid on
  -- any day up to and including it.
  running as (
    select r.day, r.hotel_id, r.paying,
           lag(r.paying) over w as prev_in_window,
           bool_or(r.paying) over w as paid_through
      from in_range r
    window w as (partition by r.hotel_id order by r.day)
  ),
  steps as (
    select u.day, u.hotel_id, u.paying,
           coalesce(u.prev_in_window, b.last_paying, false) as prev_paying,
           b.ever_paid
             or coalesce(lag(u.paid_through) over (partition by u.hotel_id order by u.day), false) as ever_before
      from running u
      join before_window b on b.hotel_id = u.hotel_id
  ),
  events as (
    select s.day, s.hotel_id, coalesce(h.name, s.hotel_id::text) as name,
           case
             when s.paying and not s.prev_paying and s.day is distinct from v_census
               then case when s.ever_before then 'won_back' else 'new_paying' end
             when not s.paying and s.prev_paying
               then 'churned'
           end as kind
      from steps s
      left join scoped h on h.id = s.hotel_id
  )
  select jsonb_build_object(
    'series', coalesce((
      select jsonb_agg(jsonb_build_object(
               'day', se.day,
               'list_mrr_cents', se.list_mrr_cents,
               'net_mrr_cents', se.net_mrr_cents,
               'paying', se.paying,
               'trialing', se.trialing)
             order by se.day)
        from series se), '[]'::jsonb),
    'new_paying', coalesce((
      select jsonb_agg(jsonb_build_object('hotel_id', e.hotel_id, 'name', e.name, 'day', e.day) order by e.day, e.name, e.hotel_id)
        from events e where e.kind = 'new_paying'), '[]'::jsonb),
    'won_back', coalesce((
      select jsonb_agg(jsonb_build_object('hotel_id', e.hotel_id, 'name', e.name, 'day', e.day) order by e.day, e.name, e.hotel_id)
        from events e where e.kind = 'won_back'), '[]'::jsonb),
    'churned', coalesce((
      select jsonb_agg(jsonb_build_object('hotel_id', e.hotel_id, 'name', e.name, 'day', e.day) order by e.day, e.name, e.hotel_id)
        from events e where e.kind = 'churned'), '[]'::jsonb),
    'accounts', (
      select count(*)
        from auth.users u
       where u.email_confirmed_at >= v_from
         and u.email_confirmed_at < v_to
         and (p_include_test
              or (strpos(coalesce(u.email::text, ''), '+') = 0
                  -- staff_roles_v1: nor MAYA staff logins.
                  and not exists (
                    select 1
                      from public.app_roles ar
                     where ar.user_id = u.id
                       and ar.role::text in ('platform_admin', 'developer', 'sales'))))),
    'paid', (
      select count(*)
        from public.hotel_subscriptions s
        join scoped h on h.id = s.hotel_id
       where s.created_at >= v_from
         and s.created_at < v_to),
    'connected', (
      select count(*)
        from public.onboarding_states o
        join scoped h on h.id = o.hotel_id
       where o.connected_at >= v_from
         and o.connected_at < v_to),
    'finished', (
      select count(*)
        from public.onboarding_states o
        join scoped h on h.id = o.hotel_id
       where o.questions_completed_at >= v_from
         and o.questions_completed_at < v_to),
    'median_hours_to_live', v_median
  ) into v_out;

  return v_out;
end;
$$;

revoke all on function public.analytics_range(date, date, boolean) from public, anon;
grant execute on function public.analytics_range(date, date, boolean) to authenticated, service_role;

-- The one way an event is written (product_events_v1, otherwise unchanged).
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
  v_user uuid;
  v_test boolean;
begin
  if p_source = 'trigger' then
    v_source := coalesce(nullif(current_setting('maya.event_source', true), ''), 'trigger');
  end if;

  if p_hotel_id is not null then
    select c.pms_type, c.pms_property_id, c.property_name, c.is_test, c.owner_user_id
      into v_pms_type, v_pms_property_id, v_property_name, v_is_test, v_owner
      from public.product_event_hotel_context(p_hotel_id) c;
  end if;

  v_user := coalesce(p_user_id, v_owner);
  v_test := coalesce(p_is_test, v_is_test, false);
  -- staff_roles_v1: MAYA staff (platform_admin, developer, sales) are not
  -- customers, so what they do outside a property is test traffic. Inside
  -- a property the property's flag decides, as before.
  if not v_test
     and p_hotel_id is null
     and v_user is not null
     and exists (
       select 1
         from public.app_roles ar
        where ar.user_id = v_user
          and ar.role::text in ('platform_admin', 'developer', 'sales')
     ) then
    v_test := true;
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
    v_user,
    jsonb_strip_nulls(coalesce(p_properties, '{}'::jsonb)),
    v_source,
    v_test,
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


revoke all on function public.product_event_emit(text, uuid, uuid, jsonb, text, timestamptz, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.product_event_emit(text, uuid, uuid, jsonb, text, timestamptz, text, text, text, text, boolean) to service_role;

-- The events already recorded: a staff login's events that are not tied to
-- a property become test ones. Those inside a property are left as they are.
-- Safe to run again: it only ever turns the flag on.
update public.product_events e
   set is_test = true
 where not e.is_test
   and e.hotel_id is null
   and e.user_id is not null
   and exists (
     select 1
       from public.app_roles ar
      where ar.user_id = e.user_id
        and ar.role::text in ('platform_admin', 'developer', 'sales')
   );

commit;

-- Check afterwards:
--
--   select u.email, ar.role from public.app_roles ar join auth.users u on u.id = ar.user_id order by 2, 1;
--   select count(*) from public.product_events e
--    where e.hotel_id is null and not e.is_test
--      and exists (select 1 from public.app_roles ar
--                   where ar.user_id = e.user_id and ar.role::text in ('platform_admin', 'developer', 'sales'));   -- 0
--
-- Make someone a developer from the SQL editor:
--
--   begin;
--   select set_config('request.jwt.claim.role', 'service_role', true);
--   select public.platform_set_staff_role(
--     (select id from auth.users where email = 'developer@modern-hospitality-solutions.com'), 'developer');
--   commit;
