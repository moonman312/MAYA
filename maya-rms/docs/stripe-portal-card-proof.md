# Stripe portal card proof (A35)

Internal. An owner step, run once in a Stripe sandbox. It answers the question
A35 left open: when an owner saves a new card in Stripe's billing portal, which
portal control keeps a subscription's own card, and which clears it?

It matters because MAYA's checkout puts the card on each subscription and
leaves the customer with no default card, and a subscription's own card
outranks the customer's default. Stripe's docs say only that customers "can
remove this override" in the portal, not which control does it.

## What MAYA does now (for reference)

On `customer.updated` with the default card changed
(`src/lib/billing/card-change.ts`):

- a subscription on the old default card moves to the new one. When the
  customer had no default before, a card counts as the old default only when
  **every** billing subscription carries that same card. One with no card,
  one on another card, or one already on the new card (unless MAYA itself
  moved it there for this same change) makes it unknowable;
- a subscription with no card of its own already follows the default;
- a subscription on a different card of its own is never touched. When the
  old card is unknowable, every subscription with a card of its own is left
  alone and logged as `old_card_unknown_left_alone`, the overdue one
  included;
- then every moved or following subscription that is `past_due` or `unpaid`,
  and one already on the new card, has its open invoices paid with the new
  card at once. An invoice Stripe says is already paid is logged as
  `invoice_already_paid`, not as a decline.

The proof below shows what Stripe's portal does by itself, above all whether
it ever takes a property off a card of its own, which MAYA promises it won't.
`check` then works out what MAYA's webhook would do with the state Stripe left
(the same `oldCardFor` and `planFor` the webhook runs) and prints it.

## Before you start

- Use the sandbox (test mode), never live. The script refuses any key that
  is not `sk_test_`.
- `.env.local` in `maya-rms/` must hold the sandbox `STRIPE_SECRET_KEY`, the
  same one previews use.
- The sandbox needs a saved customer portal: Dashboard, Settings, Billing,
  Customer portal, with payment method updates on, saved once. If `links`
  fails with a message about a configuration, that page has never been saved
  in the sandbox.
- Stripe test clocks cannot be used on an existing customer while the account
  has Billing Automations. The script only makes new customers, so this does
  not apply to it.

## Steps

All commands run from `maya-rms/`.

1. **Set up.** `npx tsx scripts/stripe-portal-card-proof.mts setup`

   This creates one test clock (a "simulation" in the Dashboard, under
   Billing, Subscriptions, Simulations) with four customers, one per portal
   control. Each customer has no default card, like a MAYA checkout.

   - Three of them are a **group**, with two subscriptions each on a one-day
     trial:
     - the **overdue** one, on its own card that attaches but fails every
       charge (Stripe's `pm_card_chargeCustomerFail`, the 4000 0000 0000 0341
       test card);
     - the **own card** one, on a good Mastercard of its own, like a group
       property paid for with a different card.
   - The fourth, Willow Cottage, is **one property**: only the overdue
     subscription.

   It then moves the clock past the trial end, so each overdue one's first
   charge fails. It prints the clock id (`clock_...`) and a first `check`.
   Expect, for each customer: no default card, the overdue subscription
   `past_due` on "the failing card" with its latest invoice `open`, and (in
   the group) the other `active` on "its own Mastercard".

   None of these subscriptions has a `hotel_id`, so MAYA's webhook ignores
   them even if the sandbox sends events to a preview. What you see is
   Stripe's doing alone.

2. **Get the links.** `npx tsx scripts/stripe-portal-card-proof.mts links --clock clock_...`

   It prints one portal link per customer with what to do on it. Each link
   stops working after about 5 minutes unused; run `links` again for fresh
   ones.

3. **Do one action per customer**, exactly as printed:

   - **Juniper Lodge (add card):** the full portal. Add a new card,
     4242 4242 4242 4242, any future date, any CVC. If the form offers to make
     it the default, leave that on.
   - **Harbour Inn (card screen):** the `payment_method_update` screen MAYA
     uses for a narrowed session. Enter 4242 4242 4242 4242 and save.
   - **Cedar House (make default):** the full portal. Do not add anything.
     Use the menu next to the spare card (`links` prints which one) to make it
     the default.
   - **Willow Cottage (one property):** the full portal, as a single-property
     owner gets it. Add 4242 4242 4242 4242 as for Juniper Lodge.

   Write down anything the portal shows about the subscriptions while you are
   there (for example a notice about the failed payment, or a button to pay
   it). Click nothing else.

4. **Read the result.** `npx tsx scripts/stripe-portal-card-proof.mts check --clock clock_...`

   For each customer it prints the default card, what each subscription's own
   card is now, the overdue invoice's state with its attempt count, its next
   scheduled retry and the card its latest attempt was on, a one-line
   finding, what MAYA's webhook would do, and either "No change needed" or
   "CHANGE NEEDED".

5. **See what Stripe's retry does.** `npx tsx scripts/stripe-portal-card-proof.mts advance --clock clock_...`

   This moves the clock to an hour past the next scheduled retry of the
   overdue invoices (Smart Retries, or a custom schedule, can put it days
   out) and checks again. Read the overdue invoice line:

   - `paid`: Stripe's retry charged the new card.
   - still open, with the attempt count up by one and the latest attempt on
     "the failing card": the retry charged the failing card again. That is
     the gap MAYA's move closes for one property.
   - still open with the same attempt count: no retry has run yet. Run
     `advance` again.

   If it says no retry is scheduled, Stripe has stopped retrying (the
   subscription is `unpaid` or cancelled). `advance --days N` still moves the
   clock N days.

6. **Send the `check` output from steps 4 and 5 to Claude**, with your notes
   from step 3.

7. **Clean up.** `npx tsx scripts/stripe-portal-card-proof.mts cleanup --clock clock_...`
   Deleting the test clock deletes its four customers and their
   subscriptions. Stripe also deletes a simulation by itself after 30 days.

## What the results mean

Per control, look at the subscriptions. "MAYA would" is what `check` prints
from `card-change.ts` for that state; the customers had no default card
before, as after a MAYA checkout.

**The group (Juniper Lodge, Harbour Inn, Cedar House)**

| Overdue subscription | Subscription on its own card | MAYA would | Change needed? |
| --- | --- | --- | --- |
| kept the failing card | kept its own card | Move nothing and pay nothing: with no default before and two different cards it cannot tell which was the old one. The overdue property keeps retrying the failing card until the owner emails us which properties to move. This is the exception the customer docs state (Moving to another card). | No, unless Jake wants this case handled too. |
| cleared, or moved to the new card | kept its own card | Leave the one on its own card alone and pay the overdue invoice with the new card at once. | No |
| any | cleared, or moved to the new card | (The portal itself took a property off a card of its own.) | **Yes.** Jake decides: say in the docs that this control moves every property, or have MAYA put each property's own card back (needs building), or stop offering a different card at checkout. |
| any other card | any other card | | Unexpected. Read both subscriptions in the Dashboard and send them to Claude. |
| (the default did not change) | | | Nothing proved. Redo the step. |

If `check` ever prints that MAYA would move the subscription on its own card,
that is a MAYA bug: it says CHANGE NEEDED. Send the output to Claude.

**One property (Willow Cottage)**

| Overdue subscription | MAYA would | Change needed? |
| --- | --- | --- |
| kept the failing card | Move it to the new card (every subscription is on that one card) and pay the open invoice at once. This is the gap A35 closes. | No |
| cleared, or moved to the new card | Pay the open invoice with the new card at once. | No |
| any other card | | Unexpected. Send it to Claude. |

The overdue invoice on its own: if `check` shows it `paid` right after the
portal action (before step 5), the portal pays an overdue invoice by itself.
That is harmless: MAYA's payment then finds nothing open, or Stripe refuses it
as already paid, which MAYA logs as `invoice_already_paid`.

## After deploying A35: an end-to-end check

Optional, on a preview that uses the sandbox keys and has its own webhook
endpoint in the sandbox (with `customer.updated` among its events).

1. Sign up a test property with a trial code, paying with the card
   4000 0000 0000 0341 (it attaches, and every later charge fails).
2. End its trial now with the Stripe CLI against the sandbox:
   `stripe subscriptions update sub_... -d trial_end=now`. The first charge
   fails and the property's Billing page reads "Payment overdue".
3. On that Billing page, click Update card, receipts & cancellation, add
   4242 4242 4242 4242 and make it the default.
4. Within a few seconds: the preview's logs show a `cardChange` line with
   `moved: 1` and `paid: 1`, and the Billing page reads "Active". In the
   Dashboard the subscription's payment method is the 4242 card.
