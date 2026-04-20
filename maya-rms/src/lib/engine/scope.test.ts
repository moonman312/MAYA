import { describe, expect, it } from "vitest";
import { ruleScopeMatches } from "./scope";
import type { EngineRule } from "@/types/domain";

function makeRule(overrides: Partial<EngineRule> = {}): EngineRule {
  return {
    id: "r1",
    hotel_id: "h1",
    name: "Test",
    is_active: true,
    version: 1,
    start_date: null,
    end_date: null,
    is_annual: false,
    dow_mask: 127,
    action_type: "percent",
    action_direction: "increase",
    action_value: 10,
    priority: 100,
    is_pickup_rule: false,
    condition: { occupancy_operator: "gt", occupancy_threshold: 0.5 },
    signal_room_type_ids: ["rt1"],
    affected_room_type_ids: ["rt1"],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("scope filters (§15.1)", () => {
  it("matches when no date window is set", () => {
    expect(ruleScopeMatches(makeRule(), "2026-07-15", "2026-07-15T02:30:00Z")).toBe(true);
  });

  it("literal date window includes both endpoints", () => {
    const rule = makeRule({ start_date: "2026-07-01", end_date: "2026-07-31" });
    expect(ruleScopeMatches(rule, "2026-07-01", "2026-07-01T02:30:00Z")).toBe(true);
    expect(ruleScopeMatches(rule, "2026-07-31", "2026-07-31T02:30:00Z")).toBe(true);
    expect(ruleScopeMatches(rule, "2026-06-30", "2026-06-30T02:30:00Z")).toBe(false);
    expect(ruleScopeMatches(rule, "2026-08-01", "2026-08-01T02:30:00Z")).toBe(false);
  });

  it("annual recurrence matches month/day only", () => {
    const rule = makeRule({
      start_date: "2025-07-01",
      end_date: "2025-07-31",
      is_annual: true,
    });
    expect(ruleScopeMatches(rule, "2026-07-15", "2026-07-15T02:30:00Z")).toBe(true);
    expect(ruleScopeMatches(rule, "2026-08-01", "2026-08-01T02:30:00Z")).toBe(false);
  });

  it("annual year-wrap window (Nov 15 → Jan 10)", () => {
    const rule = makeRule({
      start_date: "2025-11-15",
      end_date: "2025-01-10",
      is_annual: true,
    });
    expect(ruleScopeMatches(rule, "2026-12-05", "2026-12-05T02:30:00Z")).toBe(true);
    expect(ruleScopeMatches(rule, "2026-01-03", "2026-01-03T02:30:00Z")).toBe(true);
    expect(ruleScopeMatches(rule, "2026-10-31", "2026-10-31T02:30:00Z")).toBe(false);
    expect(ruleScopeMatches(rule, "2026-02-01", "2026-02-01T02:30:00Z")).toBe(false);
  });

  it("DOW mask matches stay-date weekday", () => {
    // 2026-07-13 = Monday (isoWeekday 1, bit 1)
    const mondayOnly = makeRule({ dow_mask: 1 });
    expect(ruleScopeMatches(mondayOnly, "2026-07-13", "2026-07-13T02:30:00Z")).toBe(true);
    expect(ruleScopeMatches(mondayOnly, "2026-07-14", "2026-07-14T02:30:00Z")).toBe(false);

    // Fri=16, Sat=32 → weekends+friday = 48+16 = actually Fri+Sat = 48
    const friSat = makeRule({ dow_mask: 48 });
    expect(ruleScopeMatches(friSat, "2026-07-17", "2026-07-17T02:30:00Z")).toBe(true);  // Friday
    expect(ruleScopeMatches(friSat, "2026-07-18", "2026-07-18T02:30:00Z")).toBe(true);  // Saturday
    expect(ruleScopeMatches(friSat, "2026-07-19", "2026-07-19T02:30:00Z")).toBe(false); // Sunday
  });

  it("empty signal set → rule is ineligible", () => {
    const rule = makeRule({ signal_room_type_ids: [] });
    expect(ruleScopeMatches(rule, "2026-07-15", "2026-07-15T02:30:00Z")).toBe(false);
  });

  it("empty affected set → rule is ineligible", () => {
    const rule = makeRule({ affected_room_type_ids: [] });
    expect(ruleScopeMatches(rule, "2026-07-15", "2026-07-15T02:30:00Z")).toBe(false);
  });

  it("inactive rule → ineligible", () => {
    const rule = makeRule({ is_active: false });
    expect(ruleScopeMatches(rule, "2026-07-15", "2026-07-15T02:30:00Z")).toBe(false);
  });
});
