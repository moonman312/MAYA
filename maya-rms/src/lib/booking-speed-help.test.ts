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

  it("says in one line that the rule can act again after its wait", () => {
    const line = bookingSpeedHelp(7).lines.at(-1)!;
    expect(line).toBe("If the rule is still true after its wait, it adjusts that night again.");
    expect(line.length).toBeLessThan(80);
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
