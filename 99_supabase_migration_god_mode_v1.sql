-- ============================================================================
-- GOD MODE: platform admins read everything, and change a customer's property
-- only inside a short, logged support window
-- ============================================================================
--
-- Until now a platform admin could change any hotel's rules, prices, room
-- types, team and settings through normal use: can_manage_hotel() and
-- can_manage_finances() both OR in is_platform_admin(), and every hotel
-- table's write policy calls one of them. Too much power to leave switched
-- on with real customers live.
--
-- After this file:
--
-- 1. Reading is unchanged. is_hotel_accessible() still lets an admin open
--    and view any property.
--
-- 2. Writing needs God Mode. The admin branch of can_manage_hotel(),
--    can_manage_finances(), hotels_delete, the membership and simulation
--    rank triggers and the hotel team RPCs now also requires
--    god_mode_active(): the caller is a platform admin, their JWT is aal2 (a
--    code from their authenticator app, Supabase Auth MFA), and they hold an
--    open window in support_sessions opened in this same sign-in session
--    (the JWT's session_id), so a window on one device does nothing for the
--    same login on another. Hotel members' own access is exactly as before.
--    Platform-wide Command Center actions (creating a hotel, signup codes,
--    pending invites, stalled signups) are not hotel edits and keep their
--    plain is_platform_admin() checks. Making someone MAYA staff, or taking
--    it away (platform_grant_role, platform_revoke_role), needs God Mode:
--    a new staff account can enrol its own authenticator and open God Mode,
--    so granting the role is worth as much as God Mode itself.
--
-- 3. Time-boxed, and a fresh code every time. god_mode_start() opens a
--    window of god_mode_minutes() (the one setting, 30) only for a code
--    entered in the last 5 minutes: a totp entry in the JWT's amr claim, not
--    just an aal2 session, which Supabase keeps at aal2 for its whole life
--    after one code. god_mode_end() closes the admin's windows.
--    god_mode_status() is what the banner and the app's helper read, and it
--    is where leaving by expiry is recorded the first time anyone looks
--    after the window ran out. A window covers every property.
--
-- 4. Logged. Entering and leaving go to platform_audit_events
--    (god_mode.started / ended / expired, no hotel_id). Every row an admin
--    changes under their own JWT in God Mode goes to support_changes through
--    the god_mode_record_change trigger; app routes that write with the
--    service role on an admin's behalf write the same rows themselves.
--    The trigger is on every table a signed-in admin can write in God Mode
--    (read from the write policies, section 8), except those that hold a
--    secret. support_changes is a separate table on purpose:
--    never_paid_last_activity counts platform_audit_events rows with an
--    actor as customer activity, and a support edit must not hold a
--    never-paid property back from retention. For the same reason it now
--    leaves out product events and audit lines by MAYA staff (section 7).
--
-- 5. base_rate_calendar_access was one FOR ALL policy whose USING
--    (is_hotel_accessible) governed DELETE and the UPDATE row filter, so any
--    member and a read-only admin could delete base rates. Split per command.
--
-- Run after 99_supabase_migration_rule_activation_v1.sql. save_rule (from that
-- file) checks can_manage_hotel() under the caller's own JWT, so saving a rule,
-- switching one on, and the activation popup's Apply or Skip all need God Mode
-- for an admin, and the rows it writes (the rule, its condition and room types,
-- a Skip's ladder marks and rule_skip_hold days) are recorded like any other.
-- Idempotent.
-- Supabase dashboard: Authentication -> Multi-Factor Authentication -> TOTP on,
-- or god_mode_start() can never see aal2.

begin;

-- ── 1. The windows ─────────────────────────────────────────────────────────

create table if not exists public.support_sessions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  started_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  ended_at         timestamptz,
  end_reason       text check (end_reason in ('ended', 'expired', 'replaced')),
  expiry_logged_at timestamptz,
  -- The Supabase Auth session (the JWT's session_id) the window was opened
  -- in. Only that session can use it: a window opened on one laptop does
  -- nothing for the same login on another device.
  auth_session_id  text
);

alter table public.support_sessions add column if not exists auth_session_id text;

create index if not exists idx_support_sessions_user
  on public.support_sessions (user_id, expires_at desc);

alter table public.support_sessions enable row level security;

revoke all on public.support_sessions from public, anon, authenticated, service_role;
grant select on public.support_sessions to authenticated;
grant select, insert, update, delete on public.support_sessions to service_role;

-- An admin sees their own windows; writes only happen through the functions.
drop policy if exists support_sessions_own_read on public.support_sessions;
create policy support_sessions_own_read on public.support_sessions
  for select using (public.is_platform_admin() and user_id = auth.uid());

-- ── 2. The changes ─────────────────────────────────────────────────────────

create table if not exists public.support_changes (
  id         bigint generated always as identity primary key,
  session_id uuid references public.support_sessions(id) on delete set null,
  user_id    uuid not null,
  hotel_id   uuid references public.hotels(id) on delete set null,
  at         timestamptz not null default now(),
  table_name text not null,
  row_id     text,
  op         text check (op in ('insert', 'update', 'delete')),
  before     jsonb,
  after      jsonb,
  summary    text
);

create index if not exists idx_support_changes_hotel
  on public.support_changes (hotel_id, at desc);
create index if not exists idx_support_changes_session
  on public.support_changes (session_id, at);

alter table public.support_changes enable row level security;

revoke all on public.support_changes from public, anon, authenticated, service_role;
grant select on public.support_changes to authenticated;
grant select, insert, update, delete on public.support_changes to service_role;
grant usage, select on sequence public.support_changes_id_seq to service_role;

-- Admins read them all; a hotel's members read their own property's, so the
-- change log can show "Changed by MAYA support".
drop policy if exists support_changes_read on public.support_changes;
create policy support_changes_read on public.support_changes
  for select using (
    public.is_platform_admin()
    or (hotel_id is not null and public.is_hotel_accessible(hotel_id))
  );

-- ── 3. The one setting ─────────────────────────────────────────────────────

create or replace function public.god_mode_minutes()
returns integer
language sql
immutable
as $$
  select 30
$$;

revoke all on function public.god_mode_minutes() from public, anon;
grant execute on function public.god_mode_minutes() to authenticated, service_role;

-- ── 4. Is God Mode on for the caller? ──────────────────────────────────────
--
-- False under the service role (auth.uid() is null there), so a service-role
-- write never counts as one made in God Mode; the app records those itself.

create or replace function public.god_mode_active()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_platform_admin()
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
     and exists (
       select 1
       from public.support_sessions s
       where s.user_id = auth.uid()
         and s.auth_session_id = nullif(auth.jwt() ->> 'session_id', '')
         and s.ended_at is null
         and s.expires_at > now()
     )
$$;

revoke all on function public.god_mode_active() from public, anon;
grant execute on function public.god_mode_active() to authenticated, service_role;

-- ── 5. Status, for the banner and the app helper ───────────────────────────
--
-- Not stable: the first look after a window ran out closes it as expired
-- and writes the audit line, so leaving by expiry is on record too.

create or replace function public.god_mode_status()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_aal text := coalesce(auth.jwt() ->> 'aal', 'aal1');
  v_expired record;
  v_open public.support_sessions%rowtype;
begin
  if not public.is_platform_admin() then
    return jsonb_build_object(
      'admin', false, 'aal', v_aal, 'active', false,
      'session_id', null, 'started_at', null, 'expires_at', null);
  end if;

  for v_expired in
    select id, expires_at
    from public.support_sessions
    where user_id = auth.uid()
      and ended_at is null
      and expires_at <= now()
      and expiry_logged_at is null
  loop
    update public.support_sessions
       set ended_at = v_expired.expires_at,
           end_reason = 'expired',
           expiry_logged_at = now()
     where id = v_expired.id;
    insert into public.platform_audit_events (actor_user_id, event_type, entity_type, entity_id, detail)
    values (auth.uid(), 'god_mode.expired', 'support_session', v_expired.id::text,
            jsonb_build_object('expires_at', v_expired.expires_at));
  end loop;

  -- Only a window opened in this sign-in session is this session's.
  select * into v_open
  from public.support_sessions
  where user_id = auth.uid()
    and auth_session_id = nullif(auth.jwt() ->> 'session_id', '')
    and ended_at is null
    and expires_at > now()
  order by expires_at desc
  limit 1;

  return jsonb_build_object(
    'admin', true,
    'aal', v_aal,
    'active', v_open.id is not null and v_aal = 'aal2',
    'session_id', v_open.id,
    'started_at', v_open.started_at,
    'expires_at', v_open.expires_at);
end;
$$;

revoke all on function public.god_mode_status() from public, anon;
grant execute on function public.god_mode_status() to authenticated, service_role;

-- ── 6. Start and end ───────────────────────────────────────────────────────

create or replace function public.god_mode_start()
returns public.support_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.support_sessions%rowtype;
  v_session text := nullif(auth.jwt() ->> 'session_id', '');
  v_amr jsonb := auth.jwt() -> 'amr';
begin
  if not public.is_platform_admin() then
    raise exception 'Only MAYA staff can turn on God Mode.' using errcode = '42501';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Enter the code from your authenticator app first.' using errcode = '42501';
  end if;
  -- A code entered just now, not an aal2 session from days ago: the JWT's
  -- amr lists each way this session proved who it is, with when.
  if not exists (
    select 1
    from jsonb_array_elements(case when jsonb_typeof(v_amr) = 'array' then v_amr else '[]'::jsonb end) as m(v)
    where m.v ->> 'method' = 'totp'
      and jsonb_typeof(m.v -> 'timestamp') = 'number'
      and to_timestamp((m.v ->> 'timestamp')::double precision) >= now() - interval '5 minutes'
  ) then
    raise exception 'Enter a new code from your authenticator app to turn on God Mode.' using errcode = '42501';
  end if;
  if v_session is null then
    raise exception 'Sign in again, then turn on God Mode.' using errcode = '42501';
  end if;

  -- One window at a time: starting again replaces the open one.
  update public.support_sessions
     set ended_at = now(), end_reason = 'replaced'
   where user_id = auth.uid()
     and ended_at is null
     and expires_at > now();

  insert into public.support_sessions (user_id, expires_at, auth_session_id)
  values (auth.uid(), now() + make_interval(mins => public.god_mode_minutes()), v_session)
  returning * into v_row;

  insert into public.platform_audit_events (actor_user_id, event_type, entity_type, entity_id, detail)
  values (auth.uid(), 'god_mode.started', 'support_session', v_row.id::text,
          jsonb_build_object('expires_at', v_row.expires_at));

  return v_row;
end;
$$;

create or replace function public.god_mode_end()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_closed record;
begin
  if not public.is_platform_admin() then
    raise exception 'Only MAYA staff can turn off God Mode.' using errcode = '42501';
  end if;

  for v_closed in
    update public.support_sessions
       set ended_at = now(), end_reason = 'ended'
     where user_id = auth.uid()
       and ended_at is null
       and expires_at > now()
    returning id, expires_at
  loop
    insert into public.platform_audit_events (actor_user_id, event_type, entity_type, entity_id, detail)
    values (auth.uid(), 'god_mode.ended', 'support_session', v_closed.id::text,
            jsonb_build_object('expires_at', v_closed.expires_at));
  end loop;
end;
$$;

revoke all on function public.god_mode_start() from public, anon;
grant execute on function public.god_mode_start() to authenticated, service_role;
revoke all on function public.god_mode_end() from public, anon;
grant execute on function public.god_mode_end() to authenticated, service_role;

-- ── 7. The admin branch of every hotel write now needs God Mode ────────────
--
-- Bodies as in roles_v2_part2, with is_platform_admin() joined to
-- god_mode_active(). Reads (is_hotel_accessible) are left alone.

create or replace function public.can_manage_hotel(target_hotel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (public.is_platform_admin() and public.god_mode_active())
      or has_hotel_role(
           target_hotel_id,
           array['hotel_admin', 'general_manager', 'revenue_manager']
         )
$$;

create or replace function public.can_manage_finances(target_hotel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (public.is_platform_admin() and public.god_mode_active())
      or has_hotel_role(
           target_hotel_id,
           array['hotel_admin', 'general_manager']
         )
$$;

-- Deleting a property (no_customer_deletes_v1 gave this to admins alone).
drop policy if exists hotels_delete on hotels;
create policy hotels_delete
  on hotels for delete
  using (is_platform_admin() and god_mode_active());

-- The rank triggers' admin bypass (roles_v2_part2), otherwise unchanged.
create or replace function public.enforce_membership_rank()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_rank integer;
  target_rank integer;
  previous_rank integer;
begin
  if (select auth.role()) = 'service_role'
     or (public.is_platform_admin() and public.god_mode_active()) then
    return new;
  end if;

  actor_rank := public.my_hotel_rank(new.hotel_id);
  target_rank := public.hotel_role_rank(new.role::text);

  -- Only General Manager and up may touch membership at all.
  if actor_rank < public.hotel_role_rank('general_manager') then
    raise exception 'Changing team roles requires General Manager access'
      using errcode = '42501';
  end if;

  if target_rank > actor_rank then
    raise exception 'You cannot grant a role above your own'
      using errcode = '42501';
  end if;

  -- Demoting or removing someone senior to you is equally off limits.
  if tg_op = 'UPDATE' then
    previous_rank := public.hotel_role_rank(old.role::text);
    if previous_rank > actor_rank then
      raise exception 'You cannot change the role of someone above you'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.enforce_membership_delete_rank()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) = 'service_role'
     or (public.is_platform_admin() and public.god_mode_active()) then
    return old;
  end if;
  if public.my_hotel_rank(old.hotel_id) < public.hotel_role_rank('general_manager')
     or public.hotel_role_rank(old.role::text) > public.my_hotel_rank(old.hotel_id) then
    raise exception 'You cannot remove a member at or above your own level'
      using errcode = '42501';
  end if;
  return old;
end;
$$;

create or replace function public.enforce_simulation_mode_rank()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) = 'service_role'
     or (public.is_platform_admin() and public.god_mode_active()) then
    return new;
  end if;
  if new.simulation_mode is distinct from old.simulation_mode
     and not public.can_manage_finances(new.hotel_id) then
    raise exception 'Taking pricing live requires General Manager access'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- The hotel team RPCs (command_center_v3), otherwise unchanged. Under the
-- service role the app checks God Mode itself before calling them.
create or replace function public.platform_invite_user(
  p_email citext,
  p_hotel_id uuid,
  p_role public.hotel_membership_role,
  p_supabase_invite_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_existing_user uuid;
begin
  if (select auth.role()) is distinct from 'service_role'
     and not ((public.is_platform_admin() and public.god_mode_active())
              or public.can_manage_hotel(p_hotel_id)) then
    raise exception 'Not authorized to invite users to hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  insert into public.pending_memberships (email, hotel_id, role, invited_by, supabase_invite_id)
  values (lower(p_email::text)::citext, p_hotel_id, p_role, auth.uid(), p_supabase_invite_id)
  on conflict (email, hotel_id) do update
    set role = excluded.role,
        status = 'pending',
        invited_by = excluded.invited_by,
        invited_at = now(),
        accepted_at = null,
        accepted_by = null,
        supabase_invite_id = excluded.supabase_invite_id
  returning id into v_id;

  select u.id into v_existing_user
  from auth.users u
  where u.email = p_email::text
  limit 1;

  if v_existing_user is not null then
    insert into public.hotel_memberships (hotel_id, user_id, role, status)
    values (p_hotel_id, v_existing_user, p_role, 'active')
    on conflict (hotel_id, user_id) do update
      set role = excluded.role,
          status = 'active';

    update public.pending_memberships
       set status = 'accepted',
           accepted_at = now(),
           accepted_by = v_existing_user
     where id = v_id;
  end if;

  insert into public.platform_audit_events (actor_user_id, event_type, entity_type, entity_id, hotel_id, detail)
  values (
    auth.uid(),
    case when v_existing_user is not null then 'user.added_to_hotel' else 'user.invited' end,
    'pending_membership',
    v_id::text,
    p_hotel_id,
    jsonb_build_object(
      'email', lower(p_email::text),
      'role', p_role::text,
      'existing_user', v_existing_user is not null
    )
  );

  return v_id;
end;
$$;

create or replace function public.platform_set_membership_role(
  p_hotel_id uuid,
  p_user_id uuid,
  p_role public.hotel_membership_role
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not ((public.is_platform_admin() and public.god_mode_active())
              or public.can_manage_hotel(p_hotel_id)) then
    raise exception 'Not authorized to modify memberships for hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  update public.hotel_memberships
     set role = p_role
   where hotel_id = p_hotel_id and user_id = p_user_id;

  if not found then
    raise exception 'Membership not found (hotel=%, user=%)', p_hotel_id, p_user_id
      using errcode = 'P0002';
  end if;

  insert into public.platform_audit_events (actor_user_id, event_type, entity_type, entity_id, hotel_id, detail)
  values (auth.uid(), 'membership.role_changed', 'hotel_membership',
          p_hotel_id::text || ':' || p_user_id::text, p_hotel_id,
          jsonb_build_object('user_id', p_user_id, 'new_role', p_role::text));
end;
$$;

create or replace function public.platform_remove_membership(
  p_hotel_id uuid,
  p_user_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
     and not ((public.is_platform_admin() and public.god_mode_active())
              or public.can_manage_hotel(p_hotel_id)) then
    raise exception 'Not authorized to remove memberships for hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  delete from public.hotel_memberships
   where hotel_id = p_hotel_id and user_id = p_user_id;

  insert into public.platform_audit_events (actor_user_id, event_type, entity_type, entity_id, hotel_id, detail)
  values (auth.uid(), 'membership.removed', 'hotel_membership',
          p_hotel_id::text || ':' || p_user_id::text, p_hotel_id,
          jsonb_build_object('user_id', p_user_id));
end;
$$;

-- Making someone MAYA staff, or taking it away (command_center_v3, otherwise
-- unchanged). A new staff account can enrol its own authenticator and open
-- God Mode, so an admin signed in with only a password must not be able to
-- make one: outside the service role this needs God Mode too.
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
end;
$$;

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

  if p_role = 'platform_admin'
     and p_user_id = auth.uid()
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

-- A never-paid property's last activity (never_paid_retention_v1, otherwise
-- unchanged) leaves out what MAYA staff did there: an admin looking at a
-- property or changing it in God Mode is support, not the customer, and
-- must not hold the property back from the retention sweep.
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
        and public.product_event_by_person(e.event, e.source, e.properties)
        and not exists (
          select 1 from public.app_roles ar
           where ar.user_id = e.user_id and ar.role = 'platform_admin'
        )),
    -- Only a person connecting or reconnecting creates a connection row; the
    -- scheduler only ever updates one, and the purge deletes it.
    (select max(c.created_at) from public.pms_connections c where c.hotel_id = h.id),
    -- The Marketplace and OAuth connect lines are written with no actor, but
    -- each is a person clicking Connect App, connecting, claiming, or paying.
    (select max(a.created_at)
       from public.platform_audit_events a
      where a.hotel_id = h.id
        and (a.actor_user_id is not null
             or nullif(a.detail->>'actor_user_id', '') is not null
             or a.detail->>'via' in ('marketplace_flow_a', 'oauth'))
        and not exists (
          select 1 from public.app_roles ar
           where ar.role = 'platform_admin'
             and ar.user_id::text in (a.actor_user_id::text, nullif(a.detail->>'actor_user_id', ''))
        ))
  )
    from public.hotels h
   where h.id = p_hotel_id
$$;

revoke all on function public.never_paid_last_activity(uuid) from public, anon, authenticated, service_role;

-- base_rate_calendar: one policy per command, like every other hotel table.
drop policy if exists base_rate_calendar_access on base_rate_calendar;
drop policy if exists base_rate_calendar_read on base_rate_calendar;
create policy base_rate_calendar_read on base_rate_calendar
  for select using (is_hotel_accessible(hotel_id));
drop policy if exists base_rate_calendar_insert on base_rate_calendar;
create policy base_rate_calendar_insert on base_rate_calendar
  for insert with check (can_manage_hotel(hotel_id));
drop policy if exists base_rate_calendar_update on base_rate_calendar;
create policy base_rate_calendar_update on base_rate_calendar
  for update using (can_manage_hotel(hotel_id))
  with check (can_manage_hotel(hotel_id));
drop policy if exists base_rate_calendar_delete on base_rate_calendar;
create policy base_rate_calendar_delete on base_rate_calendar
  for delete using (can_manage_hotel(hotel_id));

-- Reading rate updates is a read: rls_hardening_v1 already says so, and this
-- says so again so no database is left with the older can_manage_hotel form.
drop policy if exists rate_updates_read on public.rate_updates;
create policy rate_updates_read on public.rate_updates
  for select using (is_hotel_accessible(hotel_id));

-- ── 8. Every change made in God Mode is recorded ───────────────────────────

-- The line the change log prints: what kind of row, its name where it has
-- one, and for an update which columns moved.
create or replace function public.god_mode_change_summary(
  p_table text,
  p_op text,
  p_before jsonb,
  p_after jsonb
) returns text
language plpgsql
immutable
as $$
declare
  v_noun text;
  v_row jsonb := coalesce(p_after, p_before);
  v_name text;
  v_cols text[] := '{}';
  v_key text;
begin
  v_noun := case p_table
    when 'pricing_rules'           then 'the pricing rule'
    when 'rule_condition'          then 'the conditions of a rule'
    when 'rule_signal_room_type'   then 'a signal room type of a rule'
    when 'rule_affected_room_type' then 'an affected room type of a rule'
    when 'pricing_rule_conditions' then 'a rule condition'
    when 'pricing_rule_room_types' then 'a room type of a rule'
    when 'ladder_rule_state'       then 'the ladder state of a rule'
    when 'rule_skip_hold'          then 'a held day of a rule'
    when 'pickup_event'            then 'a pickup event'
    when 'hotel_settings'          then 'the property settings'
    when 'room_types'              then 'the room type'
    when 'hotel_closed_periods'    then 'a closed period'
    when 'base_rate_calendar'      then 'a base rate'
    when 'hotel_memberships'       then 'a team member'
    when 'pms_connections'         then 'the property system connection'
    when 'hotels'                  then 'the property'
    when 'assumption_challenges'   then 'a correction'
    when 'onboarding_findings'     then 'a setup finding'
    when 'onboarding_states'       then 'the setup state'
    when 'rule_repeat_alerts'      then 'a repeat alert of a rule'
    when 'rule_repeat_alert_nights' then 'a night of a repeat alert'
    when 'published_price'         then 'a published price'
    when 'rate_updates'            then 'a sending record'
    when 'market_events'           then 'a market event'
    when 'reservations'            then 'a reservation'
    else 'a ' || replace(p_table, '_', ' ') || ' row'
  end;
  v_name := case
    when coalesce(v_row ->> 'name', '') <> '' then ' "' || left(v_row ->> 'name', 60) || '"'
    else ''
  end;

  if p_op = 'insert' then
    return 'Added ' || v_noun || v_name || '.';
  elsif p_op = 'delete' then
    return 'Removed ' || v_noun || v_name || '.';
  end if;

  for v_key in
    select k from jsonb_object_keys(coalesce(p_after, '{}'::jsonb)) as k
    where k not in ('updated_at')
      and (p_after -> k) is distinct from (p_before -> k)
    order by k
  loop
    v_cols := v_cols || (v_key || ' from ' || coalesce(left(p_before ->> v_key, 40), 'nothing')
                         || ' to ' || coalesce(left(p_after ->> v_key, 40), 'nothing'));
  end loop;

  if coalesce(array_length(v_cols, 1), 0) = 0 then
    return 'Saved ' || v_noun || v_name || ' with nothing changed.';
  end if;
  if array_length(v_cols, 1) > 6 then
    return 'Changed ' || v_noun || v_name || ': '
      || array_to_string(v_cols[1:6], ', ')
      || ' and ' || (array_length(v_cols, 1) - 6)::text || ' more.';
  end if;
  return 'Changed ' || v_noun || v_name || ': ' || array_to_string(v_cols, ', ') || '.';
end;
$$;

revoke all on function public.god_mode_change_summary(text, text, jsonb, jsonb) from public, anon;
grant execute on function public.god_mode_change_summary(text, text, jsonb, jsonb) to authenticated, service_role;

-- Fires after every row write on the hotel tables below and does nothing
-- unless it is a platform admin writing under their own JWT in God Mode.
-- Service-role writes (the engine, the syncs, the app's admin paths) never
-- match: auth.role() is service_role and auth.uid() is null there.
create or replace function public.god_mode_record_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_row jsonb;
  v_hotel uuid;
  v_session uuid;
begin
  if (select auth.role()) is distinct from 'authenticated' or not public.god_mode_active() then
    return null;
  end if;

  if tg_op <> 'INSERT' then v_before := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_after := to_jsonb(new); end if;
  v_row := coalesce(v_after, v_before);

  v_hotel := case
    when tg_table_name = 'hotels' then (v_row ->> 'id')::uuid
    when v_row ? 'hotel_id' then (v_row ->> 'hotel_id')::uuid
    when v_row ? 'rule_id' then public.rule_hotel_id((v_row ->> 'rule_id')::uuid)
    else null
  end;

  -- A deleted rule takes its conditions and room types with it, and by then
  -- rule_hotel_id() finds no rule. The rule's own row, recorded in this same
  -- transaction (at is its start time), names the property.
  if v_hotel is null and v_row ? 'rule_id' then
    select sc.hotel_id into v_hotel
    from public.support_changes sc
    where sc.table_name = 'pricing_rules'
      and sc.row_id = v_row ->> 'rule_id'
      and sc.user_id = auth.uid()
      and sc.at = now()
      and sc.hotel_id is not null
    order by sc.id desc
    limit 1;
  end if;

  select s.id into v_session
  from public.support_sessions s
  where s.user_id = auth.uid()
    and s.auth_session_id = nullif(auth.jwt() ->> 'session_id', '')
    and s.ended_at is null
    and s.expires_at > now()
  order by s.expires_at desc
  limit 1;

  insert into public.support_changes
    (session_id, user_id, hotel_id, table_name, row_id, op, before, after, summary)
  values (
    v_session,
    auth.uid(),
    v_hotel,
    tg_table_name,
    coalesce(
      v_row ->> 'id',
      concat_ws(':', v_row ->> 'hotel_id', v_row ->> 'rule_id', v_row ->> 'room_type_id',
                     v_row ->> 'stay_date', v_row ->> 'rule_version')),
    lower(tg_op),
    v_before,
    v_after,
    public.god_mode_change_summary(tg_table_name, lower(tg_op), v_before, v_after)
  );

  -- And the other way round: rows of the rule recorded before the rule's own
  -- delete (the cascade can run first) get the property now.
  if tg_table_name = 'pricing_rules' and tg_op = 'DELETE' and v_hotel is not null then
    update public.support_changes sc
       set hotel_id = v_hotel
     where sc.hotel_id is null
       and sc.user_id = auth.uid()
       and sc.at = now()
       and sc.op = 'delete'
       and sc.before ->> 'rule_id' = v_row ->> 'id';
  end if;
  return null;
end;
$$;

revoke all on function public.god_mode_record_change() from public, anon, authenticated;

-- Every table a signed-in admin can write in God Mode: each public table
-- whose write policy lets can_manage_hotel(), can_manage_finances() or
-- god_mode_active() through, read from pg_policies so a table that gains
-- such a policy later is found when this file runs again, plus the tables
-- only save_rule and the repeat alert RPCs write (no write policy of their
-- own; those RPCs check can_manage_hotel() under the caller's JWT). Never
-- a table that holds a secret: its before and after would be copied into
-- rows the property's members can read.
--
-- The WHEN clause keeps the service role's bulk writes (the syncs, the
-- engine, the push) from calling the function at all.
create or replace function public.god_mode_recorded_tables()
returns setof text
language sql
stable
set search_path = public, pg_temp
as $$
  select distinct t
  from (
    select p.tablename::text as t
    from pg_policies p
    where p.schemaname = 'public'
      and p.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      and concat_ws(' ', p.qual, p.with_check) ~ '(can_manage_hotel|can_manage_finances|god_mode_active)'
    union all
    select unnest(array['rule_skip_hold', 'rule_repeat_alerts', 'rule_repeat_alert_nights'])
  ) x
  where to_regclass('public.' || quote_ident(t)) is not null
    and t not in ('support_sessions', 'support_changes', 'pms_connection_secrets')
  order by t
$$;

revoke all on function public.god_mode_recorded_tables() from public, anon, authenticated;

do $$
declare
  t text;
begin
  for t in select public.god_mode_recorded_tables()
  loop
    execute format('drop trigger if exists trg_god_mode_record_change on public.%I', t);
    execute format(
      'create trigger trg_god_mode_record_change after insert or update or delete on public.%I '
      || 'for each row when (current_user <> ''service_role'') '
      || 'execute function public.god_mode_record_change()', t);
  end loop;
end $$;

commit;

-- Check afterwards. Without an open window an admin's UPDATE on a customer's
-- pricing_rules matches no rows; with one it lands and support_changes gains
-- a row:
--
--   select * from public.god_mode_status();
--   select table_name, op, summary from public.support_changes order by at desc limit 20;
