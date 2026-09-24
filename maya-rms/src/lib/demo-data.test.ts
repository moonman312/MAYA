import { describe, expect, it } from "vitest";
import type { ChangelogCycle } from "@/types/domain";
import { isQuietChecks } from "./changelog-route-helpers";
import {
  buildChangelog,
  DEMO_RUNS,
  INITIAL_RULES,
  ROOM_TYPES,
  SAMPLE_RESERVATIONS,
} from "./demo-data";

describe("ROOM_TYPES", () => {
  it("has three room types", () => {
    expect(ROOM_TYPES.length).toBe(3);
  });

  it("each has name, base_rate, and total_rooms", () => {
    for (const rt of ROOM_TYPES) {
      expect(typeof rt.name).toBe("string");
      expect(rt.name.length).toBeGreaterThan(0);
      expect(rt.base_rate).toBeGreaterThan(0);
      expect(rt.total_rooms).toBeGreaterThan(0);
    }
  });

  it("includes Standard, Deluxe, Suite", () => {
    const names = ROOM_TYPES.map((rt) => rt.name);
    expect(names).toContain("Standard");
    expect(names).toContain("Deluxe");
    expect(names).toContain("Suite");
  });
});

describe("SAMPLE_RESERVATIONS", () => {
  it("has three sample reservations", () => {
    expect(SAMPLE_RESERVATIONS.length).toBe(3);
  });

  it("each has required simulation fields", () => {
    for (const res of SAMPLE_RESERVATIONS) {
      expect(typeof res.room_type).toBe("string");
      expect(typeof res.occupancy_percentage).toBe("number");
      expect(typeof res.booking_window).toBe("number");
      expect(typeof res.pickup_rate).toBe("number");
      expect(typeof res.current_rate).toBe("number");
      expect(res.current_rate).toBeGreaterThan(0);
    }
  });

  it("room types match ROOM_TYPES names", () => {
    const validNames = ROOM_TYPES.map((rt) => rt.name);
    for (const res of SAMPLE_RESERVATIONS) {
      expect(validNames).toContain(res.room_type);
    }
  });
});

describe("INITIAL_RULES", () => {
  it("has four seed rules", () => {
    expect(INITIAL_RULES.length).toBe(4);
  });

  it("each has valid RuleConfig shape", () => {
    for (const rule of INITIAL_RULES) {
      expect(typeof rule.id).toBe("string");
      expect(typeof rule.rule_name).toBe("string");
      expect(typeof rule.conditions).toBe("object");
      expect(typeof rule.action).toBe("object");
      expect(Array.isArray(rule.room_types)).toBe(true);
      expect(typeof rule.enabled).toBe("boolean");
    }
  });

  it("has at least one enabled and one disabled rule", () => {
    expect(INITIAL_RULES.some((r) => r.enabled)).toBe(true);
    expect(INITIAL_RULES.some((r) => !r.enabled)).toBe(true);
  });

  it("each rule has at least one action type", () => {
    for (const rule of INITIAL_RULES) {
      const hasPercent = rule.action.adjust_rate_percent !== undefined;
      const hasDollars = rule.action.adjust_rate_dollars !== undefined;
      expect(hasPercent || hasDollars).toBe(true);
    }
  });
});

describe("buildChangelog", () => {
  const changedRuns = () => buildChangelog().filter((i): i is ChangelogCycle => !isQuietChecks(i));

  it("shows 10 runs that changed a price, and the quiet checks between them as lines", () => {
    const items = buildChangelog();
    expect(changedRuns()).toHaveLength(10);
    expect(changedRuns().every((c) => c.has_changes)).toBe(true);
    // Never two quiet lines in a row: a stretch is one line.
    for (let i = 1; i < items.length; i++) {
      expect(isQuietChecks(items[i]) && isQuietChecks(items[i - 1])).toBe(false);
    }
    expect(items.filter(isQuietChecks).map((q) => q.checks)).toEqual([3, 4, 7, 7, 4, 8, 11, 5, 5]);
  });

  it("accounts for every run, newest first, five minutes apart", () => {
    const items = buildChangelog();
    const runs = items.reduce((n, i) => n + (isQuietChecks(i) ? i.checks : 1), 0);
    expect(runs).toBe(DEMO_RUNS);
    for (let i = 1; i < items.length; i++) {
      const newer = items[i - 1];
      const older = items[i];
      const gap = Date.parse(isQuietChecks(newer) ? newer.first_at : newer.timestamp) - Date.parse(older.timestamp);
      expect(gap).toBe(300_000);
    }
    for (const q of items.filter(isQuietChecks)) {
      expect(Date.parse(q.timestamp) - Date.parse(q.first_at)).toBe((q.checks - 1) * 300_000);
    }
  });

  it("cycles have descending cycle numbers", () => {
    const cycles = changedRuns();
    for (let i = 1; i < cycles.length; i++) {
      expect(cycles[i].cycle).toBeLessThan(cycles[i - 1].cycle);
    }
  });

  it("items have valid timestamps", () => {
    for (const c of buildChangelog()) {
      expect(new Date(c.timestamp).getTime()).not.toBeNaN();
    }
  });

  it("cycles with changes have valid entries", () => {
    const cycles = changedRuns();
    for (const c of cycles) {
      if (c.has_changes) {
        expect(c.changes.length).toBeGreaterThan(0);
        for (const ch of c.changes) {
          expect(typeof ch.room_type).toBe("string");
          expect(typeof ch.original_rate).toBe("number");
          expect(typeof ch.new_rate).toBe("number");
          expect(typeof ch.change_pct).toBe("number");
          expect(typeof ch.description).toBe("string");
          expect(ch.description.length).toBeGreaterThan(0);
        }
      } else {
        expect(c.changes.length).toBe(0);
      }
    }
  });

  it("change entries reference valid room types", () => {
    const validNames = ROOM_TYPES.map((rt) => rt.name);
    const cycles = changedRuns();
    for (const c of cycles) {
      for (const ch of c.changes) {
        expect(validNames).toContain(ch.room_type);
      }
    }
  });

  it("new_rate is correctly computed from original + pct", () => {
    const cycles = changedRuns();
    for (const c of cycles) {
      for (const ch of c.changes) {
        const expected = Math.round(ch.original_rate * (1 + ch.change_pct / 100) * 100) / 100;
        expect(ch.new_rate).toBe(expected);
      }
    }
  });
});
