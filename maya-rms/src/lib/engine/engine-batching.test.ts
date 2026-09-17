/**
 * The whole-run reads and writes that replaced per-cell round trips, each
 * checked against the per-cell function it stands in for, on data past
 * PostgREST's 1,000-row cap.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineRule } from "@/types/domain";
import { addDays } from "@/lib/observations/calendar";
import { insertAuditRows } from "./audit";
import { rng } from "./booking-speed-legacy.test";
import { FakeRpcError, fakeSupabase, missingFunction, type FakeCall, type FakeRow } from "./fake-supabase.test";
import { createLadderPassBatch, evaluateLadderTriple } from "./ladder";
import { baselineTsFrom, computeBaselineTs, loadLastPickupApplied } from "./pickup";
import {
  loadActiveLadderEffects,
  loadActiveLadderEffectsForRange,
  loadActivePickupEffects,
  loadActivePickupEffectsForRange,
  maybePublish,
  publishPrices,
} from "./pricing";
import { createSnapshotLookup, findSnapshotAt, resetSnapshotLookupLogOnce } from "./snapshots";
import type { RuleMetrics, SnapshotRow } from "./types";

afterEach(() => vi.restoreAllMocks());

const D0 = "2026-07-01";
const dates = (n: number) => Array.from({ length: n }, (_, i) => addDays(D0, i));
const uuid = (prefix: string, i: number) => `${prefix}-0000-4000-8000-${String(i).padStart(12, "0")}`;

describe("effects for the whole horizon", () => {
  const r = rng(5);
  const types = [1, 2, 3, 4].map((i) => uuid("aaaaaaaa", i));
  const rules = Array.from({ length: 30 }, (_, i) => uuid("bbbbbbbb", 30 - i));
  const days = dates(40);
  const ladder: FakeRow[] = [];
  const pickup: FakeRow[] = [];
  let ev = 0;
  for (const d of days) {
    for (const t of types) {
      for (const rule of rules) {
        if (r() < 0.5) continue;
        ladder.push({
          rule_id: rule,
          stay_date: d,
          room_type_id: t,
          is_active: r() < 0.7,
          suppressed_at: r() < 0.2 ? "2026-06-01T00:00:00Z" : null,
          action_kind: r() < 0.5 ? "percent" : "fixed",
          action_direction: r() < 0.5 ? "increase" : "decrease",
          action_value: Math.round(r() * 1000) / 100,
        });
      }
      for (let k = 0; k < 12; k++) {
        if (r() < 0.4) continue;
        pickup.push({
          id: uuid("cccccccc", 99999 - ++ev),
          hotel_id: "h1",
          rule_id: rules[k],
          stay_date: d,
          affected_room_type_id: t,
          // Ties on applied_at, broken by id.
          applied_at: `2026-06-${String(1 + Math.floor(r() * 3)).padStart(2, "0")}T00:00:00Z`,
          retired_at: r() < 0.2 ? "2026-06-20T00:00:00Z" : null,
          action_kind: "fixed",
          action_direction: "increase",
          action_value: k,
        });
      }
    }
  }

  it.each([true, false])("ladder effects match the per-cell read (suppression supported: %s)", async (supports) => {
    expect(ladder.length).toBeGreaterThan(1000);
    const { client } = fakeSupabase({ ladder_rule_state: ladder }, { maxRows: 1000 });
    const byCell = await loadActiveLadderEffectsForRange(client, types, days[0], days[days.length - 1], supports);
    for (const d of days) {
      for (const t of types) {
        expect(byCell.get(`${d}|${t}`) ?? []).toEqual(await loadActiveLadderEffects(client, d, t, supports));
      }
    }
  });

  it("pickup effects match the per-cell read, applied_at ties and all", async () => {
    expect(pickup.length).toBeGreaterThan(1000);
    const { client } = fakeSupabase({ pickup_event: pickup }, { maxRows: 1000 });
    const byCell = await loadActivePickupEffectsForRange(client, "h1", types, days[0], days[days.length - 1]);
    for (const d of days) {
      for (const t of types) {
        expect(byCell.get(`${d}|${t}`) ?? []).toEqual(await loadActivePickupEffects(client, "h1", d, t));
      }
    }
  });

  it("the newest open event per rule and date matches computeBaselineTs", async () => {
    const { client } = fakeSupabase({ pickup_event: pickup }, { maxRows: 1000 });
    const now = "2026-06-02T12:00:00.000Z";
    const last = await loadLastPickupApplied(client, "h1", rules.slice(0, 12), days[0], days[days.length - 1]);
    for (const [i, id] of rules.slice(0, 12).entries()) {
      const rule = { id, condition: { pickup_window_days: [1, 3, 7][i % 3] } } as unknown as EngineRule;
      for (const d of days) {
        expect(baselineTsFrom(rule, now, last.get(`${id}|${d}`) ?? null)).toBe(await computeBaselineTs(client, rule, d, now));
      }
    }
  });
});

describe("ladder pass batch", () => {
  const rule = (id: string): EngineRule =>
    ({
      id,
      version: 2,
      action_type: "percent",
      action_direction: "increase",
      action_value: 5,
      condition: { occupancy_operator: "gt", occupancy_threshold: 0.5 },
    }) as unknown as EngineRule;
  const busy: RuleMetrics = { occupancy: 0.9, dta: 3, net_pickup_units: null, net_pickup_revenue: null };
  const quiet: RuleMetrics = { occupancy: 0.1, dta: 3, net_pickup_units: null, net_pickup_revenue: null };

  it("reads state past 1,000 rows and writes what the per-triple path writes, failing rows included", async () => {
    const r = rng(9);
    const days = dates(120);
    const types = [1, 2, 3, 4, 5].map((i) => uuid("aaaaaaaa", i));
    const ruleIds = [1, 2, 3].map((i) => uuid("bbbbbbbb", i));
    const seedState: FakeRow[] = [];
    for (const id of ruleIds) {
      for (const d of days) {
        for (const t of types) {
          if (r() < 0.3) continue;
          seedState.push({
            rule_id: id, rule_version: 1, stay_date: d, room_type_id: t, is_active: r() < 0.5,
            activated_at: "2026-06-01T00:00:00Z", deactivated_at: null, last_evaluated_at: "2026-06-01T00:00:00Z",
            suppressed_at: r() < 0.3 ? "2026-06-02T00:00:00Z" : null, action_kind: "percent", action_direction: "increase", action_value: 5,
          });
        }
      }
    }
    expect(seedState.length).toBeGreaterThan(1000);
    const decisions = ruleIds.flatMap((id) => days.flatMap((d) => types.map((t) => ({ id, d, t, m: r() < 0.5 ? busy : quiet }))));
    const failing = (c: FakeCall) => {
      const list = Array.isArray(c.payload) ? c.payload : c.payload ? [c.payload] : [];
      const bad = list.some((p) => p.stay_date === days[7] && p.room_type_id === types[2]);
      const badUpdate = c.op === "update" && c.filters.some((f) => f.col === "room_type_id" && f.value === types[1]) &&
        c.filters.some((f) => f.col === "stay_date" && (f.value === days[11] || (Array.isArray(f.value) && f.value.includes(days[11]))));
      return (c.op !== "select" && bad) || badUpdate ? { message: "boom" } : null;
    };
    const EVAL = "2026-07-01T10:00:00.000Z";

    const perTriple = fakeSupabase({ ladder_rule_state: seedState, ladder_transition_event: [] }, { fault: failing, maxRows: 1000 });
    const perResults = [];
    for (const x of decisions) {
      perResults.push(await evaluateLadderTriple(perTriple.client, rule(x.id), "h1", x.d, x.t, x.m, EVAL));
    }

    const batched = fakeSupabase({ ladder_rule_state: seedState, ladder_transition_event: [] }, { fault: failing, maxRows: 1000 });
    const batch = await createLadderPassBatch(batched.client, ruleIds, days[0], days[days.length - 1]);
    const batchResults = [];
    for (const x of decisions) {
      batchResults.push(await evaluateLadderTriple(batched.client, rule(x.id), "h1", x.d, x.t, x.m, EVAL, undefined, true, batch));
    }
    await batch.flush();

    expect(batchResults.map((x) => x.transition)).toEqual(perResults.map((x) => x.transition));
    const norm = (rows: FakeRow[]) =>
      rows.map((x) => { const { id: _id, ...rest } = x; void _id; return JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k]])); }).sort();
    expect(norm(batched.tables.ladder_rule_state)).toEqual(norm(perTriple.tables.ladder_rule_state));
    expect(norm(batched.tables.ladder_transition_event)).toEqual(norm(perTriple.tables.ladder_transition_event));
    // Far fewer round trips, even with the failing groups retried row by row.
    expect(batched.calls.length).toBeLessThan(perTriple.calls.length / 4);
  });
});

describe("publishPrices", () => {
  it("publishes exactly what maybePublish does cell by cell, including a failing row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = rng(3);
    const types = [1, 2, 3].map((i) => uuid("aaaaaaaa", i));
    const days = dates(400);
    const seedRows: FakeRow[] = [];
    const cells = [];
    for (const d of days) {
      for (const t of types) {
        const price = 100 + Math.floor(r() * 50);
        const base = 90 + Math.floor(r() * 5);
        const roll = r();
        if (roll < 0.6) seedRows.push({ hotel_id: "h1", stay_date: d, room_type_id: t, price, base_price: roll < 0.1 ? null : base, computed_at: "x" });
        cells.push({ stayDate: d, roomTypeId: t, finalPrice: r() < 0.5 ? price : price + 1, basePrice: r() < 0.8 ? base : base + 2 });
      }
    }
    const fault = (c: FakeCall) => {
      const list = Array.isArray(c.payload) ? c.payload : c.payload ? [c.payload] : [];
      return c.op === "upsert" && list.some((p) => p.stay_date === days[33] && p.room_type_id === types[1]) ? { message: "timeout" } : null;
    };
    const one = fakeSupabase({ published_price: seedRows }, { fault, maxRows: 1000 });
    const expected = new Set<string>();
    for (const c of cells) {
      if (await maybePublish(one.client, "h1", c.stayDate, c.roomTypeId, c.finalPrice, "NOW", c.basePrice)) {
        expected.add(`${c.stayDate}|${c.roomTypeId}`);
      }
    }
    const many = fakeSupabase({ published_price: seedRows }, { fault, maxRows: 1000 });
    const got = await publishPrices(many.client, "h1", cells, "NOW");
    expect([...got].sort()).toEqual([...expected].sort());
    const norm = (rows: FakeRow[]) => rows.map((x) => `${x.stay_date}|${x.room_type_id}|${x.price}|${x.base_price}|${x.computed_at}`).sort();
    expect(norm(many.tables.published_price)).toEqual(norm(one.tables.published_price));
    expect(seedRows.length).toBeGreaterThan(500);
  });

  it("falls back to cell by cell when the current prices cannot be read", async () => {
    const { client, tables } = fakeSupabase(
      { published_price: [{ hotel_id: "h1", stay_date: D0, room_type_id: "rt", price: 100, base_price: 90 }] },
      { fault: (c) => (c.op === "select" && c.columns.includes("stay_date") ? { message: "timeout" } : null) },
    );
    const got = await publishPrices(client, "h1", [{ stayDate: D0, roomTypeId: "rt", finalPrice: 110, basePrice: 90 }], "NOW");
    expect([...got]).toEqual([`${D0}|rt`]);
    expect(tables.published_price[0].price).toBe(110);
  });
});

describe("insertAuditRows", () => {
  it("chunks by rows and by size, and a bad row costs only itself", async () => {
    const rows = Array.from({ length: 450 }, (_, i) => ({ stay_date: String(i), details: { blob: "x".repeat(i === 10 ? 1_200_000 : 100) } }));
    const { client, tables, calls } = fakeSupabase(
      { evaluation_audit: [] },
      { fault: (c) => (Array.isArray(c.payload) && c.payload.some((p) => p.stay_date === "300") ? { message: "bad row" } : null) },
    );
    await insertAuditRows(client, rows);
    expect(tables.evaluation_audit.map((x) => x.stay_date).sort()).toEqual(rows.map((x) => x.stay_date).filter((s) => s !== "300").sort());
    for (const c of calls) {
      const list = c.payload as FakeRow[];
      expect(list.length).toBeLessThanOrEqual(200);
      if (list.some((p) => p.stay_date === "10")) expect(list.length).toBe(1);
    }
  });
});

describe("snapshot lookup", () => {
  const types = ["rt1", "rt2"];
  const days = dates(30);
  const r = rng(12);
  const table: FakeRow[] = [];
  for (let run = 0; run < 6; run++) {
    const ts = new Date(Date.parse("2026-06-28T00:00:00Z") + run * 7 * 3600_000).toISOString();
    for (const d of days) {
      for (const t of types) {
        if (r() < 0.25) continue;
        table.push({ hotel_id: "h1", snapshot_ts: ts, stay_date: d, room_type_id: t, sellable_units: 9, booked_units: Math.floor(r() * 9), booked_revenue: Math.round(r() * 90000) / 100 });
      }
    }
  }
  const nowTs = "2026-06-30T12:00:00.000Z";
  const written: SnapshotRow[] = days.flatMap((d) =>
    types.map((t) => ({ hotel_id: "h1", snapshot_ts: nowTs, stay_date: d, room_type_id: t, sellable_units: 7, booked_units: 3, booked_revenue: 12.5 })),
  );

  it("answers the run's own snapshot from memory, only when every cell was written", () => {
    const { client, calls } = fakeSupabase({ stay_date_snapshot: [...table, ...written] });
    const lookup = createSnapshotLookup(client, "h1", nowTs, written);
    const hit = lookup.written(days[3], types, nowTs)!;
    expect(hit.snapshots.get("rt1")).toEqual({ booked_units: 3, booked_revenue: 12.5, snapshot_ts: nowTs });
    expect(hit.sellable.get("rt2")).toBe(7);
    expect(lookup.written(days[3], ["rt1", "rt9"], nowTs)).toBeNull();
    expect(lookup.written(days[3], types, "2026-06-29T00:00:00.000Z")).toBeNull();
    expect(calls.length).toBe(0);
  });

  it.each([
    ["with snapshot_cells_at", {}],
    ["before the migration", { rpc: (fn: string) => new FakeRpcError(missingFunction(fn)) }],
  ])("memoized and preloaded reads equal findSnapshotAt (%s)", async (_label, opts) => {
    resetSnapshotLookupLogOnce();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeSupabase({ stay_date_snapshot: table }, { ...opts, maxRows: 1000 });
    const lookup = createSnapshotLookup(client, "h1", nowTs, []);
    for (const ts of ["2026-06-27T00:00:00.000Z", "2026-06-28T09:00:00.000Z", "2026-06-29T20:00:00.000Z"]) {
      await lookup.preload(ts, days[2], days[25], types);
      for (const d of days) {
        expect(await lookup.at(d, types, ts)).toEqual(await findSnapshotAt(client, "h1", d, types, ts));
      }
    }
    if ("rpc" in opts) expect(err.mock.calls.filter((c) => String(c[0]).includes("snapshot_cells_at"))).toHaveLength(1);
  });
});
