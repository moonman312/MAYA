/**
 * Which number the rules start from, and which they never do.
 *
 * Once a measured live defect: a guest booking taken AT MAYA's own pushed
 * price became the cell's base, so the night was permanently repriced and
 * deactivating the rule reverted to the raised number instead of the
 * property's rate ($200 -> $230 -> booked at $230 -> $264.50 on the sandbox).
 * Then a subtler one (audit A6): a night the PMS had no rate for was priced
 * on its latest booking, and ratcheted with every booking taken at MAYA's
 * price. Decided 2026-09-29: a booking's rate is never a base, and neither
 * is the base remembered from an earlier run. Only a typed price or the
 * property's own rate on record.
 */
import { describe, expect, it } from "vitest";
import { resolveBase, resolveBasePrice } from "./base-price";

describe("base price precedence", () => {
  it("prices on the property's own rate", () => {
    expect(resolveBasePrice({ calendar: 200 })).toBe(200);
    expect(resolveBase({ calendar: 200 })).toEqual({ price: 200, source: "calendar" });
  });

  it("treats a genuine zero rate as a real rate, not a missing one", () => {
    // Comp / house-use nights: 0 is a price, and truthiness would skip it.
    expect(resolveBasePrice({ calendar: 0 })).toBe(0);
  });

  it("returns undefined when there is no rate on record, so the cell is skipped", () => {
    expect(resolveBasePrice({})).toBeUndefined();
    expect(resolveBasePrice({ calendar: undefined })).toBeUndefined();
    expect(resolveBase({ manual: undefined, calendar: undefined })).toBeUndefined();
  });

  it("knows no booking and no remembered base: neither is a source it can be handed", () => {
    // The type has two slots. Anything else a caller might pass is ignored,
    // so a booking's rate cannot come back as a base by a side door.
    const src = { calendar: undefined, reservation: 230, remembered: 200 } as unknown as Parameters<typeof resolveBase>[0];
    expect(resolveBase(src)).toBeUndefined();
  });
});

describe("manual price override precedence", () => {
  // A typed number is a reset point for the cell. It has to sit above the
  // calendar, or the scheduled tick outranks it five minutes later and the
  // hotelier's number never reaches the PMS.
  it("a manual price beats the calendar", () => {
    expect(resolveBasePrice({ manual: 150, calendar: 200 })).toBe(150);
    expect(resolveBase({ manual: 150, calendar: 200 })).toEqual({ price: 150, source: "manual" });
  });

  it("a manual price is a base on its own, with no rate on record", () => {
    expect(resolveBase({ manual: 150 })).toEqual({ price: 150, source: "manual" });
  });

  it("a manual 0 is a real rate, not a missing one", () => {
    expect(resolveBase({ manual: 0, calendar: 200 })).toEqual({ price: 0, source: "manual" });
  });

  it("without a manual price the calendar wins, and says so", () => {
    expect(resolveBase({ calendar: 200 })).toEqual({ price: 200, source: "calendar" });
    // `manual: undefined` is what a cell with no open override passes.
    expect(resolveBase({ manual: undefined, calendar: 200 })).toEqual({ price: 200, source: "calendar" });
  });
});
