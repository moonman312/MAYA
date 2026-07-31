import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildNudge, decideNudge, type UpcomingInvoice } from "./renewal-nudge";
import {
  renewalNudgeHtml,
  renewalNudgeSubject,
  renewalNudgeText,
} from "@/lib/email/renewal-nudge-email";

function invoice(o: Partial<UpcomingInvoice> = {}): UpcomingInvoice {
  return {
    subscriptionId: "sub_1",
    hotelId: "hotel-1",
    amountDue: 13200,
    currency: "usd",
    nextPaymentAttempt: Math.floor(Date.parse("2026-08-06T12:00:00Z") / 1000),
    periodEnd: Math.floor(Date.parse("2026-08-06T12:00:00Z") / 1000),
    customerEmail: "gm@driftwood.example",
    billingInterval: "month",
    roomCount: 24,
    isFirstCharge: true,
    ...o,
  };
}

/** Stands in for the pms_connections read. */
function fakeAdmin(statuses: string[]) {
  return {
    from: () => ({
      select: () => ({
        eq: async () => ({ data: statuses.map((status) => ({ status })), error: null }),
      }),
    }),
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.RESEND_FROM_EMAIL = "MAYA <billing@example.test>";
});

describe("decideNudge only nudges a property that hasn't connected", () => {
  it("sends when there is no PMS connection at all", async () => {
    const d = await decideNudge(fakeAdmin([]), invoice());
    expect(d.send).toBe(true);
    if (d.send) expect(d.to).toBe("gm@driftwood.example");
  });

  it("stays quiet when the PMS is connected — they're already getting what they pay for", async () => {
    const d = await decideNudge(fakeAdmin(["connected"]), invoice());
    expect(d.send).toBe(false);
    if (!d.send) expect(d.reason).toBe("pms_connected");
  });

  it("stays quiet for a connection that is merely unhappy, not absent", async () => {
    // degraded/error mean it connected once and is now struggling. That deserves
    // a different message, not a "you never set this up" nudge.
    for (const status of ["degraded", "error"]) {
      const d = await decideNudge(fakeAdmin([status]), invoice());
      expect(d.send).toBe(false);
      if (!d.send) expect(d.reason).toBe("pms_connected");
    }
  });

  it("still nudges when the only connection never got past pending", async () => {
    // A row exists because they started the OAuth dance and bailed; nothing is
    // actually syncing, so this is exactly who the email is for.
    const d = await decideNudge(fakeAdmin(["pending"]), invoice());
    expect(d.send).toBe(true);
  });

  it("stays quiet when any one connection is working", async () => {
    const d = await decideNudge(fakeAdmin(["pending", "connected"]), invoice());
    expect(d.send).toBe(false);
  });

  it("stays quiet for an invoice that owes nothing", async () => {
    // A fully discounted period has no charge to warn about.
    const d = await decideNudge(fakeAdmin([]), invoice({ amountDue: 0 }));
    expect(d.send).toBe(false);
    if (!d.send) expect(d.reason).toBe("nothing_due");
  });

  it("stays quiet when the subscription isn't ours", async () => {
    const d = await decideNudge(fakeAdmin([]), invoice({ hotelId: null }));
    expect(d.send).toBe(false);
    if (!d.send) expect(d.reason).toBe("no_hotel_metadata");
  });

  it("stays quiet with nobody to write to, but says so in the log", async () => {
    // A fault, not a decision: silent, it is indistinguishable from a fleet
    // where nobody needed nudging.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = await decideNudge(fakeAdmin([]), invoice({ customerEmail: null }));
    expect(d.send).toBe(false);
    if (!d.send) expect(d.reason).toBe("no_recipient");
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("no_recipient"));
    errors.mockRestore();
  });

  it("stays quiet rather than throwing when email isn't set up, and logs that too", async () => {
    delete process.env.RESEND_API_KEY;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = await decideNudge(fakeAdmin([]), invoice());
    expect(d.send).toBe(false);
    if (!d.send) expect(d.reason).toBe("email_not_configured");
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("email_not_configured"));
    errors.mockRestore();
  });

  it("logs nothing for a skip that is the system working", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = await decideNudge(fakeAdmin(["connected"]), invoice());
    expect(d.send).toBe(false);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("the email shows the room count they can correct", () => {
  it("states the count, the per-room rate and the total", () => {
    const built = buildNudge(invoice(), "https://app.example/onboarding/connect");
    expect(built.roomCount).toBe(24);
    // 24 rooms sits in the 21-40 bracket at $5.00.
    expect(built.perRoom).toBe("$5.00");
    expect(built.amount).toBe("$132.00");

    const text = renewalNudgeText(built);
    const html = renewalNudgeHtml(built);
    for (const body of [text, html]) {
      expect(body).toContain("24 rooms");
      expect(body).toContain("$5.00");
      expect(body).toContain("$132.00");
      // The whole reason the count is in here: so a wrong one can be fixed
      // before the charge rather than refunded after it. (The HTML spells the
      // apostrophe as an entity, hence the loose match.)
      expect(body).toMatch(/isn(&rsquo;|')t right/);
      expect(body).toContain("https://app.example/onboarding/connect");
    }
  });

  it("ties the room-count fix to connecting first", () => {
    // Billing bounces a property that never finished setup back to onboarding,
    // so a bare "change it here" link promises a page this audience cannot
    // open — the copy has to put the connect step in front of the correction.
    const built = buildNudge(invoice(), "https://app.example/onboarding");
    for (const body of [renewalNudgeText(built), renewalNudgeHtml(built)]) {
      expect(body).toContain("connect first");
      expect(body).toContain("https://app.example/account/billing");
    }
  });

  it("always shows cents on the per-room rate, across brackets", () => {
    expect(buildNudge(invoice({ roomCount: 18 }), "u").perRoom).toBe("$5.50");
    expect(buildNudge(invoice({ roomCount: 24 }), "u").perRoom).toBe("$5.00");
    expect(buildNudge(invoice({ roomCount: 90 }), "u").perRoom).toBe("$2.50");
  });

  it("names the charge day so the deadline is concrete", () => {
    const built = buildNudge(invoice(), "u");
    expect(built.chargeDate).toContain("August 6");
    expect(renewalNudgeText(built)).toContain("August 6");
  });

  it("reads as a first payment or a renewal, not the same words for both", () => {
    const first = renewalNudgeSubject(buildNudge(invoice({ isFirstCharge: true }), "u"));
    const later = renewalNudgeSubject(buildNudge(invoice({ isFirstCharge: false }), "u"));
    expect(first).not.toBe(later);
    expect(first.toLowerCase()).toContain("starts");
    expect(later.toLowerCase()).toContain("renews");
  });

  it("falls back to vague timing rather than an Invalid Date", () => {
    const built = buildNudge(invoice({ nextPaymentAttempt: null, periodEnd: null }), "u");
    expect(built.chargeDate).toBe("shortly");
    expect(renewalNudgeText(built)).not.toContain("Invalid");
  });

  it("says year when the plan is annual", () => {
    const built = buildNudge(invoice({ billingInterval: "year" }), "u");
    expect(renewalNudgeText(built)).toContain("per year");
  });
});

describe("the nudge's own arithmetic holds", () => {
  // Someone checking whether the room count is right will multiply the two
  // numbers in that sentence. If they don't reconcile, the email argues against
  // itself at exactly the moment it is asking to be trusted about a charge.
  it("quotes an annual per-room rate beside an annual total", () => {
    const built = buildNudge(
      invoice({ billingInterval: "year", roomCount: 40, amountDue: 216000 }),
      "https://app.example/onboarding",
    );
    // 40 rooms bill at $5.00/room/month; a year is 12 of those less 10% = $54.00.
    expect(built.perRoom).toBe("$54.00");
    const perRoomCents = Math.round(Number(built.perRoom.replace("$", "")) * 100);
    expect(perRoomCents * built.roomCount).toBe(216000);
  });

  it("still multiplies out for a monthly subscriber", () => {
    const built = buildNudge(
      invoice({ billingInterval: "month", roomCount: 40, amountDue: 20000 }),
      "https://app.example/onboarding",
    );
    expect(built.perRoom).toBe("$5.00");
    const perRoomCents = Math.round(Number(built.perRoom.replace("$", "")) * 100);
    expect(perRoomCents * built.roomCount).toBe(20000);
  });

  it("does not divide by zero when the room count is missing", () => {
    expect(buildNudge(invoice({ roomCount: 0 }), "https://app.example").perRoom).toBe("$0.00");
  });
});
