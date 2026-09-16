/**
 * Read-only look at the Customer Portal configurations on whichever Stripe
 * account STRIPE_SECRET_KEY points at.
 *
 * api/billing/portal creates sessions with flow_data (subscription_update, or
 * payment_method_update) and Stripe refuses a flow whose feature is switched
 * off in the portal configuration. Those toggles live in the dashboard
 * (Settings -> Billing -> Customer portal), per mode, and nothing in this repo
 * can set them — so this prints what is actually enabled, and nothing else.
 *
 *   npx tsx scripts/stripe-probe-portal.mts
 *
 * Reads STRIPE_SECRET_KEY from .env.local the way stripe-bootstrap.mts does.
 * Never prints the key. Makes one GET; creates and changes nothing.
 */
import { readFileSync } from "node:fs";
import Stripe from "stripe";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const SK = env.STRIPE_SECRET_KEY;
if (!SK) throw new Error("STRIPE_SECRET_KEY missing from .env.local");

const stripe = new Stripe(SK);
const mode = SK.startsWith("sk_live_") ? "LIVE" : "test/sandbox";

const { data } = await stripe.billingPortal.configurations.list({ limit: 5 });
console.log(`Customer portal configurations (${mode}): ${data.length}`);
for (const c of data) {
  console.log(
    JSON.stringify({
      id: c.id,
      is_default: c.is_default,
      active: c.active,
      subscription_update: c.features.subscription_update?.enabled ?? false,
      payment_method_update: c.features.payment_method_update?.enabled ?? false,
      subscription_cancel: c.features.subscription_cancel?.enabled ?? false,
    }),
  );
}
