-- MAYA Command Center v1 Migration (DB foundation)
-- Implements the database layer for the Admin Command Center described in
-- maya-rms/FUTURE_IMPLEMENTATION_PLAN.md and command-center-plan.md.
--
-- Run AFTER 02_supabase_schema.sql when upgrading a database that was created
-- before Command Center v1 objects existed. If you load 02 from this repo
-- on a fresh project, you can skip this file (02 includes the model).
--
-- This migration:
--   1) Adds the `app_role` and `pending_membership_status` enums.
--   2) Adds the `app_roles` table for platform-level roles + locks it down.
--   3) Adds `is_platform_admin(uuid)` SECURITY DEFINER helper.
--   4) Rewrites `is_hotel_accessible` / `can_manage_hotel` so platform admins
--      bypass all hotel-scoped RLS without touching individual policies.
--   5) Updates `auto_hotel_creator_membership` so platform admins do NOT
--      automatically become hotel_admin when they provision a hotel.
--   6) Adds `pending_memberships` table + `trg_accept_pending_memberships`
--      trigger on auth.users to auto-attach memberships on signup/invite accept.
--   7) Adds `platform_audit_events` table for provisioning-action audit log.
--
-- After this runs:
--   * No production user is a platform admin until someone explicitly inserts
--     a row into `public.app_roles`. From the SQL Editor, as service role:
--
--       insert into public.app_roles (user_id, role)
--       values ('<your-auth.users-uuid>', 'platform_admin');
--
--   * RLS behavior is unchanged for everyone except platform admins.
--   * Pending memberships are not yet emitted; the UI in PR 4 wires that up.

begin;

-- ============================================================================
-- 1. Required extensions (case-insensitive email comparisons)
-- ============================================================================

create extension if not exists citext;

-- ============================================================================
-- 2. Enums
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type public.app_role as enum ('platform_admin', 'platform_support');
  end if;

  if not exists (select 1 from pg_type where typname = 'pending_membership_status') then
    create type public.pending_membership_status as enum (
      'pending', 'accepted', 'expired', 'revoked'
    );
  end if;
end $$;

-- ============================================================================
-- 3. app_roles — platform-level roles. Locked down; no JWT-level access.
--    Operators manage rows from the SQL Editor (or via /admin/users in v1).
-- ============================================================================

create table if not exists public.app_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id) on delete set null,
  primary key (user_id, role)
);

alter table public.app_roles enable row level security;

revoke all on public.app_roles from public;
revoke all on public.app_roles from anon;
revoke all on public.app_roles from authenticated;
grant select, insert, update, delete on public.app_roles to service_role;

comment on table public.app_roles is
  'Platform-level roles independent of hotel memberships. Read-only via the '
  'SECURITY DEFINER helper is_platform_admin(); writes only via service role '
  'or future SECURITY DEFINER admin RPCs. JWT roles cannot SELECT this table.';

-- ============================================================================
-- 4. is_platform_admin(uuid) — gateway helper for platform-admin RLS bypass
-- ============================================================================

create or replace function public.is_platform_admin(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.app_roles
    where user_id = p_user_id
      and role = 'platform_admin'
  )
$$;

revoke all on function public.is_platform_admin(uuid) from public;
grant execute on function public.is_platform_admin(uuid)
  to authenticated, service_role;

comment on function public.is_platform_admin(uuid) is
  'Returns true if the given user (default auth.uid()) has the platform_admin '
  'role in app_roles. Used by is_hotel_accessible / can_manage_hotel to bypass '
  'hotel-membership checks for platform operators.';

-- ============================================================================
-- 5. Update is_hotel_accessible / can_manage_hotel to bypass for platform admins
--    The change is purely additive: existing hotel-membership semantics are
--    preserved for non-admins via the OR.
-- ============================================================================

create or replace function public.is_hotel_accessible(target_hotel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_platform_admin()
      or public.has_hotel_role(
           target_hotel_id,
           array['hotel_admin', 'manager', 'staff', 'viewer']
         )
$$;

create or replace function public.can_manage_hotel(target_hotel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_platform_admin()
      or public.has_hotel_role(
           target_hotel_id,
           array['hotel_admin', 'manager']
         )
$$;

-- ============================================================================
-- 6. Update auto_hotel_creator_membership to skip platform admins.
--    Customer-self-serve creators still get a hotel_admin row; platform
--    operators provisioning on behalf of customers do not.
-- ============================================================================

create or replace function public.auto_hotel_creator_membership()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null and not public.is_platform_admin() then
    insert into public.hotel_memberships (hotel_id, user_id, role, status)
    values (new.id, auth.uid(), 'hotel_admin', 'active')
    on conflict (hotel_id, user_id) do nothing;
  end if;
  return new;
end;
$$;

-- Trigger already exists from 02_supabase_schema.sql; recreating the function
-- is enough. No DDL change needed on the trigger itself.

-- ============================================================================
-- 7. pending_memberships — pre-staged invitations
-- ============================================================================

create table if not exists public.pending_memberships (
  id uuid primary key default gen_random_uuid(),
  email citext not null,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  role public.hotel_membership_role not null,
  status public.pending_membership_status not null default 'pending',
  invited_by uuid references auth.users(id) on delete set null,
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  supabase_invite_id uuid,
  unique (email, hotel_id)
);

create index if not exists idx_pending_memberships_email
  on public.pending_memberships (email);
create index if not exists idx_pending_memberships_hotel_status
  on public.pending_memberships (hotel_id, status);

alter table public.pending_memberships enable row level security;

revoke all on public.pending_memberships from public;
revoke all on public.pending_memberships from anon;
revoke all on public.pending_memberships from authenticated;
grant select, insert, update, delete on public.pending_memberships to service_role;

comment on table public.pending_memberships is
  'Pre-staged hotel memberships for invited users. Materialized into '
  'hotel_memberships by trg_accept_pending_memberships on auth.users insert. '
  'Access only via SECURITY DEFINER RPCs (PR 2) or service role.';

-- ============================================================================
-- 8. accept_pending_memberships_for_user — trigger on auth.users
--    Fires on user creation (signup or invite accept). Materializes any
--    pending invites for the new user's email into real hotel_memberships,
--    marks the pending rows accepted, and ensures a profile row exists.
-- ============================================================================

create or replace function public.accept_pending_memberships_for_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.email is null then
    return new;
  end if;

  -- Ensure a profile row exists so the rest of the app sees this user
  insert into public.profiles (id, full_name, is_active)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', null),
    true
  )
  on conflict (id) do nothing;

  -- Materialize any pending invites matching this email
  insert into public.hotel_memberships (hotel_id, user_id, role, status)
  select pm.hotel_id, new.id, pm.role, 'active'
  from public.pending_memberships pm
  where pm.email = (new.email)::citext
    and pm.status = 'pending'
  on conflict (hotel_id, user_id) do nothing;

  -- Mark the invites accepted
  update public.pending_memberships pm
     set status = 'accepted',
         accepted_at = now(),
         accepted_by = new.id
   where pm.email = (new.email)::citext
     and pm.status = 'pending';

  return new;
end;
$$;

drop trigger if exists trg_accept_pending_memberships on auth.users;
create trigger trg_accept_pending_memberships
  after insert on auth.users
  for each row execute function public.accept_pending_memberships_for_user();

-- ============================================================================
-- 9. platform_audit_events — provisioning-action audit log
--    Not hotel-scoped: some actions (e.g. user grants platform_admin) have
--    no parent hotel. UI lands in v1.1; writes start now.
-- ============================================================================

create table if not exists public.platform_audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  entity_type text not null,
  entity_id text,
  hotel_id uuid references public.hotels(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_platform_audit_events_created_at
  on public.platform_audit_events(created_at desc);
create index if not exists idx_platform_audit_events_hotel
  on public.platform_audit_events(hotel_id, created_at desc);
create index if not exists idx_platform_audit_events_actor
  on public.platform_audit_events(actor_user_id, created_at desc);

alter table public.platform_audit_events enable row level security;

drop policy if exists platform_audit_events_read on public.platform_audit_events;
create policy platform_audit_events_read
  on public.platform_audit_events for select
  using (public.is_platform_admin());

revoke all on public.platform_audit_events from public;
revoke all on public.platform_audit_events from anon;
revoke insert, update, delete on public.platform_audit_events from authenticated;
grant select on public.platform_audit_events to authenticated;
grant select, insert, update, delete on public.platform_audit_events to service_role;

comment on table public.platform_audit_events is
  'Audit log for platform-level provisioning actions. Read by platform admins '
  'via RLS; writes only via service role or SECURITY DEFINER RPCs (PR 2).';

commit;
