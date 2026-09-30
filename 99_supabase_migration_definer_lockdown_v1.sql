-- ============================================================================
-- MAYA: no function that runs with the owner's rights is open to a signed-out caller
-- ============================================================================
--
-- A SECURITY DEFINER function runs with its owner's rights and reads past row
-- level security. Supabase's bootstrap default privileges grant EXECUTE on
-- every new function to anon, authenticated and service_role directly, so a
-- `revoke ... from public` (which most of the files here wrote) leaves anon
-- with EXECUTE. Sixteen such functions could still be called with the public
-- key and no account: the RLS helpers can_manage_finances and my_hotel_rank,
-- the staff console's platform_* functions, platform_log_event, and the
-- three pms_secret_* functions. Every one of them refuses a signed-out caller
-- inside its body (or answers nothing for one), so nothing leaked through
-- them; but a body check is one bug away from a leak, which is exactly how
-- onboarding_daily_room_nights and onboarding_room_type_stats were open
-- (99_supabase_migration_onboarding_stats_lockdown_v1.sql). The grant is
-- the door, and this file closes it:
--
--   1. EXECUTE is revoked from anon (and public) on every SECURITY DEFINER
--      function in the public schema that is not a trigger function. Found
--      from the catalogue at run time, so a function this repository does
--      not know about is closed too, and each one is named in a notice.
--      authenticated and service_role keep exactly what they have.
--
--   2. hotel_has_live_subscription(uuid) answered any signed-in caller for
--      any property id whether that property has a live subscription. No
--      policy has used it since 99_supabase_migration_god_mode_v1.sql
--      rewrote hotels_delete, and nothing in the app calls it. It is closed
--      to authenticated as well: the service role alone may call it.
--
-- What breaks for anon: an anon PostgREST call to any of these now answers
-- 42501 (403), not a refusal from inside the function. An anon select on a
-- table whose policy uses can_manage_finances answers 42501 instead of an
-- empty 200, as it already does for every table whose policy uses
-- is_hotel_accessible (99_supabase_migration_rls_helpers_lockdown_v1.sql).
-- No app path queries as anon.
--
-- What an owner may notice: nothing.
--
-- A standing test (maya-rms/src/lib/security/definer-functions-sql.test.ts)
-- builds the whole schema and fails when any SECURITY DEFINER function is
-- open to anon, or to authenticated without checking the caller inside.
--
-- Run AFTER 99_supabase_migration_non_room_types_v1.sql. One transaction.
-- Idempotent: a second run finds nothing to revoke. No deploy is needed
-- before or after.
-- ============================================================================

begin;

-- 1. No signed-out caller may run a function that runs with the owner's rights.
do $$
declare
  fn record;
  n integer := 0;
begin
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.prokind in ('f', 'p')
       and p.prosecdef
       and p.prorettype <> 'trigger'::regtype
       and (has_function_privilege('anon', p.oid, 'execute')
            or has_function_privilege('public', p.oid, 'execute'))
     order by p.proname
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    raise notice 'definer_lockdown_v1: closed % to anon', fn.sig;
    n := n + 1;
  end loop;
  raise notice 'definer_lockdown_v1: % function(s) closed to anon', n;
end $$;

-- 2. hotel_has_live_subscription: unused by any policy or app path, and it
--    answered for any property id. Service role only from here on.
do $$
begin
  if to_regprocedure('public.hotel_has_live_subscription(uuid)') is not null then
    revoke all on function public.hotel_has_live_subscription(uuid) from public, anon, authenticated;
    grant execute on function public.hotel_has_live_subscription(uuid) to service_role;
  end if;
end $$;

-- Self-check: nothing that runs with the owner's rights is open to anon.
do $$
declare
  open_count integer;
begin
  select count(*) into open_count
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.prokind in ('f', 'p')
     and p.prosecdef
     and p.prorettype <> 'trigger'::regtype
     and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('public', p.oid, 'execute'));
  if open_count > 0 then
    raise exception '% SECURITY DEFINER function(s) in public are still open to anon', open_count;
  end if;
  if to_regprocedure('public.hotel_has_live_subscription(uuid)') is not null
     and has_function_privilege('authenticated', 'public.hotel_has_live_subscription(uuid)', 'execute') then
    raise exception 'hotel_has_live_subscription is still open to authenticated';
  end if;
end $$;

commit;

-- To see what is open to whom, at any time:
--
--   select p.oid::regprocedure as fn,
--          has_function_privilege('anon', p.oid, 'execute') as anon,
--          has_function_privilege('authenticated', p.oid, 'execute') as authenticated
--     from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
--    where ns.nspname = 'public' and p.prosecdef and p.prorettype <> 'trigger'::regtype
--    order by 1;
