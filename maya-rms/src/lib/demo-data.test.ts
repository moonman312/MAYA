import { describe, expect, it } from "vitest";
import {
  buildChangelog,
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
  it("returns 10 cycles", () => {
    const cycles = buildChangelog();
    expect(cycles.length).toBe(10);
  });

  it("cycles have descending cycle numbers", () => {
    const cycles = buildChangelog();
    for (let i = 1; i < cycles.length; i++) {
      expect(cycles[i].cycle).toBeLessThan(cycles[i - 1].cycle);
    }
  });

  it("cycles have valid timestamps", () => {
    const cycles = buildChangelog();
    for (const c of cycles) {
      expect(new Date(c.timestamp).getTime()).not.toBeNaN();
    }
  });

  it("timestamps are roughly 5 minutes apart", () => {
    const cycles = buildChangelog();
    for (let i = 1; i < cycles.length; i++) {
      const diff = new Date(cycles[i - 1].timestamp).getTime() - new Date(cycles[i].timestamp).getTime();
      // should be ~300000ms (5 minutes)
      expect(diff).toBeGreaterThan(250_000);
      expect(diff).toBeLessThan(350_000);
    }
  });

  it("roughly 2/3 of cycles have changes", () => {
    const cycles = buildChangelog();
    const withChanges = cycles.filter((c) => c.has_changes).length;
    expect(withChanges).toBeGreaterThanOrEqual(5);
    expect(withChanges).toBeLessThanOrEqual(8);
  });

  it("cycles with changes have valid entries", () => {
    const cycles = buildChangelog();
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
    const cycles = buildChangelog();
    for (const c of cycles) {
      for (const ch of c.changes) {
        expect(validNames).toContain(ch.room_type);
      }
    }
  });

  it("new_rate is correctly computed from original + pct", () => {
    const cycles = buildChangelog();
    for (const c of cycles) {
      for (const ch of c.changes) {
        const expected = Math.round(ch.original_rate * (1 + ch.change_pct / 100) * 100) / 100;
        expect(ch.new_rate).toBe(expected);
      }
    }
  });
});
