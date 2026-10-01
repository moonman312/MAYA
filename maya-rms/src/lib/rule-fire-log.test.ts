import { describe, expect, it } from "vitest";
import { modeTimelineFrom } from "@/lib/price-mode";
import {
  adjustmentLabel,
  buildFireItem,
  decodeCursor,
  encodeCursor,
  hotelTimeExact,
  hotelTimeLabel,
  laterLines,
  ownNumbersMetrics,
  whyLines,
  type FireLogContext,
  type FireLogRow,
  type FireLogRule,
} from "@/lib/rule-fire-log";

const NOW = new Date("2026-10-01T16:00:00Z");
const LIVE_FROM = "2026-09-20T12:00:00Z";
const timeline = modeTimelineFrom([
  { since: "-infinity", simulated: true, recorded_at: "2026-09-30T00:00:00Z" },
  { since: LIVE_FROM, simulated: false, recorded_at: LIVE_FROM },
]);

const rule: FireLogRule = {
  id: "r1",
  name: "Busy nights",
  enabled: true,
  version: 3,
  condition: { occupancy_operator: "gt", occupancy_threshold: 0.7, dta_operator: "lt", dta_threshold_days: 21 },
  measured: null,
};

const row = (over: Partial<FireLogRow> = {}): FireLogRow => ({
  kind: "ladder",
  event_id: "e1",
  sort_key: "k",
  fired_at: "2026-09-25T18:05:00Z",
  stay_date: "2026-11-13",
  room_type_id: "q",
  rule_version: 3,
  action_kind: "percent",
  action_direction: "increase",
  action_value: "10.0000",
  metrics: { occupancy: 0.72, dta: 12 },
  price_before: "150.00",
  price_after: "165.00",
  ...over,
});

const ctx = (over: Partial<FireLogContext> = {}): FireLogContext => ({
  rule,
  roomTypeNames: new Map([["q", "Queen"]]),
  currencySymbol: "$",
  timezone: "America/New_York",
  modeTimeline: timeline,
  pmsType: "cloudbeds",
  sendFacts: null,
  now: NOW,
  ...over,
});

describe("the fire log's words", () => {
  it("names the adjustment as the rules list does, in the property's currency", () => {
    expect(adjustmentLabel("percent", "increase", "10.0000", "$")).toBe("+10%");
    expect(adjustmentLabel("percent", "decrease", 12.5, "$")).toBe("-12.5%");
    expect(adjustmentLabel("fixed", "increase", 15, "€")).toBe("+€15");
    expect(adjustmentLabel("fixed", "decrease", "12.5", "$")).toBe("-$12.50");
  });

  it("tells the time in the property's zone, with the year only when it isn't this year", () => {
    expect(hotelTimeLabel("2026-09-25T18:05:00Z", "America/New_York", NOW)).toBe("Sep 25, 2:05 PM");
    expect(hotelTimeLabel("2025-12-31T18:05:00Z", "America/New_York", NOW)).toBe("Dec 31, 2025, 1:05 PM");
    expect(hotelTimeExact("2026-09-25T18:05:07Z", "America/New_York")).toBe("Sep 25, 2026, 2:05:07 PM EDT");
    // An unknown zone reads as UTC rather than failing.
    expect(hotelTimeLabel("2026-09-25T18:05:00Z", "Not/AZone", NOW)).toBe("Sep 25, 6:05 PM");
  });

  it("words a simulated fire as what would have happened, and a live one as it was", () => {
    const sim = buildFireItem(row({ fired_at: "2026-09-18T12:00:00Z" }), ctx());
    expect(sim).toMatchObject({
      mode: "simulation",
      night: "Fri Nov 13",
      adjustment: "+10%",
      price_line: "Simulation: the price for Fri Nov 13, Queen would have gone from $150.00 to $165.00.",
      send_state: "simulated",
      send_line: "Nothing was sent to Cloudbeds.",
    });
    const same = buildFireItem(row({ fired_at: "2026-09-18T12:00:00Z", price_before: null, clamped_by: "ceiling" }), ctx());
    expect(same.price_line).toBe("Simulation: the price for Fri Nov 13, Queen would have been $165.00.");
    expect(same.price_note).toBe("It would have stopped at your ceiling.");

    const live = buildFireItem(row({ clamped_by: "floor" }), ctx());
    expect(live).toMatchObject({ mode: "live", price_line: "Queen: $150.00 to $165.00.", price_note: "It stopped at your floor." });
    // No ledger read: nothing claimed.
    expect(live.send_line).toBeNull();
    expect(buildFireItem(row({ price_before: "165.00" }), ctx()).price_line).toBe("Queen: stayed at $165.00.");
    expect(buildFireItem(row({ price_before: null }), ctx()).price_line).toBe("Queen: $165.00 after this run.");
    expect(buildFireItem(row({ price_after: null }), ctx()).price_line).toBeNull();
  });

  it("says why in the change log's words, or only the numbers once the rule was edited", () => {
    expect(whyLines(row(), rule)).toEqual(["It was 72% full with 12 days to go, past the 70% and 21-day marks you set."]);
    expect(whyLines(row({ rule_version: 2 }), rule)).toEqual(["It was 72% full.", "It had 12 days to go.", "The rule has been edited since."]);
    expect(whyLines(row({ rule_version: 2, metrics: {} }), rule)).toEqual([
      "The rule has been edited since, and the numbers it fired on aren't on record.",
    ]);
    // Nothing recorded: only that its conditions held.
    expect(whyLines(row({ metrics: null }), rule)).toEqual(["This night was past the 70% and 21-day marks you set."]);
  });

  it("reads a pickup fire's own numbers only for what its condition counts", () => {
    const pickup = { pickup_operator: "gt" as const, pickup_threshold: 4, pickup_window_days: 3 as const, pickup_metric: "room_nights" as const };
    expect(ownNumbersMetrics({ units_start: 2, units_end: 9 }, pickup)).toMatchObject({ pickup_units: 7, booking_speed: null });
    expect(ownNumbersMetrics({ units_start: 2, units_end: 9 }, { ...pickup, pickup_metric: "revenue" })).toBeNull();
    expect(ownNumbersMetrics({ window_bookings: 6, window_expected: "2.5" }, null)).toMatchObject({
      pickup_units: null,
      booking_speed: { recent: 6, expected: 2.5 },
    });
  });

  it("says what ended a fire, each for the mode at its own time, oldest first", () => {
    const lines = laterLines(
      row({ ended_at: "2026-09-27T12:00:00Z", ended_reason: "bookings_cancelled", stopped_at: "2026-09-26T12:00:00Z" }),
      ctx(),
    );
    expect(lines).toEqual(["Told to stop on this night Sep 26, 8:00 AM.", "Came off Sep 27, 8:00 AM: bookings behind it cancelled."]);
    expect(laterLines(row({ ended_at: "2026-09-19T12:00:00Z", ended_reason: "came_off" }), ctx())).toEqual([
      "Would have come off Sep 19, 8:00 AM.",
    ]);
    expect(laterLines(row({ ended_at: "2026-09-27T12:00:00Z", ended_reason: "replaced" }), ctx())).toEqual([
      "Moved to the rule's new amount Sep 27, 8:00 AM.",
    ]);
    expect(laterLines(row({ suppressed_at: "2026-09-27T12:00:00Z" }), ctx())).toEqual(["A price set by hand took over Sep 27, 8:00 AM."]);
    expect(laterLines(row({ ended_at: "2026-09-27T12:00:00Z", ended_reason: "manual_price" }), ctx())).toEqual([
      "Came off Sep 27, 8:00 AM: a price was set by hand.",
    ]);
    // A night that passed is no news.
    expect(laterLines(row({ ended_at: "2026-09-27T12:00:00Z", ended_reason: "night_passed" }), ctx())).toEqual([]);
  });

  it("hands out a cursor it takes back, and refuses anything else", () => {
    const c = { at: "2026-09-25T18:05:00.123456+00:00", key: "2026-11-13|q|ladder|e1" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    for (const bad of ["", "not a cursor", encodeCursor({ at: "yesterday", key: "k" }), "eyJ4Ijo"]) expect(decodeCursor(bad)).toBeNull();
  });

  it("uses no em dash and no word saying MAYA learns, knows or thinks", () => {
    const all = [
      ...whyLines(row({ rule_version: 2 }), rule),
      ...laterLines(row({ ended_at: "2026-09-27T12:00:00Z", ended_reason: "rule_edited", suppressed_at: "2026-09-27T13:00:00Z" }), ctx()),
      JSON.stringify(buildFireItem(row({ fired_at: "2026-09-18T12:00:00Z" }), ctx())),
    ].join(" ");
    expect(all).not.toContain("—");
    expect(all).not.toMatch(/MAYA (learns|knows|thinks)/);
  });
});
