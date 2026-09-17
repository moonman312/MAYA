import { describe, expect, it } from "vitest";
import { describeClear, describeSave, manualPriceBadge } from "./manual-price-editor";

describe("manualPriceBadge", () => {
  it("says a rate changed in the PMS was changed there, and a typed one is manual", () => {
    expect(manualPriceBadge({ price: 180, source: "pms" }, "Cloudbeds")).toBe("Changed in Cloudbeds · $180.00");
    expect(manualPriceBadge({ price: 0, source: "pms" }, "Think Reservations")).toBe("Changed in Think Reservations · $0.00");
    expect(manualPriceBadge({ price: 150, source: "maya" }, "Cloudbeds")).toBe("Manual · $150.00");
    // Older rows and servers say nothing about where it came from.
    expect(manualPriceBadge({ price: 150 }, "Cloudbeds")).toBe("Manual · $150.00");
  });
});

describe("describeSave", () => {
  it("names the push path and the hotel's own PMS in house voice", () => {
    expect(describeSave({ pushed: "nudged", suppressedRules: 0, retiredPickups: 0 }, "Cloudbeds")).toBe(
      "Saved. Sending to Cloudbeds now.",
    );
    expect(
      describeSave({ pushed: "simulation", suppressedRules: 0, retiredPickups: 0 }, "Think Reservations"),
    ).toBe("Saved (simulation: not sent to Think Reservations).");
    expect(describeSave({ pushed: "beyond_window", suppressedRules: 0, retiredPickups: 0 }, "Mews")).toBe(
      "Saved. It will be sent when the date enters the 60-day push window.",
    );
  });

  it("mentions paused rules only when something was paused", () => {
    expect(describeSave({ pushed: "next_cycle", suppressedRules: 1, retiredPickups: 0 }, "Cloudbeds")).toBe(
      "Saved. Sending to Cloudbeds on the next cycle (about 5 min). Paused 1 rule on this night for this room; new rules will apply on top.",
    );
    expect(
      describeSave({ pushed: "beyond_window", suppressedRules: 2, retiredPickups: 1 }, "Cloudbeds"),
    ).toContain("Paused 3 rules");
  });

  it("splits a range that straddles the 60-day window per night, singular and plural", () => {
    expect(
      describeSave(
        { pushed: "nudged", suppressedRules: 0, retiredPickups: 0, cells: 4, pushWindow: { now: 2, later: 2 } },
        "Cloudbeds",
      ),
    ).toBe("Saved. 2 nights sending to Cloudbeds now; 2 more will be sent as they enter the 60-day window.");
    expect(
      describeSave(
        { pushed: "nudged", suppressedRules: 0, retiredPickups: 0, cells: 2, pushWindow: { now: 1, later: 1 } },
        "Mews",
      ),
    ).toBe("Saved. 1 night sending to Mews now; 1 more will be sent as it enters the 60-day window.");
    // Straddling on a hotel with no nudge configured: the near nights go on the cycle.
    expect(
      describeSave(
        { pushed: "next_cycle", suppressedRules: 0, retiredPickups: 0, cells: 3, pushWindow: { now: 2, later: 1 } },
        "Cloudbeds",
      ),
    ).toBe(
      "Saved. 2 nights sending to Cloudbeds on the next cycle (about 5 min); 1 more will be sent as it enters the 60-day window.",
    );
  });

  it("keeps the single-state sentences when the range sits on one side of the window", () => {
    expect(
      describeSave(
        { pushed: "nudged", suppressedRules: 0, retiredPickups: 0, cells: 3, pushWindow: { now: 3, later: 0 } },
        "Cloudbeds",
      ),
    ).toBe("Saved. Sending to Cloudbeds now.");
    expect(
      describeSave(
        { pushed: "beyond_window", suppressedRules: 0, retiredPickups: 0, cells: 3, pushWindow: { now: 0, later: 3 } },
        "Cloudbeds",
      ),
    ).toBe("Saved. It will be sent when the date enters the 60-day push window.");
    // Simulation never claims to send anything, straddling or not.
    expect(
      describeSave(
        { pushed: "simulation", suppressedRules: 0, retiredPickups: 0, cells: 4, pushWindow: { now: 2, later: 2 } },
        "Cloudbeds",
      ),
    ).toBe("Saved (simulation: not sent to Cloudbeds).");
  });

  it("names the window the server says the push uses", () => {
    expect(
      describeSave(
        { pushed: "nudged", suppressedRules: 0, retiredPickups: 0, cells: 4, pushWindow: { now: 2, later: 2, days: 30 } },
        "Cloudbeds",
      ),
    ).toBe("Saved. 2 nights sending to Cloudbeds now; 2 more will be sent as they enter the 30-day window.");
    expect(
      describeSave(
        { pushed: "beyond_window", suppressedRules: 0, retiredPickups: 0, cells: 1, pushWindow: { now: 0, later: 1, days: 90 } },
        "Cloudbeds",
      ),
    ).toBe("Saved. It will be sent when the date enters the 90-day push window.");
  });

  it("still appends the paused-rules clause after the split sentence", () => {
    expect(
      describeSave(
        { pushed: "nudged", suppressedRules: 2, retiredPickups: 0, cells: 4, pushWindow: { now: 2, later: 2 } },
        "Cloudbeds",
      ),
    ).toBe(
      "Saved. 2 nights sending to Cloudbeds now; 2 more will be sent as they enter the 60-day window. Paused 2 rules on these 4 nights for this room; new rules will apply on top.",
    );
  });

  it("counts the nights when the save covered a range", () => {
    expect(
      describeSave({ pushed: "nudged", suppressedRules: 6, retiredPickups: 0, cells: 3 }, "Cloudbeds"),
    ).toContain("Paused 6 rules on these 3 nights");
    expect(
      describeSave({ pushed: "nudged", suppressedRules: 1, retiredPickups: 0, cells: 1 }, "Cloudbeds"),
    ).toContain("on this night");
  });
});

describe("describeClear", () => {
  it("says how many nights went back to MAYA", () => {
    expect(describeClear(1)).toBe("Cleared. MAYA is pricing this night again.");
    expect(describeClear(undefined)).toBe("Cleared. MAYA is pricing this night again.");
    expect(describeClear(3)).toBe("Cleared 3 nights. MAYA is pricing them again.");
  });
});
