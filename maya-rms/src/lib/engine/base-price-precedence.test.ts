/**
 * Regression for a measured live defect: a guest booking taken AT MAYA's own
 * pushed price became the cell's base, so the night was permanently repriced
 * and deactivating the rule reverted to the raised number instead of the
 * property's rate. Reproduced on the sandbox as $200 -> $230 -> booked at $230
 * -> $264.50, reverting to $230 while never-sold rooms returned to $200.
 */
import { describe, expect, it } from "vitest";
import { resolveBase, resolveBasePrice } from "./base-price";

describe("base price precedence", () => {
  it("prefers the property's own rate over a booking taken at OUR price", () => {
    // The exact shape of the bug: calendar says the hotel charges 200; the
    // newest reservation says 230 because that guest paid what MAYA published.
    expect(resolveBasePrice({ calendar: 200, reservation: 230, remembered: 200 })).toBe(200);
  });

  it("still reverts to the property's rate once every room has sold at our price", () => {
    expect(resolveBasePrice({ calendar: 200, reservation: 264.5 })).toBe(200);
  });

  it("falls back to the reservation when no calendar has been captured", () => {
    // Existing hotels with no calendar keep today's behaviour exactly.
    expect(resolveBasePrice({ reservation: 180, remembered: 200 })).toBe(180);
  });

  it("treats a genuine zero rate as a real rate, not a missing one", () => {
    // Comp / house-use nights: 0 is a price, and truthiness would skip it.
    expect(resolveBasePrice({ reservation: 0, remembered: 200 })).toBe(0);
    expect(resolveBasePrice({ calendar: 0, reservation: 200 })).toBe(0);
  });

  it("falls back to the remembered base when there is neither calendar nor booking", () => {
    expect(resolveBasePrice({ remembered: 195 })).toBe(195);
  });

  it("returns undefined when nothing is known, so the cell is skipped", () => {
    expect(resolveBasePrice({})).toBeUndefined();
    expect(resolveBasePrice({ reservation: null })).toBeUndefined();
  });
});

describe("manual price override precedence", () => {
  // A typed number is a reset point for the cell. It has to sit above the
  // calendar, or the scheduled tick outranks it five minutes later and the
  // hotelier's number never reaches the PMS.
  it("a manual price beats calendar, reservation and remembered together", () => {
    expect(resolveBasePrice({ manual: 150, calendar: 200, reservation: 230, remembered: 200 })).toBe(150);
    expect(resolveBase({ manual: 150, calendar: 200, reservation: 230, remembered: 200 })).toEqual({
      price: 150,
      source: "manual",
    });
  });

  it("a manual 0 is a real rate, not a missing one", () => {
    expect(resolveBase({ manual: 0, calendar: 200 })).toEqual({ price: 0, source: "manual" });
  });

  it("without a manual price the existing order is unchanged, and says which tier won", () => {
    expect(resolveBase({ calendar: 200, reservation: 230, remembered: 200 })).toEqual({
      price: 200,
      source: "calendar",
    });
    expect(resolveBase({ reservation: 180, remembered: 200 })).toEqual({
      price: 180,
      source: "reservation",
    });
    expect(resolveBase({ remembered: 195 })).toEqual({ price: 195, source: "remembered" });
    expect(resolveBase({})).toBeUndefined();
    // `manual: undefined` is what a cell with no open override passes.
    expect(resolveBase({ manual: undefined, calendar: 200 })).toEqual({ price: 200, source: "calendar" });
  });
});
