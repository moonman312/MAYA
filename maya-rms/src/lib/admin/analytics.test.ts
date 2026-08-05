/**
 * The derivations behind the analytics panel. deriveEvents is the one that can
 * lie: a long-standing customer misread as "new," or a churn counted twice,
 * turns the growth chart into fiction.
 */
import { describe, expect, it } from "vitest";
import {
  aggregateSeries,
  deriveEvents,
  medianOf,
  monthlyListCents,
  monthlyNetCents,
} from "./analytics";

describe("monthly money", () => {
  it("divides annual back to a month-equivalent", () => {
    expect(monthlyListCents(24, "year")).toBe(Math.round(Math.round(24 * 500 * 12 * 0.9) / 12));
    expect(monthlyListCents(24, "month")).toBe(12000);
  });

  it("nets a percent code and floors an amount code at zero", () => {
    expect(monthlyNetCents(12000, { kind: "percent_off", percent_off: 75, amount_off_cents: null })).toBe(3000);
    expect(monthlyNetCents(11000, { kind: "amount_off", percent_off: null, amount_off_cents: 100000 })).toBe(0);
    expect(monthlyNetCents(12000, { kind: "trial", percent_off: null, amount_off_cents: null })).toBe(12000);
    expect(monthlyNetCents(12000, null)).toBe(12000);
  });
});

describe("aggregateSeries", () => {
  it("sums entitled money per day and counts trials separately", () => {
    const rows = [
      { day: "2026-08-01", entitled: true, status: "active", list_mrr_cents: 100, net_mrr_cents: 80 },
      { day: "2026-08-01", entitled: true, status: "past_due", list_mrr_cents: 50, net_mrr_cents: 50 },
      { day: "2026-08-01", entitled: true, status: "trialing", list_mrr_cents: 30, net_mrr_cents: 30 },
      { day: "2026-08-01", entitled: false, status: "canceled", list_mrr_cents: 0, net_mrr_cents: 0 },
    ];
    expect(aggregateSeries(rows)).toEqual([
      { day: "2026-08-01", listMrrCents: 180, netMrrCents: 160, entitled: 3, trialing: 1 },
    ]);
  });
});

describe("deriveEvents", () => {
  const d = (day: string, hotel_id: string, entitled: boolean) => ({ day, hotel_id, entitled });

  it("calls a first-ever entitled day new, and a return a win-back", () => {
    const rows = [
      d("2026-08-01", "h1", true),
      d("2026-08-02", "h1", false),
      d("2026-08-03", "h1", true),
    ];
    const ev = deriveEvents(rows, "2026-08-01", "2026-08-03");
    expect(ev.newPaying).toEqual([{ hotelId: "h1", day: "2026-08-01" }]);
    expect(ev.churned).toEqual([{ hotelId: "h1", day: "2026-08-02" }]);
    expect(ev.wonBack).toEqual([{ hotelId: "h1", day: "2026-08-03" }]);
  });

  it("does not call a long-standing customer new on the window's first day", () => {
    const rows = [d("2026-07-01", "h1", true), d("2026-08-01", "h1", true)];
    const ev = deriveEvents(rows, "2026-08-01", "2026-08-31");
    expect(ev.newPaying).toEqual([]);
    expect(ev.wonBack).toEqual([]);
  });

  it("reports only events inside the range, using history from before it", () => {
    const rows = [
      d("2026-07-01", "h1", true),
      d("2026-07-15", "h1", false),
      d("2026-08-02", "h1", true),
    ];
    const ev = deriveEvents(rows, "2026-08-01", "2026-08-31");
    expect(ev.churned).toEqual([]);
    expect(ev.wonBack).toEqual([{ hotelId: "h1", day: "2026-08-02" }]);
  });
});

describe("medianOf", () => {
  it("handles empty, odd and even", () => {
    expect(medianOf([])).toBeNull();
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([1, 2, 3, 4])).toBe(2.5);
  });
});
