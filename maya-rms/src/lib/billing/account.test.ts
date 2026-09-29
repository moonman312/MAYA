/**
 * The headline is the only sentence most owners will read about their money, and
 * its ORDER is the part that goes wrong: a property whose pricing has stopped
 * must not be told about its trial, and one whose card just died must not be
 * told everything is fine.
 */
import { describe, expect, it } from "vitest";
import {
  headlineFor,
  offersRestart,
  periodEndDate,
  periodEndLabel,
  priceHint,
  priceLabel,
  type AccountBilling,
} from "./account";
import { describeRoomChange, priceCents } from "./tiers";

const NOW = new Date("2026-07-30T12:00:00Z");

function billing(o: Partial<AccountBilling> = {}): AccountBilling {
  return {
    hotelId: "hotel-1",
    status: "active",
    interval: "month",
    rooms: 40,
    periodCents: priceCents(40, "month"),
    chargeCents: null,
    codeApplied: false,
    renewsAt: "2026-08-30T12:00:00Z",
    unpaidSince: null,
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    cardTrouble: null,
    signupCode: null,
    entitled: true,
    roomTruth: { kind: "ok", measured: 40, billed: 40 },
    roomGraceDaysLeft: 7,
    notBilledFor: [],
    allRoomTypesExcluded: false,
    ...o,
  };
}

describe("headlineFor", () => {
  it("sends a cancellation at the restart path and an unpaid card at the card", () => {
    // Two different fixes hide under "not entitled" — the wrong pointer wastes
    // the owner's time, and pointing unpaid at a new checkout double-bills.
    const cancelled = headlineFor(billing({ entitled: false, status: "canceled" }), NOW);
    expect(cancelled.detail).toMatch(/restart below/i);

    const unpaid = headlineFor(billing({ entitled: false, status: "unpaid" }), NOW);
    expect(unpaid.detail).toContain("card");
    expect(unpaid.detail).not.toMatch(/restart below/i);
  });

  it("gives a paused subscription its own words, pointing at us rather than a restart", () => {
    // Paused is still there in Stripe. Calling it cancelled sent the owner to
    // a restart that would have put a second subscription beside it.
    const h = headlineFor(billing({ entitled: false, status: "paused" }), NOW);
    expect(h.tone).toBe("stopped");
    expect(h.detail).toContain("Your subscription is on hold. Email us and we'll get it running again.");
    expect(h.detail).not.toMatch(/cancelled|restart/i);
    expect(h.emailSubject).toBe("Paused subscription");

    expect(headlineFor(billing({ entitled: false, status: "canceled" }), NOW).emailSubject).toBeUndefined();
  });

  it("says what stopped in the owner's terms, with no dashes", () => {
    for (const status of ["canceled", "unpaid", "paused"]) {
      const h = headlineFor(billing({ entitled: false, status }), NOW);
      expect(h.detail).toMatch(
        /^Your rules no longer run on a schedule and nothing is sent to your PMS\. /,
      );
      expect(h.detail).not.toMatch(/calculated/i);
      expect(h.detail).not.toContain("—");
    }
  });


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
    expect(h.detail).toMatch(/no longer run on a schedule/i);
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

  it("reassures a past_due property that its rules keep running", () => {
    // Cutting them off on the first failed charge is exactly what isEntitled
    // refuses to do, so the copy must not imply it has happened.
    const h = headlineFor(billing({ status: "past_due" }), NOW);
    expect(h.tone).toBe("warn");
    expect(h.detail).toBe(
      "Your rules keep running while the bank retries. Update your card to avoid an interruption.",
    );
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

  describe("a room shortfall", () => {
    const short = { kind: "short", measured: 60, billed: 40, shortBy: 20 } as const;

    it("counts down from the notice while there is time left", () => {
      const h = headlineFor(billing({ roomTruth: short, roomGraceDaysLeft: 5 }), NOW);
      expect(h.tone).toBe("warn");
      expect(h.detail).toContain("within 5 days");
      expect(h.detail).toContain("update it to 60");
      expect(h.detail).not.toContain("\u2014");
    });

    it("says 'shortly' only once the notice period has run out", () => {
      const h = headlineFor(billing({ roomTruth: short, roomGraceDaysLeft: 0 }), NOW);
      expect(h.detail).toContain("update it to 60 shortly");
    });

    it("promises no date and no correction when no notice has gone out", () => {
      // trueUpOne refuses to correct without a notice about this count, so a
      // countdown or "shortly" here would say the reverse of what happens.
      const h = headlineFor(billing({ roomTruth: short, roomGraceDaysLeft: null }), NOW);
      expect(h.detail).toContain("We'll email you before anything changes.");
      expect(h.detail).not.toMatch(/shortly|within \d/);
    });

    it("sends a count above 500 to us, and promises no email that never comes", () => {
      // Neither the notice email nor the correction touches a count above the
      // self-serve ceiling, and the count box cannot take one either.
      const h = headlineFor(
        billing({
          roomTruth: { kind: "short", measured: 600, billed: 20, shortBy: 580 },
          roomGraceDaysLeft: null,
        }),
        NOW,
      );
      expect(h.title).toBe("You're billed for 20 rooms but running 600");
      expect(h.detail).toBe(
        "MAYA charges per room, so 580 rooms are not being paid for. That's above what we sell self-serve. Email us and we'll set it up with you.",
      );
      expect(h.emailSubject).toBe("Over 500 rooms");

      // At the ceiling itself the ordinary path still applies.
      const at = headlineFor(
        billing({ roomTruth: { kind: "short", measured: 500, billed: 20, shortBy: 480 }, roomGraceDaysLeft: null }),
        NOW,
      );
      expect(at.detail).toContain("We'll email you before anything changes.");
      expect(at.emailSubject).toBeUndefined();
    });
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

describe("offersRestart", () => {
  it("offers a new checkout only where the old subscription is gone", () => {
    for (const status of ["canceled", "incomplete", "incomplete_expired"]) {
      expect(offersRestart(billing({ entitled: false, status })), status).toBe(true);
    }
  });

  it("never offers one beside a subscription Stripe still holds", () => {
    // Unpaid revives through the card; paused waits on us. A restart beside
    // either is a second subscription.
    expect(offersRestart(billing({ entitled: false, status: "unpaid" }))).toBe(false);
    expect(offersRestart(billing({ entitled: false, status: "paused" }))).toBe(false);
    expect(offersRestart(billing())).toBe(false);
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

  it("does not call an unpaid subscription ended, because a card revives it", () => {
    const unpaid = billing({ entitled: false, status: "unpaid", unpaidSince: "2026-07-01T09:00:00Z" });
    expect(periodEndLabel(unpaid)).toBe("Unpaid since");
    // Its period end is usually still to come; the date is when it stopped
    // being paid for.
    expect(periodEndDate(unpaid)).toBe("2026-07-01T09:00:00Z");
    expect(periodEndDate({ ...unpaid, unpaidSince: null })).toBeNull();
  });

  it("keeps Ended for what really has ended", () => {
    for (const status of ["canceled", "incomplete", "incomplete_expired"]) {
      const over = billing({ entitled: false, status });
      expect(periodEndLabel(over), status).toBe("Ended");
      expect(periodEndDate(over), status).toBe(over.renewsAt);
    }
  });

  it("shows no date for a paused subscription, which is on hold rather than over", () => {
    expect(periodEndDate(billing({ entitled: false, status: "paused" }))).toBeNull();
  });
});

describe("priceHint", () => {
  it("names a code only when one is taking money off the next invoice", () => {
    const h = priceHint(billing({ chargeCents: 10_000, codeApplied: true }));
    expect(h).toBe("40 rooms at MAYA's monthly rate, with your code applied.");
  });

  it("puts any other difference down to the room count change, not a code", () => {
    // A room count change leaves its part-period difference on the next
    // invoice. Calling that "your code" sent owners hunting for one.
    const raised = priceHint(billing({ chargeCents: priceCents(40, "month") + 1_234 }));
    expect(raised).toBe("40 rooms at MAYA's monthly rate, adjusted for a recent room count change.");
    expect(raised).not.toMatch(/code/);
  });

  it("adds nothing when the invoice is the bracket price, or unknown", () => {
    expect(priceHint(billing({ chargeCents: priceCents(40, "month") }))).toBe("40 rooms at MAYA's monthly rate.");
    expect(priceHint(billing({ chargeCents: null }))).toBe("40 rooms at MAYA's monthly rate.");
    expect(priceHint(billing({ rooms: 1, interval: "year", chargeCents: null }))).toBe(
      "1 room at MAYA's annual rate.",
    );
  });
});

describe("priceLabel", () => {
  it("says Price while the subscription can still come back", () => {
    expect(priceLabel(billing())).toBe("Price");
    expect(priceLabel(billing({ entitled: false, status: "unpaid" }))).toBe("Price");
    expect(priceLabel(billing({ entitled: false, status: "paused" }))).toBe("Price");
  });

  it("says Was once it is cancelled or never completed", () => {
    for (const status of ["canceled", "incomplete", "incomplete_expired"]) {
      expect(priceLabel(billing({ entitled: false, status })), status).toBe("Was");
    }
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
