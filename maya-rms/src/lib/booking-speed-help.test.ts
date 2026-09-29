import { describe, expect, it } from "vitest";
import {
  BOOKING_SPEED_HELP_EXAMPLE,
  STRONGER_RULE_LINE,
  WHOLE_DAYS_WAIT_LINE,
  bookingSpeedHelp,
  bookingSpeedWaitHelp,
  pickupWaitHelp,
  pickupWindowHelp,
} from "@/lib/booking-speed-help";
import { classifyBookingSpeed } from "@/lib/observations/booking-speed";

describe("bookingSpeedHelp", () => {
  const e = BOOKING_SPEED_HELP_EXAMPLE;
  const speed = (recent: number) =>
    classifyBookingSpeed({ recentBookings: recent, expectedBookings: e.expected, comparableCount: 8 }).speed;

  it("gives examples the classifier agrees with", () => {
    expect(speed(e.muchSlower)).toBe("much_slower");
    for (const n of e.normal) expect(speed(n)).toBe("normal");
    expect(speed(e.muchFaster)).toBe("much_faster");
  });

  it("names the window the rule measures over", () => {
    expect(bookingSpeedHelp(1).lines[0]).toContain("past day");
    expect(bookingSpeedHelp(7).lines[0]).toContain("past week");
    expect(bookingSpeedHelp(30).lines[0]).toContain("past month");
  });

  it("counts bookings, and says in one short line that a booking with several rooms counts once", () => {
    // What the engine does: a reservation is one booking on each of its
    // nights however many rooms it holds (booking-rows.ts bookingKeyOf,
    // booking_key in SQL), while occupancy still counts rooms.
    for (const w of [1, 7, 30]) {
      const h = bookingSpeedHelp(w);
      expect(h.lines[0]).toMatch(/^MAYA counts how many bookings a night received/);
      expect(h.lines[1]).toBe("A booking with several rooms counts once.");
      expect(h.lines[1].length).toBeLessThan(50);
      expect(h.lines.join(" ")).not.toMatch(/rooms (were |are )?booked/);
    }
  });

  it("says in one line that the rule can act again after its wait", () => {
    const line = bookingSpeedHelp(7).lines.at(-2)!;
    expect(line).toBe("If those keep the rule true after its wait, it adjusts that night again.");
    expect(line.length).toBeLessThan(80);
  });

  it("says that once a rule changed a night it and the weaker rules that move the price the same way only count what was booked since", () => {
    // What the engine does: countFromFireAt, the newest fire on the night by
    // the rule itself or a stronger rule that adjusts the same way, and a
    // weaker rule's never (Jake, 2026-09-24, option A); a rule that raises
    // on "at least" a pace, which is how the form builds a raise on Faster,
    // Much Faster or Surging, reads the comparables over its whole window,
    // any other over the same shorter stretch (keepsWholeWindowBar).
    for (const [w, span] of [
      [1, "day"],
      [7, "week"],
      [30, "month"],
    ] as const) {
      const lines = bookingSpeedHelp(w).lines;
      expect(lines.at(-4)).toBe(
        "After a rule changes a night, it only counts bookings made since then, while that change is still on the price. So does every weaker rule that moves the price the same way, so they don't add to that change on the same bookings.",
      );
      expect(lines.at(-3)).toBe(
        `A rule that raises on a fast pace needs those bookings alone to beat what similar nights get in a whole ${span}. Any other rule compares them with similar nights over the same days.`,
      );
      expect(lines.join(" ")).not.toContain("whichever rule");
    }
  });

  it("says that a rule that cuts counts full days only, and one that raises counts today too", () => {
    // What the engine does: countsCompleteDays, on the night and on the
    // nights it is compared with alike.
    for (const w of [1, 7, 30]) {
      expect(bookingSpeedHelp(w).lines.at(-5)).toBe(
        "A rule that cuts counts full days only, up to yesterday. A rule that raises counts today so far too.",
      );
    }
  });

  it("says what makes a rule stronger in terms the owner can see: the bigger change, then booking speed ahead of none, then the faster speed", () => {
    // What the engine does: comparePickupRules ranks by the change to the
    // price first; at the same change a rule with a Booking Speed condition
    // ranks ahead of one without whatever its pickup count, then the faster
    // level for a raise (slower for a cut); priority, which owners can't
    // set, only after the pickup count.
    expect(STRONGER_RULE_LINE).toBe(
      "A stronger rule is one that changes the price by more. If two change it by the same amount, a rule that watches booking speed is stronger than one that doesn't, and of two that do, the one set to the faster speed is stronger (the slower speed, for rules that cut).",
    );
    for (const w of [1, 7, 30]) expect(bookingSpeedHelp(w).lines.at(-1)).toBe(STRONGER_RULE_LINE);
    expect(bookingSpeedWaitHelp("1 week").lines.at(-1)).toBe(STRONGER_RULE_LINE);
    expect(STRONGER_RULE_LINE).not.toMatch(/priority/i);
  });

  it("has no em dashes", () => {
    for (const w of [1, 7, 30]) {
      const h = bookingSpeedHelp(w);
      expect([h.label, h.title, ...h.lines].join(" ")).not.toContain("—");
    }
  });
});

describe("bookingSpeedWaitHelp", () => {
  it("says what the wait covers, in the words of the wait that is chosen", () => {
    const h = bookingSpeedWaitHelp("2 days");
    expect(h.lines[0]).toBe("After this rule adjusts a night, it leaves that night alone for 2 days.");
    // What the engine does: the wait is per night and room type, a stronger
    // rule may still fire during it, and three of its changes on a night
    // alert the owner (repeat-alerts.ts counts the ones still on the price).
    expect(h.lines.join(" ")).toContain("Each room type waits on its own");
    expect(h.lines.join(" ")).toContain("stronger rule can still step in");
    expect(h.lines.join(" ")).toContain("MAYA tells you once three of its changes are on one night.");
    // waitAnchor: a change that came off for cancellations still starts the wait.
    expect(h.lines.join(" ")).toContain("If cancellations take its change off, the wait still runs from that change.");
    // Once it is over, only what came in since its own last adjustment
    // counts, or since a stronger rule's that moves the price the same way
    // when that is later, until a typed price starts it over with its
    // whole window.
    expect(h.lines.join(" ")).toContain(
      "it only counts bookings made since its last change still on that night, or since a stronger rule's that moves the price the same way, if that was later.",
    );
    expect(h.lines.join(" ")).not.toContain("whichever rule");
    expect(h.lines.join(" ")).toContain("starts it over");
    expect(h.lines.join(" ")).toContain("whole window");
  });

  it("says once when the pickup lookback is what sets the wait", () => {
    // A rule with both conditions waits the longer of the two, so a dropdown
    // set to a day but a 7-day pickup window really waits a week.
    const h = bookingSpeedWaitHelp("1 week", "1 week");
    expect(h.lines[0]).toBe("After this rule adjusts a night, it leaves that night alone for 1 week.");
    expect(h.lines[1]).toBe("This rule also counts pickup over 1 week, which is longer, so that is what it waits.");
    expect(bookingSpeedWaitHelp("1 week").lines.join(" ")).not.toContain("also counts pickup");
  });

  it("names the pickup wait chosen, not the window, when that is what sets it", () => {
    const h = bookingSpeedWaitHelp("2 weeks", null, "2 weeks");
    expect(h.lines[1]).toBe("Its pickup count waits 2 weeks, which is longer, so that is what it waits.");
    expect(h.lines.join(" ")).not.toContain("counts pickup over");
  });

  it("has no em dashes and no math symbols", () => {
    const h = bookingSpeedWaitHelp("1 week");
    const words = [h.label, h.title, ...h.lines].join(" ");
    expect(words).not.toContain("—");
    expect(words).not.toMatch(/[<>]/);
  });
});

describe("pickupWaitHelp", () => {
  it("says the wait chosen, and that a rule with none chosen waits its lookback window", () => {
    const h = pickupWaitHelp("2 days");
    expect(h.label).toBe("How the wait works");
    expect(h.lines[0]).toBe("After this rule adjusts a night, it leaves that night alone for 2 days.");
    // ruleWaitDays: pickup_cooldown_days, else pickup_window_days.
    expect(h.lines[1]).toBe("Unless you choose a wait, it waits as long as its lookback window.");
  });

  it("says a count on pickup above a number only counts what came in since its own last change or a stronger rule's", () => {
    // countFromFireAt and pickupWindowOpensAt: the newest fire on the night
    // by the rule itself or a stronger rule that adjusts the same way, and a
    // weaker rule's never (Jake, 2026-09-24, option A).
    const words = pickupWaitHelp("2 days").lines.join(" ");
    expect(words).toContain(
      "When the wait is over it counts pickup over its lookback window, but only what came in since its last change still on that night, or since a stronger rule's that moves the price the same way, if that was later.",
    );
    expect(words).not.toContain("whichever rule");
    // openFireHeads: a change taken off for cancellations is not "still on", so it opens no pickup count.
    expect(words).toContain("MAYA tells you once three of its changes are on one night.");
    expect(words).toContain("If cancellations take its change off, the wait still runs from that change.");
    // A typed price: waitAnchor starts the wait there, and
    // pickupWindowOpensAt ignores the fires before it.
    expect(words).toContain("starts it over");
    expect(words).toContain("whole window");
    expect(words).toContain("Each room type waits on its own");
    expect(words).toContain("stronger rule can still step in");
    expect(pickupWaitHelp("2 days").lines.at(-1)).toBe(STRONGER_RULE_LINE);
    // Pickup is not bookings made since: it is net, and it is room nights or revenue.
    expect(words).not.toContain("only counts bookings made since");
  });

  it("says a count on low pickup only judges a whole window after a change, so it never adjusts again sooner, whatever the wait", () => {
    // pickupJudgesShortStretch: a stretch shorter than the window would only
    // read as slower, so after its own change or a stronger rule's the rule
    // has nothing to judge until a whole window has passed.
    const words = pickupWaitHelp("1 day", null, true).lines.join(" ");
    expect(words).toContain(
      "It looks for low pickup, so it counts full days only, up to yesterday, and after its last change still on that night, or a stronger rule's that moves the price the same way if that was later, it only judges a whole lookback window of full days from the start of that change's day. So it never adjusts a night again sooner than its lookback window, whatever the wait.",
    );
    expect(words).not.toContain("When the wait is over it counts pickup");
    expect(words).toContain("three of its changes");
    expect(words).toContain("starts it over");
    expect(pickupWaitHelp("1 day", null, false).lines).toEqual(pickupWaitHelp("1 day").lines);
  });

  it("says once when the booking speed wait is what sets it", () => {
    const h = pickupWaitHelp("1 week", "1 week");
    expect(h.lines[2]).toBe("Its booking speed condition waits 1 week, which is longer, so that is what it waits.");
    expect(pickupWaitHelp("2 days").lines.join(" ")).not.toContain("Its booking speed condition");
  });

  it("has no em dashes, no exclamation marks and no math symbols", () => {
    const h = pickupWaitHelp("1 week", "1 week");
    const words = [h.label, h.title, ...h.lines].join(" ");
    expect(words).not.toContain("\u2014");
    expect(words).not.toContain("!");
    expect(words).not.toMatch(/[<>]/);
  });
});

describe("waits and windows in whole days (Jake, 2026-09-28)", () => {
  it("every wait panel says a wait counts whole days at the property, once", () => {
    // isWaiting in engine/pickup.ts: a wait of N days from a change on day D
    // ends when day D + N begins, whatever the hour of the change.
    for (const h of [bookingSpeedWaitHelp("1 week"), pickupWaitHelp("2 days"), pickupWaitHelp("1 day", null, true)]) {
      expect(h.lines.filter((l) => l === WHOLE_DAYS_WAIT_LINE)).toHaveLength(1);
    }
    expect(WHOLE_DAYS_WAIT_LINE).toBe(
      "Waits count whole days at your property. A 2-day wait from a change made at any time on a Monday is over as Wednesday begins.",
    );
  });

  it("the lookback window's panel names the days counted: today so far and the days before, or full days to yesterday", () => {
    // baselineTsFrom and countPickupToDayStart in engine/pickup.ts.
    expect(pickupWindowHelp(3).lines[1]).toBe("It looks for more pickup, so it counts today so far and the 2 days before.");
    expect(pickupWindowHelp(1).lines[1]).toBe("It looks for more pickup, so it counts today so far.");
    expect(pickupWindowHelp(2).lines[1]).toBe("It looks for more pickup, so it counts today so far and the day before.");
    expect(pickupWindowHelp(7, true).lines[1]).toBe(
      "It looks for low pickup, so it counts full days only: the 7 days up to yesterday. A day that isn't over yet never reads as slow, and a cancellation made today counts against it straight away.",
    );
    expect(pickupWindowHelp(1, true).lines[1]).toContain("the day up to yesterday");
    for (const h of [pickupWindowHelp(3), pickupWindowHelp(7, true)]) {
      expect(h.lines[0]).toContain("the days move on at midnight");
      const words = [h.label, h.title, ...h.lines].join(" ");
      expect(words).not.toContain("—");
      expect(words).not.toMatch(/MAYA (learns|knows|thinks)/);
    }
  });
});
