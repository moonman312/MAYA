-- Warn before charging.
--
-- The shortfall correction raises what a customer pays without them touching
-- anything, and until now the only warning lived on the billing page. A hotel
-- that doesn't sign in during the grace week would have met the correction as a
-- larger invoice they had never been told about — which is how a defensible
-- adjustment becomes a chargeback and a cancelled account.
--
-- Run AFTER 99_supabase_migration_room_count_truth_v1.sql. Idempotent.

alter table hotel_subscriptions
  add column if not exists room_shortfall_notified_at timestamptz,
  add column if not exists room_shortfall_notified_rooms integer;

comment on column hotel_subscriptions.room_shortfall_notified_at is
  'When the owner was last emailed about billing for fewer rooms than they run.';
comment on column hotel_subscriptions.room_shortfall_notified_rooms is
  'The measured count that notice quoted. A different number means the situation changed and is worth a fresh email; the same number is not.';
