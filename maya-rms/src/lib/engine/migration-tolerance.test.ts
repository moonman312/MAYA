/**
 * Deploy order must not matter. Engine code that lands before its migration
 * has to notice the old schema, say so once in the log naming the file to
 * run, and price the way it did before that migration. Anything that is not
 * a schema gap is still an outage and still throws.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineRule } from "@/types/domain";
import { evaluateHotel } from "./evaluate";
import {
  callTouchesColumn,
  fakeSupabase,
  missingColumn,
  missingRelation,
  type FakeRow,
} from "./fake-supabase.test";
import { evaluateLadderTriple, probeSuppressionSupport } from "./ladder";
import { loadActiveLadderEffects } from "./pricing";
import type { RuleMetrics } from "./types";

const EVAL_TS = "2026-09-16T12:00:00Z";
const D0 = "2026-09-16";
const MANUAL_PRICE_MIGRATION = "99_supabase_migration_manual_price_v1.sql";

function seed(extra: Record<string, FakeRow[]> = {}): Record<string, FakeRow[]> {
  return {
    hotels: [{ id: "h1", timezone: "UTC" }],
    room_types: [
      { id: "rt1", hotel_id: "h1", name: "King", is_active: true, total_rooms: 20, floor_price: 10, ceiling_price: 1000, counts_as_room: true },
    ],
    reservations: Array.from({ length: 16 }, (_, i) => ({
      id: `b${i}`, hotel_id: "h1", stay_date: D0, room_type_id: "rt1",
      base_rate: 100, current_rate: 100, created_at: "2026-09-01T00:00:00Z",
    })),
    pricing_rules: [
      {
        id: "r1", hotel_id: "h1", name: "Busy", is_active: true, version: 1, priority: 100,
        start_date: null, end_date: null, is_annual: false, dow_mask: 127,
        action_type: "percent", action_direction: "increase", action_value: 10, is_pickup_rule: false,
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
        rule_condition: [{ occupancy_operator: "gt", occupancy_threshold: 0.5 }],
        rule_signal_room_type: [{ room_type_id: "rt1" }],
        rule_affected_room_type: [{ room_type_id: "rt1" }],
      },
    ],
    ...extra,
  };
}

const rule: EngineRule = {
  id: "r1",
  hotel_id: "h1",
  name: "Busy",
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
};
const busy: RuleMetrics = { occupancy: 0.8, dta: 10, net_pickup_units: null, net_pickup_revenue: null };
const quiet: RuleMetrics = { occupancy: 0.2, dta: 10, net_pickup_units: null, net_pickup_revenue: null };

/** The database as it looks before 99_supabase_migration_manual_price_v1.sql touched ladder_rule_state. */
const noSuppressedAtColumn = (c: { table: string } & Parameters<typeof callTouchesColumn>[0]) =>
  c.table === "ladder_rule_state" && callTouchesColumn(c, "suppressed_at")
    ? missingColumn("ladder_rule_state", "suppressed_at")
    : null;

afterEach(() => vi.restoreAllMocks());

describe("ladder_rule_state without suppressed_at", () => {
  it("the run completes, effects apply, activations upsert without the column, one error line", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, tables } = fakeSupabase(
      seed({
        // A pre-existing active effect from an older rule: it must keep applying.
        ladder_rule_state: [
          { rule_id: "r0", rule_version: 1, stay_date: D0, room_type_id: "rt1", is_active: true,
            action_kind: "fixed", action_direction: "increase", action_value: 5 },
        ],
      }),
      { fault: noSuppressedAtColumn },
    );

    const result = await evaluateHotel(client, "h1", EVAL_TS, 1);
    expect(result.ladder_activations).toBe(1);
    expect(result.prices_published).toBe(1);

    // r0 (+5) then r1 (+10%), rule_id order: 100 -> 105 -> 115.50
    expect(tables.published_price[0].price).toBe(115.5);

    const fresh = tables.ladder_rule_state.find((r) => r.rule_id === "r1")!;
    expect(fresh.is_active).toBe(true);
    expect(fresh).not.toHaveProperty("suppressed_at");

    expect(err).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(err.mock.calls[0][0]));
    expect(line.step).toBe("probe_suppressed_at");
    expect(line.schema).toBe("pre-migration");
    expect(line.migration).toBe(MANUAL_PRICE_MIGRATION);
  });

  it("the probe answers false once, and any other failure is reported as supported", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client: pre } = fakeSupabase({}, { fault: noSuppressedAtColumn });
    expect(await probeSuppressionSupport(pre, "h1")).toBe(false);

    const { client: outage } = fakeSupabase(
      {},
      { fault: (c) => (c.table === "ladder_rule_state" ? { code: "57014", message: "canceling statement due to statement timeout" } : null) },
    );
    expect(await probeSuppressionSupport(outage, "h1")).toBe(true);
    expect(err).toHaveBeenCalledTimes(2);
  });

  it("deactivation updates without the column and the effects read skips the filter", async () => {
    const { client, tables } = fakeSupabase(
      {
        ladder_rule_state: [
          { rule_id: "r1", rule_version: 1, stay_date: D0, room_type_id: "rt1", is_active: true,
            activated_at: "2026-09-01T00:00:00Z", deactivated_at: null,
            action_kind: "percent", action_direction: "increase", action_value: 10 },
        ],
      },
      { fault: noSuppressedAtColumn },
    );
    expect((await loadActiveLadderEffects(client, D0, "rt1", false)).map((e) => e.rule_id)).toEqual(["r1"]);

    const r = await evaluateLadderTriple(client, rule, "h1", D0, "rt1", quiet, EVAL_TS, undefined, false);
    expect(r.transition).toBe("deactivate");
    expect(tables.ladder_rule_state[0].is_active).toBe(false);
    expect(tables.ladder_rule_state[0]).not.toHaveProperty("suppressed_at");

    // A re-activation with an override probe present never consults it: the
    // column it would write does not exist.
    let asked = false;
    const again = await evaluateLadderTriple(client, rule, "h1", D0, "rt1", busy, EVAL_TS, {
      set_at: EVAL_TS,
      heldAtOverride: async () => ((asked = true), true),
    }, false);
    expect(again.transition).toBe("activate");
    expect(asked).toBe(false);
    expect(tables.ladder_rule_state[0]).not.toHaveProperty("suppressed_at");
  });

  it("with the column present, a suppressed row is skipped only when the run says suppression is supported", async () => {
    const { client } = fakeSupabase({
      ladder_rule_state: [
        { rule_id: "r1", stay_date: D0, room_type_id: "rt1", is_active: true, suppressed_at: EVAL_TS,
          action_kind: "percent", action_direction: "increase", action_value: 10 },
      ],
    });
    expect(await loadActiveLadderEffects(client, D0, "rt1", true)).toEqual([]);
    expect((await loadActiveLadderEffects(client, D0, "rt1", false)).map((e) => e.rule_id)).toEqual(["r1"]);
  });
});

describe("manual_price table missing", () => {
  it("the run completes with no overrides and names the migration once", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, tables } = fakeSupabase(
      seed({
        manual_price: [
          { id: "m1", hotel_id: "h1", stay_date: D0, room_type_id: "rt1", price: 999, set_by: "u1", set_at: EVAL_TS, cleared_at: null },
        ],
      }),
      { fault: (c) => (c.table === "manual_price" ? missingRelation("manual_price") : null) },
    );
    const result = await evaluateHotel(client, "h1", EVAL_TS, 1);
    expect(result.prices_published).toBe(1);
    // Base from the reservation, not the (unreachable) typed 999.
    expect(tables.published_price[0].base_price).toBe(100);
    expect(tables.published_price[0].price).toBe(110);

    expect(err).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(err.mock.calls[0][0]));
    expect(line.step).toBe("manual_price");
    expect(line.degradedToEmpty).toBe(true);
    expect(line.schema).toBe("pre-migration");
    expect(line.migration).toBe(MANUAL_PRICE_MIGRATION);
  });

  it("any other manual_price failure still degrades to empty but is not blamed on the migration", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeSupabase(seed(), {
      fault: (c) => (c.table === "manual_price" ? { code: "57014", message: "statement timeout" } : null),
    });
    await evaluateHotel(client, "h1", EVAL_TS, 1);
    expect(err).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(err.mock.calls[0][0]));
    expect(line.step).toBe("manual_price");
    expect(line.degradedToEmpty).toBe(true);
    expect(line).not.toHaveProperty("migration");
  });
});

describe("room_types without counts_as_room", () => {
  it("every active type counts and the run says so once", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, tables } = fakeSupabase(
      seed({
        room_types: [
          { id: "rt1", hotel_id: "h1", name: "King", is_active: true, total_rooms: 20, floor_price: 10, ceiling_price: 1000 },
          { id: "rt2", hotel_id: "h1", name: "Court", is_active: true, total_rooms: 5, floor_price: 10, ceiling_price: 1000 },
        ],
      }),
      {
        fault: (c) =>
          c.table === "room_types" && c.columns.includes("counts_as_room")
            ? missingColumn("room_types", "counts_as_room")
            : null,
      },
    );
    const result = await evaluateHotel(client, "h1", EVAL_TS, 1);
    expect(result.stay_dates_evaluated).toBe(1);
    expect(new Set(tables.stay_date_snapshot.map((s) => s.room_type_id))).toEqual(new Set(["rt1", "rt2"]));
    expect(err).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(err.mock.calls[0][0]));
    expect(line.step).toBe("room_types");
    expect(line.migration).toBe("99_supabase_migration_room_type_counts_as_room_v1.sql");
  });
});

describe("room_type_out_of_service table missing", () => {
  it("snapshots the physical count and names its migration once", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, tables } = fakeSupabase(seed(), {
      fault: (c) => (c.table === "room_type_out_of_service" ? missingRelation("room_type_out_of_service") : null),
    });
    await evaluateHotel(client, "h1", EVAL_TS, 1);
    expect(tables.stay_date_snapshot[0].sellable_units).toBe(20);
    expect(err).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(err.mock.calls[0][0]));
    expect(line.step).toBe("room_type_out_of_service");
    expect(line.migration).toBe("99_supabase_migration_room_type_out_of_service_v1.sql");
  });
});

describe("real outages still throw", () => {
  it("a failed ladder effects read that is not a schema gap rejects the run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeSupabase(seed(), {
      fault: (c) =>
        c.table === "ladder_rule_state" && c.op === "select" && c.columns.includes("action_kind")
          ? { code: "57014", message: "canceling statement due to statement timeout" }
          : null,
    });
    await expect(evaluateHotel(client, "h1", EVAL_TS, 1)).rejects.toThrow(/Failed to load ladder effects/);
  });

  it("a failed rules load still rejects", async () => {
    const { client } = fakeSupabase(seed(), {
      fault: (c) => (c.table === "pricing_rules" ? { code: "42703", message: "column rule_condition.x does not exist" } : null),
    });
    await expect(evaluateHotel(client, "h1", EVAL_TS, 1)).rejects.toThrow(/Failed to load pricing rules/);
  });
});
