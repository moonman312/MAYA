/**
 * The windows a property's business numbers are shown for, in the hotel's
 * own days, each within one staff_hotel_business_numbers() call.
 */
import { describe, expect, it } from "vitest";
import { BUSINESS_NUMBERS_MAX_NIGHTS } from "./business-numbers";
import { BUSINESS_WINDOWS, businessWindow } from "./business-window";

const nights = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;

describe("businessWindow", () => {
  it("counts back from yesterday or forward from today", () => {
    expect(businessWindow("last30", "2026-09-30")).toMatchObject({ from: "2026-08-31", to: "2026-09-29" });
    expect(businessWindow("next30", "2026-09-30")).toMatchObject({ from: "2026-09-30", to: "2026-10-29" });
    expect(businessWindow("next90", "2026-09-30")).toMatchObject({ from: "2026-09-30", to: "2026-12-28" });
    expect(businessWindow("last365", "2026-09-30")).toMatchObject({ from: "2025-09-30", to: "2026-09-29" });
  });

  it("falls back to the last 30 nights for anything else", () => {
    for (const raw of [undefined, "", "all", ["next30"], 3]) expect(businessWindow(raw, "2026-03-01").key).toBe("last30");
  });

  it("never asks for more nights than one call allows", () => {
    for (const w of BUSINESS_WINDOWS) {
      const { from, to } = businessWindow(w.key, "2028-02-29");
      expect(nights(from, to)).toBeLessThanOrEqual(BUSINESS_NUMBERS_MAX_NIGHTS);
    }
  });
});
