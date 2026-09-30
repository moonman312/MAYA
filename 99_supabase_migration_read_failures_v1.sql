-- ============================================================================
-- MAYA: a failing property system read is retried within 15 minutes (A12), v1
-- ============================================================================
--
-- Decided by Jake on 2026-09-29 (audit item A12): while reads of a property
-- system keep failing for any reason except a refused login, MAYA keeps
-- holding pricing for the hotel, retries every 10 to 15 minutes instead of
-- backing off to hourly, raises a critical alert after 3 failed reads in a
-- row or 30 minutes without a good read, and marks the connection Error
-- after about an hour (which starts the outage email and the banner). A good
-- read clears all of it. The alert and the Error mark live in code
-- (pms/connection-health.ts, called by the scheduled syncs); the retry
-- cadence is this file.
--
-- release_pms_sync backed a failed run off exponentially: with the 5-minute
-- interval, 10, 20, 40 and then 60 minutes between tries. A property system
-- back after a short outage could wait an hour to be read again, and a hotel
-- is priced on nothing meanwhile. The wait is now capped at 15 minutes (or
-- the sync interval itself, when that is longer): 10 minutes after the first
-- failure, then 15. The failure count still grows, so the syncs can tell a
-- third failed read in a row from a first.
--
-- A refused login is not affected: after three of those in a row the
-- connection is Disconnected, and a Disconnected connection is never claimed.
--
-- Same signature and grants as before (service role only); no table, policy
-- or grant on a table changes. Safe to run more than once, and independent of
-- deploy order.
-- ============================================================================

begin;

/**
 * Release a claim and say when the connection should next be looked at.
 *
 * A failure backs off 2x, 4x ... the interval, capped at 15 minutes (or the
 * interval, when it is longer). Success resets it.
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
  cap integer := greatest(900, coalesce(p_interval_seconds, 300));
begin
  select case when p_ok then 0 else least(sync_failures + 1, 10) end
    into fails
    from pms_connections
   where hotel_id = p_hotel_id and pms_type = p_pms_type::pms_type;

  backoff := case
    when p_ok then p_interval_seconds
    else least(p_interval_seconds * power(2, fails)::integer, cap)
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

commit;

-- ----------------------------------------------------------------------------
-- Checks
-- ----------------------------------------------------------------------------
-- Connections whose reads are failing right now, and when each is due again:
--
--   select c.hotel_id, h.name, c.pms_type, c.status, c.sync_failures,
--          c.last_sync_at, c.sync_due_at
--     from public.pms_connections c
--     join public.hotels h on h.id = c.hotel_id
--    where c.sync_failures > 0
--    order by c.last_sync_at;
