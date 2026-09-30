-- ============================================================================
-- MAYA: an account counts once its email is confirmed
-- ============================================================================
-- "Confirm email" is about to go on in Supabase Auth. From then on anyone can
-- create an account, but it only works once the owner opens the link in the
-- confirmation email. account.created (the top of every signup funnel) was
-- recorded as the profile row was made, which with confirmation on is the
-- moment someone typed an address, confirmed or not. After this file it is
-- recorded when the address is confirmed, once per user:
--
--   1. product_events_profiles() records account.created at profile insert
--      only when the auth user is already confirmed by then. Everything else
--      it does (onboarding.path_chosen, the is_test rule) is exactly as
--      99_supabase_migration_product_events_v1.sql left it.
--   2. A new AFTER UPDATE OF email_confirmed_at trigger on auth.users records
--      account.created the moment email_confirmed_at is first set, dated
--      email_confirmed_at, with the same is_test rule (a + in the address).
--
-- NEVER TWICE. Both paths write through product_event_emit with the same
-- dedupe key per user ('account.created:<user id>'), so whichever comes
-- first wins and the other writes nothing. Both also skip a user who already
-- has an account.created row from before this file (those have no key).
-- Which path fires:
--   * Confirmation on: signUp inserts an unconfirmed user (nothing recorded);
--     opening the link sets email_confirmed_at (path 2 records it).
--   * Confirmation off, as today: Supabase inserts the user and confirms it
--     in the same transaction, so path 2 records it at sign-up, as now.
--   * A user created already confirmed (by an admin, say): path 1 records it
--     at insert, and a later update never fires path 2.
--   * An invitation: the invited user is unconfirmed until they accept, so
--     the account counts when they accept.
--
-- SAFE FOR SIGN-UP. The new trigger sits on auth.users, so a failure in it
-- would fail sign-up for everyone. Its whole body is in its own exception
-- block and only raises a WARNING, like every other analytics trigger.
-- It is SECURITY DEFINER with a fixed search_path, and nobody may call it
-- directly.
--
-- NO BACKFILL. Every existing user is already confirmed and already has
-- account.created (from the live trigger or the product_events backfill).
-- The only unconfirmed users today would be invitations not yet accepted;
-- they were counted when invited, and the already-counted check above keeps
-- them from counting again when they accept. The self-check says how many
-- there are.
--
-- Run AFTER 99_supabase_migration_product_events_v1.sql, and BEFORE turning
-- on "Confirm email" (until then it changes nothing anyone can see). One
-- transaction. Idempotent: safe to run twice. No deploy is needed before or
-- after.
-- ============================================================================

begin;

do $$
begin
  if to_regclass('public.product_events') is null
     or to_regprocedure('public.product_event_emit(text, uuid, uuid, jsonb, text, timestamptz, text, text, text, text, boolean)') is null
     or to_regprocedure('public.product_events_profiles()') is null then
    raise exception 'Missing product events, run 99_supabase_migration_product_events_v1.sql first';
  end if;
end $$;

-- ── 1. Profiles: account.created only for a confirmed address ──────────────

create or replace function public.product_events_profiles()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_test boolean;
  v_confirmed boolean;
  v_hotel uuid;
begin
  begin
    -- An account exists before any hotel does, so the only test signal is the
    -- +suffix address convention the analytics panel already uses.
    select coalesce(u.email, '') like '%+%', u.email_confirmed_at is not null
      into v_is_test, v_confirmed
      from auth.users u where u.id = new.id;

    -- An unconfirmed account is counted when it is confirmed, by
    -- product_events_email_confirmed() on auth.users.
    if tg_op = 'INSERT' and coalesce(v_confirmed, false)
       and not exists (
         select 1 from public.product_events e
          where e.event = 'account.created' and e.user_id = new.id
       ) then
      perform public.product_event_emit(
        'account.created', null, new.id, '{}'::jsonb, 'trigger', new.created_at,
        'account.created:' || new.id, null, null, null, coalesce(v_is_test, false)
      );
    end if;

    if new.onboarding_path is not null
       and (tg_op = 'INSERT' or new.onboarding_path is distinct from old.onboarding_path) then
      -- The choice is per user; it is only pinned to a property when the user
      -- has exactly one, which is the case for everyone mid-onboarding.
      select min(hm.hotel_id::text)::uuid into v_hotel
        from public.hotel_memberships hm
       where hm.user_id = new.id and hm.status = 'active'
      having count(*) = 1;
      perform public.product_event_emit(
        'onboarding.path_chosen', v_hotel, new.id,
        jsonb_build_object('path', new.onboarding_path::text),
        'trigger', null, null, null, null, null,
        case when v_hotel is null then coalesce(v_is_test, false) end
      );
    end if;
  exception when others then
    raise warning 'product_events_profiles: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

revoke all on function public.product_events_profiles() from public, anon, authenticated;

-- ── 2. auth.users: account.created when the address is confirmed ───────────

create or replace function public.product_events_email_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Never let analytics fail a sign-up or a confirmation.
  begin
    if not exists (
      select 1 from public.product_events e
       where e.event = 'account.created' and e.user_id = new.id
    ) then
      perform public.product_event_emit(
        'account.created', null, new.id, '{}'::jsonb, 'trigger', new.email_confirmed_at,
        'account.created:' || new.id, null, null, null, coalesce(new.email, '') like '%+%'
      );
    end if;
  exception when others then
    raise warning 'product_events_email_confirmed: % [%]', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

revoke all on function public.product_events_email_confirmed() from public, anon, authenticated;

drop trigger if exists trg_product_events_email_confirmed on auth.users;
create trigger trg_product_events_email_confirmed
  after update of email_confirmed_at on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function public.product_events_email_confirmed();

-- ── Self-check ──────────────────────────────────────────────────────────────

do $$
declare
  fn text;
  v_def text;
  v_unconfirmed bigint;
  v_counted bigint;
begin
  foreach fn in array array[
    'public.product_events_profiles()',
    'public.product_events_email_confirmed()'
  ]
  loop
    if has_function_privilege('anon', fn, 'execute')
       or has_function_privilege('authenticated', fn, 'execute') then
      raise exception '% is still open to anon or authenticated', fn;
    end if;
    if not exists (
      select 1 from pg_proc p
       where p.oid = fn::regprocedure
         and p.prosecdef
         and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
    ) then
      raise exception '% must be security definer with a fixed search_path', fn;
    end if;
  end loop;

  select pg_get_triggerdef(t.oid) into v_def
    from pg_trigger t
   where t.tgrelid = 'auth.users'::regclass
     and t.tgname = 'trg_product_events_email_confirmed'
     and t.tgenabled <> 'D';
  if v_def is null
     or v_def not ilike '%after update of email_confirmed_at on auth.users%'
     or v_def not ilike '%old.email_confirmed_at is null%' then
    raise exception 'trg_product_events_email_confirmed is missing or not as written: %', v_def;
  end if;

  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.profiles'::regclass
       and t.tgname = 'trg_product_events_profiles'
       and t.tgenabled <> 'D'
  ) then
    raise exception 'trg_product_events_profiles is missing, run 99_supabase_migration_product_events_v1.sql first';
  end if;

  if position('email_confirmed_at' in pg_get_functiondef('public.product_events_profiles()'::regprocedure)) = 0 then
    raise exception 'product_events_profiles() still records unconfirmed accounts';
  end if;

  -- What the "no backfill" above rests on, for whoever runs this.
  select count(*),
         count(*) filter (where exists (
           select 1 from public.product_events e
            where e.event = 'account.created' and e.user_id = u.id
         ))
    into v_unconfirmed, v_counted
    from auth.users u
   where u.email_confirmed_at is null;
  raise notice 'confirmed signups: % users not confirmed yet, % of them already counted (never again); the rest count when they confirm',
    v_unconfirmed, v_counted;
end $$;

commit;
