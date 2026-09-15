-- Fix: the sync claim/release RPCs cannot compare their argument to the column.
--
-- pms_connections.pms_type is the enum `pms_type`. All three of these functions
-- declare p_pms_type as `text` and then compare it directly:
--
--     where c.pms_type = p_pms_type      -- pms_type = text  ->  42883
--
-- Postgres has no operator for that pair, so every call fails with
-- "operator does not exist: pms_type = text". The bug has been latent since
-- these functions were created — nothing exercised them until the scheduled
-- sync functions that call them were deployed, at which point EVERY sync
-- stopped: the worker asks claim_pms_sync_batch which hotels are due, gets an
-- exception, and processes nothing.
--
-- Cast at each comparison rather than changing the parameter type. Casting the
-- argument (not the column) keeps idx_pms_connections_sync_due usable; the
-- other direction, c.pms_type::text = p_pms_type, would force a sequential scan
-- on the hot path. The signatures stay `text` so the existing grants and every
-- caller keep working unchanged.
--
-- Safe to re-run.

begin;

/**
 * Claim up to p_limit connections that are due, and lease them.
 *
 * SKIP LOCKED is the whole trick: two workers running the same statement at the
 * same instant take different rows instead of blocking on each other.
 */
create or replace function public.claim_pms_sync_batch(
  p_pms_type text,
  p_limit integer default 25,
  p_lease_seconds integer default 300,
  p_owner text default null
)
returns table (hotel_id uuid, sync_failures integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with due as (
    select c.hotel_id
      from pms_connections c
     where c.pms_type = p_pms_type::pms_type
       and c.status <> 'disconnected'
       and c.sync_due_at <= now()
       and (c.sync_lease_until is null or c.sync_lease_until < now())
     order by c.sync_due_at
     limit p_limit
     for update skip locked
  )
  update pms_connections c
     set sync_lease_until = now() + make_interval(secs => p_lease_seconds),
         sync_lease_owner = p_owner
    from due
   where c.hotel_id = due.hotel_id
     and c.pms_type = p_pms_type::pms_type
  returning c.hotel_id, c.sync_failures;
end;
$$;

revoke all on function public.claim_pms_sync_batch(text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.claim_pms_sync_batch(text, integer, integer, text) to service_role;

/**
 * Release a claim and say when the connection should next be looked at.
 *
 * A failure backs off exponentially — 2, 4, 8 ... capped at an hour. Success
 * resets it.
 */
create or replace function public.release_pms_sync(
  p_hotel_id uuid,
  p_pms_type text,
  p_ok boolean,
  p_interval_seconds integer default 300
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  fails integer;
  backoff integer;
begin
  select case when p_ok then 0 else least(sync_failures + 1, 10) end
    into fails
    from pms_connections
   where hotel_id = p_hotel_id and pms_type = p_pms_type::pms_type;

  backoff := case
    when p_ok then p_interval_seconds
    else least(p_interval_seconds * power(2, fails)::integer, 3600)
  end;

  update pms_connections
     set sync_lease_until = null,
         sync_lease_owner = null,
         sync_failures = fails,
         sync_due_at = now() + make_interval(secs => backoff)
   where hotel_id = p_hotel_id and pms_type = p_pms_type::pms_type;
end;
$$;

revoke all on function public.release_pms_sync(uuid, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.release_pms_sync(uuid, text, boolean, integer) to service_role;

/**
 * Claim ONE connection for a manual, user-triggered sync.
 *
 * Deliberately has no status filter: a disconnected connection is exactly the
 * one someone presses "Sync now" on after reconnecting.
 */
create or replace function public.claim_pms_sync_one(
  p_hotel_id uuid,
  p_pms_type text,
  p_lease_seconds integer default 600,
  p_owner text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claimed uuid;
begin
  update pms_connections c
     set sync_lease_until = now() + make_interval(secs => p_lease_seconds),
         sync_lease_owner = p_owner
   where c.hotel_id = p_hotel_id
     and c.pms_type = p_pms_type::pms_type
     and (c.sync_lease_until is null or c.sync_lease_until < now())
  returning c.hotel_id into claimed;

  if claimed is not null then
    return 'claimed';
  end if;
  if exists (
    select 1 from pms_connections
     where hotel_id = p_hotel_id and pms_type = p_pms_type::pms_type
  ) then
    return 'busy';
  end if;
  return 'missing';
end;
$$;

revoke all on function public.claim_pms_sync_one(uuid, text, integer, text) from public, anon, authenticated;
grant execute on function public.claim_pms_sync_one(uuid, text, integer, text) to service_role;

commit;

-- Everything that was due while this was broken is still due, so the next tick
-- picks the whole backlog up on its own. Confirm with:
--
--   select hotel_id, status, last_sync_at, sync_due_at, sync_failures
--     from pms_connections where pms_type = 'cloudbeds';
