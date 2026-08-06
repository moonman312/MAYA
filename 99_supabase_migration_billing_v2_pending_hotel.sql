-- MAYA Billing v2 — the hotel row a payment lands on before a property exists.
--
-- Payment now comes first: pay, pick a PMS, connect it, choose how much help you
-- want. That inverts what the billing tables assumed. hotel_subscriptions is
-- keyed by hotel_id and sync.ts refuses a subscription whose metadata carries
-- none, so a payment taken before the PMS connect had nothing to attach to.
--
-- So checkout creates the hotel row itself and the connect callback adopts it,
-- renaming it from what the PMS reports. setup_pending_at marks the row as
-- not-yet-a-property: set at checkout, cleared on adoption. Non-null means no
-- PMS has ever been connected to it.
--
-- Paired with is_active = false, which is what actually hides it: the app's
-- accessible-hotel lookup filters on is_active, so a half-finished signup stays
-- out of the property picker, the dashboard, and every sweep over live hotels
-- without any of them needing to know this column exists.
--
-- Worth keeping distinct from is_active = false on its own, which means a
-- property that was switched off. "Never finished starting" and "shut down" want
-- different answers from a cleanup script.
--
-- Run AFTER 99_supabase_migration_billing_v1.sql. Idempotent.

alter table hotels
  add column if not exists setup_pending_at timestamptz;

create index if not exists idx_hotels_setup_pending
  on hotels(setup_pending_at)
  where setup_pending_at is not null;

comment on column hotels.setup_pending_at is
  'Set when checkout created this row so a Stripe subscription had a hotel_id to attach to; cleared when the PMS connect adopts it. Non-null means no PMS has ever been connected.';

-- Abandoning checkout leaves one of these behind per user — at most one, since
-- checkout reuses an existing pending row rather than making another. Clearing
-- them out is safe ONLY where no subscription ever attached: hotel_subscriptions
-- cascades on hotel delete, so deleting a hotel that paid would destroy the only
-- local record of what Stripe is still billing.
--
--   delete from hotels h
--    where h.setup_pending_at < now() - interval '30 days'
--      and not exists (select 1 from hotel_subscriptions s where s.hotel_id = h.id);
