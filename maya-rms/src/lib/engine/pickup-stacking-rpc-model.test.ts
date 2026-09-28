/**
 * In-memory stand-in for pickup_fire_heads, written straight from the SQL
 * so engine tests run the migrated path against fakeSupabase: by default as
 * 99_supabase_migration_undo_on_cancellation_v1.sql leaves it (the counts
 * over the open fires only, to the newest of their applied_at), which
 * undo-on-cancellation-sql.test.ts checks the real function against; and as
 * 99_supabase_migration_pickup_event_stacking_v1.sql made it (`version:
 * "stacking"`), which pickup-stacking-sql.test.ts checks it against, both
 * in PGlite.
 */
import { describe, expect, it } from "vitest";
import type { FakeRow } from "./fake-supabase.test";

/** Retired reasons whose fire still starts the rule's wait. */
const ANCHORS = new Set(["bookings_cancelled", "night_passed", "legacy"]);

function isAnchor(r: FakeRow): boolean {
  return r.retired_at == null || ANCHORS.has(String(r.retired_reason));
}

/** Which pickup_fire_heads: the undo migration's (the default) or the stacking one it replaced. */
export type FireHeadsVersion = "undo" | "stacking";

/**
 * Counted toward counted_fires and last_counted_at: the open fires, and
 * before the undo migration one taken off for cancellations too.
 */
function isCounted(r: FakeRow, version: FireHeadsVersion): boolean {
  return r.retired_at == null || (version === "stacking" && r.retired_reason === "bookings_cancelled");
}

/** pickup_fire_heads(p_hotel_id, p_rule_ids, p_from, p_to) */
export function pickupFireHeads(
  events: FakeRow[],
  a: Record<string, unknown>,
  version: FireHeadsVersion = "undo",
): FakeRow[] {
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
  const newest = (instants: string[]) =>
    instants.reduce<string | null>((max, at) => (max === null || Date.parse(at) > Date.parse(max) ? at : max), null);
  return [...groups.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([key, rows]) => {
      const [rule_id, stay_date, affected_room_type_id, rule_version] = key.split("|");
      const counted = rows.filter((r) => isCounted(r, version));
      return {
        rule_id,
        stay_date,
        affected_room_type_id,
        rule_version: Number(rule_version),
        max_fire_seq: Math.max(...rows.map((r) => Number(r.fire_seq ?? 0))),
        anchor_at: newest(rows.filter(isAnchor).map((r) => String(r.applied_at))),
        counted_fires: counted.length,
        last_counted_at: newest(counted.map((r) => String(r.applied_at))),
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

  it("before the undo migration: the highest fire number, the newest fire that starts a wait, and the counted fires", () => {
    const rows = [
      fire({ fire_seq: 1, applied_at: "2026-09-01T00:00:00.000Z", retired_at: "2026-09-02T00:00:00.000Z", retired_reason: "bookings_cancelled" }),
      fire({ fire_seq: 2, applied_at: "2026-09-08T00:00:00.000Z" }),
      // A fire of the bug, and one a price took off: neither starts a wait or counts.
      fire({ fire_seq: 3, applied_at: "2026-09-09T00:00:00.000Z", retired_at: "2026-09-09T00:00:00.000Z", retired_reason: "self_cancelled" }),
      fire({ fire_seq: 4, applied_at: "2026-09-10T00:00:00.000Z", retired_at: "2026-09-11T00:00:00.000Z", retired_reason: "manual_price" }),
    ];
    const out = pickupFireHeads(rows, { p_hotel_id: "h1", p_rule_ids: ["r1"], p_from: "2026-09-30", p_to: "2026-10-31" }, "stacking");
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

  it("after it: only the open fires count, to the newest applied_at (a change kept after cancellations included), while a change taken off for cancellations still starts the wait", () => {
    const rows = [
      fire({ fire_seq: 1, applied_at: "2026-09-01T00:00:00.000Z", checked_at: "2026-09-03T00:00:00.000Z" }),
      fire({ fire_seq: 2, applied_at: "2026-09-08T00:00:00.000Z", retired_at: "2026-09-09T00:00:00.000Z", retired_reason: "bookings_cancelled" }),
      fire({ fire_seq: 3, applied_at: "2026-09-10T00:00:00.000Z", retired_at: "2026-09-11T00:00:00.000Z", retired_reason: "manual_price" }),
    ];
    const out = pickupFireHeads(rows, { p_hotel_id: "h1", p_rule_ids: ["r1"], p_from: "2026-09-30", p_to: "2026-10-31" });
    expect(out.map((r) => [r.max_fire_seq, r.anchor_at, r.counted_fires, r.last_counted_at])).toEqual([
      [3, "2026-09-08T00:00:00.000Z", 1, "2026-09-01T00:00:00.000Z"],
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
