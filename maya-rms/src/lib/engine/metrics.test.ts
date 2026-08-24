import { describe, expect, it } from "vitest";
import { computeDta, computeNetPickup, computeOccupancy, computeRuleMetrics } from "./metrics";
import type { BaselineSnapshotStore, CellSnapshot } from "./snapshots";
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
    is_pickup_rule: true,
    condition: { pickup_operator: "lt", pickup_threshold: 3 },
    signal_room_type_ids: ["rt1"],
    affected_room_type_ids: ["rt1"],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("DTA (§5.1)", () => {
  it("computes days until arrival correctly", () => {
    expect(computeDta("2026-07-20", "2026-07-15")).toBe(5);
    expect(computeDta("2026-07-15", "2026-07-15")).toBe(0);
    expect(computeDta("2026-08-15", "2026-07-15")).toBe(31);
  });
});

describe("occupancy (§5.2, §15.2)", () => {
  it("combined occupancy across a multi-room signal set", () => {
    const snapMap = new Map<string, { booked_units: number; sellable_units: number }>([
      ["rt1", { booked_units: 20, sellable_units: 40 }],
      ["rt2", { booked_units: 10, sellable_units: 30 }],
      ["rt3", { booked_units: 5, sellable_units: 15 }],
    ]);
    // Combined: 35/85
    const occ = computeOccupancy(snapMap, ["rt1", "rt2", "rt3"]);
    expect(occ).toBeCloseTo(35 / 85, 5);
  });

  it("is sum of numerators / sum of denominators, not average of ratios", () => {
    const snapMap = new Map([
      ["rt1", { booked_units: 1, sellable_units: 1 }],   // 100%
      ["rt2", { booked_units: 0, sellable_units: 100 }],  // 0%
    ]);
    // Average of ratios would be 50%, but sum/sum = 1/101
    const occ = computeOccupancy(snapMap, ["rt1", "rt2"]);
    expect(occ).toBeCloseTo(1 / 101, 5);
  });

  it("zero denominator → null (not zero)", () => {
    const snapMap = new Map([
      ["rt1", { booked_units: 0, sellable_units: 0 }],
    ]);
    expect(computeOccupancy(snapMap, ["rt1"])).toBeNull();
  });

  it("missing room type in snapshot → skipped", () => {
    const snapMap = new Map([
      ["rt1", { booked_units: 10, sellable_units: 20 }],
    ]);
    expect(computeOccupancy(snapMap, ["rt1", "rt_missing"])).toBeCloseTo(0.5, 5);
  });

  it("all signal rooms zero sellable → null", () => {
    const snapMap = new Map([
      ["rt1", { booked_units: 0, sellable_units: 0 }],
      ["rt2", { booked_units: 0, sellable_units: 0 }],
    ]);
    expect(computeOccupancy(snapMap, ["rt1", "rt2"])).toBeNull();
  });
});

describe("net pickup (§5.3, §15.4)", () => {
  it("computes delta between current and baseline", () => {
    const current = new Map([
      ["rt1", { booked_units: 20, booked_revenue: 4000 }],
    ]);
    const baseline = new Map([
      ["rt1", { booked_units: 14, booked_revenue: 2800 }],
    ]);
    const pickup = computeNetPickup(current, baseline, ["rt1"]);
    expect(pickup.units).toBe(6);
    expect(pickup.revenue).toBe(1200);
  });

  it("handles cancellations (negative pickup)", () => {
    const current = new Map([
      ["rt1", { booked_units: 8, booked_revenue: 1600 }],
    ]);
    const baseline = new Map([
      ["rt1", { booked_units: 12, booked_revenue: 2400 }],
    ]);
    const pickup = computeNetPickup(current, baseline, ["rt1"]);
    expect(pickup.units).toBe(-4);
    expect(pickup.revenue).toBe(-800);
  });

  it("combines across multiple signal room types", () => {
    const current = new Map([
      ["rt1", { booked_units: 10, booked_revenue: 2000 }],
      ["rt2", { booked_units: 5, booked_revenue: 1000 }],
    ]);
    const baseline = new Map([
      ["rt1", { booked_units: 7, booked_revenue: 1400 }],
      ["rt2", { booked_units: 3, booked_revenue: 600 }],
    ]);
    const pickup = computeNetPickup(current, baseline, ["rt1", "rt2"]);
    expect(pickup.units).toBe(5);
    expect(pickup.revenue).toBe(1000);
  });

  it("misaligned baseline map throws (handled upstream in computeRuleMetrics)", () => {
    const current = new Map([
      ["rt1", { booked_units: 10, booked_revenue: 2000 }],
      ["rt2", { booked_units: 1, booked_revenue: 100 }],
    ]);
    const baseline = new Map([["rt1", { booked_units: 7, booked_revenue: 1400 }]]);
    expect(() => computeNetPickup(current, baseline, ["rt1", "rt2"])).toThrow();
  });
});

describe("computeRuleMetrics: every signal room type deactivated (regression)", () => {
  // evaluate.ts filters signal_room_type_ids down to currently-active room
  // types before metrics ever run. If a rule's WHOLE signal set was
  // deactivated, that leaves an empty array here — this must block
  // explicitly (and never consult the stores), not silently read "zero
  // pickup" as evidence a "lt" condition could fire on.
  const throwingStore: BaselineSnapshotStore = {
    rowAt() {
      throw new Error("must not read baselines when signal_room_type_ids is empty");
    },
    coverageAt() {
      throw new Error("must not probe coverage when signal_room_type_ids is empty");
    },
  };

  it("blocks with a dedicated reason instead of computing pickup = 0", async () => {
    const rule = makeRule({ signal_room_type_ids: [] });
    const metrics = await computeRuleMetrics(
      rule,
      "2026-08-01",
      "2026-07-28",
      new Map(),
      throwingStore,
      "2026-07-21T00:00:00Z",
    );
    expect(metrics.occupancy).toBeNull();
    expect(metrics.net_pickup_units).toBeNull();
    expect(metrics.net_pickup_revenue).toBeNull();
    expect(metrics.pickup_block_reason).toBe("no_active_signal_room_types");
  });

  it("keeps that rule from matching a lt pickup condition on no evidence", async () => {
    const rule = makeRule({ signal_room_type_ids: [] });
    const metrics = await computeRuleMetrics(
      rule,
      "2026-08-01",
      "2026-07-28",
      new Map(),
      throwingStore,
      "2026-07-21T00:00:00Z",
    );
    // Without the block reason, net_pickup_units would read 0, and 0 < 3
    // would satisfy this rule's condition on a signal set that no longer
    // exists.
    expect(metrics.pickup_block_reason).toBeTruthy();
  });
});

describe("computeRuleMetrics: synthesized zero baseline (first bookings on a date)", () => {
  // Earlier engine generations only wrote snapshot rows for cells with
  // bookings, so a date receiving its FIRST bookings has no baseline row —
  // exactly when a pickup rule matters. The baseline is synthesized as zero
  // only when the hotel was demonstrably snapshotting at the baseline
  // instant; otherwise the run still blocks.
  const NOW = "2026-08-01T12:00:00Z";
  const BASELINE = "2026-07-29T12:00:00Z";
  const currentSnaps = new Map<string, CellSnapshot>([
    ["2026-10-26|rt1", { booked_units: 5, booked_revenue: 1000, sellable_units: 10, snapshot_ts: NOW }],
  ]);

  // The store already resolves "nearest fresh row per cell" — these tests
  // exercise what metrics DOES with a missing cell, so the store is the
  // scenario: no baseline row for the cell, coverage as each case needs.
  function store(coverageTs: string | null): BaselineSnapshotStore {
    return {
      rowAt: () => undefined,
      coverageAt: async () => coverageTs,
    };
  }

  it("treats a missing baseline cell as zero when the stay date was being snapshotted", async () => {
    // Date-level coverage minutes before the baseline instant (a sibling
    // room type's row) proves this date was being written; the cell simply
    // had nothing booked back then.
    const metrics = await computeRuleMetrics(
      makeRule({ condition: { pickup_operator: "gt", pickup_threshold: 3 } }),
      "2026-10-26",
      "2026-08-01",
      currentSnaps,
      store("2026-07-29T11:55:00Z"),
      BASELINE,
    );
    expect(metrics.pickup_block_reason).toBeNull();
    expect(metrics.signal_booked_units_baseline).toBe(0);
    expect(metrics.net_pickup_units).toBe(5);
  });

  it("still blocks when the date has no snapshot history at the baseline", async () => {
    const metrics = await computeRuleMetrics(
      makeRule({ condition: { pickup_operator: "gt", pickup_threshold: 3 } }),
      "2026-10-26",
      "2026-08-01",
      currentSnaps,
      store(null),
      BASELINE,
    );
    expect(metrics.pickup_block_reason).toBe("insufficient_snapshot_history");
    expect(metrics.net_pickup_units).toBeNull();
  });

  it("blocks as stale when the date's coverage predates the baseline by more than the freshness window", async () => {
    const metrics = await computeRuleMetrics(
      makeRule({ condition: { pickup_operator: "gt", pickup_threshold: 3 } }),
      "2026-10-26",
      "2026-08-01",
      currentSnaps,
      store("2026-07-27T00:00:00Z"),
      BASELINE,
    );
    expect(metrics.pickup_block_reason).toBe("stale_baseline_snapshot");
  });
});
