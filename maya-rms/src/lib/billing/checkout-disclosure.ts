import { TERMS_URL } from "@/lib/legal/versions";
import type { BillingInterval } from "@/lib/billing/tiers";

/**
 * The disclosure above Checkout's pay button (custom_text.submit). Text, not a
 * checkbox: acceptance itself is already on file, which the checkout route
 * checks before it gets here, and this puts what that acceptance covers
 * next to the card at the moment it is entered. The amount and any trial
 * length are left to Checkout, which already shows them, so the two can never
 * disagree on tax, discounts or proration.
 *
 * Only a Marketplace session reuses the card for other properties (one
 * customer per owner, see api/billing/checkout/route.ts). A Flow B customer is its property's alone,
 * so its text does not say otherwise. Stripe caps the message at 1200
 * characters; this stays well under.
 */
export function checkoutDisclosure(args: {
  interval: BillingInterval;
  trialDays: number;
  marketplace: boolean;
}): string {
  const trial = args.trialDays
    ? ` Your ${args.trialDays}-day free trial becomes a paid subscription unless you cancel before it ends.`
    : "";
  const reuse = args.marketplace ? " and offered for your other properties" : "";
  return (
    `By subscribing you agree to the [MAYA Terms of Service](${TERMS_URL}).${trial} ` +
    `Your subscription renews automatically every ${args.interval} until you cancel. ` +
    `Your card is stored and may be charged for room-count changes${reuse} (Terms 7.6).`
  );
}
