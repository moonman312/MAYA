/**
 * Creates (or re-points) MAYA's Stripe product and prices.
 *
 * Idempotent and safe to re-run: prices are found by `lookup_key`, never by a
 * hardcoded id, so the app resolves them the same way in sandbox and in live
 * and nothing needs copying between environments. A Stripe price is immutable —
 * changing the tiers means creating a new price and moving the lookup_key onto
 * it, which this does, leaving the old one archived and existing subscriptions
 * on it untouched until they are explicitly migrated.
 *
 *   npx tsx scripts/stripe-bootstrap.mts          # report what exists
 *   npx tsx scripts/stripe-bootstrap.mts --apply  # create/update
 *
 * Reads STRIPE_SECRET_KEY from .env.local. Whether it hits sandbox or live is
 * decided entirely by which key that is.
 */
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const SK = env.STRIPE_SECRET_KEY;
if (!SK) throw new Error("STRIPE_SECRET_KEY missing from .env.local");
const LIVE = SK.startsWith("sk_live_");

export const MONTHLY_LOOKUP_KEY = "maya_rooms_monthly_v1";
export const ANNUAL_LOOKUP_KEY = "maya_rooms_annual_v1";

/**
 * Per-room cents by bracket. `volume` tiers_mode bills the WHOLE quantity at
 * the bracket its count lands in — Jake's step function, boundary inversions
 * included (a 21-room property pays less in total than a 20-room one, and that
 * is the intended, signed-off behaviour; do not "fix" it into graduated).
 */
const MONTHLY_TIERS = [
  { upTo: "20", cents: 550 },
  { upTo: "40", cents: 500 },
  { upTo: "60", cents: 400 },
  { upTo: "80", cents: 300 },
  { upTo: "inf", cents: 250 },
] as const;

/**
 * Annual = 12x monthly, less 10% for every bracket above the first. The
 * smallest properties get no discount — annual is offered to them purely as
 * "pay once a year", and the UI must not imply a saving they aren't getting.
 * The discount boundary is deliberately the 20/21 bracket edge rather than a
 * literal "over 21 rooms", so one number decides both price and discount.
 */
const ANNUAL_TIERS = MONTHLY_TIERS.map((t, i) => ({
  upTo: t.upTo,
  cents: i === 0 ? t.cents * 12 : Math.round(t.cents * 12 * 0.9),
}));

async function stripe(path: string, body?: Record<string, string>, method?: string) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      Authorization: `Basic ${Buffer.from(`${SK}:`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    ...(body ? { body: new URLSearchParams(body).toString() } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json()) as Record<string, never> & { error?: { message: string } };
  if (json.error) throw new Error(`${path}: ${json.error.message}`);
  return json as Record<string, never>;
}

function tierParams(tiers: readonly { upTo: string; cents: number }[]) {
  const p: Record<string, string> = {};
  tiers.forEach((t, i) => {
    p[`tiers[${i}][up_to]`] = t.upTo;
    p[`tiers[${i}][unit_amount]`] = String(t.cents);
  });
  return p;
}

/** Same tiers in the same order at the same amounts — nothing to re-create. */
function tiersMatch(existing: unknown, want: readonly { upTo: string; cents: number }[]): boolean {
  const got = (existing ?? []) as { up_to: number | null; unit_amount: number }[];
  if (got.length !== want.length) return false;
  return want.every((w, i) => {
    const upToMatches = w.upTo === "inf" ? got[i].up_to === null : got[i].up_to === Number(w.upTo);
    return upToMatches && got[i].unit_amount === w.cents;
  });
}

async function findByLookupKey(key: string) {
  const list = await stripe(`prices?lookup_keys[]=${encodeURIComponent(key)}&expand[]=data.tiers&limit=1`);
  return ((list as unknown as { data: Record<string, never>[] }).data ?? [])[0];
}

async function ensureProduct(): Promise<string> {
  const found = await stripe("products?limit=100&active=true");
  const existing = ((found as unknown as { data: { id: string; metadata?: Record<string, string> }[] }).data ?? []).find(
    (p) => p.metadata?.maya === "rooms",
  );
  if (existing) return existing.id;
  if (!APPLY) return "(would create)";
  const created = await stripe("products", {
    name: "MAYA",
    description: "Machine Assisted Yield Automation",
    "metadata[maya]": "rooms",
  });
  return (created as unknown as { id: string }).id;
}

async function ensurePrice(
  productId: string,
  lookupKey: string,
  interval: "month" | "year",
  tiers: readonly { upTo: string; cents: number }[],
) {
  const existing = await findByLookupKey(lookupKey);
  if (existing) {
    const e = existing as unknown as { id: string; tiers?: unknown; recurring?: { interval: string } };
    if (e.recurring?.interval === interval && tiersMatch(e.tiers, tiers)) {
      console.log(`  ${lookupKey}: up to date (${e.id})`);
      return e.id;
    }
    console.log(`  ${lookupKey}: tiers changed — needs a new price (current ${e.id})`);
    if (!APPLY) return e.id;
    // Free the key first; Stripe allows one active price per lookup_key.
    await stripe(`prices/${e.id}`, { "lookup_key": "", active: "false" });
  } else {
    console.log(`  ${lookupKey}: missing`);
    if (!APPLY) return "(would create)";
  }
  const created = await stripe("prices", {
    product: productId,
    currency: "usd",
    "recurring[interval]": interval,
    billing_scheme: "tiered",
    tiers_mode: "volume",
    lookup_key: lookupKey,
    transfer_lookup_key: "true",
    ...tierParams(tiers),
  });
  const id = (created as unknown as { id: string }).id;
  console.log(`  ${lookupKey}: created ${id}`);
  return id;
}

const acct = (await stripe("account")) as unknown as { id: string };
console.log(`Stripe account ${acct.id} — ${LIVE ? "LIVE MODE" : "sandbox"}`);
if (LIVE && !APPLY) console.log("(dry run; pass --apply to write)");
if (LIVE && APPLY) console.log("!! writing to LIVE mode !!");

const productId = await ensureProduct();
console.log(`product: ${productId}`);
const monthly = await ensurePrice(productId, MONTHLY_LOOKUP_KEY, "month", MONTHLY_TIERS);
const annual = await ensurePrice(productId, ANNUAL_LOOKUP_KEY, "year", ANNUAL_TIERS);

if (!APPLY) {
  console.log("\nDry run — nothing written. Re-run with --apply.");
} else {
  console.log(`\nmonthly=${monthly}\nannual=${annual}`);
  console.log("Resolve these in app code by lookup_key, not by id.");
}
