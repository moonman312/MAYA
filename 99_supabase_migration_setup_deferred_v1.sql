-- "Not now" for a parked Marketplace property.
--
-- A group grant parks one hotel per property and /onboarding walks the owner
-- through paying for them one at a time. An owner who only wants two of five
-- live was stuck: the subscribe screen kept offering the other three and there
-- was no way to say "skip this one" short of ignoring the page. This flag is
-- that answer. listUnpaidMarketplaceHotels leaves a deferred hotel out, so
-- /onboarding moves on to the next sibling (or into the product), and the
-- billing page lists what was deferred with a way back.
--
-- Nothing else changes: the hotel stays parked (is_active=false,
-- setup_pending_at set), its connection stays 'pending', and the claim still
-- points at it. Un-deferring clears both columns and the queue picks it up
-- again on the owner's next visit.
--
-- Code deployed ahead of this migration reads the column as missing and falls
-- back to the old behaviour (every parked sibling offered), logging that it did.
--
-- Run AFTER: billing_v2_pending_hotel, marketplace claims. Idempotent.

begin;

alter table hotels
  add column if not exists setup_deferred_at timestamptz,
  add column if not exists setup_deferred_by uuid references auth.users(id) on delete set null;

comment on column hotels.setup_deferred_at is
  'Owner said ''not now'' to paying for this parked Marketplace property; '
  '/onboarding stops offering it; the billing page lists it with a way back. '
  'Clears on un-defer.';

comment on column hotels.setup_deferred_by is
  'Who said not now. Cleared with setup_deferred_at.';

-- The only reader filters parked rows by this, so a partial index is plenty.
create index if not exists idx_hotels_setup_deferred
  on hotels(setup_deferred_at)
  where setup_deferred_at is not null;

commit;
