/**
 * The derivations behind the analytics panel. deriveEvents is the one that can
 * lie: a long-standing customer misread as "new," or a churn counted twice,
 * turns the growth chart into fiction.
 */
import { describe, expect, it } from "vitest";
import {
  aggregateSeries,
  deriveEvents,
  loadAnalyticsRange,
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
  it("counts paying money only — a trial is served but collects nothing", () => {
    // The chart and the MRR tile have to agree, and the tile has always
    // excluded trials. A trialing row carrying money here is what made the
    // same screen show two different MRRs.
    const rows = [
      { day: "2026-08-01", entitled: true, status: "active", list_mrr_cents: 100, net_mrr_cents: 80 },
      { day: "2026-08-01", entitled: true, status: "past_due", list_mrr_cents: 50, net_mrr_cents: 50 },
      { day: "2026-08-01", entitled: true, status: "trialing", list_mrr_cents: 30, net_mrr_cents: 30 },
      { day: "2026-08-01", entitled: false, status: "canceled", list_mrr_cents: 0, net_mrr_cents: 0 },
    ];
    expect(aggregateSeries(rows)).toEqual([
      { day: "2026-08-01", listMrrCents: 150, netMrrCents: 130, paying: 2, trialing: 1 },
    ]);
  });
});

describe("deriveEvents", () => {
  const d = (day: string, hotel_id: string, entitled: boolean, status = entitled ? "active" : "canceled") => ({
    day,
    hotel_id,
    entitled,
    status,
  });

  it("does not report the table's first day as a stampede of signups", () => {
    // The snapshot table starts empty and has no backfill, so its first day is
    // a census of who already existed. Counting it as acquisition reported the
    // entire customer base as new — for the whole default 30-day window.
    const rows = [d("2026-08-01", "h1", true), d("2026-08-01", "h2", true), d("2026-08-02", "h3", true)];
    const ev = deriveEvents(rows, "2026-08-01", "2026-08-31");
    expect(ev.newPaying).toEqual([{ hotelId: "h3", day: "2026-08-02" }]);
  });

  it("tracks churn and a return once the table has a history", () => {
    const rows = [
      d("2026-07-31", "h0", true),
      d("2026-08-01", "h1", true),
      d("2026-08-02", "h1", false),
      d("2026-08-03", "h1", true),
    ];
    const ev = deriveEvents(rows, "2026-08-01", "2026-08-03");
    expect(ev.newPaying).toEqual([{ hotelId: "h1", day: "2026-08-01" }]);
    expect(ev.churned).toEqual([{ hotelId: "h1", day: "2026-08-02" }]);
    expect(ev.wonBack).toEqual([{ hotelId: "h1", day: "2026-08-03" }]);
  });

  it("a trial starting is not an acquisition; converting is", () => {
    const rows = [
      d("2026-07-31", "h0", true),
      d("2026-08-01", "h1", true, "trialing"),
      d("2026-08-05", "h1", true, "active"),
    ];
    const ev = deriveEvents(rows, "2026-08-01", "2026-08-31");
    expect(ev.newPaying).toEqual([{ hotelId: "h1", day: "2026-08-05" }]);
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

describe("scoping test properties out", () => {
  /** Records every table read and the filters applied to it. */
  function fakeAdmin() {
    const seen: { table: string; eq: [string, unknown][] }[] = [];
    const builder = (table: string) => {
      const eq: [string, unknown][] = [];
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          eq.push([col, val]);
          return b;
        },
        in: () => b,
        gte: () => b,
        lte: () => b,
        not: () => b,
        or: () => b,
        order: () => b,
        limit: () => b,
        range: () => {
          seen.push({ table, eq });
          return Promise.resolve({ data: [], error: null });
        },
      };
      return b;
    };
    return {
      admin: {
        from: builder,
        auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } },
      } as never,
      seen,
      filtersFor: (table: string) => seen.filter((q) => q.table === table).flatMap((q) => q.eq),
    };
  }

  it("filters test properties out of both the hotel list and the money history", async () => {
    const { admin, filtersFor } = fakeAdmin();
    await loadAnalyticsRange(admin, "2026-08-01", "2026-08-05", { includeTest: false });
    // The hotels list decides who gets named; the snapshot table decides the
    // money. Filtering one without the other is how a test property's revenue
    // survives on the chart while its name is hidden.
    expect(filtersFor("hotels")).toContainEqual(["is_test", false]);
    expect(filtersFor("hotel_metrics_daily")).toContainEqual(["is_test", false]);
  });

  it("drops both filters when test properties are explicitly included", async () => {
    const { admin, filtersFor } = fakeAdmin();
    await loadAnalyticsRange(admin, "2026-08-01", "2026-08-05", { includeTest: true });
    expect(filtersFor("hotels").some(([c]) => c === "is_test")).toBe(false);
    expect(filtersFor("hotel_metrics_daily").some(([c]) => c === "is_test")).toBe(false);
  });
});
