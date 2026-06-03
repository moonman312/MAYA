-- MAYA PMS Secrets v1 Migration
-- Implements PR review comments #1 (RLS exposes Mews tokens) and #2 (column lies
-- about encryption) by moving PMS credentials out of `pms_connections` and into
-- Supabase Vault, accessed only through SECURITY DEFINER RPCs.
--
-- Run AFTER 02_supabase_schema.sql when upgrading a database that was created
-- before PMS Secrets v1 objects existed. If you load 01 + 02 from this repo on
-- a fresh project, you can skip this file (01 and 02 already include the model).
--
-- This migration:
--   1) Ensures `supabase_vault` extension is available.
--   2) Creates `pms_connection_secrets` — sibling table with vault_secret_id only.
--   3) Locks the table down (RLS on, no policies, table grants revoked from
--      authenticated/anon). Service role bypasses RLS; SECURITY DEFINER RPCs
--      bridge for managers.
--   4) Creates RPCs: pms_secret_get / pms_secret_set / pms_secret_delete.
--   5) Migrates any plaintext JSON in `pms_connections.credentials_encrypted`
--      into Vault and inserts matching rows in `pms_connection_secrets`.
--   6) Drops `pms_connections.credentials_encrypted` (the secret no longer
--      lives on this row — only metadata: status, base_url, last_sync_at, etc.).
--
-- After this runs, no credential bytes are reachable through PostgREST. Hotel
-- staff/viewers still see connection status. Only managers (or service role)
-- can decrypt secrets via pms_secret_get.

begin;

-- ============================================================================
-- 1. Vault extension (idempotent; usually pre-installed on Supabase hosted)
-- ============================================================================

create extension if not exists supabase_vault with schema vault cascade;

-- ============================================================================
-- 2. pms_connection_secrets — sibling table backed by Supabase Vault
-- ============================================================================

create table if not exists public.pms_connection_secrets (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  pms_type public.pms_type not null,
  vault_secret_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, pms_type)
);

create index if not exists idx_pms_connection_secrets_hotel
  on public.pms_connection_secrets(hotel_id);

-- ============================================================================
-- 3. Lock down the secrets table
--    RLS on with no policy = JWT roles cannot SELECT/INSERT/UPDATE/DELETE.
--    Table grants revoked from authenticated/anon as belt-and-suspenders.
--    service_role bypasses RLS, but stays out of normal app code paths.
-- ============================================================================

alter table public.pms_connection_secrets enable row level security;

revoke all on public.pms_connection_secrets from public;
revoke all on public.pms_connection_secrets from anon;
revoke all on public.pms_connection_secrets from authenticated;
grant select, insert, update, delete on public.pms_connection_secrets to service_role;

comment on table public.pms_connection_secrets is
  'PMS credentials kept encrypted in Supabase Vault. Read/write only via '
  'SECURITY DEFINER RPCs pms_secret_get / pms_secret_set / pms_secret_delete. '
  'No RLS policy exists by design — JWT roles cannot touch this table directly.';

-- Touch updated_at on UPDATE
create or replace function public.pms_connection_secrets_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_pms_connection_secrets_touch on public.pms_connection_secrets;
create trigger trg_pms_connection_secrets_touch
  before update on public.pms_connection_secrets
  for each row execute function public.pms_connection_secrets_touch_updated_at();

-- Clean up the Vault secret when the row is deleted (cascade or explicit)
create or replace function public.pms_connection_secrets_cleanup_vault()
returns trigger
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
begin
  if old.vault_secret_id is not null then
    delete from vault.secrets where id = old.vault_secret_id;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_pms_connection_secrets_cleanup on public.pms_connection_secrets;
create trigger trg_pms_connection_secrets_cleanup
  after delete on public.pms_connection_secrets
  for each row execute function public.pms_connection_secrets_cleanup_vault();

-- ============================================================================
-- 4. RPCs: pms_secret_get / pms_secret_set / pms_secret_delete
--    All SECURITY DEFINER (owner = postgres) so they can touch vault.* even
--    though callers don't have direct vault access.
--    Authorization rule inside each function:
--      - service_role: always allowed (cron + Edge functions).
--      - authenticated JWT: must satisfy can_manage_hotel(target_hotel_id).
--      - everyone else: denied.
-- ============================================================================

create or replace function public.pms_secret_get(
  p_hotel_id uuid,
  p_pms_type public.pms_type
) returns jsonb
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  v_secret_id uuid;
  v_text text;
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.can_manage_hotel(p_hotel_id) then
    raise exception 'Not authorized to read PMS credentials for hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  select s.vault_secret_id
    into v_secret_id
  from public.pms_connection_secrets s
  where s.hotel_id = p_hotel_id
    and s.pms_type = p_pms_type;

  if v_secret_id is null then
    return null;
  end if;

  select decrypted_secret
    into v_text
  from vault.decrypted_secrets
  where id = v_secret_id;

  if v_text is null then
    return null;
  end if;

  return v_text::jsonb;
end;
$$;

revoke all on function public.pms_secret_get(uuid, public.pms_type) from public;
grant execute on function public.pms_secret_get(uuid, public.pms_type)
  to authenticated, service_role;

create or replace function public.pms_secret_set(
  p_hotel_id uuid,
  p_pms_type public.pms_type,
  p_secret jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  v_secret_id uuid;
  v_secret_name text;
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.can_manage_hotel(p_hotel_id) then
    raise exception 'Not authorized to set PMS credentials for hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  if p_secret is null then
    raise exception 'PMS secret payload may not be null'
      using errcode = '22004';
  end if;

  v_secret_name := format('pms:%s:%s', p_pms_type::text, p_hotel_id::text);

  select s.vault_secret_id
    into v_secret_id
  from public.pms_connection_secrets s
  where s.hotel_id = p_hotel_id
    and s.pms_type = p_pms_type;

  if v_secret_id is null then
    v_secret_id := vault.create_secret(
      p_secret::text,
      v_secret_name,
      'MAYA PMS credentials'
    );

    insert into public.pms_connection_secrets (hotel_id, pms_type, vault_secret_id)
    values (p_hotel_id, p_pms_type, v_secret_id);
  else
    perform vault.update_secret(v_secret_id, p_secret::text);

    update public.pms_connection_secrets
       set updated_at = now()
     where vault_secret_id = v_secret_id;
  end if;

  return v_secret_id;
end;
$$;

revoke all on function public.pms_secret_set(uuid, public.pms_type, jsonb) from public;
grant execute on function public.pms_secret_set(uuid, public.pms_type, jsonb)
  to authenticated, service_role;

create or replace function public.pms_secret_delete(
  p_hotel_id uuid,
  p_pms_type public.pms_type
) returns boolean
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  v_deleted boolean := false;
begin
  if (select auth.role()) is distinct from 'service_role'
     and not public.can_manage_hotel(p_hotel_id) then
    raise exception 'Not authorized to delete PMS credentials for hotel %', p_hotel_id
      using errcode = '42501';
  end if;

  delete from public.pms_connection_secrets s
   where s.hotel_id = p_hotel_id
     and s.pms_type = p_pms_type;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.pms_secret_delete(uuid, public.pms_type) from public;
grant execute on function public.pms_secret_delete(uuid, public.pms_type)
  to authenticated, service_role;

-- ============================================================================
-- 5. Migrate existing plaintext credentials_encrypted -> Vault
--    Idempotent: skips any (hotel_id, pms_type) that already has a secret row.
--    Skips rows where credentials_encrypted is empty / non-JSON.
-- ============================================================================

do $$
declare
  r record;
  v_secret_id uuid;
  v_secret_name text;
  v_payload jsonb;
begin
  -- Skip cleanly if the column is already gone (re-run safety).
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'pms_connections'
      and column_name = 'credentials_encrypted'
  ) then
    raise notice 'pms_connections.credentials_encrypted already removed; skipping migration step.';
    return;
  end if;

  for r in
    execute $sql$
      select pc.id, pc.hotel_id, pc.pms_type, pc.credentials_encrypted
      from public.pms_connections pc
      where pc.credentials_encrypted is not null
        and pc.credentials_encrypted <> ''
        and not exists (
          select 1
          from public.pms_connection_secrets s
          where s.hotel_id = pc.hotel_id
            and s.pms_type = pc.pms_type
        )
    $sql$
  loop
    begin
      v_payload := r.credentials_encrypted::jsonb;
    exception when others then
      raise warning 'Skipping pms_connections.id=% — credentials_encrypted is not valid JSON.', r.id;
      continue;
    end;

    v_secret_name := format('pms:%s:%s', r.pms_type::text, r.hotel_id::text);
    v_secret_id := vault.create_secret(
      v_payload::text,
      v_secret_name,
      'MAYA PMS credentials (migrated from credentials_encrypted)'
    );

    insert into public.pms_connection_secrets (hotel_id, pms_type, vault_secret_id)
    values (r.hotel_id, r.pms_type, v_secret_id);
  end loop;
end $$;

-- ============================================================================
-- 6. Drop the plaintext column on pms_connections.
--    After this, the column is gone everywhere; PostgREST cannot serve it.
-- ============================================================================

alter table public.pms_connections
  drop column if exists credentials_encrypted;

commit;
