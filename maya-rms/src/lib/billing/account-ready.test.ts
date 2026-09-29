/**
 * The "Payment received" screen promises an email when the account is ready.
 * These hold it to "once, and never twice": across redeliveries, deliveries
 * that land together, and a send that fails part way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fakeSupabase, missingColumn, type FakeFault, type FakeRow } from "../engine/fake-supabase.test";
import type { SubscriptionProjection } from "./sync";

const mail = vi.hoisted(() => ({
  configured: true,
  sent: [] as { to: string; subject: string; text: string; replyTo?: string; idempotencyKey?: string }[],
  failNext: 0,
}));

vi.mock("@/lib/email/resend", () => ({
  isResendConfigured: () => mail.configured,
  sendEmail: async (input: { to: string; subject: string; text: string; replyTo?: string; idempotencyKey?: string }) => {
    // Yield first, so deliveries racing each other really interleave here.
    await Promise.resolve();
    if (mail.failNext > 0) {
      mail.failNext -= 1;
      throw new Error("Resend send failed: HTTP 500");
    }
    mail.sent.push(input);
    return { id: `email_${mail.sent.length}` };
  },
}));

const { sendAccountReadyOnce, ACCOUNT_READY_WINDOW_HOURS } = await import("./account-ready");

const NOW = new Date("2026-09-29T12:00:00Z");
const CREATED = Math.floor(NOW.getTime() / 1000) - 60;

function sub(o: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    created: CREATED,
    trial_end: null,
    metadata: { hotel_id: "hotel-1", user_id: "user-1" },
    ...o,
  } as unknown as Stripe.Subscription;
}

function projection(o: Partial<SubscriptionProjection> = {}): SubscriptionProjection {
  return {
    hotel_id: "hotel-1",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    status: "active",
    billing_interval: "month",
    billed_rooms: 12,
    current_period_end: null,
    trial_end: null,
    cancel_at_period_end: false,
    card_verify_due_at: null,
    card_verify_anchor_at: null,
    signup_code_id: null,
    ...o,
  };
}

function setup(
  opts: {
    subRow?: FakeRow | null;
    hotelName?: string;
    users?: Record<string, string>;
    customerEmail?: string | null;
    fault?: FakeFault;
  } = {},
) {
  const db = fakeSupabase(
    {
      hotel_subscriptions:
        opts.subRow === null
          ? []
          : [{ hotel_id: "hotel-1", stripe_subscription_id: "sub_1", account_ready_emailed_at: null, ...opts.subRow }],
      hotels: [{ id: "hotel-1", name: opts.hotelName ?? "Pending setup 1a2b3c4d" }],
    },
    { fault: opts.fault },
  );
  const users = opts.users ?? { "user-1": "owner@harbour.example" };
  const admin = {
    ...(db.client as unknown as Record<string, unknown>),
    auth: {
      admin: {
        getUserById: async (id: string) =>
          users[id]
            ? { data: { user: { id, email: users[id] } }, error: null }
            : { data: { user: null }, error: { message: "User not found" } },
      },
    },
  } as unknown as SupabaseClient;
  const customerLookups: string[] = [];
  const stripe = {
    customers: {
      retrieve: async (id: string) => {
        customerLookups.push(id);
        return { id, email: opts.customerEmail === undefined ? "billing@harbour.example" : opts.customerEmail };
      },
    },
  } as unknown as Stripe;
  return { db, admin, stripe, customerLookups, row: () => db.tables.hotel_subscriptions[0] };
}

beforeEach(() => {
  mail.configured = true;
  mail.sent = [];
  mail.failNext = 0;
  process.env.MAYA_INVITE_REDIRECT_BASE = "https://maya-rms.com/";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("sendAccountReadyOnce", () => {
  it("emails the person who paid once the subscription is live, and claims it", async () => {
    const s = setup();
    const r = await sendAccountReadyOnce(s.admin, s.stripe, sub(), projection(), NOW);

    expect(r).toEqual({ sent: true, hotelId: "hotel-1", to: "owner@harbour.example" });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({
      to: "owner@harbour.example",
      subject: "Your MAYA account is ready",
      replyTo: "info@modern-hospitality-solutions.com",
      idempotencyKey: "account-ready:hotel-1",
    });
    expect(mail.sent[0].text).toContain("https://maya-rms.com/onboarding");
    expect(mail.sent[0].text).toContain("connect your property management system");
    expect(s.row().account_ready_emailed_at).toBe(NOW.toISOString());
    // The login answered, so Stripe was never asked.
    expect(s.customerLookups).toHaveLength(0);
  });

  it("sends nothing on a redelivery", async () => {
    const s = setup();
    await sendAccountReadyOnce(s.admin, s.stripe, sub(), projection(), NOW);
    const again = await sendAccountReadyOnce(s.admin, s.stripe, sub(), projection(), NOW);
    expect(again).toEqual({ sent: false, reason: "already_sent" });
    expect(mail.sent).toHaveLength(1);
  });

  it("sends once when several deliveries land together", async () => {
    const s = setup();
    const results = await Promise.all(
      [1, 2, 3].map(() => sendAccountReadyOnce(s.admin, s.stripe, sub(), projection(), NOW)),
    );
    // All three got past the look-before and reached the claim: the claim,
    // not the look, is what kept it to one.
    expect(s.db.calls.filter((c) => c.table === "hotel_subscriptions" && c.op === "update")).toHaveLength(3);
    expect(mail.sent).toHaveLength(1);
    expect(results.filter((r) => r.sent)).toHaveLength(1);
    expect(results.filter((r) => !r.sent).map((r) => (r.sent ? null : r.reason))).toEqual(["already_sent", "already_sent"]);
  });

  it("gives the claim back when the send fails, so a later delivery sends it", async () => {
    const s = setup();
    mail.failNext = 1;
    const first = await sendAccountReadyOnce(s.admin, s.stripe, sub(), projection(), NOW);
    expect(first).toMatchObject({ sent: false, reason: "send_failed" });
    expect(s.row().account_ready_emailed_at).toBeNull();

    const later = new Date(NOW.getTime() + 60_000);
    const second = await sendAccountReadyOnce(s.admin, s.stripe, sub(), projection(), later);
    expect(second).toMatchObject({ sent: true });
    expect(mail.sent).toHaveLength(1);
    expect(s.row().account_ready_emailed_at).toBe(later.toISOString());
  });

  it("never welcomes a property that went live long ago", async () => {
    const s = setup();
    const old = CREATED - (ACCOUNT_READY_WINDOW_HOURS * 3600 + 60);
    const r = await sendAccountReadyOnce(s.admin, s.stripe, sub({ created: old }), projection(), NOW);
    expect(r).toEqual({ sent: false, reason: "not_fresh" });
    expect(mail.sent).toHaveLength(0);
    expect(s.row().account_ready_emailed_at).toBeNull();
  });

  it.each(["incomplete", "incomplete_expired", "unpaid", "canceled"])("waits while the subscription is %s", async (status) => {
    const s = setup();
    const r = await sendAccountReadyOnce(s.admin, s.stripe, sub({ status }), projection({ status }), NOW);
    expect(r).toEqual({ sent: false, reason: "not_entitled" });
    expect(mail.sent).toHaveLength(0);
    expect(s.db.calls.some((c) => c.op === "update")).toBe(false);
  });

  it("counts a trial as live and says when it ends", async () => {
    const s = setup({ hotelName: "The Harbour Inn" });
    const trialEnd = Math.floor(Date.parse("2026-10-06T12:00:00Z") / 1000);
    const trialing = sub({ status: "trialing", trial_end: trialEnd, metadata: { hotel_id: "hotel-1", user_id: "user-1", via: "marketplace_flow_a" } });
    await sendAccountReadyOnce(s.admin, s.stripe, trialing, projection({ status: "trialing" }), NOW);

    expect(mail.sent[0].subject).toBe("The Harbour Inn is ready in MAYA");
    expect(mail.sent[0].text).toContain("your free trial runs until October 6, 2026");
    expect(mail.sent[0].text).toContain("Your property system is connected");
  });

  it("falls back to the billing email when the login cannot be found", async () => {
    const s = setup({ users: {} });
    const r = await sendAccountReadyOnce(s.admin, s.stripe, sub(), projection(), NOW);
    expect(r).toMatchObject({ sent: true, to: "billing@harbour.example" });
    expect(s.customerLookups).toEqual(["cus_1"]);
  });

  it("claims nothing when there is nobody to send it to", async () => {
    const s = setup({ users: {}, customerEmail: null });
    const r = await sendAccountReadyOnce(s.admin, s.stripe, sub(), projection(), NOW);
    expect(r).toEqual({ sent: false, reason: "no_recipient" });
    expect(s.row().account_ready_emailed_at).toBeNull();
  });

  it("claims nothing when email is not set up, or the link would be dead", async () => {
    mail.configured = false;
    const a = setup();
    expect(await sendAccountReadyOnce(a.admin, a.stripe, sub(), projection(), NOW)).toEqual({
      sent: false,
      reason: "email_not_configured",
    });
    expect(a.row().account_ready_emailed_at).toBeNull();

    mail.configured = true;
    delete process.env.MAYA_INVITE_REDIRECT_BASE;
    const b = setup();
    expect(await sendAccountReadyOnce(b.admin, b.stripe, sub(), projection(), NOW)).toEqual({
      sent: false,
      reason: "no_base_url",
    });
    expect(b.row().account_ready_emailed_at).toBeNull();
    expect(mail.sent).toHaveLength(0);
  });

  it("sends nothing, and does not throw, ahead of the column's migration", async () => {
    const s = setup({
      fault: (call) =>
        call.table === "hotel_subscriptions" ? missingColumn("hotel_subscriptions", "account_ready_emailed_at") : null,
    });
    const r = await sendAccountReadyOnce(s.admin, s.stripe, sub(), projection(), NOW);
    expect(r).toEqual({ sent: false, reason: "column_missing" });
    expect(mail.sent).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("99_supabase_migration_account_ready_email_v1.sql"));
  });

  it("does not claim a row that has since moved to another subscription", async () => {
    const s = setup({ subRow: { stripe_subscription_id: "sub_other" } });
    const r = await sendAccountReadyOnce(s.admin, s.stripe, sub(), projection(), NOW);
    expect(r).toEqual({ sent: false, reason: "already_sent" });
    expect(mail.sent).toHaveLength(0);
  });

  it("turns a lookup that throws into an outcome, with nothing claimed", async () => {
    const s = setup({ users: {} });
    (s.stripe.customers as unknown as { retrieve: () => Promise<never> }).retrieve = async () => {
      throw new Error("stripe unreachable");
    };
    const r = await sendAccountReadyOnce(s.admin, s.stripe, sub(), projection(), NOW);
    expect(r).toMatchObject({ sent: false, reason: "error", message: "stripe unreachable" });
    expect(s.row().account_ready_emailed_at).toBeNull();
  });
});
