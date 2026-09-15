import { describe, expect, it } from "vitest";
import { describeClear, describeSave } from "./manual-price-editor";

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
