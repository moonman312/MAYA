-- ============================================================================
-- FLOW A — connections that start in the Cloudbeds Marketplace
-- ============================================================================
--
-- Cloudbeds has mandated Flow A for all new apps since 2020-11-01: the user
-- clicks "Connect App" in the Marketplace, approves the scopes, and Cloudbeds
-- redirects them to our callback. Two things about that are different from the
-- flow MAYA had (Flow B, where MAYA builds the authorize URL itself):
--
--   1. There is no state parameter we signed, because we did not start it.
--   2. There may be no MAYA account yet, and Flow A explicitly says the app
--      needs no account-creation UI. So the callback has to accept a valid
--      grant for a property nobody has claimed, hold it safely, and attach it
--      to whoever proves they own it next.
--
-- The hotel row is created immediately (setup_pending_at set, is_active false)
-- so the tokens have somewhere to live — pms_secret_set is keyed by hotel_id
-- and the Vault is the only place credentials may go. What is missing at that
-- point is a MEMBERSHIP, and this table is the one-time ticket that grants it.
--
-- The token is random and single-use. It is not a session: claiming still
-- requires an authenticated MAYA user, so the worst a leaked token buys is
-- attaching someone else's property to your own account — which is why it
-- expires quickly and is deleted on use.

create table if not exists pms_marketplace_claims (
  -- The value that travels in the URL. Random, single-use, never reused.
  token                 text primary key,
  hotel_id              uuid not null references hotels(id) on delete cascade,
  pms_type              pms_type not null,
  -- Namespaced ("cloudbeds:320691") so two PMSes cannot collide on a number.
  external_property_id  text not null,
  property_name         text,
  created_at            timestamptz not null default now(),
  expires_at            timestamptz not null,
  claimed_by            uuid references auth.users(id) on delete set null,
  claimed_at            timestamptz,
  unique (hotel_id, pms_type)
);

create index if not exists idx_marketplace_claims_property
  on pms_marketplace_claims (external_property_id);

create index if not exists idx_marketplace_claims_expiry
  on pms_marketplace_claims (expires_at) where claimed_at is null;

-- Service-role only, like pms_connection_secrets: this table is a bearer
-- ticket, so no client may list, guess at, or read one. Every read and write
-- goes through the callback and the claim route, both server-side.
alter table pms_marketplace_claims enable row level security;
revoke all on pms_marketplace_claims from anon, authenticated;

-- Lets the Flow A callback find the hotel a property already belongs to, so a
-- RE-connect updates the existing hotel instead of minting a duplicate.
create index if not exists idx_hotels_external_enterprise_id
  on hotels (external_enterprise_id) where external_enterprise_id is not null;
