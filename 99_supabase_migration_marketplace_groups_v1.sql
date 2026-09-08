-- ============================================================================
-- FLOW A — group accounts: one grant, many properties
-- ============================================================================
--
-- A Cloudbeds GROUP user's authorization covers every property in the group,
-- not one: "when the group user authorizes the connection, the access token or
-- API keys will provide data for the entire group". getHotels then returns the
-- whole list, and taking the first entry — which is what a single-property
-- discover does — silently connects one hotel and drops the rest.
--
-- So a Marketplace connection can now create SEVERAL parked properties from a
-- single grant, and they have to be claimable together: the owner clicks one
-- link and gets all of their hotels, not the first one and a mystery.
-- group_key is what ties those claims into one bundle.
--
-- Sharing one grant across properties is only safe because Cloudbeds does not
-- rotate refresh tokens — verified 2026-09-09 by refreshing and comparing: the
-- same refresh token comes back. Each hotel therefore keeps its own copy of the
-- credentials (with its own propertyId) and refreshes independently without
-- invalidating its siblings. If that ever changes, this design has to change
-- with it.

alter table pms_marketplace_claims
  add column if not exists group_key text;

-- Redemption looks up every unclaimed sibling by this key, so it is the access
-- path, not just a label.
create index if not exists idx_marketplace_claims_group
  on pms_marketplace_claims (group_key) where claimed_at is null;
