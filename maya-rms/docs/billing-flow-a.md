# Paying through the Cloudbeds Marketplace (Flow A)

A property that installs MAYA from the Cloudbeds Marketplace now pays before
anything about it is imported. This is how the pieces fit, how to test it with
a fake card, and how to flip it to real money.

## The sequence

```
Cloudbeds "Connect App"
  └─ /api/pms/cloudbeds/callback        tokens → Vault, hotel row parked
                                        (is_active=false, setup_pending_at set,
                                         pms_connections.status='pending'),
                                        claim ticket minted
  └─ /login?claim=…                     sign up or sign in
  └─ POST /api/pms/marketplace/claim    owner attached. STILL parked.
  └─ /onboarding                        the Marketplace subscribe screen:
                                        PMS settled, no code asked for,
                                        "Try MAYA free for N days"
  └─ POST /api/billing/checkout         Stripe Checkout (trial applied)
  └─ Stripe webhook                     subscription trialing/active →
       customer.subscription.created    activateMarketplaceHotelIfPending:
                                        hotel live, connection 'connected',
                                        import queued + worker kicked
  └─ /api/billing/checkout/return       same activation, in case the browser
                                        beats the webhook (idempotent)
  └─ /onboarding → path choice → import progress
```

**What is pulled before payment: nothing.** The callback makes one
`getHotelDetails` call to name the property. Bookings, room types, rates — all
of it waits for the subscription. The scheduler will not touch a `pending`
connection either (`99_supabase_migration_sync_claim_skip_pending_v1.sql`).

**What happens the instant a subscription is entitled:** the webhook activates
the hotel and queues the history import, so by the time the owner is back from
Stripe's card form the import is already running. `trialing` counts — a trial
is a plan.

**If they bounce off the card form:** Stripe sends them to
`/onboarding?checkout=cancelled`, which is the same Marketplace subscribe
screen with a "no charge was made" note. Every later visit to `/onboarding`,
and the renewal-nudge email, lands there too. Setting up payment is always one
click away and nothing is lost.

## Settings

| Variable | Where | Meaning |
|---|---|---|
| `MAYA_MARKETPLACE_TRIAL_DAYS` | Vercel + `.env.local` | Free days before the first charge. `0`/unset = no trial. A signup code's own trial replaces it; they never stack. |
| `STRIPE_SECRET_KEY` | Vercel + `.env.local` | `sk_test_…` = sandbox, `sk_live_…` = real money. Nothing else in the code changes between the two. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Vercel + `.env.local` | Must match the secret key's mode. |
| `STRIPE_WEBHOOK_SECRET` | Vercel + `.env.local` | Per endpoint. Test and live endpoints have different secrets. |

The signup-code gate (`/admin/pms-access`) does not apply to Marketplace
arrivals: the listing is the gate. A code they type anyway is still validated
and honoured.

## Testing it with a fake card

1. **Park a property and get the link.** Uses the sandbox connection's real
   tokens, exactly as the Marketplace would hand them over:

   ```bash
   mkdir -p node_modules/server-only && printf '{"name":"server-only","main":"index.js"}' > node_modules/server-only/package.json && echo 'module.exports = {};' > node_modules/server-only/index.js && npx tsx scripts/flow-a-e2e.mts --mint-only; rm -rf node_modules/server-only
   ```

   It prints a `/login?claim=…` URL and the cleanup command.

2. **Webhook delivery.** Locally, Stripe cannot reach `localhost`, so forward it:

   ```bash
   stripe listen --forward-to localhost:3000/api/stripe/webhook
   ```

   and put the `whsec_…` it prints into `.env.local` as `STRIPE_WEBHOOK_SECRET`
   (restart the dev server). On a Vercel deployment the dashboard endpoint does
   this already.

3. **Open the link**, sign up with a fresh email, and you land on the
   Marketplace subscribe screen. Enter a room count and continue to Stripe.

4. **Pay with a test card.** Any future expiry, any CVC, any postcode.

   | Card | What it does |
   |---|---|
   | `4242 4242 4242 4242` | Succeeds. The normal path. |
   | `4000 0025 0000 3155` | Requires 3-D Secure — tests the authentication step. |
   | `4000 0000 0000 9995` | Declined, insufficient funds — tests the bounce screen. |
   | `4000 0000 0000 0341` | Attaches, then fails when charged — tests the 48-hour re-check and the dunning banner. |

5. **Watch it go live.** Within a second or two of the webhook:

   ```sql
   select h.name, h.is_active, h.setup_pending_at, c.status, s.status as sub, j.status as import, j.phase
     from hotels h
     left join pms_connections c on c.hotel_id = h.id
     left join hotel_subscriptions s on s.hotel_id = h.id
     left join import_jobs j on j.hotel_id = h.id
    where h.id = '<hotelId from step 1>';
   ```

   You want `is_active=true`, `status=connected`, `sub=trialing`, and an import
   `queued` or `running` — before you have even clicked back to the app.

6. **Tear it down:** `npx tsx scripts/flow-a-e2e.mts --cleanup <hotelId>`
   (same `server-only` shim as step 1). Cancel the test subscription in the
   Stripe dashboard if you want the customer gone too.

The scripted version (`flow-a-e2e.mts` with no flags) does all of this without
a browser, standing in for the webhook by inserting the subscription row and
calling the activation directly. It cleans up after itself.

## Switching to production

Three environment variables and one script. No code changes.

1. In the Stripe dashboard, switch to **live** mode. Copy the live secret and
   publishable keys.
2. Run the price bootstrap against the live account so the lookup keys exist
   there too:

   ```bash
   STRIPE_SECRET_KEY=sk_live_… npx tsx scripts/stripe-bootstrap.mts --apply
   ```

3. Add a live webhook endpoint at `https://maya-rms.com/api/stripe/webhook`
   listening for: `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `customer.subscription.paused`, `customer.subscription.resumed`,
   `customer.subscription.trial_will_end`, `invoice.payment_succeeded`,
   `invoice.upcoming`. Copy its signing secret.
4. In Vercel (Production), set `STRIPE_SECRET_KEY`,
   `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` to the live
   values, and `MAYA_MARKETPLACE_TRIAL_DAYS` to what the offer should be.
5. Redeploy. The first live signup is the smoke test — use your own card and
   cancel it.

Going back to test mode is the same three variables, the other way.

## Known limits

- **Group grants.** A Cloudbeds group account parks one hotel per property and
  hands back one ticket. Subscriptions are per hotel, and the subscribe screen
  pays for one at a time; after the first is live, the owner is routed into the
  product and the rest stay parked. Same limitation as Flow B, which cannot do
  groups at all. Needs a multi-property checkout before a group customer signs.
- **The pre-payment name lookup** is the only Cloudbeds call made for an unpaid
  property. If that is ever too much, the callback could skip
  `getHotelDetails` and name the hotel on activation instead.
