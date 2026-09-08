-- ============================================================================
-- Onboarding v2: suggestion kinds for the "ask for help" re-run flow.
--
-- Re-running the guided analysis on a hotel that already has rules must never
-- overwrite anything — it produces suggestions the user accepts or rejects
-- one by one. These are the two new finding kinds that carry them.
--
-- Run AFTER 99_supabase_migration_onboarding_v1.sql. Purely additive.
-- ============================================================================

alter type finding_kind add value if not exists 'rule_suggestion';
alter type finding_kind add value if not exists 'guardrail_suggestion';
