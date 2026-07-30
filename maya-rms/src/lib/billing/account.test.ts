/**
 * The headline is the only sentence most owners will read about their money, and
 * its ORDER is the part that goes wrong: a property whose pricing has stopped
 * must not be told about its trial, and one whose card just died must not be
 * told everything is fine.
 */
import { describe, expect, it } from "vitest";
import { headlineFor, periodEndLabel, type AccountBilling } from "./account";
import { describeRoomChange, priceCents } from "./tiers";

const NOW = new Date("2026-07-30T12:00:00Z");

function billing(o: Partial<AccountBilling> = {}): AccountBilling {
  return {
    hotelId: "hotel-1",
    status: "active",
    interval: "month",
    rooms: 40,
    periodCents: priceCents(40, "month"),
    renewsAt: "2026-08-30T12:00:00Z",
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    cardTrouble: null,
    signupCode: null,
    entitled: true,
    roomTruth: { kind: "ok", measured: 40, billed: 40 },
    roomGraceDaysLeft: 7,
    notBilledFor: [],
    ...o,
  };
}

describe("headlineFor", () => {
  it("leads with work having stopped, above everything else", () => {
    const h = headlineFor(
      billing({
        entitled: false,
        status: "canceled",
        // All of these would otherwise have something to say.
        cardTrouble: { code: "expired_card", since: "2026-07-01T00:00:00Z" },
        cancelAtPeriodEnd: true,
      }),
      NOW,
    );
    expect(h.tone).toBe("stopped");
    expect(h.title).toMatch(/paused/i);
    expect(h.detail).toMatch(/no longer being calculated/i);
  });

  it("points an unpaid property at its card, which genuinely revives it", async () => {
    const h = headlineFor(billing({ entitled: false, status: "unpaid" }), NOW);
    expect(h.detail).toMatch(/update your card/i);
  });

  it("does not promise a cancelled property that a new card will fix it", async () => {
    // The subscription is gone from Stripe; no amount of card-updating restarts
    // it, and saying otherwise sends someone round a loop that cannot work.
    const h = headlineFor(billing({ entitled: false, status: "canceled" }), NOW);
    expect(h.detail).not.toMatch(/update your card/i);
    expect(h.detail).toMatch(/cancelled/i);
  });

  it("reassures a past_due property that it is still being priced", () => {
    // Cutting them off on the first failed charge is exactly what isEntitled
    // refuses to do, so the copy must not imply it has happened.
    const h = headlineFor(billing({ status: "past_due" }), NOW);
    expect(h.tone).toBe("warn");
    expect(h.detail).toMatch(/still pricing/i);
  });

  it("warns about a dead card before it has cost anything", () => {
    const h = headlineFor(
      billing({ cardTrouble: { code: "card_declined", since: "2026-07-28T00:00:00Z" } }),
      NOW,
    );
    expect(h.tone).toBe("warn");
    expect(h.title).toMatch(/stopped working/i);
    // Truthful: nothing has failed yet, and saying otherwise would be alarming
    // and wrong.
    expect(h.detail).toMatch(/next charge will/i);
  });

  it("says a pending cancellation still has time left on it", () => {
    const h = headlineFor(billing({ cancelAtPeriodEnd: true }), NOW);
    expect(h.tone).toBe("warn");
    expect(h.detail).toContain("August 30, 2026");
  });

  it("counts the trial down and names the first charge", () => {
    const h = headlineFor(
      billing({ status: "trialing", trialEndsAt: "2026-08-06T12:00:00Z", renewsAt: null }),
      NOW,
    );
    expect(h.title).toBe("Your trial ends in 7 days");
    expect(h.detail).toContain("$200");
    expect(h.detail).toContain("August 6, 2026");
  });

  it("does not say 'in 0 days' on the last day", () => {
    const h = headlineFor(
      billing({ status: "trialing", trialEndsAt: "2026-07-30T18:00:00Z" }),
      NOW,
    );
    expect(h.title).toBe("Your trial ends today");
  });

  it("states the next charge when everything is fine", () => {
    const h = headlineFor(billing(), NOW);
    expect(h.tone).toBe("ok");
    expect(h.detail).toContain("$200");
    expect(h.detail).toContain("August 30, 2026");
  });
});

describe("periodEndLabel", () => {
  it("never promises a charge that will not be taken", () => {
    // The date is still worth showing on a dead subscription — it is when the
    // property last had MAYA — but calling it "Next charge" is a lie.
    expect(periodEndLabel(billing({ entitled: false, status: "canceled" }))).toBe("Ended");
  });

  it("calls a pending cancellation what it is", () => {
    expect(periodEndLabel(billing({ cancelAtPeriodEnd: true }))).toBe("Access ends");
  });

  it("does not call a failed payment a future charge", () => {
    expect(periodEndLabel(billing({ status: "past_due" }))).toBe("Retrying payment until");
  });

  it("is a next charge when a charge is actually next", () => {
    expect(periodEndLabel(billing())).toBe("Next charge");
  });
});

describe("describeRoomChange", () => {
  it("tells them the bill goes DOWN when crossing a bracket upward", () => {
    // 20 rooms at $5.50 = $110; 21 rooms at $5.00 = $105. The inversion is
    // intended, and the copy has to be straight about it rather than assuming
    // more rooms means more money.
    const q = describeRoomChange(20, 21, "month");
    expect(q.deltaCents).toBeLessThan(0);
    expect(q.summary).toContain("$110");
    expect(q.summary).toContain("$105");
    expect(q.summary).toContain("down to");
  });

  it("promises an adjusted invoice rather than an exact proration", () => {
    // Stripe computes the credit. Quoting a figure here would eventually
    // disagree with the invoice, which is worse than not quoting one.
    expect(describeRoomChange(40, 60, "month").summary).toMatch(/next invoice is adjusted/i);
  });

  it("says nothing changes when the count lands in the same bracket at the same size", () => {
    expect(describeRoomChange(40, 40, "month").deltaCents).toBe(0);
  });

  it("phrases an annual change per year", () => {
    expect(describeRoomChange(40, 60, "year").summary).toContain("per year");
  });
});
