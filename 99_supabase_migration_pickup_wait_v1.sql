-- ============================================================================
-- MAYA pickup count rules get a wait of their own (v1)
-- ============================================================================
--
-- After a pickup count rule adjusts a night and room type, it waits before it
-- may adjust them again. Until now that wait was always its lookback window
-- (pickup_window_days: 1, 3 or 7 days) and nothing on screen said so, while a
-- booking speed rule already had its own "(advanced)" wait. Decided
-- 2026-09-24 (Jake): the rule builder offers a pickup count rule the same
-- choice, starting on "Same as the lookback window".
--
-- 1. rule_condition.pickup_cooldown_days (integer, null): the days a pickup
--    count rule waits on a night and room type after it fires there. Null
--    means "same as the lookback window", which is what every rule that
--    exists keeps: nothing is backfilled, so no rule waits differently the
--    day this runs. Two named checks:
--      rule_condition_pickup_cooldown_chk         at least 1 day, like the
--                                                 booking speed wait: with
--                                                 fires stacking, 0 would
--                                                 raise or cut every run.
--      rule_condition_pickup_cooldown_family_chk  null when the rule has no
--                                                 pickup condition, the way
--                                                 booking_speed_cooldown_days
--                                                 is null without a booking
--                                                 speed condition.
--    02_supabase_schema.sql creates the same column and checks, by the same
--    names, for a fresh install.
--
-- What the engine does with it (engine/pickup.ts, both copies): a pickup
-- count rule waits pickup_cooldown_days when it is set, else its window; a
-- rule with a booking speed condition as well still waits the longer of its
-- two waits (ruleWaitDays). When the wait is shorter than the window, the
-- next decision on the night must not count the bookings an earlier raise
-- already acted on, so the count now opens no earlier than the night and
-- room type's newest counted fire in the rule's direction (pickupCountFrom):
-- the newest raise for a rule that raises, the newest cut for one that cuts,
-- by any event rule, current rule versions only, open or taken off for
-- cancellations; fires taken off by a typed price never count, and after a
-- typed price the rule waits from the price and then counts its whole
-- window. This is the rule booking speed conditions already follow. It
-- applies to rules left on "Same as the lookback window" too, but there only
-- another rule's fire inside the window can move the count: a rule that
-- waits its whole window never finds its own fire inside it. The run that
-- made a fire wrote a snapshot at that very instant (snapshot_ts = the fire's
-- applied_at, for every counting room type on every night it priced), so the
-- count finds its starting point there, well inside the 12-hour staleness
-- guard and the snapshot retention (longest window plus 7 days).
--
-- The engine reads pickup_cooldown_days as soon as it is deployed. Before
-- this file it re-reads the rules without the column, logs once per run
-- naming this file, and every pickup count rule waits its window, which is
-- how it priced before; the new count start works either way. The app reads
-- and writes the column with no such fallback: the Rules tab would fail to
-- load and a rule saved with a chosen wait would be refused. So run this
-- first.
--
-- Run AFTER 99_supabase_migration_booking_speed_counts_bookings_v1.sql.
-- Idempotent, one transaction, safe to replay.
--
-- Deploy: run this, then deploy cloudbeds-scheduled-sync,
-- mews-scheduled-sync and think-scheduled-sync (one command each; loops are
-- blocked), then push the app. Every scheduled sync runs the engine, whose
-- wait and count start changed; the app carries the rule builder's new
-- dropdown and "?", the rules table text, and the change log and alert
-- sentences that say when a count started at the night's last raise or cut.
-- Between the migration and the deploy, the old engine ignores the column
-- (nobody can have set it yet: the old app has no way to) and prices as
-- before. What an owner may notice once the new engine runs: a rule that
-- raises on pickup no longer raises again on a burst another rule already
-- raised the night for inside its window, and a rule that cuts on pickup
-- counts from the night's last cut the same way.
--
-- Checking by hand:
--
--   select pickup_window_days, pickup_cooldown_days, count(*)
--     from public.rule_condition
--    where pickup_operator is not null
--    group by 1, 2;
--
-- Right after this file, pickup_cooldown_days is null on every row.
-- ============================================================================

begin;

alter table public.rule_condition
  add column if not exists pickup_cooldown_days integer;

comment on column public.rule_condition.pickup_cooldown_days is
  'Days a pickup count rule waits on a night and room type after it fires there. Null waits its lookback window (pickup_window_days). At least 1; null without a pickup condition.';

alter table public.rule_condition drop constraint if exists rule_condition_pickup_cooldown_chk;
alter table public.rule_condition add constraint rule_condition_pickup_cooldown_chk
  check (pickup_cooldown_days is null or pickup_cooldown_days >= 1);

alter table public.rule_condition drop constraint if exists rule_condition_pickup_cooldown_family_chk;
alter table public.rule_condition add constraint rule_condition_pickup_cooldown_family_chk
  check (pickup_cooldown_days is null or pickup_operator is not null);

commit;
