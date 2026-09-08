-- Anchor the 48-hour recheck on the SUBSCRIPTION, not on the row.
--
-- patchFor counted the 48 hours from hotel_subscriptions.created_at, which is
-- when the ROW was first written. That is the same thing on a first signup and
-- badly wrong on a re-subscribe: the row is reused (it is keyed by hotel), so
-- created_at still points at the original signup months earlier, and
-- "signup + 48h" lands in the past. The recheck is then due the instant stage
-- one passes, and the delay that exists to catch a cancelled virtual card is
-- skipped entirely for exactly the customers who have churned once already.
--
-- Stripe's own subscription.created is the right clock, so it gets a column.
-- projectSubscription fills it on every webhook, and
-- trg_hotel_subscriptions_reset_card_verify already clears the verification
-- stamps when the subscription id changes, so a re-subscribe starts over
-- properly.
--
-- Run AFTER 99_supabase_migration_card_reverify_v2_two_stage.sql. Idempotent.

alter table hotel_subscriptions
  add column if not exists card_verify_anchor_at timestamptz;

comment on column hotel_subscriptions.card_verify_anchor_at is
  'When the CURRENT Stripe subscription was created. The 48-hour recheck counts from here, not from the row.';

-- Backfill so existing rows do not fall back to created_at. For a first signup
-- the two are within a webhook round-trip of each other, which is the best
-- available answer for rows that predate the column.
update hotel_subscriptions
   set card_verify_anchor_at = created_at
 where card_verify_anchor_at is null;
