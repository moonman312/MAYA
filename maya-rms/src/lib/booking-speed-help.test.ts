import { describe, expect, it } from "vitest";
import { BOOKING_SPEED_HELP_EXAMPLE, bookingSpeedHelp, bookingSpeedWaitHelp } from "@/lib/booking-speed-help";
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
    const line = bookingSpeedHelp(7).lines.at(-1)!;
    expect(line).toBe("If those keep the rule true after its wait, it adjusts that night again.");
    expect(line.length).toBeLessThan(80);
  });

  it("says that once a rule adjusted a night it only counts what was booked since, other rules' bookings included", () => {
    // What the engine does: bookingSpeedCountFrom from the rule's own last
    // fire on the night; another rule's fire never moves it (Jake,
    // 2026-09-24), and the comparables read over the same shorter stretch
    // (observeBookingSpeed countFrom).
    for (const w of [1, 7, 30]) {
      const lines = bookingSpeedHelp(w).lines;
      expect(lines.at(-3)).toBe(
        "Once this rule has adjusted a night, it only counts bookings made since then. Bookings another rule acted on still count.",
      );
      expect(lines.at(-2)).toBe("Those bookings are compared with similar nights over the same days.");
      expect(lines.join(" ")).not.toContain("whichever rule");
    }
  });

  it("says that a rule that cuts counts full days only, and one that raises counts today too", () => {
    // What the engine does: countsCompleteDays, on the night and on the
    // nights it is compared with alike.
    for (const w of [1, 7, 30]) {
      expect(bookingSpeedHelp(w).lines.at(-4)).toBe(
        "A rule that cuts counts full days only, up to yesterday. A rule that raises counts today so far too.",
      );
    }
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
    // Once it is over, only what came in since this rule's own last
    // adjustment counts, other rules' included, until a typed price starts
    // it over with its whole window.
    expect(h.lines.join(" ")).toContain(
      "it only counts bookings made since it last adjusted that night. Bookings another rule acted on still count.",
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
