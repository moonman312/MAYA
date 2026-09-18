/**
 * In-memory stand-in for pickup_fire_heads from
 * 99_supabase_migration_pickup_event_stacking_v1.sql, written straight from
 * the SQL so engine tests run the migrated path against fakeSupabase.
 * pickup-stacking-sql.test.ts checks the real function against this model in
 * PGlite.
 */
import { describe, expect, it } from "vitest";
import type { FakeRow } from "./fake-supabase.test";

/** Retired reasons whose fire still starts the rule's wait. */
const ANCHORS = new Set(["bookings_cancelled", "night_passed", "legacy"]);

function isAnchor(r: FakeRow): boolean {
  return r.retired_at == null || ANCHORS.has(String(r.retired_reason));
}

function isCounted(r: FakeRow): boolean {
  return r.retired_at == null || r.retired_reason === "bookings_cancelled";
}

/** pickup_fire_heads(p_hotel_id, p_rule_ids, p_from, p_to) */
export function pickupFireHeads(events: FakeRow[], a: Record<string, unknown>): FakeRow[] {
  const ruleIds = new Set((a.p_rule_ids as string[] | null) ?? []);
  const groups = new Map<string, FakeRow[]>();
  for (const e of events) {
    if (e.hotel_id !== a.p_hotel_id || !ruleIds.has(String(e.rule_id))) continue;
    const d = String(e.stay_date);
    if (d < String(a.p_from) || d > String(a.p_to)) continue;
    const key = `${e.rule_id}|${d}|${e.affected_room_type_id}|${e.rule_version}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  const newest = (rows: FakeRow[]) =>
    rows.reduce<string | null>(
      (max, r) => (max === null || Date.parse(String(r.applied_at)) > Date.parse(max) ? String(r.applied_at) : max),
      null,
    );
  return [...groups.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([key, rows]) => {
      const [rule_id, stay_date, affected_room_type_id, rule_version] = key.split("|");
      const counted = rows.filter(isCounted);
      return {
        rule_id,
        stay_date,
        affected_room_type_id,
        rule_version: Number(rule_version),
        max_fire_seq: Math.max(...rows.map((r) => Number(r.fire_seq ?? 0))),
        anchor_at: newest(rows.filter(isAnchor)),
        counted_fires: counted.length,
        last_counted_at: newest(counted),
      };
    });
}

/** An rpc handler for fakeSupabase that answers the stacking migration's functions. */
export function stackingRpc(fn: string, args: unknown, tables: Record<string, FakeRow[]>): unknown {
  const a = args as Record<string, unknown>;
  switch (fn) {
    case "pickup_fire_heads":
      return pickupFireHeads(tables.pickup_event ?? [], a);
    default:
      return null;
  }
}

describe("pickup_fire_heads model", () => {
  const fire = (over: Partial<FakeRow>): FakeRow => ({
    hotel_id: "h1",
    rule_id: "r1",
    rule_version: 1,
    stay_date: "2026-10-01",
    affected_room_type_id: "rt1",
    applied_at: "2026-09-01T00:00:00.000Z",
    fire_seq: 1,
    retired_at: null,
    retired_reason: null,
    ...over,
  });

  it("gives the highest fire number, the newest fire that starts a wait, and the counted fires", () => {
    const rows = [
      fire({ fire_seq: 1, applied_at: "2026-09-01T00:00:00.000Z", retired_at: "2026-09-02T00:00:00.000Z", retired_reason: "bookings_cancelled" }),
      fire({ fire_seq: 2, applied_at: "2026-09-08T00:00:00.000Z" }),
      // A fire of the bug, and one a price took off: neither starts a wait or counts.
      fire({ fire_seq: 3, applied_at: "2026-09-09T00:00:00.000Z", retired_at: "2026-09-09T00:00:00.000Z", retired_reason: "self_cancelled" }),
      fire({ fire_seq: 4, applied_at: "2026-09-10T00:00:00.000Z", retired_at: "2026-09-11T00:00:00.000Z", retired_reason: "manual_price" }),
    ];
    const out = pickupFireHeads(rows, { p_hotel_id: "h1", p_rule_ids: ["r1"], p_from: "2026-09-30", p_to: "2026-10-31" });
    expect(out).toEqual([
      {
        rule_id: "r1",
        stay_date: "2026-10-01",
        affected_room_type_id: "rt1",
        rule_version: 1,
        max_fire_seq: 4,
        anchor_at: "2026-09-08T00:00:00.000Z",
        counted_fires: 2,
        last_counted_at: "2026-09-08T00:00:00.000Z",
      },
    ]);
  });

  it("keeps each rule version apart, and leaves out other hotels, rules and nights", () => {
    const rows = [
      fire({ fire_seq: 1 }),
      fire({ rule_version: 2, fire_seq: 2, applied_at: "2026-09-20T00:00:00.000Z" }),
      fire({ hotel_id: "h2", fire_seq: 9 }),
      fire({ rule_id: "r2", fire_seq: 9 }),
      fire({ stay_date: "2026-11-30", fire_seq: 9 }),
    ];
    const out = pickupFireHeads(rows, { p_hotel_id: "h1", p_rule_ids: ["r1"], p_from: "2026-09-30", p_to: "2026-10-31" });
    expect(out.map((r) => [r.rule_version, r.max_fire_seq, r.counted_fires])).toEqual([
      [1, 1, 1],
      [2, 2, 1],
    ]);
  });

  it("answers nothing for a hotel with no fires", () => {
    expect(pickupFireHeads([], { p_hotel_id: "h1", p_rule_ids: ["r1"], p_from: "2026-01-01", p_to: "2026-12-31" })).toEqual([]);
  });
});
