import { describe, expect, it } from "vitest";
import {
  buildRevparScale,
  colorForRevpar,
  computeRevpar,
  isDateInPeriods,
  MIN_SERIES_DAYS,
  percentileLinear,
  scaleToThresholds,
  splitRevparSeries,
  terciles,
} from "./calendar-color";

describe("computeRevpar", () => {
  it("divides revenue by total rooms, rounded to 2dp", () => {
    expect(computeRevpar(1000, 85)).toBe(11.76);
    expect(computeRevpar(4500, 30)).toBe(150);
  });

  it("returns 0 when the property has no rooms", () => {
    expect(computeRevpar(1000, 0)).toBe(0);
    expect(computeRevpar(1000, -5)).toBe(0);
  });

  it("returns 0 for zero revenue", () => {
    expect(computeRevpar(0, 40)).toBe(0);
  });
});

describe("percentileLinear", () => {
  it("returns 0 for an empty series", () => {
    expect(percentileLinear([], 0.5)).toBe(0);
  });

  it("returns the single element regardless of p", () => {
    expect(percentileLinear([42], 0)).toBe(42);
    expect(percentileLinear([42], 1)).toBe(42);
  });

  it("interpolates linearly between closest ranks", () => {
    expect(percentileLinear([0, 10], 0.5)).toBe(5);
    expect(percentileLinear([0, 10, 20], 0.25)).toBe(5);
  });

  it("hits exact ranks without interpolation", () => {
    const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    expect(percentileLinear(series, 0)).toBe(1);
    expect(percentileLinear(series, 0.5)).toBe(6);
    expect(percentileLinear(series, 1)).toBe(11);
  });

  it("computes tercile cutoffs of 1..10 as 4 and 7 (within float tolerance)", () => {
    const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentileLinear(series, 1 / 3)).toBeCloseTo(4, 10);
    expect(percentileLinear(series, 2 / 3)).toBeCloseTo(7, 10);
  });

  it("clamps p outside [0, 1]", () => {
    expect(percentileLinear([1, 2, 3], -1)).toBe(1);
    expect(percentileLinear([1, 2, 3], 2)).toBe(3);
  });
});

describe("terciles", () => {
  it("sorts the input before computing cutoffs", () => {
    const shuffled = [10, 1, 7, 3, 9, 2, 8, 4, 6, 5];
    expect(terciles(shuffled)).toEqual({ p33: 4, p67: 7 });
  });

  it("rounds cutoffs to 2dp", () => {
    const { p33, p67 } = terciles([0, 1, 2, 4]);
    expect(p33).toBe(1);
    expect(p67).toBe(2);
    const t = terciles([0, 0.1, 0.2, 0.4]);
    expect(t.p33).toBe(0.1);
    expect(t.p67).toBe(0.2);
  });
});

describe("splitRevparSeries", () => {
  const data = [
    { date: "2026-07-01", revpar: 10 },
    { date: "2026-07-27", revpar: 20 },
    { date: "2026-07-28", revpar: 30 },
    { date: "2026-07-29", revpar: 40 },
  ];

  it("puts dates before today in past, today and later in future", () => {
    const { past, future } = splitRevparSeries(data, "2026-07-28");
    expect(past).toEqual([10, 20]);
    expect(future).toEqual([30, 40]);
  });

  it("excludes closed days from both sides", () => {
    const withClosed = [
      ...data,
      { date: "2026-07-02", revpar: 0, closed: true },
      { date: "2026-07-30", revpar: 0, closed: true },
    ];
    const { past, future } = splitRevparSeries(withClosed, "2026-07-28");
    expect(past).toEqual([10, 20]);
    expect(future).toEqual([30, 40]);
  });
});

describe("buildRevparScale", () => {
  const range = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => i + 1 + offset);

  it("judges past and future against their own series", () => {
    const past = range(12); // 1..12
    const future = range(12, 100); // 101..112
    const scale = buildRevparScale(past, future);
    expect(scale.past).not.toBeNull();
    expect(scale.future).not.toBeNull();
    expect(scale.past!.p67).toBeLessThan(scale.future!.p33);
    // A mid-pack future day is orange against its peers, not green vs history
    expect(colorForRevpar(106, scale.future)).toBe("orange");
    expect(colorForRevpar(106, scale.past)).toBe("green");
  });

  it("falls back to the combined series when one side is tiny", () => {
    const past = range(20); // 1..20
    const future = [3]; // fewer than MIN_SERIES_DAYS
    const scale = buildRevparScale(past, future);
    const combined = terciles([...past, ...future]);
    expect(scale.future).toEqual(combined);
    expect(scale.past).toEqual(terciles(past));
  });

  it("returns null sides when even the combined series is tiny", () => {
    const scale = buildRevparScale([1, 2], [3, 4]);
    expect(scale.past).toBeNull();
    expect(scale.future).toBeNull();
  });

  it("uses own series exactly at the minimum size", () => {
    const past = range(MIN_SERIES_DAYS);
    const scale = buildRevparScale(past, []);
    expect(scale.past).toEqual(terciles(past));
    // future side falls back to combined (= past here)
    expect(scale.future).toEqual(terciles(past));
  });
});

describe("colorForRevpar", () => {
  const pair = { p33: 50, p67: 100 };

  it("is red strictly below p33", () => {
    expect(colorForRevpar(49.99, pair)).toBe("red");
    expect(colorForRevpar(0, pair)).toBe("red");
  });

  it("is orange from p33 up to (not including) p67", () => {
    expect(colorForRevpar(50, pair)).toBe("orange");
    expect(colorForRevpar(99.99, pair)).toBe("orange");
  });

  it("is green at and above p67", () => {
    expect(colorForRevpar(100, pair)).toBe("green");
    expect(colorForRevpar(500, pair)).toBe("green");
  });

  it("is orange when there is no scale", () => {
    expect(colorForRevpar(500, null)).toBe("orange");
    expect(colorForRevpar(0, null)).toBe("orange");
  });
});

describe("isDateInPeriods", () => {
  const periods = [
    { start_date: "2026-01-10", end_date: "2026-01-20" },
    { start_date: "2026-03-01", end_date: "2026-03-01" },
  ];

  it("includes both boundary dates", () => {
    expect(isDateInPeriods("2026-01-10", periods)).toBe(true);
    expect(isDateInPeriods("2026-01-20", periods)).toBe(true);
    expect(isDateInPeriods("2026-03-01", periods)).toBe(true);
  });

  it("excludes dates outside every period", () => {
    expect(isDateInPeriods("2026-01-09", periods)).toBe(false);
    expect(isDateInPeriods("2026-01-21", periods)).toBe(false);
    expect(isDateInPeriods("2026-02-15", periods)).toBe(false);
  });

  it("is false with no periods", () => {
    expect(isDateInPeriods("2026-01-15", [])).toBe(false);
  });
});

describe("scaleToThresholds", () => {
  it("passes real cutoffs through", () => {
    const scale = { past: { p33: 10, p67: 20 }, future: { p33: 30, p67: 40 } };
    expect(scaleToThresholds(scale)).toEqual({
      basis: "revpar",
      past: { p33: 10, p67: 20 },
      future: { p33: 30, p67: 40 },
    });
  });

  it("degenerates null sides to zeros", () => {
    expect(scaleToThresholds({ past: null, future: null })).toEqual({
      basis: "revpar",
      past: { p33: 0, p67: 0 },
      future: { p33: 0, p67: 0 },
    });
  });
});
