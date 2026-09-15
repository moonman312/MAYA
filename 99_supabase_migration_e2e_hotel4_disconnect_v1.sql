-- E2E fixture hotel 4 says it is connected to Cloudbeds. It is not: the seed
-- created its pms_connections row with no credential in the Vault, so every
-- scheduled tick claimed it, failed to resolve a token, and backed off — an
-- hourly retry, forever, on a property that can never sync. It had zero rows in
-- the request log because it never reached the API once. 'connected' was there
-- so the cron would "pick it up"; picking it up was the waste.
--
-- 'disconnected' is the honest state and the one status claim_pms_sync_batch
-- skips. The seeded room types, reservations and rules stay; /api/evaluate and
-- the engine tests still work; claim_pms_sync_one (the manual "Sync now" path)
-- has no status filter, so a test that wants the sync path can still take it
-- deliberately. What changes: the cron no longer evaluates this hotel on its
-- own — that was only ever a side effect of the failing sync.
--
-- The seed and verify scripts are updated to match. Safe to re-run.

update public.pms_connections
   set status = 'disconnected',
       sync_failures = 0,
       sync_lease_until = null,
       sync_lease_owner = null,
       updated_at = now()
 where pms_type = 'cloudbeds'
   and status <> 'disconnected'
   and hotel_id = (
     select id from public.hotels
      where external_enterprise_id = 'cb-e2e-property-mayatest4'
   );

-- Expect one row: status = disconnected, fails = 0.
select h.name, c.status, c.sync_failures, c.sync_due_at
  from public.pms_connections c
  join public.hotels h on h.id = c.hotel_id
 where h.external_enterprise_id = 'cb-e2e-property-mayatest4';
