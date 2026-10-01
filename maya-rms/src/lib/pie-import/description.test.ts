import { describe, expect, it } from "vitest";
import { parseDescription } from "./description";
import { fixDigits, nameKey, parseMoney, parseNumber, parsePieDate, tidy } from "./text";

const ok = (text: string) => {
  const read = parseDescription(text);
  if (!read.ok) throw new Error(`not read: ${text} (${read.reason})`);
  return read;
};

describe("PIE's description template", () => {
  it("reads a raise with a booking window", () => {
    expect(ok("Raise rate by 10.00 % when occupancy is greater than 31.00 % and when booking 80-800 days in advance")).toEqual({
      ok: true,
      complete: true,
      rule: {
        direction: "raise",
        kind: "percent",
        amount: 10,
        occupancyOp: "gt",
        threshold: 31,
        scope: { kind: "overall" },
        window: { from: 80, to: 800 },
      },
    });
  });

  it("reads a raise with no window", () => {
    const read = ok("Raise rate by 12.00 % when occupancy is greater than 87.00 %");
    expect(read.complete).toBe(true);
    expect(read.rule).toMatchObject({ amount: 12, threshold: 87, window: null, occupancyOp: "gt" });
  });

  it("reads a lower with a window from today", () => {
    const read = ok("Lower rate by 10.00 % when occupancy is lower than 20.00 % and when booking today-28 days in advance");
    expect(read.rule).toMatchObject({ direction: "lower", occupancyOp: "lt", threshold: 20, window: { from: 0, to: 28 } });
  });

  it("reads a fixed amount, with or without a currency sign", () => {
    expect(ok("Raise rate by 5.00 when occupancy is greater than 60.00 %").rule).toMatchObject({ kind: "fixed", amount: 5 });
    expect(ok("Lower rate by $12.50 when occupancy is less than 20.00 %").rule).toMatchObject({
      kind: "fixed",
      direction: "lower",
      amount: 12.5,
      occupancyOp: "lt",
    });
    expect(ok("Raise rate by 1,250.00 when occupancy is greater than 90.00 %").rule.amount).toBe(1250);
  });

  it("reads 'less than', 'or equal to' and 'equal to'", () => {
    expect(ok("Lower rate by 5.00 % when occupancy is less than 30.00 %").rule.occupancyOp).toBe("lt");
    expect(ok("Raise rate by 5.00 % when occupancy is greater than or equal to 60.00 %").rule.occupancyOp).toBe("gte");
    expect(ok("Lower rate by 5.00 % when occupancy is lower than or equal to 30.00 %").rule.occupancyOp).toBe("lte");
    expect(ok("Raise rate by 5.00 % when occupancy is equal to 50.00 %").rule.occupancyOp).toBe("eq");
  });

  it("reads room type wording: individual, combined, or named", () => {
    expect(ok("Raise rate by 10.00 % when individual occupancy of Loft Suite, Garden Room is greater than 50.00 %").rule.scope).toEqual({
      kind: "individual",
      names: ["Loft Suite", "Garden Room"],
    });
    expect(ok("Raise rate by 10.00 % when combined occupancy of Suites and Lofts is greater than 50.00 %").rule.scope).toEqual({
      kind: "combined",
      names: ["Suites", "Lofts"],
    });
    expect(ok("Raise rate by 10.00 % for Tree House - ADA when occupancy is greater than 50.00 %").rule.scope).toEqual({
      kind: "combined",
      names: ["Tree House - ADA"],
    });
    expect(ok("Raise rate by 10.00 % when overall occupancy is greater than 50.00 %").rule.scope).toEqual({ kind: "overall" });
    expect(ok("Raise rate by 10.00 % when individual occupancy is greater than 50.00 %").rule.scope).toEqual({ kind: "individual", names: [] });
  });

  it("takes OCR noise: spacing, look-alike digits, a decimal comma, stray marks", () => {
    const read = ok("  Raise  rate by 1O.00% when occupancy is  greater than 3l.00 %  and when  booking 8O-800 days in advance .");
    expect(read.rule).toMatchObject({ amount: 10, threshold: 31, window: { from: 80, to: 800 } });
    expect(ok("Lower rate by 10,00 % when occupancy is lower than 20,50 % and when booking t0day-28 days in advance").rule).toMatchObject({
      amount: 10,
      threshold: 20.5,
      window: { from: 0, to: 28 },
    });
    expect(ok("Raise rate by 12.00 % when occupancy is greater than 96.00 % ~").complete).toBe(true);
    expect(ok("Raise rate bv 4.00 % when occupancy is greater than 77.00 %").rule.amount).toBe(4);
  });

  it("marks a description cut off at the screenshot's edge", () => {
    // The window started and the rest is below the edge (or unreadable).
    const cut = ok("Lower rate by 10.00 % when occupancy is lower than 30.00 % and qe 4 xv | Rk W. Lb pttz");
    expect(cut.complete).toBe(false);
    expect(cut.rule).toMatchObject({ direction: "lower", threshold: 30, window: null });
    expect(ok("Raise rate by 10.00 % when occupancy is greater than 38.00 % and when booking 50-").complete).toBe(false);
    // The % never came.
    expect(ok("Raise rate by 12.00 % when occupancy is greater than 96.00").complete).toBe(false);
    expect(parseDescription("Raise rate by 12.00 % when occupancy is")).toEqual({ ok: false, reason: "cut", direction: "raise" });
    expect(parseDescription("Raise rate by")).toMatchObject({ ok: false, reason: "cut" });
  });

  it("says when it is not a rate rule, or can't be read", () => {
    expect(parseDescription("Close to arrival when occupancy is greater than 90.00 %")).toEqual({ ok: false, reason: "not_rate" });
    expect(parseDescription("")).toEqual({ ok: false, reason: "not_rate" });
    expect(parseDescription("Raise rate by 10.00 % when pickup is greater than 5")).toMatchObject({ ok: false, reason: "unreadable" });
    expect(parseDescription("Raise rate by 10.00 % when occupancy is greater than 140.00 %")).toMatchObject({ ok: false, reason: "unreadable" });
    expect(parseDescription("Raise rate by 10.00 % when occupancy is greater than 40.00 % or when it rains")).toMatchObject({
      ok: false,
      reason: "unreadable",
    });
    expect(parseDescription("Raise rate by 10.00 % when occupancy is greater than 40.00 % and when booking 90-30 days in advance")).toMatchObject({
      ok: false,
      reason: "unreadable",
    });
  });
});

describe("text helpers", () => {
  it("fixes look-alike letters only inside numbers", () => {
    expect(fixDigits("1O.00")).toBe("10.00");
    expect(fixDigits("3l%")).toBe("31%");
    expect(fixDigits("SOLD")).toBe("SOLD");
    expect(fixDigits("OIl1")).toBe("OIl1");
    expect(tidy("Raise rate  by   1O.00 %")).toBe("Raise rate by 10.00 %");
  });

  it("reads numbers and money as PIE prints them", () => {
    expect(parseNumber("3,500.00")).toBe(3500);
    expect(parseNumber("10,00")).toBe(10);
    expect(parseNumber("1.234,50")).toBe(1234.5);
    expect(parseNumber("abc")).toBeNull();
    expect(parseMoney("$1,234.00")).toBe(1234);
    expect(parseMoney("€ 139,00")).toBe(139);
    expect(parseMoney("139.00")).toBe(139);
    expect(parseMoney("$")).toBeNull();
  });

  it("compares names case and spacing aside", () => {
    expect(nameKey("  Tree House - ADA ")).toBe(nameKey("tree house-ada"));
    expect(nameKey("Garden  Room")).toBe("garden room");
  });

  it("reads PIE's dates, N/A as none", () => {
    expect(parsePieDate("N/A")).toEqual({ kind: "none" });
    expect(parsePieDate("N/A I")).toEqual({ kind: "none" });
    expect(parsePieDate("")).toEqual({ kind: "none" });
    expect(parsePieDate("10/15/2026")).toEqual({ kind: "date", date: "2026-10-15", ambiguous: false });
    expect(parsePieDate("03/04/2027")).toEqual({ kind: "date", date: "2027-03-04", ambiguous: true });
    expect(parsePieDate("25/12/2026")).toEqual({ kind: "date", date: "2026-12-25", ambiguous: false });
    expect(parsePieDate("Oct 15, 2026")).toEqual({ kind: "date", date: "2026-10-15", ambiguous: false });
    expect(parsePieDate("2026-11-02")).toEqual({ kind: "date", date: "2026-11-02", ambiguous: false });
    expect(parsePieDate("someday")).toEqual({ kind: "unreadable" });
  });
});
