-- Hotel roles v2: General Manager, Revenue Manager, and a real hierarchy.
--
-- Before: hotel_admin / manager / staff / viewer, where manager and
-- hotel_admin were identical except for deleting the hotel, and staff and
-- viewer were identical to each other. Four names, two-and-a-half levels.
--
-- After, highest to lowest:
--   hotel_admin      everything, including deleting the hotel
--   general_manager  everything except deleting the hotel — owns the
--                    commercial decisions: going live, the PMS connection,
--                    billing, and who holds which role
--   revenue_manager  the day-to-day pricing job: rules, rates, floor and
--                    ceiling guardrails, reverts, challenging assumptions.
--                    No commercial or membership control.
--   staff            read only
--   viewer           read only
--
-- Two capability tiers back this:
--   can_manage_hotel     revenue_manager and up — may change pricing
--   can_manage_finances  general_manager and up — may change commercial state
--
-- This also closes the self-promotion hole found in the security review: the
-- role column was manager-writable with no constraint, so a manager could
-- promote themselves to hotel_admin and then delete the hotel. Role writes
-- are now rank-checked by trigger.

-- ── 1. Enum ────────────────────────────────────────────────────────────────
-- ALTER TYPE ... ADD VALUE cannot be used in the same transaction that adds
-- it, so this block runs first and alone. Re-running is safe.

alter type hotel_membership_role rename value 'manager' to 'general_manager';

do $$ begin
  alter type hotel_membership_role add value if not exists 'revenue_manager' after 'general_manager';
end $$;
