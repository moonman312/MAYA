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
    ...o,
  };
}

function seedRow(o: Row = {}): Row {
  return {
    hotel_id: "hotel-1",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    status: "trialing",
    card_verify_due_at: DUE,
    card_verified_at: null,
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

  it("clears the reason once the card passes", () => {
    expect(patchFor({ kind: "verified" }, row({ card_verify_attempts: 2 }), NOW)).toEqual({
      card_verified_at: NOW.toISOString(),
      card_verify_failed_at: null,
      card_verify_last_code: null,
      card_verify_attempts: 3,
    });
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
    expect(rows[0]).toMatchObject({ card_verified_at: NOW.toISOString(), card_verify_attempts: 1 });
  });

  it("refuses to overwrite a verdict another runner already settled", async () => {
    const { admin, rows } = fakeAdmin([seedRow({ card_verified_at: "2026-07-31T11:00:00Z" })]);
    await recordOutcome(admin, row(), { kind: "failed", code: "do_not_honor" }, NOW);
    expect(rows[0]).toMatchObject({
      card_verified_at: "2026-07-31T11:00:00Z",
      card_verify_failed_at: null,
    });
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
        hotel_id: "already-ok",
        stripe_subscription_id: "sub_ok",
        card_verified_at: "2026-07-30T00:00:00Z",
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
