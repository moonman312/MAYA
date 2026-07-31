/**
 * Regression tests for the 48-hour card re-check.
 *
 * The two things that must never drift: the sweep never creates a charge or an
 * authorization (a pending line on a new customer's statement is worse than the
 * problem it would detect), and it never touches subscription status — a card we
 * cannot confirm is a signal for a human, not a switch that turns MAYA off.
 *
 * The fake Stripe therefore throws on paymentIntents.create rather than
 * recording it, so a future "just put a $1 hold on it" fails the suite instead
 * of shipping. Everything else is a small in-memory Supabase.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  clearCardAlarmAfterPayment,
  patchFor,
  recordOutcome,
  REVERIFY_MAX_ATTEMPTS,
  REVERIFY_RETRY_AFTER_HOURS,
  sweepCardReverification,
  verifySavedCard,
  type DueSubscription,
} from "./reverify";

const NOW = new Date("2026-07-31T12:00:00Z");
const DUE = "2026-07-31T10:00:00Z";
/** When the subscription was recorded — what the 48 hours counts from. */
const SIGNUP = "2026-07-29T12:00:00Z";

type Row = Record<string, unknown>;

function fakeAdmin(seed: Row[] = []) {
  const rows = seed.map((r) => ({ ...r }));
  const state = { selectError: null as string | null, updateError: null as string | null };

  function builder() {
    const preds: ((r: Row) => boolean)[] = [];
    let patch: Row | null = null;
    let cap = Infinity;
    let sortBy: string | null = null;

    const api = {
      select() {
        return api;
      },
      lte(col: string, val: unknown) {
        preds.push((r) => r[col] != null && String(r[col]) <= String(val));
        return api;
      },
      is(col: string, val: unknown) {
        preds.push((r) => (r[col] ?? null) === val);
        return api;
      },
      eq(col: string, val: unknown) {
        preds.push((r) => r[col] === val);
        return api;
      },
      order(col: string) {
        sortBy = col;
        return api;
      },
      limit(n: number) {
        cap = n;
        return api;
      },
      update(p: Row) {
        patch = p;
        return api;
      },
      then(resolve: (v: { data: unknown; error: { message: string } | null }) => void) {
        return run().then(resolve);
      },
    };

    async function run() {
      const matched = rows.filter((r) => preds.every((p) => p(r)));
      if (patch) {
        if (state.updateError) return { data: null, error: { message: state.updateError } };
        for (const r of matched) Object.assign(r, patch);
        return { data: matched, error: null };
      }
      if (state.selectError) return { data: null, error: { message: state.selectError } };
      const sorted = sortBy
        ? [...matched].sort((a, b) => String(a[sortBy!]).localeCompare(String(b[sortBy!])))
        : matched;
      return { data: sorted.slice(0, cap), error: null };
    }

    return api;
  }

  return {
    admin: { from: () => builder() } as unknown as SupabaseClient,
    rows,
    state,
  };
}

type StripeOpts = {
  subscription?: Row | null;
  retrieveError?: unknown;
  intent?: Row;
  createError?: unknown;
};

function fakeStripe(opts: StripeOpts = {}) {
  const calls = { retrieves: [] as string[], creates: [] as { params: Row; options?: Row }[] };
  const stripe = {
    subscriptions: {
      retrieve: async (id: string) => {
        calls.retrieves.push(id);
        if (opts.retrieveError) throw opts.retrieveError;
        return (
          opts.subscription ?? {
            id,
            status: "trialing",
            customer: { id: "cus_1", invoice_settings: { default_payment_method: null } },
            default_payment_method: "pm_1",
          }
        );
      },
    },
    setupIntents: {
      create: async (params: Row, options?: Row) => {
        calls.creates.push({ params, options });
        if (opts.createError) throw opts.createError;
        return opts.intent ?? { id: "seti_1", status: "succeeded", last_setup_error: null };
      },
    },
    paymentIntents: {
      create: async () => {
        throw new Error("the re-check must never authorize or charge the card");
      },
    },
  };
  return { stripe: stripe as unknown as Stripe, calls };
}

function row(o: Partial<DueSubscription> = {}): DueSubscription {
  return {
    hotel_id: "hotel-1",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    card_verify_due_at: DUE,
    card_verify_attempts: 0,
    // Default is the SIGNUP check: nothing verified yet. Pass card_verified_at
    // to build a row that has passed it and owes only the 48-hour recheck.
    card_verified_at: null,
    card_verify_anchor_at: SIGNUP,
    created_at: SIGNUP,
    ...o,
  };
}

function seedRow(o: Row = {}): Row {
  return {
    hotel_id: "hotel-1",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    status: "trialing",
    // Internal plans have no card, so the sweep filters them out entirely.
    plan_kind: "stripe",
    created_at: SIGNUP,
    card_verify_due_at: DUE,
    card_verified_at: null,
    card_verify_anchor_at: SIGNUP,
    card_rechecked_at: null,
    card_verify_failed_at: null,
    card_verify_attempts: 0,
    card_verify_last_code: null,
    ...o,
  };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("verifySavedCard: how the card is checked", () => {
  it("confirms a zero-amount SetupIntent and nothing else", async () => {
    const { stripe, calls } = fakeStripe();
    expect(await verifySavedCard(stripe, row())).toEqual({ kind: "verified" });

    expect(calls.creates).toHaveLength(1);
    const params = calls.creates[0].params;
    expect(params).toMatchObject({ customer: "cus_1", payment_method: "pm_1", confirm: true });
    // No amount, no capture: this is a validity inquiry, not a hold.
    expect(params).not.toHaveProperty("amount");
    expect(params).not.toHaveProperty("capture_method");
  });

  it("re-uses one intent per attempt so an overlapping run can't double-ask the issuer", async () => {
    const { stripe, calls } = fakeStripe();
    await verifySavedCard(stripe, row());
    await verifySavedCard(stripe, row());
    expect(calls.creates[0].options?.idempotencyKey).toBe(calls.creates[1].options?.idempotencyKey);
    // A deliberate later retry is a new attempt, and must be allowed to ask again.
    await verifySavedCard(stripe, row({ card_verify_attempts: 1 }));
    expect(calls.creates[2].options?.idempotencyKey).not.toBe(calls.creates[0].options?.idempotencyKey);
  });

  it("asks the issuer again at the 48-hour recheck instead of replaying the signup answer", async () => {
    // The recheck resets card_verify_attempts to zero so it gets its own retry
    // budget, which made both stages produce the same key — and a matching key
    // means Stripe hands back the cached "succeeded" without contacting anyone.
    // That is the whole point of the second check, silently not happening.
    const { stripe, calls } = fakeStripe();
    await verifySavedCard(stripe, row({ card_verified_at: null, card_verify_attempts: 0 }));
    await verifySavedCard(stripe, row({ card_verified_at: "2026-07-30T00:00:00Z", card_verify_attempts: 0 }));
    expect(calls.creates[1].options?.idempotencyKey).not.toBe(calls.creates[0].options?.idempotencyKey);
  });

  it("falls back to the customer's invoice default when the subscription has none", async () => {
    const { stripe, calls } = fakeStripe({
      subscription: {
        id: "sub_1",
        status: "active",
        default_payment_method: null,
        customer: { id: "cus_1", invoice_settings: { default_payment_method: "pm_customer" } },
      },
    });
    expect(await verifySavedCard(stripe, row())).toEqual({ kind: "verified" });
    expect(calls.creates[0].params).toMatchObject({ payment_method: "pm_customer" });
  });

  it("verifies a legacy default_source rather than calling the card gone", async () => {
    const { stripe, calls } = fakeStripe({
      subscription: {
        id: "sub_1",
        status: "active",
        default_payment_method: null,
        customer: {
          id: "cus_1",
          invoice_settings: { default_payment_method: null },
          default_source: "card_legacy",
        },
      },
    });
    expect(await verifySavedCard(stripe, row())).toEqual({ kind: "verified" });
    expect(calls.creates[0].params).toMatchObject({ payment_method: "card_legacy" });
  });

  it("calls the card gone when there is no saved payment method left, without asking Stripe", async () => {
    // Checkout collects a card even for a trial, so an empty slot means someone
    // removed it — which is the answer, and needs no round trip.
    const { stripe, calls } = fakeStripe({
      subscription: {
        id: "sub_1",
        status: "trialing",
        default_payment_method: null,
        customer: { id: "cus_1", invoice_settings: { default_payment_method: null } },
      },
    });
    expect(await verifySavedCard(stripe, row())).toEqual({ kind: "failed", code: "no_payment_method" });
    expect(calls.creates).toHaveLength(0);
  });
});

describe("verifySavedCard: verdicts", () => {
  it("reports the issuer's decline reason", async () => {
    const { stripe } = fakeStripe({
      createError: { type: "StripeCardError", code: "card_declined", decline_code: "card_not_supported" },
    });
    expect(await verifySavedCard(stripe, row())).toEqual({ kind: "failed", code: "card_not_supported" });
  });

  it("falls back to the error code when the issuer gives no decline reason", async () => {
    const { stripe } = fakeStripe({ createError: { type: "card_error", code: "expired_card" } });
    expect(await verifySavedCard(stripe, row())).toEqual({ kind: "failed", code: "expired_card" });
  });

  it("treats a deleted payment method as a failure", async () => {
    const { stripe } = fakeStripe({
      createError: { type: "StripeInvalidRequestError", code: "resource_missing" },
    });
    expect(await verifySavedCard(stripe, row())).toEqual({
      kind: "failed",
      code: "payment_method_missing",
    });
  });

  it("does not accuse the card when the issuer wants the cardholder", async () => {
    const { stripe } = fakeStripe({ intent: { status: "requires_action" } });
    expect(await verifySavedCard(stripe, row())).toEqual({
      kind: "inconclusive",
      code: "authentication_required",
    });
  });

  it("reaches the same verdict when Stripe raises that as a decline instead of a status", async () => {
    // Stripe reports "needs the cardholder present" either way, and
    // authentication_required is a documented DECLINE code as well as a status.
    // Classified as a decline it would permanently stamp failed — so an SCA card
    // from a UK or EU property, one that authenticated at checkout and will bill
    // fine off that mandate, got reported to its owner as dead at 48h.
    const { stripe } = fakeStripe({
      createError: { type: "StripeCardError", code: "authentication_required" },
    });
    expect(await verifySavedCard(stripe, row())).toEqual({
      kind: "inconclusive",
      code: "authentication_required",
    });
  });

  it("sends a return_url so a redirect-requiring card isn't rejected outright", async () => {
    // Without one Stripe refuses the confirm with an InvalidRequestError, which
    // reads as inconclusive, burns all four attempts, and ends in a failed stamp.
    const { stripe, calls } = fakeStripe({ intent: { status: "succeeded" } });
    await verifySavedCard(stripe, row());
    expect(calls.creates[0]?.params).toMatchObject({ return_url: expect.any(String) });
  });

  it("does not accuse the card when Stripe is the thing that's broken", async () => {
    const { stripe } = fakeStripe({
      createError: { type: "StripeRateLimitError", code: "rate_limit", statusCode: 429 },
    });
    expect(await verifySavedCard(stripe, row())).toEqual({ kind: "inconclusive", code: "rate_limit" });
  });

  it("reads the failure off the intent when confirmation resolves instead of throwing", async () => {
    const { stripe } = fakeStripe({
      intent: {
        status: "requires_payment_method",
        last_setup_error: { type: "card_error", code: "card_declined", decline_code: "do_not_honor" },
      },
    });
    expect(await verifySavedCard(stripe, row())).toEqual({ kind: "failed", code: "do_not_honor" });
  });

  it("has nothing to check on a subscription that already ended", async () => {
    const { stripe, calls } = fakeStripe({
      subscription: { id: "sub_1", status: "canceled", customer: "cus_1", default_payment_method: "pm_1" },
    });
    expect(await verifySavedCard(stripe, row())).toEqual({
      kind: "moot",
      code: "subscription_canceled",
    });
    expect(calls.creates).toHaveLength(0);
  });

  it("retries a 404 instead of retiring the row, because the usual cause is the wrong Stripe key", async () => {
    // Live subscriptions can only be cancelled, and a cancelled one still reads
    // fine — so a 404 in production points at the account, not the customer.
    // Retiring on it would drop every hotel's check without a word.
    const { stripe } = fakeStripe({ retrieveError: { type: "StripeInvalidRequestError", statusCode: 404 } });
    expect(await verifySavedCard(stripe, row())).toEqual({
      kind: "inconclusive",
      code: "subscription_missing",
    });
  });

  it("retries rather than resolving when the subscription read fails transiently", async () => {
    const { stripe } = fakeStripe({ retrieveError: { type: "StripeAPIError", statusCode: 500 } });
    expect(await verifySavedCard(stripe, row())).toEqual({ kind: "inconclusive", code: "StripeAPIError" });
  });
});

describe("patchFor", () => {
  it("never writes anything that could change entitlement", () => {
    // isEntitled() reads `status`, and a card we cannot confirm is not grounds
    // for cutting a hotel off. Nothing outside these five columns may be written.
    const allowed = new Set([
      "card_verify_due_at",
      "card_verified_at",
      "card_verify_failed_at",
      "card_verify_attempts",
      "card_verify_last_code",
    ]);
    for (const outcome of [
      { kind: "verified" } as const,
      { kind: "failed", code: "do_not_honor" } as const,
      { kind: "inconclusive", code: "rate_limit" } as const,
      { kind: "moot", code: "subscription_canceled" } as const,
    ]) {
      for (const key of Object.keys(patchFor(outcome, row(), NOW))) {
        expect(allowed.has(key), `patch wrote ${key}`).toBe(true);
      }
    }
  });

  it("passing the signup check arms the 48-hour one instead of settling", () => {
    const signup = "2026-07-29T12:00:00Z";
    const patch = patchFor(
      { kind: "verified" },
      row({ card_verify_attempts: 2, created_at: signup }),
      NOW,
    );
    expect(patch).toEqual({
      card_verified_at: NOW.toISOString(),
      // Signup + 48h, NOT now + 48h: a sweep that ran late must not push the
      // recheck out, because the window it covers is when a virtual card gets
      // cancelled.
      card_verify_due_at: new Date(Date.parse(signup) + 48 * 3600_000).toISOString(),
      card_verify_failed_at: null,
      card_verify_last_code: null,
      // The recheck gets its own retry budget.
      card_verify_attempts: 0,
    });
    expect(patch).not.toHaveProperty("card_rechecked_at");
  });

  it("passing the 48-hour check settles the row for good", () => {
    const patch = patchFor(
      { kind: "verified" },
      row({ card_verified_at: "2026-07-29T12:04:00Z", card_verify_attempts: 1 }),
      NOW,
    );
    expect(patch).toEqual({
      card_rechecked_at: NOW.toISOString(),
      card_verify_due_at: null,
      card_verify_failed_at: null,
      card_verify_last_code: null,
      card_verify_attempts: 2,
    });
    // Overwriting the signup stamp would lose when the card was first proven.
    expect(patch).not.toHaveProperty("card_verified_at");
  });

  it("counts the 48 hours from THIS subscription, not from the row", () => {
    // hotel_subscriptions is keyed by hotel and reused when someone
    // re-subscribes, so created_at still points at the original signup. Using it
    // put the recheck permanently in the past for anyone who had churned once —
    // skipping the wait for exactly the customers most worth re-checking.
    const patch = patchFor(
      { kind: "verified" },
      row({ created_at: "2026-01-01T00:00:00Z", card_verify_anchor_at: "2026-07-30T12:00:00Z" }),
      NOW,
    );
    expect(patch.card_verify_due_at).toBe("2026-08-01T12:00:00.000Z");
  });

  it("falls back to the row's creation for rows written before the anchor existed", () => {
    const patch = patchFor(
      { kind: "verified" },
      row({ card_verify_anchor_at: null, created_at: "2026-07-30T12:00:00Z" }),
      NOW,
    );
    expect(patch.card_verify_due_at).toBe("2026-08-01T12:00:00.000Z");
  });

  it("falls back to now when a row somehow has no creation time", () => {
    const patch = patchFor({ kind: "verified" }, row({ created_at: null, card_verify_anchor_at: null }), NOW);
    expect(patch.card_verify_due_at).toBe(new Date(NOW.getTime() + 48 * 3600_000).toISOString());
  });

  it("re-arms an inconclusive check instead of settling it", () => {
    const patch = patchFor({ kind: "inconclusive", code: "authentication_required" }, row(), NOW);
    expect(patch).toEqual({
      card_verify_due_at: new Date(NOW.getTime() + REVERIFY_RETRY_AFTER_HOURS * 3600_000).toISOString(),
      card_verify_last_code: "authentication_required",
      card_verify_attempts: 1,
    });
    expect(patch).not.toHaveProperty("card_verify_failed_at");
  });

  it("stops re-arming and surfaces the reason once retrying is pointless", () => {
    const patch = patchFor(
      { kind: "inconclusive", code: "authentication_required" },
      row({ card_verify_attempts: REVERIFY_MAX_ATTEMPTS - 1 }),
      NOW,
    );
    expect(patch).toMatchObject({
      card_verify_failed_at: NOW.toISOString(),
      card_verify_last_code: "authentication_required",
    });
  });

  it("takes a moot row out of the sweep without claiming a verdict", () => {
    const patch = patchFor({ kind: "moot", code: "subscription_canceled" }, row(), NOW);
    expect(patch).toMatchObject({ card_verify_due_at: null });
    expect(patch).not.toHaveProperty("card_verified_at");
    expect(patch).not.toHaveProperty("card_verify_failed_at");
  });
});

describe("recordOutcome", () => {
  it("stamps the row", async () => {
    const { admin, rows } = fakeAdmin([seedRow()]);
    expect((await recordOutcome(admin, row(), { kind: "verified" }, NOW)).ok).toBe(true);
    expect(rows[0]).toMatchObject({
      card_verified_at: NOW.toISOString(),
      card_verify_due_at: new Date(Date.parse(SIGNUP) + 48 * 3600_000).toISOString(),
    });
  });

  it("writes the 48-hour verdict, whose row already has the signup stamp", async () => {
    // The guard is per-stage. Keyed on card_verified_at for both, every recheck
    // verdict would be silently dropped and the row would stay due forever.
    const verified = "2026-07-29T12:04:00Z";
    const { admin, rows } = fakeAdmin([seedRow({ card_verified_at: verified })]);
    const res = await recordOutcome(admin, row({ card_verified_at: verified }), { kind: "verified" }, NOW);
    expect(res.ok).toBe(true);
    expect(rows[0]).toMatchObject({
      card_verified_at: verified,
      card_rechecked_at: NOW.toISOString(),
      card_verify_due_at: null,
    });
  });

  it("refuses to overwrite a verdict another runner already settled", async () => {
    const { admin, rows } = fakeAdmin([seedRow({ card_verified_at: "2026-07-31T11:00:00Z" })]);
    await recordOutcome(admin, row(), { kind: "failed", code: "do_not_honor" }, NOW);
    expect(rows[0]).toMatchObject({
      card_verified_at: "2026-07-31T11:00:00Z",
      card_verify_failed_at: null,
    });
  });

  it("drops a recheck verdict for a card that is no longer the one it checked", async () => {
    // Re-subscribing clears both stamps (trg_hotel_subscriptions_reset_card_verify).
    // Landing a stale card_rechecked_at on the reset row would retire it without
    // the NEW card ever being looked at.
    const { admin, rows } = fakeAdmin([seedRow({ card_verified_at: null })]);
    await recordOutcome(admin, row({ card_verified_at: "2026-07-29T12:04:00Z" }), { kind: "verified" }, NOW);
    expect(rows[0].card_rechecked_at ?? null).toBeNull();
    expect(rows[0].card_verified_at).toBeNull();
  });

  it("reports a write failure to the caller", async () => {
    const { admin, state } = fakeAdmin([seedRow()]);
    state.updateError = "deadlock detected";
    const res = await recordOutcome(admin, row(), { kind: "verified" }, NOW);
    expect(res).toMatchObject({ ok: false, error: "deadlock detected" });
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("sweepCardReverification", () => {
  it("checks only the rows that are due and unsettled", async () => {
    const { admin, rows } = fakeAdmin([
      seedRow({ hotel_id: "due", stripe_subscription_id: "sub_due" }),
      seedRow({
        hotel_id: "not-yet",
        stripe_subscription_id: "sub_future",
        card_verify_due_at: "2026-08-05T00:00:00Z",
      }),
      seedRow({
        hotel_id: "recheck-done",
        stripe_subscription_id: "sub_ok",
        card_verified_at: "2026-07-29T12:04:00Z",
        card_rechecked_at: "2026-07-31T12:04:00Z",
      }),
      seedRow({
        hotel_id: "already-bad",
        stripe_subscription_id: "sub_bad",
        card_verify_failed_at: "2026-07-30T00:00:00Z",
      }),
      seedRow({ hotel_id: "no-due-date", stripe_subscription_id: "sub_none", card_verify_due_at: null }),
    ]);
    const { stripe, calls } = fakeStripe();

    const result = await sweepCardReverification({ admin, stripe, now: NOW });
    expect(result).toMatchObject({ examined: 1, verified: 1, failed: 0, deferred: 0, moot: 0 });
    expect(calls.retrieves).toEqual(["sub_due"]);
    expect(rows.find((r) => r.hotel_id === "due")).toMatchObject({
      card_verified_at: NOW.toISOString(),
    });
    expect(rows.find((r) => r.hotel_id === "not-yet")).toMatchObject({ card_verified_at: null });
  });

  it("picks a row back up for its 48-hour check after the signup one passed", async () => {
    // The regression this guards: keying the sweep on card_verified_at would take
    // the row out after the first pass, and the check Jake actually asked for —
    // the one that catches a cancelled virtual card — would never run at all.
    const { admin, rows } = fakeAdmin([
      seedRow({ card_verified_at: "2026-07-29T12:04:00Z", card_verify_due_at: DUE }),
    ]);
    const { stripe, calls } = fakeStripe();

    const result = await sweepCardReverification({ admin, stripe, now: NOW });
    expect(result).toMatchObject({ examined: 1, verified: 1 });
    expect(calls.retrieves).toEqual(["sub_1"]);
    expect(rows[0]).toMatchObject({
      card_rechecked_at: NOW.toISOString(),
      card_verify_due_at: null,
    });
  });

  it("runs both stages end to end without a second card ever being needed", async () => {
    const { admin, rows } = fakeAdmin([seedRow({ card_verify_due_at: SIGNUP })]);
    const { stripe, calls } = fakeStripe();

    // Signup check: minutes after checkout.
    await sweepCardReverification({ admin, stripe, now: new Date(Date.parse(SIGNUP) + 4 * 60_000) });
    const armed = new Date(Date.parse(SIGNUP) + 48 * 3600_000).toISOString();
    expect(rows[0]).toMatchObject({ card_verify_due_at: armed, card_rechecked_at: null });

    // Sweeps in between find nothing: the recheck is not due yet.
    await sweepCardReverification({ admin, stripe, now: new Date(Date.parse(SIGNUP) + 24 * 3600_000) });
    expect(calls.retrieves).toHaveLength(1);

    // Two days later, the recheck runs and the row settles.
    await sweepCardReverification({ admin, stripe, now: new Date(Date.parse(armed) + 60_000) });
    expect(calls.retrieves).toHaveLength(2);
    expect(rows[0].card_rechecked_at).not.toBeNull();
    expect(rows[0].card_verify_due_at).toBeNull();

    // And never again.
    await sweepCardReverification({ admin, stripe, now: new Date(Date.parse(armed) + 86_400_000) });
    expect(calls.retrieves).toHaveLength(2);
  });

  it("records a failure without touching the subscription's status", async () => {
    const { admin, rows } = fakeAdmin([seedRow()]);
    const { stripe } = fakeStripe({
      createError: { type: "StripeCardError", code: "card_declined", decline_code: "do_not_honor" },
    });

    const result = await sweepCardReverification({ admin, stripe, now: NOW });
    expect(result).toMatchObject({ examined: 1, failed: 1 });
    expect(rows[0]).toMatchObject({
      status: "trialing",
      card_verify_failed_at: NOW.toISOString(),
      card_verify_last_code: "do_not_honor",
      card_verify_attempts: 1,
    });
  });

  it("defers an inconclusive check and leaves it re-checkable", async () => {
    const { admin, rows } = fakeAdmin([seedRow()]);
    const { stripe } = fakeStripe({ intent: { status: "requires_action" } });

    const result = await sweepCardReverification({ admin, stripe, now: NOW });
    expect(result).toMatchObject({ deferred: 1, failed: 0 });
    expect(rows[0]).toMatchObject({
      card_verify_failed_at: null,
      card_verified_at: null,
      card_verify_attempts: 1,
      card_verify_due_at: new Date(NOW.getTime() + REVERIFY_RETRY_AFTER_HOURS * 3600_000).toISOString(),
    });
  });

  it("honours the batch cap so one run can't stall on a backlog", async () => {
    const { admin } = fakeAdmin([
      seedRow({ hotel_id: "h1", card_verify_due_at: "2026-07-31T01:00:00Z" }),
      seedRow({ hotel_id: "h2", card_verify_due_at: "2026-07-31T02:00:00Z" }),
      seedRow({ hotel_id: "h3", card_verify_due_at: "2026-07-31T03:00:00Z" }),
    ]);
    const { stripe, calls } = fakeStripe();
    const result = await sweepCardReverification({ admin, stripe, now: NOW, limit: 2 });
    expect(result.examined).toBe(2);
    expect(calls.retrieves).toHaveLength(2);
  });

  it("gives up quietly when the due query itself fails", async () => {
    const { admin, state } = fakeAdmin([seedRow()]);
    state.selectError = "connection reset";
    const { stripe, calls } = fakeStripe();
    const result = await sweepCardReverification({ admin, stripe, now: NOW });
    expect(result).toMatchObject({ examined: 0, errors: ["connection reset"] });
    expect(calls.retrieves).toHaveLength(0);
  });
});

describe("clearCardAlarmAfterPayment", () => {
  function fakeAdmin(rows: { stripe_subscription_id: string; card_verify_failed_at: string | null }[]) {
    const patched: Record<string, unknown>[] = [];
    const admin = {
      from: () => ({
        update: (patch: Record<string, unknown>) => ({
          eq: (_c: string, subId: string) => ({
            not: () => ({
              select: async () => {
                const hit = rows.filter(
                  (r) => r.stripe_subscription_id === subId && r.card_verify_failed_at !== null,
                );
                if (hit.length) patched.push(patch);
                return { data: hit.map(() => ({ hotel_id: "h1" })), error: null };
              },
            }),
          }),
        }),
      }),
    };
    return { admin: admin as unknown as SupabaseClient, patched };
  }

  it("takes the alarm down once a real charge settles", async () => {
    // A payment going through is better evidence than the probe that raised it.
    const { admin, patched } = fakeAdmin([
      { stripe_subscription_id: "sub_1", card_verify_failed_at: "2026-07-28T00:00:00Z" },
    ]);
    expect(await clearCardAlarmAfterPayment(admin, "sub_1")).toEqual({ cleared: true });
    expect(patched[0]).toMatchObject({ card_verify_failed_at: null, card_verify_last_code: null });
  });

  it("gives the next check a full retry budget rather than the exhausted one", async () => {
    const { admin, patched } = fakeAdmin([
      { stripe_subscription_id: "sub_1", card_verify_failed_at: "2026-07-28T00:00:00Z" },
    ]);
    await clearCardAlarmAfterPayment(admin, "sub_1");
    expect(patched[0]).toMatchObject({ card_verify_attempts: 0 });
  });

  it("does nothing when no alarm was raised", async () => {
    const { admin, patched } = fakeAdmin([
      { stripe_subscription_id: "sub_1", card_verify_failed_at: null },
    ]);
    expect(await clearCardAlarmAfterPayment(admin, "sub_1")).toEqual({ cleared: false });
    expect(patched).toHaveLength(0);
  });

  it("ignores a payment for someone else's subscription", async () => {
    const { admin } = fakeAdmin([
      { stripe_subscription_id: "sub_other", card_verify_failed_at: "2026-07-28T00:00:00Z" },
    ]);
    expect(await clearCardAlarmAfterPayment(admin, "sub_1")).toEqual({ cleared: false });
  });
});

describe("internal plans are not swept", () => {
  it("leaves an internal plan alone even when it looks due", async () => {
    // Our own properties have no card and no Stripe customer. Without the filter
    // they would be due forever, failing every check against a customer that
    // does not exist — and eventually latching card_verify_failed_at on a hotel
    // nobody is billing.
    const { admin, rows } = fakeAdmin([
      seedRow({ hotel_id: "ours", plan_kind: "internal", stripe_customer_id: null }),
    ]);
    const { stripe, calls } = fakeStripe();
    const result = await sweepCardReverification({ admin, stripe, now: NOW });
    expect(result).toMatchObject({ examined: 0 });
    expect(calls.creates).toHaveLength(0);
    expect(rows[0].card_verify_failed_at).toBeNull();
  });

  it("still sweeps a real plan sitting beside one", async () => {
    const { admin } = fakeAdmin([
      seedRow({ hotel_id: "ours", plan_kind: "internal", stripe_customer_id: null }),
      seedRow({ hotel_id: "paying", stripe_subscription_id: "sub_paying" }),
    ]);
    const { stripe } = fakeStripe();
    expect(await sweepCardReverification({ admin, stripe, now: NOW })).toMatchObject({ examined: 1 });
  });
});
