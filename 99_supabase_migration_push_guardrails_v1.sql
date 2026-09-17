-- MAYA Push Guardrails v1 Migration
--
-- 1. pms_connections.base_rates_refreshed_at — when the base rate calendar was
--    last re-read from the PMS for this hotel. The scheduled tick used to read
--    each night's base rate once, about 45 days out, and never again, so a
--    rate the hotel changed in its PMS during simulation was written over by
--    the first live push. The tick now re-reads the whole pricing window, at
--    most once an hour per hotel (MAYA_BASE_RATE_REFRESH_MINUTES) and again
--    as soon as the hotel's date moves, and writes only the cells that
--    changed. An unchanged calendar costs no writes to base_rate_calendar,
--    so its captured_at can't say when the last read happened; this column
--    does.
--
-- 2. Clears the cached push targets (pms_connections.push_rate_targets). The
--    resolver used to fall back to another non-derived rate plan, such as a
--    package, when a room type had no base rate, and a map it cached keeps
--    being used for as long as it covers the room types being pushed. Cleared,
--    the next push re-resolves under the base-rate-only rule. Deploy the code
--    straight after this runs: until then the old code can cache the old
--    choice again. Re-running this only costs one catalog read per hotel.
--
-- Run AFTER 99_supabase_migration_rate_push_v1.sql. Idempotent. Code deployed
-- ahead of this file fills calendar gaps only, as before, and logs that the
-- column is missing.
--
-- NOT mirrored into 02_supabase_schema.sql yet — fold it in on the next
-- schema consolidation pass.

begin;

alter table public.pms_connections
  add column if not exists base_rates_refreshed_at timestamptz;

comment on column public.pms_connections.base_rates_refreshed_at is
  'Instant of the scheduled tick that last re-read this hotel''s base rates '
  'from the PMS into base_rate_calendar. Throttles the refresh; null = never.';

update public.pms_connections
   set push_rate_targets = null
 where push_rate_targets is not null;

commit;
