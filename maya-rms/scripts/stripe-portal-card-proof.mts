/**
 * A35 owner step: prove, on a Stripe test clock, what each billing-portal
 * control does to a subscription's own card.
 *
 * TEST MODE ONLY. Refuses any key that is not sk_test_. Creates its own
 * customers on a test clock, so it never touches a real customer or MAYA's
 * own test properties, and its subscriptions carry no hotel_id, so MAYA's
 * webhook ignores them even if the sandbox sends events to a deployment.
 *
 *   npx tsx scripts/stripe-portal-card-proof.mts setup
 *   npx tsx scripts/stripe-portal-card-proof.mts links   --clock clock_...
 *   npx tsx scripts/stripe-portal-card-proof.mts check   --clock clock_...
 *   npx tsx scripts/stripe-portal-card-proof.mts advance --clock clock_...   (past Stripe's next retry; --days N to move N days instead)
 *   npx tsx scripts/stripe-portal-card-proof.mts cleanup --clock clock_...
 *
 * The whole procedure, and what each result means, is in
 * docs/stripe-portal-card-proof.md. Reads STRIPE_SECRET_KEY from .env.local
 * (or the environment). Never prints the key.
 */
import { existsSync, readFileSync } from "node:fs";
import Stripe from "stripe";
import { MONTHLY_LOOKUP_KEY } from "../src/lib/billing/tiers";
import { PORTAL_CONTROLS, readProof, type PortalControl } from "../src/lib/billing/portal-card-proof";

function secretKey(): string {
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY;
  if (!existsSync(".env.local")) throw new Error("STRIPE_SECRET_KEY is not set and there is no .env.local");
  const env = Object.fromEntries(
    readFileSync(".env.local", "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
  );
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY missing from .env.local");
  return key;
}

const SK = secretKey();
if (!SK.startsWith("sk_test_")) {
  console.error("Refusing to run: this proof is for test mode only, and the key is not a test key (sk_test_).");
  process.exit(1);
}
const stripe = new Stripe(SK);

const [, , command, ...rest] = process.argv;
const arg = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

const CONTROLS: PortalControl[] = ["add_card", "card_flow", "make_default", "single_add_card"];
const NAMES: Record<PortalControl, string> = {
  add_card: "Juniper Lodge (A35 add card)",
  card_flow: "Harbour Inn (A35 card screen)",
  make_default: "Cedar House (A35 make default)",
  single_add_card: "Willow Cottage (A35 one property)",
};
const DAY = 86_400;

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  typeof v === "string" ? v : (v?.id ?? null);

async function waitForClock(clockId: string): Promise<void> {
  for (let i = 0; i < 90; i++) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (clock.status === "ready") return;
    if (clock.status === "internal_failure") throw new Error(`Test clock ${clockId} failed to advance`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Test clock ${clockId} is still advancing after 3 minutes. Run check in a minute.`);
}

async function priceId(): Promise<string> {
  // MAYA's own monthly price when the sandbox has it (stripe-bootstrap.mts),
  // so the portal shows the subscription as an owner would see it.
  const found = await stripe.prices.list({ lookup_keys: [MONTHLY_LOOKUP_KEY], active: true, limit: 1 });
  if (found.data[0]) return found.data[0].id;
  const product = await stripe.products.create({ name: "MAYA A35 portal card proof (test)" });
  const price = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: 550,
    recurring: { interval: "month" },
  });
  return price.id;
}

async function setup(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: now, name: "A35 portal card proof" });
  const price = await priceId();
  const trialEnd = now + DAY;

  for (const control of CONTROLS) {
    // No default card on the customer: that is what MAYA's checkout leaves.
    const customer = await stripe.customers.create({
      name: NAMES[control],
      email: `a35-${control.replaceAll("_", "-")}@example.com`,
      test_clock: clock.id,
      metadata: { a35_proof_control: control },
    });
    // Attaches fine, then every charge on it fails: the card that dies.
    const failing = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", { customer: customer.id });
    // A good card a second property sits on by choice.
    const ownCard = await stripe.paymentMethods.attach("pm_card_mastercard", { customer: customer.id });
    const spare =
      control === "make_default"
        ? await stripe.paymentMethods.attach("pm_card_amex", { customer: customer.id })
        : null;
    await stripe.customers.update(customer.id, {
      metadata: {
        a35_proof_control: control,
        a35_failing_card: failing.id,
        a35_own_card: ownCard.id,
        ...(spare ? { a35_spare_card: spare.id } : {}),
      },
    });

    // On a one-day trial, each with its own card, as checkout makes them. The
    // one-property customer has only the overdue one.
    await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price, quantity: 10 }],
      default_payment_method: failing.id,
      trial_end: trialEnd,
      metadata: { a35_proof: "overdue" },
    });
    if (PORTAL_CONTROLS[control].group) {
      await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price, quantity: 10 }],
        default_payment_method: ownCard.id,
        trial_end: trialEnd,
        metadata: { a35_proof: "own_card" },
      });
    }
  }

  // Past the trial end and past the hour Stripe holds a renewal invoice as a
  // draft, so the charge on the failing card has been tried and refused.
  await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: trialEnd + 3 * 3600 });
  await waitForClock(clock.id);

  console.log(`Test clock: ${clock.id}`);
  console.log("Next: run check to see the starting point, then links.");
  await check(clock.id);
}

async function proofCustomers(clockId: string): Promise<Stripe.Customer[]> {
  const list = await stripe.customers.list({ test_clock: clockId, limit: 10 });
  return list.data.filter((c) => c.metadata?.a35_proof_control);
}

async function links(clockId: string): Promise<void> {
  for (const customer of await proofCustomers(clockId)) {
    const control = customer.metadata.a35_proof_control as PortalControl;
    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: "https://example.com/a35-proof-done",
      ...(control === "card_flow" ? { flow_data: { type: "payment_method_update" as const } } : {}),
    });
    console.log(`\n${PORTAL_CONTROLS[control].label}  (${customer.name})`);
    console.log(PORTAL_CONTROLS[control].howTo);
    if (control === "make_default" && customer.metadata.a35_spare_card) {
      const spare = await stripe.paymentMethods.retrieve(customer.metadata.a35_spare_card);
      console.log(`The spare card is the ${spare.card?.brand} ending ${spare.card?.last4}.`);
    }
    console.log(session.url);
  }
  console.log("\nEach link stops working after about 5 minutes unused. Run links again for fresh ones.");
}

/** The overdue invoice's retry state, and the card its latest attempt was on. */
async function attemptLine(inv: Stripe.Invoice, label: (pm: string | null) => string): Promise<string> {
  const next = inv.next_payment_attempt ? new Date(inv.next_payment_attempt * 1000).toISOString() : "none scheduled";
  let tried = "unknown";
  try {
    const payments = await stripe.invoicePayments.list({ invoice: inv.id, limit: 1, expand: ["data.payment.payment_intent"] });
    const pi = payments.data[0]?.payment.payment_intent;
    if (pi && typeof pi === "object") {
      tried = label(idOf(pi.last_payment_error?.payment_method ?? pi.payment_method ?? null));
    }
  } catch (e) {
    tried = `could not read (${e instanceof Error ? e.message : String(e)})`;
  }
  return `attempts ${inv.attempt_count}, next retry ${next}, latest attempt on ${tried}`;
}

/** The overdue invoices' next retries, so advance can move just past them. */
async function nextRetries(clockId: string): Promise<number[]> {
  const out: number[] = [];
  for (const customer of await proofCustomers(clockId)) {
    const subs = await stripe.subscriptions.list({ customer: customer.id, status: "all", limit: 10 });
    const overdue = subs.data.find((s) => s.metadata?.a35_proof === "overdue");
    if (!overdue) continue;
    const latest = (await stripe.invoices.list({ subscription: overdue.id, limit: 1 })).data[0];
    if (latest?.status === "open" && latest.next_payment_attempt) out.push(latest.next_payment_attempt);
  }
  return out;
}

async function check(clockId: string): Promise<void> {
  const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
  console.log(`Clock time: ${new Date(clock.frozen_time * 1000).toISOString()} (${clock.status})`);
  for (const customer of await proofCustomers(clockId)) {
    const control = customer.metadata.a35_proof_control as PortalControl;
    const group = PORTAL_CONTROLS[control].group;
    const fresh = (await stripe.customers.retrieve(customer.id)) as Stripe.Customer;
    const def = idOf(fresh.invoice_settings?.default_payment_method ?? null);
    const subs = await stripe.subscriptions.list({ customer: customer.id, status: "all", limit: 10 });
    const overdue = subs.data.find((s) => s.metadata?.a35_proof === "overdue");
    const own = subs.data.find((s) => s.metadata?.a35_proof === "own_card");
    if (!overdue || (group && !own)) {
      console.log(`\n${customer.name}: subscriptions missing. Run setup again.`);
      continue;
    }
    const label = (pm: string | null): string =>
      !pm
        ? "none (follows the default)"
        : pm === customer.metadata.a35_failing_card
          ? "the failing card"
          : pm === customer.metadata.a35_own_card
            ? "its own Mastercard"
            : pm === customer.metadata.a35_spare_card
              ? "the spare card"
              : pm === def
                ? "the new default card"
                : `another card (${pm})`;

    const latest = (await stripe.invoices.list({ subscription: overdue.id, limit: 1 })).data[0];
    const overdueInvoice: "paid" | "open" | "other" | "none" = !latest
      ? "none"
      : latest.status === "paid"
        ? "paid"
        : latest.status === "open"
          ? "open"
          : "other";

    console.log(`\n${PORTAL_CONTROLS[control].label}  (${customer.name})`);
    console.log(`  Customer default card: ${def ? label(def) : "none"}`);
    console.log(
      `  Overdue subscription: ${overdue.status}, own card: ${label(idOf(overdue.default_payment_method))}, latest invoice: ${overdueInvoice}`,
    );
    if (latest && latest.status === "open") console.log(`  Overdue invoice: ${await attemptLine(latest, label)}`);
    if (own) console.log(`  Subscription on its own card: ${own.status}, own card: ${label(idOf(own.default_payment_method))}`);

    if (!def) {
      console.log("  Not done yet: no default card. Do this control's step from links, then run check again.");
      continue;
    }
    const verdict = readProof({
      control,
      defaultCard: def,
      overdue: { before: customer.metadata.a35_failing_card, after: idOf(overdue.default_payment_method) },
      ownCard: own ? { before: customer.metadata.a35_own_card, after: idOf(own.default_payment_method) } : null,
      overdueInvoice,
    });
    console.log(`  Finding: ${verdict.finding}`);
    if (verdict.maya) console.log(`  What MAYA would do: ${verdict.maya}`);
    console.log(`  ${verdict.changeNeeded ? "CHANGE NEEDED" : "No change needed"}: ${verdict.action}`);
  }
}

/**
 * Move the clock just past the overdue invoices' next scheduled retry, so the
 * next check shows what that retry did. With --days, move that many days
 * instead. Smart Retries, or a custom schedule, can put the first retry days
 * out, so a fixed number of days may land before any retry at all.
 */
async function advance(clockId: string, days: number | null): Promise<void> {
  const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
  let to: number;
  if (days != null) {
    to = clock.frozen_time + Math.round(days * DAY);
  } else {
    const retries = await nextRetries(clockId);
    if (retries.length === 0) {
      console.log("No open overdue invoice has a retry scheduled. Run advance --days N to move the clock anyway.");
      return;
    }
    // An hour past the last of them, so every scheduled retry has run.
    to = Math.max(...retries) + 3600;
    console.log(`Moving the clock to ${new Date(to * 1000).toISOString()}, an hour past the next scheduled retry.`);
  }
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: to });
  await waitForClock(clockId);
  await check(clockId);
}

async function cleanup(clockId: string): Promise<void> {
  // Deleting a test clock deletes its customers and their subscriptions. It
  // only exists in test mode, so nothing real can go with it.
  await stripe.testHelpers.testClocks.del(clockId);
  console.log(`Deleted test clock ${clockId} and everything on it.`);
}

const clockId = arg("clock");
const needClock = (): string => {
  if (!clockId || !clockId.startsWith("clock_")) {
    console.error("Pass --clock clock_... (setup printed it).");
    process.exit(1);
  }
  return clockId;
};

switch (command) {
  case "setup":
    await setup();
    break;
  case "links":
    await links(needClock());
    break;
  case "check":
    await check(needClock());
    break;
  case "advance":
    await advance(needClock(), arg("days") != null ? Number(arg("days")) : null);
    break;
  case "cleanup":
    await cleanup(needClock());
    break;
  default:
    console.error("Usage: setup | links --clock ID | check --clock ID | advance --clock ID [--days N] | cleanup --clock ID");
    process.exit(1);
}
