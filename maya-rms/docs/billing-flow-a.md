# Paying through the Cloudbeds Marketplace (Flow A)

A property that installs MAYA from the Cloudbeds Marketplace starts importing
its booking history as soon as its owner claims it, and pays before MAYA syncs,
prices or writes anything for it. This is how the pieces fit, how to test it
with a fake card, and how to flip it to real money.

## The sequence

```
Cloudbeds "Connect App"
  └─ /api/pms/cloudbeds/callback        tokens → Vault, hotel row parked
                                        (is_active=false, setup_pending_at set,
                                         pms_connections.status='pending'),
                                        claim ticket minted
  └─ /login?claim=…                     sign up or sign in
  └─ POST /api/pms/marketplace/claim    owner attached. STILL parked.
                                        History import queued for the property
                                        the owner is shown next, worker kicked
  └─ /onboarding                        the Marketplace subscribe screen:
                                        PMS settled, no code asked for,
                                        "Try MAYA free for N days"
                                        (a group sibling's import is queued
                                        when it comes up here)
  └─ POST /api/billing/checkout         Stripe Checkout (trial applied)
  └─ Stripe webhook                     subscription trialing/active →
       customer.subscription.created    activateMarketplaceHotelIfPending:
                                        hotel live, connection 'connected',
                                        the claim's import adopted, not repeated
  └─ /api/billing/checkout/return       same activation, in case the browser
                                        beats the webhook (idempotent)
  └─ /onboarding → path choice → import progress, or straight to review
                                        when the import is already done
```

**What is pulled before the claim.** Only what the callback needs to name the
property: one `getHotels` call, plus one `getHotelDetails` per property in the
grant. A connect nobody claims is never imported, and the claim sweep deletes it
three days after its ticket expires (`99_supabase_migration_marketplace_claim_sweep_v1.sql`).

**What is pulled after the claim, before payment.** The claim queues the
history import for the property the owner is about to be shown
(`lib/pms/eager-import.ts`): property details and room types, the current
booking window with per-night rates (`getReservationsWithRateDetails`, a
hundred bookings a call), three years of history, an early analysis that writes
the findings and starter rules, the rest of the history back to the first empty
year, and a final analysis. The worker runs it for the unpaid property without
touching its connection status or activating it. A group grant is imported one
property at a time, as each comes up on the subscribe screen. A property the
owner says "Not now" to is never imported, and saying it stops an import
already queued for it; "Set up" from Billing puts it back on the subscribe
screen, which carries on from where it stopped. Paid imports are claimed before
unpaid ones, and one unpaid import per owner runs at a time
(`99_supabase_migration_import_at_claim_v1.sql`).

**What waits for the subscription.** The scheduled sync (the scheduler still
leaves a `pending` connection alone:
`99_supabase_migration_sync_claim_skip_pending_v1.sql` and `splitByParked`),
engine evaluation, and every write to Cloudbeds. Nothing read before payment
reaches the property's rates, and the owner sees none of it until they have
subscribed or started the trial.

**What happens the instant a subscription is entitled:** the webhook activates
the hotel, flips the connection to `connected`, and adopts the import the claim
started. `onboarding_states` points at that job whether it is queued, running
or finished; only a failed or stopped one is re-queued, from its checkpoint.
So an owner back from Stripe's card form usually finds the import done, and the
progress screen sends them straight to review. `trialing` counts — a trial is a
plan.

**A property that never pays.** 180 days after a person last did anything with
it, `never_paid_retention_sweep()` deletes the booking history it imported and
the rows derived from it, its import jobs, open findings, unaccepted invites,
its stored PMS credential and its connection row
(`99_supabase_migration_never_paid_retention_v1.sql`). The property, members,
rules, room types and their classifications, closed periods and answered
findings stay, so an owner who comes back does not set anything up again. With
no connection left, the subscribe screen, the import progress screen and the
dashboard show the ordinary reconnect prompt, which says the booking history
comes back once they reconnect (`lib/pms/purged.ts`). Reconnecting, from that
prompt or from the Marketplace, sees `hotels.data_purged_at` (stamped before
the sweep deletes anything) and queues a fresh full import: through the
pre-payment queue while the property is parked and is the one the subscribe
screen shows next (a group's other siblings are queued as each comes up), or
adopted the way payment adopts one if they paid first. A trial that ended
unpaid waits for payment. The reconnect prompt's own OAuth callback only
accepts a login that can reach the Cloudbeds property the hotel is bound to,
and stores that property ID with the credential. A parked property stays
`pending`; a paid one is left alone by `claim_pms_sync_batch` and
`splitByParked` (which also covers a manual price's one-hotel sync) until an
import created after the purge has completed, so nothing prices it off the
recent window alone. Anything that is
paying, trialing, past due or has ever paid (`hotel_subscriptions.first_paid_at`,
stamped by the webhook from the first paid, non-zero invoice) is never touched.
Disconnecting deletes nothing, and no owner-facing control deletes anything.

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

   You want `is_active=true`, `status=connected`, `sub=trialing`, and exactly
   one import job, the one queued when you claimed the property: `running`, or
   already `completed`.

6. **Tear it down:** `npx tsx scripts/flow-a-e2e.mts --cleanup <hotelId>`
   (same `server-only` shim as step 1). Cancel the test subscription in the
   Stripe dashboard if you want the customer gone too.

The scripted version (`flow-a-e2e.mts` with no flags) does all of this without
a browser, standing in for the webhook by inserting the subscription row and
calling the activation directly. It checks that the claim queues one import
while the property stays parked, and that payment adopts that same job. It
cleans up after itself.

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

- **Group grants pay one property at a time.** A Cloudbeds group account parks
  one hotel per property and hands back one ticket; the claim attaches the
  owner to all of them. Subscriptions are per hotel, so `/onboarding` walks the
  group in order (`listUnpaidMarketplaceHotels`, oldest first): the subscribe
  screen says "Property 2 of 3", checkout is told which hotel it is paying for,
  and the return route sends the owner straight back for the next one until
  none are parked. Each property is priced at its own bracket, on its own
  subscription. The Stripe customer is keyed on the owner rather than the hotel
  for Marketplace properties, so the card taken for the first is on the same
  customer for the rest. What is still true: it is one Checkout per property,
  not one for the group — a five-property owner goes through Stripe five times,
  and whether Checkout offers the saved card on the later visits is Stripe's
  call (verify in the sandbox; `saved_payment_method_options` may be needed).
  Flow B still cannot do groups at all: a group login there is refused with a
  plain message asking them to reply to their receipt.
- **"Not now" for a sibling.** A group owner who only wants some of the
  properties live can click "Not now — set this property up later" under the
  pay button on the Marketplace subscribe screen. That stamps
  `hotels.setup_deferred_at/_by` (`POST /api/onboarding/defer`,
  `99_supabase_migration_setup_deferred_v1.sql`), `listUnpaidMarketplaceHotels`
  leaves the property out, and `/onboarding` moves on to the next sibling or
  into the product. The property stays parked: connection `pending`, no charge,
  and no import (one already queued for it is stopped, and the queue refuses to
  run it while the flag is set). The count on screen keeps the group's total
  and treats the deferred one as done-for-now ("Property 2 of 3" after skipping
  the first). The way back is Billing, where "Properties not set up yet" lists
  each deferred property with a "Set up" button (`DELETE /api/onboarding/defer`)
  that clears the flag and lands on `/onboarding`, which offers it again. Both
  directions write a `pms.marketplace_deferred` / `pms.marketplace_resumed`
  audit event. The link is not offered on the last parked property when nothing
  is live — there would be nowhere to go — and never for Flow B. Deployed ahead
  of its migration, the route answers 503 "This needs a database update first."
  and the queue behaves as before.
- **Pre-payment API budget.** An unclaimed connect costs the callback's 1 + N
  calls and nothing more. A claimed property that never pays costs one import:
  for a 42-room property with seven years of history, roughly 390 Cloudbeds
  calls (about 20 for the current window with paged rate details, about 52 per
  year of history across the four active statuses, a few for the empty year that
  stops it), paced at least 220 ms apart, and an estimated 28 MB of rows until
  the 180-day sweep. Watch the ratio of claims to conversions: a Marketplace
  listing that attracts browsers is a cost line, not just a funnel.
