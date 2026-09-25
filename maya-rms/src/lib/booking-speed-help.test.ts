import { describe, expect, it } from "vitest";
import { BOOKING_SPEED_HELP_EXAMPLE, STRONGER_RULE_LINE, bookingSpeedHelp, bookingSpeedWaitHelp } from "@/lib/booking-speed-help";
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
        "After a rule changes a night, it only counts bookings made since then. So does every weaker rule that moves the price the same way, so they don't add to that change on the same bookings.",
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
    // rule may still fire during it, and three fires on a night alert the owner.
    expect(h.lines.join(" ")).toContain("Each room type waits on its own");
    expect(h.lines.join(" ")).toContain("stronger rule can still step in");
    expect(h.lines.join(" ")).toContain("three times");
    // Once it is over, only what came in since its own last adjustment
    // counts, or since a stronger rule's that moves the price the same way
    // when that is later, until a typed price starts it over with its
    // whole window.
    expect(h.lines.join(" ")).toContain(
      "it only counts bookings made since it last adjusted that night, or since a stronger rule that moves the price the same way did, if that was later.",
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

  it("has no em dashes and no math symbols", () => {
    const h = bookingSpeedWaitHelp("1 week");
    const words = [h.label, h.title, ...h.lines].join(" ");
    expect(words).not.toContain("—");
    expect(words).not.toMatch(/[<>]/);
  });
});
