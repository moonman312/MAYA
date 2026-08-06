/**
 * Server-only Stripe access.
 *
 * The secret key must never reach a client bundle — nothing here may be
 * imported from a "use client" module. Prices are resolved by lookup_key rather
 * than by id so the same code runs against sandbox and live with no per-
 * environment configuration; whichever key is in the environment decides which
 * one it talks to.
 */

import Stripe from "stripe";
import { ANNUAL_LOOKUP_KEY, MONTHLY_LOOKUP_KEY, type BillingInterval } from "./tiers";

let cached: Stripe | null = null;

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function stripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  if (!cached) cached = new Stripe(key);
  return cached;
}

/**
 * Price id for a billing interval, cached briefly.
 *
 * A missing lookup_key means the bootstrap script has not been run against this
 * Stripe account — throwing names that explicitly, because the alternative
 * (falling back to some other price) would charge the wrong amount.
 *
 * The cache expires rather than living for the process: a reprice moves the
 * lookup_key onto a NEW price and archives the old one, and a warm instance
 * still holding the archived id would fail every checkout it serves until it
 * happened to recycle — while cold instances succeed, which reads as a flake
 * instead of a rotation.
 */
const PRICE_ID_TTL_MS = 5 * 60 * 1000;
const priceIdCache = new Map<BillingInterval, { id: string; at: number }>();

export async function priceIdFor(interval: BillingInterval): Promise<string> {
  const hit = priceIdCache.get(interval);
  if (hit && Date.now() - hit.at < PRICE_ID_TTL_MS) return hit.id;

  const lookupKey = interval === "month" ? MONTHLY_LOOKUP_KEY : ANNUAL_LOOKUP_KEY;
  const found = await stripeClient().prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  const price = found.data[0];
  if (!price) {
    throw new Error(
      `No active Stripe price with lookup_key "${lookupKey}". Run scripts/stripe-bootstrap.mts --apply against this account.`,
    );
  }
  priceIdCache.set(interval, { id: price.id, at: Date.now() });
  return price.id;
}
