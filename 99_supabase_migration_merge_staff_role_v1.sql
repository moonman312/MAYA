-- Merge the "staff" role into "viewer" — they granted the same thing.
--
-- Staff and Viewer had identical descriptions ("Can look, cannot change
-- anything") and "staff" was never checked for anywhere outside lib/roles.ts.
-- Two roles doing one job.
--
-- Postgres cannot drop an enum value without recreating the type and every
-- column and function signature that uses it (hotel_memberships.role,
-- pending_memberships.role, and the role column in at least two RPC return
-- tables). That is real migration risk for zero behavioural gain, so the enum
-- value stays — merely unreachable from the product now that lib/roles.ts no
-- longer offers it. This migration is the data half: anyone already on
-- 'staff' moves to 'viewer', so the merge is real, not just hidden in a picker.
--
-- Checked before writing this: zero rows on either table used 'staff'. This
-- UPDATE is therefore a no-op today and exists for safety — a pending invite
-- issued between checking and this running, or a fresh environment seeded
-- differently, still gets swept up correctly.
--
-- Run any time. Idempotent.

update hotel_memberships set role = 'viewer' where role = 'staff';
update pending_memberships set role = 'viewer' where role = 'staff';

comment on type hotel_membership_role is
  'staff is deprecated and merged into viewer as of 2026-07-31 — see 99_supabase_migration_merge_staff_role_v1.sql. Left in the enum rather than dropped: Postgres cannot remove an enum value without recreating the type and every column/function that reference it. lib/roles.ts no longer offers "staff" as a choice.';
