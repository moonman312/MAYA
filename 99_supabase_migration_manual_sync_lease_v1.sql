-- Manual sync under the same lease as the scheduled worker.
--
-- The manual "Sync now" button had a per-hotel request counter (6 per 5
-- minutes) but no in-flight guard: several presses in quick succession each
-- started a full sync, and every one of them paced itself correctly in its own
-- isolate while together hammering the property's PMS allowance — which is the
-- budget Cloudbeds suspends credentials over.
--
-- claim_pms_sync_batch can't serve the button: it only hands out connections
-- that are DUE, and a manual sync is by definition ahead of schedule. This is
-- the single-connection claim on the same lease columns, so a manual run, a
-- second press, and the scheduled worker all exclude each other. Release goes
-- through the existing release_pms_sync.
--
-- Run after 99_supabase_migration_limits_and_scale_v1.sql (lease columns).
-- Idempotent.

begin;

/**
 * Lease one connection regardless of sync_due_at.
 *
 * Returns 'claimed', 'busy' (someone holds the lease), or 'missing' (no such
 * connection — e.g. Mews credentials supplied per-request). Concurrent callers
 * serialize on the row lock, so exactly one of two simultaneous presses claims.
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
     and c.pms_type = p_pms_type
     and (c.sync_lease_until is null or c.sync_lease_until < now())
  returning c.hotel_id into claimed;

  if claimed is not null then
    return 'claimed';
  end if;
  if exists (
    select 1 from pms_connections
     where hotel_id = p_hotel_id and pms_type = p_pms_type
  ) then
    return 'busy';
  end if;
  return 'missing';
end;
$$;

revoke all on function public.claim_pms_sync_one(uuid, text, integer, text) from public, anon, authenticated;
grant execute on function public.claim_pms_sync_one(uuid, text, integer, text) to service_role;

commit;
