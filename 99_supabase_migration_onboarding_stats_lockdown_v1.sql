-- ============================================================================
-- MAYA: only the server may read a property's booking counts and rate stats
-- ============================================================================
-- onboarding_daily_room_nights(uuid) and onboarding_room_type_stats(uuid) run
-- with the owner's rights and take any property id. They were open to every
-- caller, signed in or not, so anyone holding the app's public key and a
-- property's id could read that property's nights booked per day and its rate
-- statistics. Only the history import and the suggestions call them, and both
-- run on the service role. From here on only the service role may.
--
-- What an owner may notice: nothing.
--
-- Run AFTER 99_supabase_migration_onboarding_v1.sql (it creates both
-- functions). One transaction. Idempotent: safe to run twice.
-- No deploy is needed before or after.
-- ============================================================================

begin;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.onboarding_daily_room_nights(uuid)',
    'public.onboarding_room_type_stats(uuid)'
  ]
  loop
    if to_regprocedure(fn) is null then
      raise exception 'Missing %, run 99_supabase_migration_onboarding_v1.sql first', fn;
    end if;
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;

-- Self-check: nobody but the service role (and the owner) may run them.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.onboarding_daily_room_nights(uuid)',
    'public.onboarding_room_type_stats(uuid)'
  ]
  loop
    if has_function_privilege('anon', fn, 'execute')
       or has_function_privilege('authenticated', fn, 'execute') then
      raise exception '% is still open to anon or authenticated', fn;
    end if;
    if not has_function_privilege('service_role', fn, 'execute') then
      raise exception '% is closed to the service role', fn;
    end if;
  end loop;
end $$;

commit;
