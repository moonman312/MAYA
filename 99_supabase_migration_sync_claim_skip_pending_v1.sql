-- The scheduler must not sync a property nobody has paid for.
--
-- A Marketplace (Flow A) arrival is parked by the callback with a
-- pms_connections row in status 'pending': credentials in the Vault, no owner
-- yet, no payment yet. sync_due_at defaults to now(), and claim_pms_sync_batch
-- took anything that was not 'disconnected' — so a parked property was claimed
-- on the very next tick and its bookings pulled before anyone had signed in,
-- let alone paid. splitByEntitlement does not catch it: a hotel with no
-- subscription row is allowed through on purpose (the sandbox, installs with
-- no Stripe keys), so the only place to stop it is here.
--
-- 'pending' now means what it says. The claim path leaves a Marketplace hotel
-- pending until its subscription lands; activation flips it to 'connected' and
-- that is when the first sync happens. 'degraded' and 'error' stay claimable —
-- those are live connections mid-retry, and a retry is the point.
--
-- claim_pms_sync_one (the manual "Sync now" path) is untouched: it never had a
-- status filter, because pressing the button on a not-yet-synced property is
-- exactly what it is for.
--
-- Run AFTER 99_supabase_migration_sync_claim_enum_cast_v1.sql. Safe to re-run.

begin;

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
       and c.status not in ('disconnected', 'pending')
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

commit;

-- Anything currently parked and pending stops being claimed on the next tick.
-- Confirm with:
--
--   select hotel_id, status, sync_due_at from pms_connections
--    where pms_type = 'cloudbeds' and status = 'pending';
