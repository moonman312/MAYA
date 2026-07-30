/**
 * The card check, run twice: once at signup and again 48 hours later.
 *
 * Checkout won't complete on a card the issuer refuses, so the signup check is
 * partly a belt to Stripe's braces — but only partly. It also catches a card
 * removed or swapped in the minutes after checkout, and it is the run that
 * proves this whole path works before anything depends on it. The 48-hour one is
 * the one that earns its keep: the failure mode Jake is guarding against is a
 * virtual card cancelled the moment the trial starts, which nothing at signup
 * can see.
 *
 * The check is a confirmed SetupIntent against the card already on file. The two
 * obvious alternatives were both wrong:
 *
 * - Retrieving the PaymentMethod and inspecting it detects nothing. A cancelled
 *   virtual card is unchanged in Stripe's records — same brand, last4 and expiry
 *   — because Stripe holds a token and never polls the issuer. It would pass
 *   every local check and decline every real charge.
 *
 * - An authorization detects it, at a price we won't pay. A PaymentIntent can't
 *   be for zero (Stripe's floor is $0.50), so it means a real hold on a real
 *   card; even cancelled immediately, how long the pending line sits on the
 *   statement is the issuer's decision, and on some banks that's days. A mystery
 *   charge two days into "we won't charge you until the trial ends" costs more in
 *   chargebacks and cancellations than the fraud it catches.
 *
 * The SetupIntent is a real round trip to the issuer — setting up a card is where
 * Stripe says it "may be necessary to authenticate the customer or check the
 * card's validity with the customer's bank" — that moves no money and creates no
 * charge. The caveat, stated plainly: a zero-amount validity check is a strong
 * signal, not a guarantee. An issuer can approve an account-status inquiry on a
 * card it would decline for a purchase, so a card can pass here and still fail
 * the first invoice. That residual case is already handled — dunning, past_due,
 * isEntitled — while a phantom charge on day two is handled by nothing.
 *
 * A verdict here NEVER changes entitlement. isEntitled() in sync.ts is the only
 * rule about that, and a failed re-check is a signal for a human to act on, not
 * a switch that turns MAYA off.
 */

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CARD_REVERIFY_AFTER_HOURS } from "./sync";

/** Subscriptions examined per invocation. Bounded so the route can't run long. */
export const REVERIFY_BATCH_SIZE = 25;

/** How long an inconclusive check waits before it is tried again. */
export const REVERIFY_RETRY_AFTER_HOURS = 6;

/**
 * Attempts before an inconclusive check is recorded as a failure. Without a
 * ceiling a card stuck on "the issuer wants the cardholder" would be re-checked
 * forever and nobody would ever be told.
 */
export const REVERIFY_MAX_ATTEMPTS = 4;

/** Nothing to re-check: these never bill again. */
const TERMINAL_STATUSES = new Set(["canceled", "incomplete_expired"]);

export type DueSubscription = {
  hotel_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  card_verify_due_at: string | null;
  card_verify_attempts: number | null;
  /** Set once the signup-time check passed. Null means this sweep IS that check. */
  card_verified_at: string | null;
  /** When we first recorded the subscription — what the 48 hours counts from. */
  created_at: string | null;
};

export type ReverifyOutcome =
  /** The issuer accepted it. */
  | { kind: "verified" }
  /** The card is gone or the issuer refused it. Surface this. */
  | { kind: "failed"; code: string }
  /** We could not tell. Try again later; do not alarm anyone yet. */
  | { kind: "inconclusive"; code: string }
  /** There is no longer a card worth checking. */
  | { kind: "moot"; code: string };

const SELECT_COLUMNS =
  "hotel_id, stripe_customer_id, stripe_subscription_id, card_verify_due_at, card_verify_attempts, card_verified_at, created_at";

/**
 * Subscriptions whose re-check has come due and has no verdict yet. Matches
 * idx_hotel_subscriptions_card_due; oldest first so a backlog drains in order
 * across invocations instead of starving the ones that waited longest.
 */
export async function dueSubscriptions(
  admin: SupabaseClient,
  now: Date,
  limit = REVERIFY_BATCH_SIZE,
): Promise<{ rows: DueSubscription[]; error?: string }> {
  const { data, error } = await admin
    .from("hotel_subscriptions")
    .select(SELECT_COLUMNS)
    .lte("card_verify_due_at", now.toISOString())
    // card_rechecked_at, not card_verified_at: the signup check is not terminal.
    // A row that passed it still owes its 48-hour recheck, and keying on
    // verified_at would have taken it out of the sweep after the first stage.
    .is("card_rechecked_at", null)
    .is("card_verify_failed_at", null)
    .order("card_verify_due_at", { ascending: true })
    .limit(limit);

  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as DueSubscription[] };
}

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  typeof v === "string" ? v : (v?.id ?? null);

type StripeErrorish = {
  type?: string;
  code?: string;
  decline_code?: string;
  statusCode?: number;
  message?: string;
};

/** The most specific thing Stripe told us about a failure. */
function codeOf(err: StripeErrorish): string {
  return err.decline_code || err.code || err.type || "stripe_error";
}

/**
 * Checks one hotel's saved card.
 *
 * Reads the subscription from Stripe rather than trusting our copy, for the same
 * reason the webhook does (see sync.ts): our row can be a delivery behind, and
 * re-checking the card of a subscription that was cancelled an hour ago would
 * raise an alarm about a customer who has already left.
 */
export async function verifySavedCard(
  stripe: Stripe,
  row: DueSubscription,
): Promise<ReverifyOutcome> {
  if (!row.stripe_subscription_id) return { kind: "moot", code: "no_subscription" };

  let sub: Stripe.Subscription;
  try {
    sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id, { expand: ["customer"] });
  } catch (e) {
    const err = e as StripeErrorish;
    // A 404 is deliberately NOT treated as "nothing to check". Live subscriptions
    // can't be deleted, only cancelled — and a cancelled one still reads fine — so
    // in production this almost always means the key points at the wrong Stripe
    // account. Retiring the row on that would silently drop every hotel's check.
    if (err.statusCode === 404) return { kind: "inconclusive", code: "subscription_missing" };
    return { kind: "inconclusive", code: codeOf(err) };
  }

  if (TERMINAL_STATUSES.has(sub.status)) {
    return { kind: "moot", code: `subscription_${sub.status}` };
  }

  const customerId = idOf(sub.customer as string | { id: string } | null);
  if (!customerId) return { kind: "moot", code: "no_customer" };

  const customer = typeof sub.customer === "object" ? sub.customer : null;
  if (customer?.deleted) return { kind: "moot", code: "customer_deleted" };

  // Stripe's own precedence for which card an invoice will use: the
  // subscription's, then the customer's invoice default, then default_source.
  // Our checkout only ever produces the first, but a customer set up by hand in
  // the dashboard can carry a legacy card object and it verifies the same way.
  const paymentMethodId =
    idOf(sub.default_payment_method) ??
    (customer ? idOf(customer.invoice_settings?.default_payment_method) : null) ??
    (customer ? idOf(customer.default_source) : null);

  // Checkout collected a card even on a trial (payment_method_collection:
  // always), so an empty slot here means it was removed afterwards — exactly the
  // thing worth telling someone about, and worth knowing without a round trip.
  if (!paymentMethodId) return { kind: "failed", code: "no_payment_method" };

  try {
    const intent = await stripe.setupIntents.create(
      {
        customer: customerId,
        payment_method: paymentMethodId,
        // The card is already saved; this confirmation exists purely to ask the
        // issuer whether it would still honour it.
        usage: "off_session",
        confirm: true,
        // Never actually followed — nobody is at a browser during a cron sweep.
        // It is here because Stripe rejects the confirm outright when a card's
        // next action would be a redirect, and that InvalidRequestError would
        // otherwise burn all four attempts and stamp a good card failed.
        return_url: "https://maya.invalid/card-reverify",
        metadata: { maya_purpose: "card_reverify", hotel_id: row.hotel_id },
      },
      // A retried sweep — overlapping cron runs, a network retry — must re-use
      // the same intent rather than send a second inquiry to the issuer.
      { idempotencyKey: reverifyIdempotencyKey(row) },
    );

    if (intent.status === "succeeded") return { kind: "verified" };

    // requires_action off-session means the issuer wants the cardholder present.
    // That is a card we cannot silently confirm, not a card we know is dead.
    if (intent.status === "requires_action") {
      return { kind: "inconclusive", code: "authentication_required" };
    }
    if (intent.status === "processing") return { kind: "inconclusive", code: "processing" };

    const err = (intent.last_setup_error ?? {}) as StripeErrorish;
    return { kind: "failed", code: intent.last_setup_error ? codeOf(err) : intent.status };
  } catch (e) {
    const err = e as StripeErrorish;
    // Stripe reports "needs the cardholder present" two different ways — as a
    // requires_action STATUS (handled above) or as an authentication_required
    // DECLINE raised from here. Same fact either way, so it has to reach the
    // same verdict: a European card that authenticated interactively at
    // checkout will bill fine off that mandate, and stamping it failed at 48h
    // would tell the owner their good card had died.
    if (codeOf(err) === "authentication_required") {
      return { kind: "inconclusive", code: "authentication_required" };
    }
    // A decline is the answer we came for.
    if (err.type === "StripeCardError" || err.type === "card_error") {
      return { kind: "failed", code: codeOf(err) };
    }
    // The saved card was deleted out from under us.
    if (err.code === "resource_missing") return { kind: "failed", code: "payment_method_missing" };
    // Rate limits, Stripe outages, and our own bad requests all land here. None
    // of them says anything about the card, so none of them may accuse it.
    return { kind: "inconclusive", code: codeOf(err) };
  }
}

/**
 * Keyed on the attempt, not on time: a re-run of the same attempt must reuse the
 * intent, while a deliberate retry hours later must be allowed to ask again.
 *
 * The STAGE is in the key too, and has to be. The recheck deliberately resets
 * card_verify_attempts to zero so it gets its own retry budget, which meant both
 * stages sent the identical key — so Stripe replayed the signup check's cached
 * "succeeded" instead of asking the issuer, and the 48-hour check silently never
 * asked anyone anything. Exactly the card it exists to catch.
 */
function reverifyIdempotencyKey(row: DueSubscription): string {
  const stage = row.card_verified_at ? "recheck" : "signup";
  return `maya_card_reverify_${row.stripe_subscription_id}_${stage}_${row.card_verify_attempts ?? 0}`;
}

/** What a verdict does to the row, before the write. */
export function patchFor(
  outcome: ReverifyOutcome,
  row: DueSubscription,
  now: Date,
): Record<string, unknown> {
  const attempts = (row.card_verify_attempts ?? 0) + 1;
  const at = now.toISOString();

  if (outcome.kind === "verified") {
    // Two stages, and which one just passed is the difference between "come back
    // in 48 hours" and "done". Anchored on created_at rather than now() so the
    // recheck lands 48h after SIGNUP — a slow first sweep must not push the
    // deadline out, which is the window a cancelled virtual card lives in.
    if (!row.card_verified_at) {
      const signup = row.created_at ? Date.parse(row.created_at) : now.getTime();
      return {
        card_verified_at: at,
        card_verify_due_at: new Date(signup + CARD_REVERIFY_AFTER_HOURS * 3600_000).toISOString(),
        card_verify_failed_at: null,
        card_verify_last_code: null,
        // The recheck gets its own retry budget; the signup check's inconclusive
        // attempts should not eat into it.
        card_verify_attempts: 0,
      };
    }
    return {
      card_rechecked_at: at,
      card_verify_due_at: null,
      card_verify_failed_at: null,
      card_verify_last_code: null,
      card_verify_attempts: attempts,
    };
  }
  if (outcome.kind === "failed") {
    return { card_verify_failed_at: at, card_verify_last_code: outcome.code, card_verify_attempts: attempts };
  }
  if (outcome.kind === "moot") {
    // No verdict to record, so nulling the due date is what takes it out of the
    // sweep. Stamping verified_at would be a lie and failed_at a false alarm.
    return { card_verify_due_at: null, card_verify_last_code: outcome.code, card_verify_attempts: attempts };
  }
  // A settled row never comes back here. If the hotel subscribes again,
  // trg_hotel_subscriptions_reset_card_verify clears the stamps so the new card
  // gets its own 48 hours (99_supabase_migration_card_reverify_v1.sql).

  // Inconclusive: try again, until trying again stops being useful.
  if (attempts >= REVERIFY_MAX_ATTEMPTS) {
    return { card_verify_failed_at: at, card_verify_last_code: outcome.code, card_verify_attempts: attempts };
  }
  return {
    card_verify_due_at: new Date(now.getTime() + REVERIFY_RETRY_AFTER_HOURS * 3600_000).toISOString(),
    card_verify_last_code: outcome.code,
    card_verify_attempts: attempts,
  };
}

/**
 * Writes the verdict. Guarded on the row still having none: two overlapping
 * sweeps, or a sweep racing a manual re-check, must not overwrite a settled
 * result with a staler one.
 */
export async function recordOutcome(
  admin: SupabaseClient,
  row: DueSubscription,
  outcome: ReverifyOutcome,
  now: Date,
): Promise<{ ok: boolean; error?: string }> {
  // Which stamp means "already settled" depends on the stage. A recheck by
  // definition has card_verified_at set, so guarding every write on that column
  // would reject every stage-two verdict and leave the row due forever.
  const settled = row.card_verified_at ? "card_rechecked_at" : "card_verified_at";

  let q = admin
    .from("hotel_subscriptions")
    .update(patchFor(outcome, row, now))
    .eq("hotel_id", row.hotel_id)
    .is(settled, null)
    .is("card_verify_failed_at", null);

  // Stage two also pins the stage-one stamp it read. If the hotel re-subscribed
  // between the read and the write, the reset trigger cleared that stamp — and
  // stamping card_rechecked_at on top would retire the row for good without the
  // new card ever being checked.
  if (row.card_verified_at) q = q.eq("card_verified_at", row.card_verified_at);

  const { error } = await q;

  if (error) {
    console.error(
      JSON.stringify({ fn: "recordOutcome", hotel: row.hotel_id, outcome: outcome.kind, error: error.message }),
    );
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export type SweepResult = {
  examined: number;
  verified: number;
  failed: number;
  deferred: number;
  moot: number;
  errors: string[];
};

/**
 * One pass of the sweep.
 *
 * Sequential on purpose: a batch is small, each hotel costs two Stripe calls,
 * and firing them all at once buys nothing but rate-limit errors that would be
 * recorded as inconclusive checks.
 */
export async function sweepCardReverification(opts: {
  admin: SupabaseClient;
  stripe: Stripe;
  now?: Date;
  limit?: number;
}): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const result: SweepResult = { examined: 0, verified: 0, failed: 0, deferred: 0, moot: 0, errors: [] };

  const { rows, error } = await dueSubscriptions(opts.admin, now, opts.limit ?? REVERIFY_BATCH_SIZE);
  if (error) {
    // The one failure that kills the whole feature, and the one nothing would
    // otherwise notice: the route still answers 200 and pg_cron discards the
    // body, so a deploy-before-migrate (or a bad service key) would look
    // exactly like "nothing was due" forever.
    console.error(JSON.stringify({ fn: "sweepCardReverification", step: "due_query", error }));
    result.errors.push(error);
    return result;
  }

  for (const row of rows) {
    result.examined += 1;
    const outcome = await verifySavedCard(opts.stripe, row);

    if (outcome.kind === "verified") result.verified += 1;
    else if (outcome.kind === "failed") result.failed += 1;
    else if (outcome.kind === "moot") result.moot += 1;
    else result.deferred += 1;

    // A failed card is the whole reason this runs; it goes in the log whether or
    // not anything has been built yet to show it to the owner.
    if (outcome.kind !== "verified") {
      console.error(
        JSON.stringify({
          fn: "cardReverify",
          hotel: row.hotel_id,
          sub: row.stripe_subscription_id,
          outcome: outcome.kind,
          code: outcome.code,
        }),
      );
    }

    const saved = await recordOutcome(opts.admin, row, outcome, now);
    if (!saved.ok && saved.error) result.errors.push(saved.error);
  }

  return result;
}
