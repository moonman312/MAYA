/**
 * A manual price is a reset point for its cell: the typed number is what MAYA
 * publishes, every effect that was already holding on the cell is suppressed,
 * and only rules that fire AFTER the override apply on top of it. The API
 * route writes the suppression (suppressed_at on ladder rows, retired pickup
 * events); these tests cover the engine's side of the contract — that it
 * respects those marks and clears them at the right moments.
 */
import { describe, expect, it } from "vitest";
import type { EngineRule } from "@/types/domain";
import type { SupabaseClient } from "@supabase/supabase-js";
import { auditSignature, writeAudit } from "./audit";
import { evaluateLadderTriple } from "./ladder";
import { floorBaselineToOverride } from "./pickup";
import { loadActiveLadderEffects, type AssembledPrice } from "./pricing";
import type { RuleMetrics } from "./types";

/* ── A tiny in-memory Supabase: enough of the query grammar the engine uses ── */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = { ...seed };
  const client = {
    from(table: string) {
      const rows = (tables[table] ??= []);
      const filters: [string, unknown][] = [];
      const nulls: string[] = [];
      let op: "select" | "insert" | "upsert" | "update" = "select";
      let payload: Row = {};
      let conflictKeys: string[] = [];

      const match = () =>
        rows.filter(
          (r) => filters.every(([c, v]) => r[c] === v) && nulls.every((c) => r[c] == null),
        );

      const exec = () => {
        if (op === "insert") rows.push({ ...payload });
        if (op === "upsert") {
          const hit = rows.find((r) => conflictKeys.every((k) => r[k] === payload[k]));
          if (hit) Object.assign(hit, payload);
          else rows.push({ ...payload });
        }
        if (op === "update") for (const r of match()) Object.assign(r, payload);
        return { data: op === "select" ? match() : null, error: null };
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
        select: () => b,
        eq: (c: string, v: unknown) => (filters.push([c, v]), b),
        is: (c: string, v: unknown) => (v === null && nulls.push(c), b),
        order: () => b,
        insert: (row: Row) => ((op = "insert"), (payload = row), b),
        upsert: (row: Row, opts?: { onConflict?: string }) => (
          (op = "upsert"),
          (payload = row),
          (conflictKeys = (opts?.onConflict ?? "").split(",")),
          b
        ),
        update: (patch: Row) => ((op = "update"), (payload = patch), b),
        maybeSingle: () => Promise.resolve({ data: match()[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(exec()).then(res, rej),
      };
      return b;
    },
  };
  return { client: client as unknown as SupabaseClient, tables };
}

function ladderRule(overrides: Partial<EngineRule> = {}): EngineRule {
  return {
    id: "r1",
    hotel_id: "h1",
    name: "Busy nights",
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

const busy: RuleMetrics = { occupancy: 0.8, dta: 10, net_pickup_units: null, net_pickup_revenue: null };
const quiet: RuleMetrics = { occupancy: 0.2, dta: 10, net_pickup_units: null, net_pickup_revenue: null };

const STAY = "2026-10-01";
const OVERRIDE_AT = "2026-09-15T12:00:00Z";

describe("ladder suppression", () => {
  it("a suppressed row is still active but contributes no effect", async () => {
    const { client } = fakeDb({
      ladder_rule_state: [
        { rule_id: "r1", stay_date: STAY, room_type_id: "rt1", is_active: true, suppressed_at: null,
          action_kind: "percent", action_direction: "increase", action_value: 10 },
        { rule_id: "r2", stay_date: STAY, room_type_id: "rt1", is_active: true, suppressed_at: OVERRIDE_AT,
          action_kind: "percent", action_direction: "increase", action_value: 5 },
      ],
    });
    const effects = await loadActiveLadderEffects(client, STAY, "rt1");
    expect(effects.map((e) => e.rule_id)).toEqual(["r1"]);
  });

  it("holding keeps suppression; deactivating clears it; the next activation applies again", async () => {
    const { client, tables } = fakeDb({
      ladder_rule_state: [
        { rule_id: "r1", rule_version: 1, stay_date: STAY, room_type_id: "rt1", is_active: true,
          activated_at: "2026-09-01T00:00:00Z", deactivated_at: null, suppressed_at: OVERRIDE_AT,
          last_evaluated_at: "2026-09-15T11:55:00Z",
          action_kind: "percent", action_direction: "increase", action_value: 10 },
      ],
    });
    const rule = ladderRule();
    const row = () => tables.ladder_rule_state[0];

    // The condition merely keeps holding: same trigger, stays suppressed.
    let r = await evaluateLadderTriple(client, rule, "h1", STAY, "rt1", busy, "2026-09-15T12:05:00Z");
    expect(r.transition).toBe("noop");
    expect(row().is_active).toBe(true);
    expect(row().suppressed_at).toBe(OVERRIDE_AT);
    expect(await loadActiveLadderEffects(client, STAY, "rt1")).toEqual([]);

    // The trigger ends: suppression goes with it.
    r = await evaluateLadderTriple(client, rule, "h1", STAY, "rt1", quiet, "2026-09-16T12:00:00Z");
    expect(r.transition).toBe("deactivate");
    expect(row().is_active).toBe(false);
    expect(row().suppressed_at).toBeNull();

    // A new trigger is a rule firing AFTER the override: it applies on top.
    r = await evaluateLadderTriple(client, rule, "h1", STAY, "rt1", busy, "2026-09-17T12:00:00Z");
    expect(r.transition).toBe("activate");
    expect(row().is_active).toBe(true);
    expect(row().suppressed_at).toBeNull();
    expect((await loadActiveLadderEffects(client, STAY, "rt1")).map((e) => e.rule_id)).toEqual(["r1"]);
  });

  it("a fresh activation on a cell with no prior row starts unsuppressed", async () => {
    const { client, tables } = fakeDb();
    const r = await evaluateLadderTriple(client, ladderRule(), "h1", STAY, "rt1", busy, "2026-09-17T12:00:00Z");
    expect(r.transition).toBe("activate");
    expect(tables.ladder_rule_state[0].suppressed_at).toBeNull();
  });

  // The route can only stamp rows that exist. A cell past the scheduled
  // tick's horizon has none, so the override's own republish run is the
  // first evaluation: the rule matches, and without the probe it would fire
  // on top of the number the manager just typed.
  it("a first-ever row is born suppressed when the condition already held at the override", async () => {
    const { client, tables } = fakeDb();
    const r = await evaluateLadderTriple(client, ladderRule(), "h1", STAY, "rt1", busy, OVERRIDE_AT, {
      set_at: OVERRIDE_AT,
      heldAtOverride: async () => true,
    });
    expect(r.transition).toBe("activate");
    expect(tables.ladder_rule_state[0].is_active).toBe(true);
    expect(tables.ladder_rule_state[0].suppressed_at).toBe(OVERRIDE_AT);
    expect(await loadActiveLadderEffects(client, STAY, "rt1")).toEqual([]);
  });

  it("a first-ever row applies when the condition only started holding after the override", async () => {
    const { client, tables } = fakeDb();
    const r = await evaluateLadderTriple(client, ladderRule(), "h1", STAY, "rt1", busy, "2026-09-17T12:00:00Z", {
      set_at: OVERRIDE_AT,
      heldAtOverride: async () => false,
    });
    expect(r.transition).toBe("activate");
    expect(tables.ladder_rule_state[0].suppressed_at).toBeNull();
    expect((await loadActiveLadderEffects(client, STAY, "rt1")).map((e) => e.rule_id)).toEqual(["r1"]);
  });

  it("an existing inactive row re-activates unsuppressed without consulting the probe", async () => {
    const { client, tables } = fakeDb({
      ladder_rule_state: [
        { rule_id: "r1", rule_version: 1, stay_date: STAY, room_type_id: "rt1", is_active: false,
          activated_at: "2026-09-01T00:00:00Z", deactivated_at: "2026-09-16T12:00:00Z", suppressed_at: null,
          action_kind: "percent", action_direction: "increase", action_value: 10 },
      ],
    });
    let asked = false;
    const r = await evaluateLadderTriple(client, ladderRule(), "h1", STAY, "rt1", busy, "2026-09-17T12:00:00Z", {
      set_at: OVERRIDE_AT,
      heldAtOverride: async () => ((asked = true), true),
    });
    expect(r.transition).toBe("activate");
    expect(asked).toBe(false);
    expect(tables.ladder_rule_state[0].suppressed_at).toBeNull();
  });

  it("a failed effects read rejects rather than pricing the cell with no rules", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    for (const m of ["select", "eq", "is", "order"]) b[m] = () => b;
    b.then = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: { message: "column suppressed_at does not exist" } }).then(res);
    const client = { from: () => b } as unknown as SupabaseClient;
    await expect(loadActiveLadderEffects(client, STAY, "rt1")).rejects.toThrow(/suppressed_at does not exist/);
  });
});

describe("pickup baseline floor", () => {
  const baseline = "2026-09-12T12:00:00Z";

  it("leaves the baseline alone for a cell with no override", () => {
    expect(floorBaselineToOverride(baseline, undefined)).toBe(baseline);
    expect(floorBaselineToOverride(baseline, null)).toBe(baseline);
  });

  it("leaves the baseline alone when the override predates it", () => {
    // Bookings since the baseline all came after the override; nothing to exclude.
    expect(floorBaselineToOverride(baseline, "2026-09-10T00:00:00Z")).toBe(baseline);
  });

  it("moves the baseline up to the override so earlier bookings do not count", () => {
    expect(floorBaselineToOverride(baseline, OVERRIDE_AT)).toBe(OVERRIDE_AT);
  });
});

describe("audit attribution", () => {
  function assembled(base_source: AssembledPrice["base_source"]): AssembledPrice {
    return {
      stay_date: STAY,
      room_type_id: "rt1",
      base_price: 150,
      base_source,
      floor_price: 50,
      ceiling_price: 500,
      ladder_effects: [],
      pickup_effects: [],
      pre_clamp_price: 150,
      final_price: 150,
      clamped_by: "none",
    };
  }

  async function auditRow(base_source: AssembledPrice["base_source"]) {
    const { client, tables } = fakeDb();
    await writeAudit(client, {
      runId: "run1",
      hotelId: "h1",
      evalTs: "2026-09-15T12:05:00Z",
      assembled: assembled(base_source),
      ladderResults: [],
      pickupWinners: [],
      pickupLosers: [],
      pickupIdempotentSkips: [],
      pickupWriteFailures: [],
      basePrices: new Map([[`${STAY}|rt1`, 150]]),
      manualOverride: { set_by: "user-1", set_at: OVERRIDE_AT },
    });
    return tables.evaluation_audit[0].details as Record<string, unknown>;
  }

  it("records who typed the base when it is manual", async () => {
    const d = await auditRow("manual");
    expect(d.base_source).toBe("manual");
    expect(d.manual_override).toEqual({ set_by: "user-1", set_at: OVERRIDE_AT });
  });

  it("names the tier and no author when the base is MAYA's own", async () => {
    const d = await auditRow("calendar");
    expect(d.base_source).toBe("calendar");
    expect(d).not.toHaveProperty("manual_override");
  });

  // Typing the number MAYA was already publishing moves nothing, but it is
  // the change the manager will look for, so it must still earn a row.
  it("a manual price that leaves the number unchanged still writes a row", async () => {
    const { client, tables } = fakeDb();
    const written = await writeAudit(client, {
      runId: "run1",
      hotelId: "h1",
      evalTs: "2026-09-15T12:05:00Z",
      assembled: assembled("manual"),
      ladderResults: [],
      pickupWinners: [],
      pickupLosers: [],
      pickupIdempotentSkips: [],
      pickupWriteFailures: [],
      basePrices: new Map([[`${STAY}|rt1`, 150]]),
      manualOverride: { set_by: "user-1", set_at: OVERRIDE_AT },
      previousSignature: auditSignature(150, [], "none"),
    });
    expect(written).toBe(true);
    expect(tables.evaluation_audit).toHaveLength(1);
  });
});
