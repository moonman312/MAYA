-- ============================================================================
-- TERMS OF SERVICE ACCEPTANCE
-- ============================================================================
--
-- One row per time a person agreed to a version of the MAYA Terms of Service
-- and Privacy Policy. A claim that someone agreed is worth only as much as the
-- record behind it, so the record is written by the server, timestamped by
-- the database, and never edited afterwards.
--
-- Three ways a row gets here:
--
-- 1. Signing up (context signup or claim). The checkbox is on the account
--    form, and Supabase may require an email confirmation before any session
--    exists, so there is nobody signed in to call an API route yet. The form
--    carries the acceptance in the signUp user metadata under `maya_terms`,
--    and trg_record_signup_terms_acceptance turns it into a row in the same
--    transaction that creates the user. accepted_at is the moment Supabase
--    created the user, never a time the browser sent.
--
-- 2. Accepting an invite, or accepting once as an existing user (context
--    invite or reaccept). A session exists, so /api/legal/acceptance writes
--    the row as service role, with the IP and user agent it observed.
--
-- 3. The backfill at the bottom of this file, for anyone who signed up with
--    the checkbox while the app was deployed ahead of this migration.
--
-- The trigger can never block a signup. Any error inside it is downgraded to
-- a WARNING, and the app notices the missing row on the next page load and
-- adopts the metadata through record_terms_acceptance_from_signup().
--
-- user_id deliberately has no foreign key: the record is evidence of an
-- agreement with the business the person acted for, and it has to outlive
-- their login. email is copied for the same reason.
--
-- Rows are append-only. authenticated can read its own rows and nothing else;
-- service_role can read and insert; nobody but the table owner can update or
-- delete. hotel_id is set null by the foreign key if a property is purged,
-- which runs as the owner and is unaffected by those grants.
--
-- Run after 99_supabase_migration_no_customer_deletes_v1.sql (ordering only;
-- nothing here depends on it). Idempotent. Code deployed ahead of this file
-- treats acceptance as not required, logs that it did so, and never shows the
-- accept screen, so nobody is locked out.
--
-- NOT mirrored into 02_supabase_schema.sql yet. Fold it in on the next schema
-- consolidation pass.

begin;

create table if not exists public.terms_acceptances (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null,
  email           text,
  terms_version   text not null check (char_length(terms_version) between 1 and 40),
  privacy_version text not null check (char_length(privacy_version) between 1 and 40),
  accepted_at     timestamptz not null default now(),
  context         text not null check (context in ('signup', 'claim', 'invite', 'reaccept')),
  hotel_id        uuid references public.hotels(id) on delete set null,
  ip              text check (ip is null or char_length(ip) <= 64),
  user_agent      text check (user_agent is null or char_length(user_agent) <= 512),
  -- Where the row came from, so an auditor can tell a server-observed click
  -- from one carried through signup metadata or reconstructed by the backfill.
  source          text not null default 'app'
                  check (source in ('app', 'signup_metadata', 'backfill'))
);

comment on table public.terms_acceptances is
  'Append-only record of each acceptance of the MAYA Terms of Service and Privacy Policy. Written by service role or SECURITY DEFINER functions only; users read their own rows.';

-- The app asks one question on every page load: has this user accepted these
-- two versions?
create index if not exists idx_terms_acceptances_user_versions
  on public.terms_acceptances (user_id, terms_version, privacy_version);

alter table public.terms_acceptances enable row level security;

drop policy if exists terms_acceptances_select_own on public.terms_acceptances;
create policy terms_acceptances_select_own
  on public.terms_acceptances for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Supabase's default privileges grant everything on new tables to anon,
-- authenticated and service_role directly, so a revoke from public alone
-- leaves the doors open.
revoke all on public.terms_acceptances from public, anon, authenticated, service_role;
grant select on public.terms_acceptances to authenticated;
grant select, insert on public.terms_acceptances to service_role;

-- ----------------------------------------------------------------------------
-- terms_acceptance_from_metadata: the one place a `maya_terms` metadata object
-- becomes a row. Validates everything, because user metadata is written by the
-- browser. A browser can only ever claim signup or claim here; invite and
-- reaccept are recorded by the server route.
-- Returns true when a row for these versions and context now exists.
-- ----------------------------------------------------------------------------
create or replace function public.terms_acceptance_from_metadata(
  p_user_id     uuid,
  p_email       text,
  p_meta        jsonb,
  p_accepted_at timestamptz,
  p_source      text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_terms   text;
  v_privacy text;
  v_context text;
  v_agent   text;
begin
  if p_user_id is null or p_meta is null or jsonb_typeof(p_meta) <> 'object' then
    return false;
  end if;

  v_terms   := nullif(btrim(p_meta ->> 'terms_version'), '');
  v_privacy := nullif(btrim(p_meta ->> 'privacy_version'), '');
  v_context := coalesce(nullif(btrim(p_meta ->> 'context'), ''), 'signup');
  v_agent   := left(nullif(btrim(p_meta ->> 'user_agent'), ''), 512);

  if v_terms is null or v_privacy is null
     or char_length(v_terms) > 40 or char_length(v_privacy) > 40 then
    return false;
  end if;
  if v_context not in ('signup', 'claim') then
    v_context := 'signup';
  end if;
  if p_source not in ('signup_metadata', 'backfill') then
    raise exception 'terms_acceptance_from_metadata: unexpected source %', p_source;
  end if;

  if exists (
    select 1
      from public.terms_acceptances
     where user_id = p_user_id
       and terms_version = v_terms
       and privacy_version = v_privacy
       and context = v_context
  ) then
    return true;
  end if;

  insert into public.terms_acceptances
    (user_id, email, terms_version, privacy_version, accepted_at, context, user_agent, source)
  values
    (p_user_id, p_email, v_terms, v_privacy, coalesce(p_accepted_at, now()), v_context, v_agent, p_source);

  return true;
end;
$$;

revoke all on function public.terms_acceptance_from_metadata(uuid, text, jsonb, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.terms_acceptance_from_metadata(uuid, text, jsonb, timestamptz, text)
  to service_role;

-- ----------------------------------------------------------------------------
-- Trigger: signup metadata -> row, in the signup transaction.
-- ----------------------------------------------------------------------------
create or replace function public.record_signup_terms_acceptance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.raw_user_meta_data is null
     or jsonb_typeof(new.raw_user_meta_data -> 'maya_terms') is distinct from 'object' then
    return new;
  end if;

  -- A failure here must never cost someone their account. The app adopts the
  -- metadata on their first page load instead.
  begin
    perform public.terms_acceptance_from_metadata(
      new.id,
      new.email,
      new.raw_user_meta_data -> 'maya_terms',
      coalesce(new.created_at, now()),
      'signup_metadata'
    );
  exception when others then
    raise warning 'terms acceptance not recorded at signup for user %: % (%)',
      new.id, sqlerrm, sqlstate;
  end;

  return new;
end;
$$;

revoke all on function public.record_signup_terms_acceptance() from public, anon, authenticated;

drop trigger if exists trg_record_signup_terms_acceptance on auth.users;
create trigger trg_record_signup_terms_acceptance
  after insert on auth.users
  for each row execute function public.record_signup_terms_acceptance();

-- ----------------------------------------------------------------------------
-- record_terms_acceptance_from_signup: the app's fallback when the trigger
-- missed. Reads the metadata from auth.users itself rather than trusting the
-- request, and dates the row to when Supabase created the user, which is when
-- the form carrying the tick was submitted.
-- ----------------------------------------------------------------------------
create or replace function public.record_terms_acceptance_from_signup(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  u record;
begin
  select id, email, raw_user_meta_data, created_at
    into u
    from auth.users
   where id = p_user_id;
  if not found then
    return false;
  end if;

  return public.terms_acceptance_from_metadata(
    u.id,
    u.email,
    u.raw_user_meta_data -> 'maya_terms',
    u.created_at,
    'signup_metadata'
  );
end;
$$;

revoke all on function public.record_terms_acceptance_from_signup(uuid) from public, anon, authenticated;
grant execute on function public.record_terms_acceptance_from_signup(uuid) to service_role;

-- ----------------------------------------------------------------------------
-- Backfill: anyone who ticked the box while this file had not been run yet.
-- ----------------------------------------------------------------------------
do $$
declare
  u record;
begin
  for u in
    select id, email, raw_user_meta_data, created_at
      from auth.users
     where jsonb_typeof(raw_user_meta_data -> 'maya_terms') = 'object'
  loop
    perform public.terms_acceptance_from_metadata(
      u.id,
      u.email,
      u.raw_user_meta_data -> 'maya_terms',
      u.created_at,
      'backfill'
    );
  end loop;
end $$;

commit;

-- Check afterwards:
--
--   select context, source, terms_version, privacy_version, count(*)
--     from public.terms_acceptances
--    group by 1, 2, 3, 4
--    order by 1, 2;
--
--   select grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public' and table_name = 'terms_acceptances'
--    order by 1, 2;
--
-- Expect authenticated: SELECT only; service_role: INSERT, SELECT only.
