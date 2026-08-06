/**
 * Puts a signed-in user back to "never signed up" so the flow can be walked
 * again from the top, and makes sure there's a code to walk it with.
 *
 *   npx tsx scripts/billing-test-reset.mts                 # show current state
 *   npx tsx scripts/billing-test-reset.mts --email you@x --project <ref>
 *   npx tsx scripts/billing-test-reset.mts --email you@x --project <ref> --keep-hotel
 *
 * The Stripe half refuses a live key. The SUPABASE half needs its own guard and
 * did not have one: there is a single Supabase project behind every environment
 * here, so a test key on the Stripe side proved nothing about the database this
 * was about to delete hotels out of. Naming the project on the command line is
 * the whole point — it cannot be satisfied by muscle memory, so the destructive
 * path can't be reached by pressing up-arrow in the wrong terminal.
 */
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const argAfter = (flag: string): string | null => {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const EMAIL = argAfter("--email");
const NAMED_PROJECT = argAfter("--project");
const KEEP_HOTEL = args.includes("--keep-hotel");
const APPLY = Boolean(EMAIL);

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

if (env.STRIPE_SECRET_KEY?.startsWith("sk_live_")) {
  throw new Error("This is a live key. This script cancels subscriptions — sandbox only.");
}

/** Supabase project ref, which is the first label of the project URL host. */
const PROJECT_REF = new URL(env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split(".")[0];

if (APPLY && NAMED_PROJECT !== PROJECT_REF) {
  throw new Error(
    `This deletes hotels, subscriptions and redemptions from Supabase project "${PROJECT_REF}".\n` +
      `Re-run naming it explicitly:\n\n` +
      `  npx tsx scripts/billing-test-reset.mts --email ${EMAIL} --project ${PROJECT_REF}\n`,
  );
}

const stripe = new Stripe(env.STRIPE_SECRET_KEY!);
const f: typeof fetch = (i, o) => fetch(i, { ...o, signal: AbortSignal.timeout(20_000) });
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  global: { fetch: f },
});

/** A standing code to test with, so signup is never blocked for lack of one. */
const TEST_CODE = "MHSFOUNDER";
const { data: existingCode } = await admin
  .from("signup_codes")
  .select("id, code, kind, trial_days, is_active")
  .eq("code", TEST_CODE)
  .maybeSingle();

// Only created on the reset path. Run with no arguments this prints state and
// nothing else — it used to mint an uncapped, never-expiring signup code as a
// side effect of "showing" you the database, which is not something a read
// should ever do to a project holding real codes.
if (APPLY && !existingCode) {
  const { data, error } = await admin
    .from("signup_codes")
    .insert({
      code: TEST_CODE,
      kind: "trial",
      trial_days: 7,
      notes: "Standing code for local testing. Created by billing-test-reset.",
    })
    .select("id, code")
    .single();
  if (error) throw new Error(`could not create ${TEST_CODE}: ${error.message}`);
  console.log(`created code ${data.code} (7-day trial)`);
} else if (existingCode) {
  console.log(`code ${existingCode.code} already exists (${existingCode.kind}, active=${existingCode.is_active})`);
} else {
  console.log(`code ${TEST_CODE} does not exist — it is created on the --email reset path.`);
}

const { data: codes } = await admin
  .from("signup_codes")
  .select("code, kind, trial_days, percent_off, duration_months, fixed_price_cents, max_redemptions, expires_at, is_active");
console.log(`\ncodes available (${codes?.length ?? 0}):`);
for (const c of codes ?? []) {
  const what =
    c.kind === "trial"
      ? `${c.trial_days}d trial`
      : c.kind === "percent_off"
        ? `${c.percent_off}% off${c.duration_months ? ` x${c.duration_months}mo` : " forever"}`
        : `$${((c.fixed_price_cents ?? 0) / 100).toFixed(2)} fixed`;
  console.log(`  ${c.code.padEnd(14)} ${what.padEnd(20)} ${c.is_active ? "" : "(inactive) "}${c.expires_at ? `expires ${c.expires_at.slice(0, 10)}` : ""}`);
}

if (!APPLY) {
  const { data: subs } = await admin
    .from("hotel_subscriptions")
    .select("hotel_id, status, billed_rooms, billing_interval, hotels(name)");
  console.log(`\nsubscriptions (${subs?.length ?? 0}):`);
  for (const s of subs ?? []) {
    const name = (s.hotels as { name?: string } | null)?.name ?? s.hotel_id;
    console.log(`  ${name} — ${s.status}, ${s.billed_rooms} rooms ${s.billing_interval}ly`);
  }
  console.log("\nPass --email <address> to reset that user back to a fresh signup.");
  process.exit(0);
}

/* ── Reset one user ───────────────────────────────────────────────────────── */

const { data: users, error: usersErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 500 });
if (usersErr) throw usersErr;
const user = users.users.find((u) => u.email?.toLowerCase() === EMAIL!.toLowerCase());
if (!user) throw new Error(`no user with email ${EMAIL}`);
console.log(`\nresetting ${user.email} (${user.id})`);

const { data: memberships } = await admin
  .from("hotel_memberships")
  .select("hotel_id, role, hotels(name)")
  .eq("user_id", user.id);
const hotelIds = (memberships ?? []).map((m) => m.hotel_id);
console.log(`  ${hotelIds.length} hotel membership(s)`);

// Stripe first: cancel anything live so a re-run of the flow starts clean.
for (const hotelId of hotelIds) {
  const { data: sub } = await admin
    .from("hotel_subscriptions")
    .select("stripe_subscription_id, stripe_customer_id")
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (sub?.stripe_subscription_id) {
    await stripe.subscriptions.cancel(sub.stripe_subscription_id).catch((e) => {
      console.log(`  (subscription ${sub.stripe_subscription_id} already gone: ${e.message})`);
    });
    console.log(`  cancelled ${sub.stripe_subscription_id}`);
  }
  if (sub?.stripe_customer_id) {
    await stripe.customers.del(sub.stripe_customer_id).catch(() => {});
    console.log(`  deleted customer ${sub.stripe_customer_id}`);
  }
}

if (hotelIds.length) {
  await admin.from("hotel_subscriptions").delete().in("hotel_id", hotelIds);
  await admin.from("signup_code_redemptions").delete().in("hotel_id", hotelIds);
  console.log("  cleared subscription + redemption rows");
}

// The redemption row can also be keyed to the user with no hotel.
await admin.from("signup_code_redemptions").delete().eq("user_id", user.id);

if (KEEP_HOTEL) {
  // Re-enter onboarding without losing the imported history: clearing the
  // completion stamps is what puts the flow back at the start.
  if (hotelIds.length) {
    await admin
      .from("onboarding_states")
      .update({ questions_completed_at: null, review_completed_at: null })
      .in("hotel_id", hotelIds);
    console.log("  cleared onboarding completion stamps (hotel + history kept)");
  }
} else {
  // Full fresh signup: no hotel at all, which is what the flow's first step
  // expects. hotels CASCADE takes memberships, room types, reservations and
  // onboarding state with them.
  for (const m of memberships ?? []) {
    const name = (m.hotels as { name?: string } | null)?.name ?? m.hotel_id;
    await admin.from("hotels").delete().eq("id", m.hotel_id);
    console.log(`  deleted hotel "${name}"`);
  }
  // onboarding_path too, not just the dismissal stamp: resolveOnboardingStep
  // treats EITHER as "they already chose", so leaving the path set skipped the
  // two-button screen on every run after the first.
  await admin
    .from("profiles")
    .update({ onboarding_dismissed_at: null, onboarding_path: null })
    .eq("id", user.id);
}

console.log(`\ndone — sign in as ${user.email} and you'll land at the start of the flow.`);
console.log(`use code ${TEST_CODE} and card 4242 4242 4242 4242.`);
