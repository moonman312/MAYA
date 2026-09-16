-- ============================================================================
-- IMPORT EARLY ANALYSIS — one open copy of each onboarding question
-- ============================================================================
--
-- The import worker now analyses a property twice: early, once the current
-- window and three years of history are in, so the owner can review closures
-- and room types and run starter rules within the first minute; and again
-- when every year has loaded. Either pass can also repeat after a worker dies
-- between finishing it and checkpointing it.
--
-- The analysis refines open findings in place and stops asking questions the
-- owner has answered, which on its own keeps sequential passes from
-- duplicating anything. What it cannot rule out is two passes running at once
-- (a worker whose lease lapsed mid-analysis while a second one claimed the
-- job): both would read the same state and both insert the same new finding.
--
-- finding_key names the question a finding asks ("room_type:<id>",
-- "closure:<start>:<end>", "property" for the whole-property counts), and the
-- partial unique index refuses a second OPEN copy of one question per hotel.
-- Only proposed rows are covered: a resolved answer is history, and a refresh
-- may legitimately ask again later.
--
-- Existing rows keep a null key and are not covered. Nothing is backfilled,
-- because older imports did leave duplicate open copies behind and a backfill
-- would fail the index on exactly those hotels; the analysis matches legacy
-- rows by their payload instead and refines them the same way.
--
-- No new import phase needs schema: import_jobs.phase is free text, and the
-- new 'analyze_early' value is written by the worker only.
--
-- Deploy order: either. Code deployed ahead of this file sees PostgREST
-- reject finding_key, logs a warning naming this file, and writes the same
-- findings without the key. This file ahead of the code adds a column nothing
-- writes yet.
-- Run after 99_supabase_migration_onboarding_v2.sql. Idempotent.
--
-- NOT mirrored into 02_supabase_schema.sql yet — fold it in on the next
-- schema consolidation pass.

begin;

alter table onboarding_findings
  add column if not exists finding_key text;

comment on column onboarding_findings.finding_key is
  'The question this finding asks, stable across analysis passes. Unique per hotel and kind among open (proposed) findings. Null on rows written before early analysis.';

create unique index if not exists uq_onboarding_findings_open_question
  on onboarding_findings (hotel_id, kind, finding_key)
  where status = 'proposed' and finding_key is not null;

commit;

-- Check afterwards:
--
--   select indexdef from pg_indexes
--    where tablename = 'onboarding_findings'
--      and indexname = 'uq_onboarding_findings_open_question';
