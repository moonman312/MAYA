-- ============================================================================
-- IMPORT AT THE CLAIM — the import queue learns about unpaid properties
-- ============================================================================
--
-- A Marketplace property now starts its history import when its owner claims
-- it (lib/pms/eager-import.ts), not when it is paid for, so by the time the
-- owner is back from the card form the work is already done. The import queue
-- was built for paying hotels only, and three things about it stop being true:
--
--   1. FIFO is no longer fair. claim_import_job took the oldest runnable job in
--      the fleet. With unpaid imports in the same queue, a customer who just
--      paid would wait behind every stranger who claimed a property earlier
--      and walked away. Jobs for live hotels now go first.
--
--   2. One owner could run several at once. A group owner is shown one
--      property at a time and each is queued when it is shown, but a quick
--      "Not now" followed by the next sibling could put two of that owner's
--      unpaid imports in flight. One pre-payment job per owner runs at a time;
--      the next waits in the queue. Paid jobs are not limited.
--
--   3. A job could outlive the reason it was queued. Nothing stopped a job for
--      a property that disconnected, whose owner said "Not now", or whose claim
--      was swept: it was re-claimed every lease for fifty rounds, calling the
--      PMS with a dead grant and winning the FIFO over live hotels each time.
--      claim_import_job now cancels such jobs before it picks one, with
--      last_error saying why. The worker makes the same check when it starts
--      (worker-core.ts importStopReason), which covers a job already claimed
--      when the reason appeared and a deploy that lands before this file.
--
-- WHAT STOPS A JOB (import_job_stop_reason, mirrored in worker-core.ts):
--   connection_missing  no pms_connections row for the hotel and PMS
--   disconnected        the connection is 'disconnected'
--   deferred            the hotel is not live and the owner said "Not now"
--   claim_missing       the hotel is not live and no redeemed Marketplace claim
--                       points at it
-- A live hotel is only stopped by the first two. A stopped job is 'canceled',
-- keeps its checkpoint, and is re-queued where the reason goes away: showing
-- the property on the subscribe screen again, paying for it, or reconnecting
-- a paid property.
--
-- WHAT DOES NOT CHANGE: the scheduled syncs, rate pushes and engine evaluation
-- stay payment-gated exactly as before (claim_pms_sync_batch, splitByParked,
-- splitByEntitlement). This file only touches the one-shot import queue.
--
-- Claims are serialised with a transaction-scoped advisory lock. The per-owner
-- limit reads other rows, and two claims running side by side could each see
-- the other's job as still queued; the lock costs nothing at the rate this is
-- called (pg_cron once a minute plus the worker's own chain).
--
-- Run AFTER 99_supabase_migration_onboarding_v1.sql,
-- 99_supabase_migration_marketplace_flow_a_v1.sql and
-- 99_supabase_migration_setup_deferred_v1.sql. Idempotent.
--
-- Deploy order: either.
--   * Code first: unpaid jobs are queued at the claim and the worker runs them;
--     the old claim is FIFO with no per-owner limit, so a paid job can wait
--     behind unpaid ones (as it could behind any older job before) and a group
--     owner can briefly have two running. The worker still cancels jobs that
--     must stop, so nothing loops.
--   * This file first: no unpaid jobs exist yet; paid jobs are unaffected apart
--     from a job for a disconnected property being canceled instead of retried
--     for two and a half hours.
--
-- NOT mirrored into 02_supabase_schema.sql yet — fold it in on the next
-- schema consolidation pass.

begin;

-- Why a job must not run, or null when it may. Service role only.
create or replace function public.import_job_stop_reason(p_hotel_id uuid, p_pms_type public.pms_type)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when c.status is null then 'connection_missing'
    when c.status::text = 'disconnected' then 'disconnected'
    when h.is_active then null
    when h.setup_deferred_at is not null then 'deferred'
    when not exists (
      select 1 from public.pms_marketplace_claims mc
       where mc.hotel_id = h.id and mc.claimed_at is not null
    ) then 'claim_missing'
  end
    from public.hotels h
    left join public.pms_connections c
      on c.hotel_id = h.id and c.pms_type = p_pms_type
   where h.id = p_hotel_id
$$;

revoke all on function public.import_job_stop_reason(uuid, public.pms_type) from public, anon, authenticated;
grant execute on function public.import_job_stop_reason(uuid, public.pms_type) to service_role;

create or replace function public.claim_import_job(p_lease_seconds integer default 180)
returns setof import_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('public.claim_import_job'));

  -- Only jobs nobody is working on right now. One with a live lease belongs
  -- to a worker, which checks the same reasons when its next run starts.
  update import_jobs j
     set status = 'canceled',
         finished_at = now(),
         lease_expires_at = null,
         updated_at = now(),
         last_error = case r.reason
           when 'connection_missing' then 'Stopped: the property has no PMS connection.'
           when 'disconnected' then 'Stopped: the PMS connection was disconnected.'
           when 'deferred' then 'Stopped: the owner chose "Not now" for this property.'
           else 'Stopped: nobody has claimed this property.'
         end
    from (
      select q.id, public.import_job_stop_reason(q.hotel_id, q.pms_type) as reason
        from import_jobs q
       where q.status = 'queued'
          or (q.status = 'running' and q.lease_expires_at is not null and q.lease_expires_at < now())
    ) r
   where j.id = r.id
     and r.reason is not null;

  -- Live hotels first, then oldest. An unpaid job waits while the same owner
  -- has another unpaid one in flight: one holding a live lease, or an older
  -- one between runs. The older-first half is what keeps two stalled jobs of
  -- one owner from each waiting on the other forever.
  select j.id into v_id
    from import_jobs j
    join hotels h on h.id = j.hotel_id
   where (j.status = 'queued'
          or (j.status = 'running' and j.lease_expires_at is not null and j.lease_expires_at < now()))
     and (h.is_active or not exists (
           select 1
             from import_jobs o
             join hotels oh on oh.id = o.hotel_id
            where o.id <> j.id
              and o.status = 'running'
              and not oh.is_active
              and o.requested_by is not distinct from j.requested_by
              and (o.lease_expires_at > now() or (o.created_at, o.id) < (j.created_at, j.id))
         ))
   order by h.is_active desc, j.created_at, j.id
   limit 1
   for update of j skip locked;

  if v_id is null then
    return;
  end if;

  return query
  update import_jobs
  set status = 'running',
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempts = attempts + 1,
      started_at = coalesce(started_at, now()),
      updated_at = now()
  where id = v_id
  returning *;
end;
$$;

revoke all on function public.claim_import_job(integer) from public;
grant execute on function public.claim_import_job(integer) to service_role;

commit;

-- Check afterwards (as service role, or in the SQL editor):
--
--   select id, hotel_id, status, last_error, finished_at
--     from import_jobs
--    where status = 'canceled' and last_error like 'Stopped:%'
--    order by finished_at desc limit 20;
--
-- What the queue looks like, paid first:
--
--   select j.id, h.name, h.is_active as paid, j.status, j.phase, j.requested_by, j.created_at
--     from import_jobs j join hotels h on h.id = j.hotel_id
--    where j.status in ('queued', 'running')
--    order by h.is_active desc, j.created_at;
