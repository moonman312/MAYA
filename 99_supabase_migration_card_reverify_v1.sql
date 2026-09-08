-- MAYA card re-verification — the two columns the 48-hour sweep needs, and the
-- trigger that re-arms it when a hotel subscribes again.
--
-- The sweep re-checks a saved card by confirming a zero-amount SetupIntent
-- against it. Three outcomes matter and the existing verified_at/failed_at pair
-- only expresses two: a check can also come back inconclusive (Stripe
-- unreachable, rate limited, or the issuer asking for the cardholder to
-- authenticate — none of which is evidence the card is dead). Those get retried,
-- and retrying needs a counter or the row spins in the sweep forever.
--
-- Run AFTER 99_supabase_migration_billing_v1.sql. Idempotent.

alter table hotel_subscriptions
  add column if not exists card_verify_attempts integer not null default 0,
  -- Stripe's decline_code / error code, or one of our own tokens
  -- (no_payment_method, authentication_required, subscription_canceled). The
  -- banner needs it: "your bank declined the card" and "we couldn't reach your
  -- bank" ask the owner for different things.
  add column if not exists card_verify_last_code text;

comment on column hotel_subscriptions.card_verify_attempts is
  'Re-verification attempts made so far. Bounds the retry of inconclusive checks.';
comment on column hotel_subscriptions.card_verify_last_code is
  'Why the last re-verification did not succeed. Null once verified.';

-- idx_hotel_subscriptions_card_due (billing_v1) already covers the sweep's
-- predicate — due, unverified, unfailed — and neither column changes it.

/* ── A new subscription gets a new re-check ───────────────────────────────── */

-- The sweep only looks at rows with no verdict yet, so a hotel that failed a
-- re-check, cancelled, and later signed up again would keep its old failure
-- forever: the webhook's upsert brings a fresh card_verify_due_at but leaves the
-- stamps alone, and a row that is already stamped is never swept again. Their new
-- card would never be checked and the banner would accuse them over a card they
-- no longer have.
--
-- Done as a trigger rather than in the webhook's projection because only the
-- database can see the id it is replacing — projectSubscription() builds the row
-- without reading the old one, so it cannot tell a genuine re-subscribe from any
-- other status update, and clearing the stamps on every update would re-arm the
-- check every time Stripe sends anything.
create or replace function public.billing_reset_card_verify()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.stripe_subscription_id is distinct from old.stripe_subscription_id then
    -- A different subscription means a different card to vouch for.
    new.card_verified_at := null;
    new.card_verify_failed_at := null;
    new.card_verify_last_code := null;
    new.card_verify_attempts := 0;
  else
    -- Same subscription: whatever the sweep decided stands. persistSubscription
    -- rewrites card_verify_due_at from the subscription's creation time on every
    -- webhook, which would otherwise re-arm a check the sweep had already
    -- resolved — including the case where it nulled the deadline because the
    -- subscription was cancelled and the question had become moot.
    new.card_verify_due_at := old.card_verify_due_at;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_hotel_subscriptions_reset_card_verify on public.hotel_subscriptions;
create trigger trg_hotel_subscriptions_reset_card_verify
  before update on public.hotel_subscriptions
  for each row execute function public.billing_reset_card_verify();
