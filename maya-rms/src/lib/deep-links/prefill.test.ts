import { describe, expect, it } from "vitest";
import { links } from "@/lib/deep-links";
import { builderFill, testRuleFill } from "@/lib/deep-links/prefill";
import { readPlace, writePlace } from "@/lib/deep-links/dashboard-url";

const strip = <T extends { id: string }>(rows: T[] | undefined) => rows?.map(({ id: _id, ...r }) => (void _id, r));

describe("builderFill", () => {
  it("builds exactly the conditions the link names, in the builder's order", () => {
    const { params } = links.parseLink("rules.new", "name=Slow-date+rescue%2C+not+full&speed=much_slower&over=30&wait=7&occupancy=lt50&direction=decrease&percent=15");
    const fill = builderFill(params);
    expect(fill.name).toBe("Slow-date rescue, not full");
    expect(fill.direction).toBe("decrease");
    expect(fill.percent).toBe("15");
    expect(fill.dollars).toBeUndefined();
    expect(strip(fill.rows)).toEqual([
      expect.objectContaining({ metric: "occupancy", operator: "lt", value: "50" }),
      expect.objectContaining({
        metric: "booking_speed",
        booking_speed_level: "much_slower",
        booking_speed_window_days: 30,
        booking_speed_cooldown_days: 7,
      }),
    ]);
  });

  it("keeps the builder's defaults for what the link leaves out", () => {
    const fill = builderFill(links.parseLink("rules.new", "speed=faster").params);
    expect(fill.rows?.[0]).toMatchObject({ metric: "booking_speed", booking_speed_window_days: 7, booking_speed_cooldown_days: 7 });
    expect(fill.direction).toBeUndefined();
    expect(fill.percent).toBeUndefined();
    expect(builderFill({})).toEqual({});
  });

  it("maps pickup's lookback and measure, a fixed amount, and the split box", () => {
    const fill = builderFill(links.parseLink("rules.new", "pickup=gt4.5&lookback=7&measures=revenue&amount=20&split=1&direction=increase").params);
    expect(fill.rows?.[0]).toMatchObject({ metric: "pickup", operator: "gt", value: "4.5", pickup_window_days: 7, pickup_metric: "revenue" });
    expect(fill.dollars).toBe("20");
    expect(fill.percent).toBeUndefined();
    expect(fill.split).toBe(true);
  });

  it("fills one amount at most, the percent when a hand-made link names both", () => {
    expect(links.parseLink("rules.new", "percent=10&amount=20").params.amount).toBeUndefined();
    const fill = builderFill({ percent: "10", amount: "20" });
    expect(fill.percent).toBe("10");
    expect(fill.dollars).toBeUndefined();
  });
});

describe("testRuleFill", () => {
  it("takes what the test rule form has, and the night", () => {
    const fill = testRuleFill(links.parseLink("simulator.test-rule", "name=Last+minute&window=lt3&occupancy=lt50&direction=decrease&percent=15&stay_in=1&night_speed=none").params);
    expect(fill).toMatchObject({ name: "Last minute", direction: "decrease", kind: "percent", amount: "15", stayIn: 1, nightSpeed: "" });
    expect(fill.rows?.map((r) => r.metric)).toEqual(["occupancy", "booking_window"]);
    expect(testRuleFill({ amount: "12.5" })).toMatchObject({ kind: "fixed", amount: "12.5" });
  });
});

describe("the dashboard's address", () => {
  const now = new Date("2026-09-24T12:00:00Z");
  it("reads and writes each tab's own keys, leaving defaults out", () => {
    expect(readPlace("", now)).toEqual({ tab: "calendar", panel: null, year: 2026, month: 9, day: null, filter: "all", view: "changes" });
    expect(readPlace("?date=2026-10-03", now)).toMatchObject({ tab: "calendar", year: 2026, month: 10, day: 3 });
    expect(readPlace("?month=2026-12&date=2027-01-05", now)).toMatchObject({ year: 2027, month: 1, day: 5 });
    expect(readPlace("?tab=rules&panel=builder&filter=enabled", now)).toMatchObject({ tab: "rules", panel: "builder", filter: "enabled" });
    expect(readPlace("?tab=rules&panel=corrections&view=all&month=2026-12", now)).toMatchObject({ panel: null, view: "changes", month: 9 });
    expect(readPlace("?tab=nope&date=2026-02-30", now)).toMatchObject({ tab: "calendar", day: null, month: 9 });

    for (const q of ["", "tab=rules&panel=builder&filter=enabled", "month=2026-12", "date=2026-10-03", "tab=changelog&panel=corrections&view=all", "tab=simulator&panel=test-rule", "tab=pms"]) {
      expect(writePlace(readPlace(q, now), now)).toBe(q);
    }
    expect(writePlace({ ...readPlace("", now), year: 2026, month: 9 }, now)).toBe("");
  });
});
