-- MAYA RLS Helpers Lockdown v1 Migration
-- Closes the anon-executable RLS helper hole: rule_hotel_id, has_hotel_role,
-- is_hotel_accessible and can_manage_hotel carried no execute revokes at all,
-- and is_platform_admin's `revoke ... from public` was not enough — Supabase's
-- bootstrap default privileges grant EXECUTE to anon *directly*, which a
-- public-only revoke does not remove. Result: an unauthenticated PostgREST
-- caller could run any of the five (rule_hotel_id even resolves rule uuid ->
-- hotel uuid past RLS), and any caller could probe is_platform_admin with an
-- arbitrary uuid to learn who the platform admins are.
--
-- Run AFTER 02_supabase_schema.sql when upgrading a database created before
-- these revokes existed. If you load 02 from this repo on a fresh
-- project, you can skip this file (02 already includes the lockdown).
--
-- This migration:
--   1) Recreates is_platform_admin so non-service_role callers can only ask
--      about themselves (p_user_id is ignored unless the JWT role is
--      service_role). Every caller in the app passes its own auth.uid() or no
--      argument, so nothing observable changes for legitimate use.
--   2) Revokes execute on all five helpers from public AND anon, granting
--      only authenticated + service_role. All five appear directly in RLS
--      policy expressions, so authenticated must keep execute.
--
-- After this runs, an anon /rest/v1/rpc/ call to any of the five returns
-- 42501 (PostgREST 403), not a result. Anon selects on helper-guarded tables
-- also move from empty 200s to 42501/403 — the policy expression itself now
-- fails the execute check. No app path issues those queries without a
-- session, so nothing user-facing changes.

begin;

-- Non-service callers only get to ask about themselves; honoring an arbitrary
-- p_user_id made this an admin-enumeration oracle for anyone with a uuid.
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
    where user_id = case
        when (select auth.role()) = 'service_role' then p_user_id
        else auth.uid()
      end
      and role = 'platform_admin'
  )
$$;

revoke all on function public.rule_hotel_id(uuid) from public, anon;
grant execute on function public.rule_hotel_id(uuid)
  to authenticated, service_role;

revoke all on function public.has_hotel_role(uuid, text[]) from public, anon;
grant execute on function public.has_hotel_role(uuid, text[])
  to authenticated, service_role;

revoke all on function public.is_platform_admin(uuid) from public, anon;
grant execute on function public.is_platform_admin(uuid)
  to authenticated, service_role;

revoke all on function public.is_hotel_accessible(uuid) from public, anon;
grant execute on function public.is_hotel_accessible(uuid)
  to authenticated, service_role;

revoke all on function public.can_manage_hotel(uuid) from public, anon;
grant execute on function public.can_manage_hotel(uuid)
  to authenticated, service_role;

commit;
