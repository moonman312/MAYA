-- MAYA Sync Checkpoint v1 Migration
-- A full Cloudbeds sweep bigger than one invocation's budget used to restart
-- from the top of the list every tick: the same reservations re-fetched
-- forever, the tail never reached, the watermark never set — so a large
-- property never became incremental at all. These two columns let a sweep
-- resume where it stopped and finish across as many ticks as it needs.
--
--   full_sweep_after_id    last reservation id the sweep got through, in the
--                          sweep's own stable ordering. Null = no sweep mid-flight.
--   full_sweep_started_at  when the multi-tick sweep began. Becomes the
--                          watermark when it completes, so anything modified
--                          WHILE it ran falls inside the next incremental pull.
--
-- Run AFTER 99_supabase_migration_incremental_sync_v1.sql. Idempotent.

begin;

alter table pms_connections
  add column if not exists full_sweep_after_id text,
  add column if not exists full_sweep_started_at timestamptz;

commit;
