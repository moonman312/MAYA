-- MAYA Command Center v2 Migration (RPCs + view)
-- Adds the platform_* RPCs, the platform_users_view, and RLS-safe list/get
-- helpers used by the Next.js /admin routes.
--
-- Run AFTER 99_supabase_migration_command_center_v1.sql on existing databases.
-- If you load 02 from this repo on a fresh project, you can skip this
-- file (02 already includes these objects).
--
-- Objects created:
--   * platform_users_view                 (SECURITY DEFINER view over auth.users)
--   * platform_list_users(...)
--   * platform_list_hotel_users(hotel_id)
--   * platform_list_hotels(...)
--   * platform_list_pending_invites(...)
--   * platform_invite_user(email, hotel_id, role, supabase_invite_id)
--   * platform_set_membership_role(hotel_id, user_id, role)
--   * platform_remove_membership(hotel_id, user_id)
--   * platform_revoke_pending(pending_id)
--   * platform_grant_role(user_id, role)
--   * platform_revoke_role(user_id, role)
--   * platform_log_event(event_type, entity_type, entity_id, hotel_id, detail)

begin;

-- ============================================================================
-- 1. platform_users_view — auth.users joined to profiles, restricted use
-- ============================================================================

create or replace view public.platform_users_view as
select
  u.id,
  u.email::text as email,
  u.created_at,
  u.last_sign_in_at,
  p.full_name,
  p.is_active,
  (select array_agg(role::text) from public.app_roles where user_id = u.id) as platform_roles
from auth.users u
left join public.profiles p on p.id = u.id;

revoke all on public.platform_users_view from public;
revoke all on public.platform_users_view from anon;
revoke all on public.platform_users_view from authenticated;
grant select on public.platform_users_view to service_role;

comment on view public.platform_users_view is
  'Auth.users + profiles + platform roles. Not directly queryable via '
  'PostgREST; consumed by SECURITY DEFINER functions platform_list_users / '
  'platform_get_user.';

-- ============================================================================
-- 2. platform_list_users(search, limit, offset)
-- ============================================================================

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
  if not public.is_platform_admin() then
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

revoke all on function public.platform_list_users(text, int, int) from public;
grant execute on function public.platform_list_users(text, int, int)
  to authenticated, service_role;

-- ============================================================================
-- 3. platform_list_hotel_users(hotel_id) — memberships for one hotel + emails
-- ============================================================================

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
  if not (public.is_platform_admin() or public.can_manage_hotel(p_hotel_id)) then
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

revoke all on function public.platform_list_hotel_users(uuid) from public;
grant execute on function public.platform_list_hotel_users(uuid)
  to authenticated, service_role;

-- ============================================================================
-- 4. platform_list_hotels(search) — every hotel + status + membership count
-- ============================================================================

create or replace function public.platform_list_hotels(
  p_search text default null
) returns table (
  id uuid,
  name text,
  timezone text,
  currency text,
  is_active boolean,
  total_rooms_per_type int,
  external_enterprise_id text,
  created_at timestamptz,
  updated_at timestamptz,
  pms_type public.pms_type,
  pms_status public.connection_status,
  pms_last_sync_at timestamptz,
  membership_count int
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
    select
      h.id,
      h.name,
      h.timezone,
      h.currency,
      h.is_active,
      h.total_rooms_per_type,
      h.external_enterprise_id,
      h.created_at,
      h.updated_at,
      pc.pms_type,
      pc.status,
      pc.last_sync_at,
      (select count(*)::int from public.hotel_memberships hm where hm.hotel_id = h.id) as membership_count
    from public.hotels h
    left join public.pms_connections pc on pc.hotel_id = h.id
    where p_search is null
       or h.name ilike '%' || p_search || '%'
    order by h.created_at desc;
end;
$$;

revoke all on function public.platform_list_hotels(text) from public;
grant execute on function public.platform_list_hotels(text)
  to authenticated, service_role;

-- ============================================================================
-- 5. platform_list_pending_invites(hotel_id?) — outstanding invites
-- ============================================================================

create or replace function public.platform_list_pending_invites(
  p_hotel_id uuid default null
) returns table (
  id uuid,
  email text,
  hotel_id uuid,
  hotel_name text,
  role public.hotel_membership_role,
  status public.pending_membership_status,
  invited_by uuid,
  invited_by_email text,
  invited_at timestamptz,
  accepted_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
    select
      pm.id,
      pm.email::text,
      pm.hotel_id,
      h.name as hotel_name,
      pm.role,
      pm.status,
      pm.invited_by,
      inviter.email::text as invited_by_email,
      pm.invited_at,
      pm.accepted_at
    from public.pending_memberships pm
    join public.hotels h on h.id = pm.hotel_id
    left join auth.users inviter on inviter.id = pm.invited_by
    where p_hotel_id is null or pm.hotel_id = p_hotel_id
    order by pm.invited_at desc;
end;
$$;

revoke all on function public.platform_list_pending_invites(uuid) from public;
grant execute on function public.platform_list_pending_invites(uuid)
  to authenticated, service_role;

-- ============================================================================
-- 6. platform_log_event — write to platform_audit_events
-- ============================================================================

create or replace function public.platform_log_event(
  p_event_type text,
  p_entity_type text,
  p_entity_id text default null,
  p_hotel_id uuid default null,
  p_detail jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized to write audit events' using errcode = '42501';
  end if;

  insert into public.platform_audit_events (actor_user_id, event_type, entity_type, entity_id, hotel_id, detail)
  values (auth.uid(), p_event_type, p_entity_type, p_entity_id, p_hotel_id, coalesce(p_detail, '{}'::jsonb))
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.platform_log_event(text, text, text, uuid, jsonb) from public;
grant execute on function public.platform_log_event(text, text, text, uuid, jsonb)
  to authenticated, service_role;

-- ============================================================================
-- 7. platform_invite_user — pre-stage a pending_memberships row
-- ============================================================================

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
  if not (public.is_platform_admin() or public.can_manage_hotel(p_hotel_id)) then
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

  -- If the user already exists (invited to a second hotel), materialize
  -- immediately since the trigger only fires on INSERT to auth.users.
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

revoke all on function public.platform_invite_user(citext, uuid, public.hotel_membership_role, uuid) from public;
grant execute on function public.platform_invite_user(citext, uuid, public.hotel_membership_role, uuid)
  to authenticated, service_role;

-- ============================================================================
-- 8. platform_set_membership_role
-- ============================================================================

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
  if not (public.is_platform_admin() or public.can_manage_hotel(p_hotel_id)) then
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

revoke all on function public.platform_set_membership_role(uuid, uuid, public.hotel_membership_role) from public;
grant execute on function public.platform_set_membership_role(uuid, uuid, public.hotel_membership_role)
  to authenticated, service_role;

-- ============================================================================
-- 9. platform_remove_membership
-- ============================================================================

create or replace function public.platform_remove_membership(
  p_hotel_id uuid,
  p_user_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_platform_admin() or public.can_manage_hotel(p_hotel_id)) then
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

revoke all on function public.platform_remove_membership(uuid, uuid) from public;
grant execute on function public.platform_remove_membership(uuid, uuid)
  to authenticated, service_role;

-- ============================================================================
-- 10. platform_revoke_pending — cancel a pending invite
-- ============================================================================

create or replace function public.platform_revoke_pending(
  p_pending_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hotel_id uuid;
begin
  select hotel_id into v_hotel_id
  from public.pending_memberships
  where id = p_pending_id;

  if v_hotel_id is null then
    raise exception 'Pending invite not found' using errcode = 'P0002';
  end if;

  if not (public.is_platform_admin() or public.can_manage_hotel(v_hotel_id)) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  update public.pending_memberships
     set status = 'revoked'
   where id = p_pending_id and status = 'pending';

  insert into public.platform_audit_events (actor_user_id, event_type, entity_type, entity_id, hotel_id, detail)
  values (auth.uid(), 'invite.revoked', 'pending_membership', p_pending_id::text, v_hotel_id, '{}'::jsonb);
end;
$$;

revoke all on function public.platform_revoke_pending(uuid) from public;
grant execute on function public.platform_revoke_pending(uuid)
  to authenticated, service_role;

-- ============================================================================
-- 11. platform_grant_role / platform_revoke_role — manage app_roles
--     Both are platform-admin-only; used by the /admin/users toggle.
-- ============================================================================

create or replace function public.platform_grant_role(
  p_user_id uuid,
  p_role public.app_role
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_admin() then
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

revoke all on function public.platform_grant_role(uuid, public.app_role) from public;
grant execute on function public.platform_grant_role(uuid, public.app_role)
  to authenticated, service_role;

create or replace function public.platform_revoke_role(
  p_user_id uuid,
  p_role public.app_role
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  -- Safety net: don't let a lone platform admin revoke themselves.
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

revoke all on function public.platform_revoke_role(uuid, public.app_role) from public;
grant execute on function public.platform_revoke_role(uuid, public.app_role)
  to authenticated, service_role;

commit;
