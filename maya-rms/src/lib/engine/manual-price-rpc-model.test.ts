/**
 * In-memory stand-in for set_manual_prices_from_pms in
 * 99_supabase_migration_push_guardrails_v1.sql, written straight from the SQL
 * so fakeSupabase answers it like a migrated database.
 * push-guardrails-migration-sql.test.ts runs the real function in PGlite;
 * this model only has to agree with its contract, which is the reset a price
 * typed in MAYA makes (setManualPrices), in one go.
 */
import { describe, expect, it } from "vitest";
import { setManualPrices } from "../pms/manual-price";
import { fakeSupabase, type FakeRow } from "./fake-supabase.test";

/** set_manual_prices_from_pms(p_hotel_id, p_pms_type, p_set_at, p_cells) */
export function setManualPricesFromPms(tables: Record<string, FakeRow[]>, a: Record<string, unknown>): FakeRow[] {
  const cells = new Map<string, { room_type_id: unknown; stay_date: unknown; price: unknown }>();
  for (const c of (a.p_cells as { room_type_id: unknown; stay_date: unknown; price: unknown }[]) ?? []) {
    const key = `${c.room_type_id}|${c.stay_date}`;
    if (!cells.has(key)) cells.set(key, c);
  }
  tables.manual_price ??= [];
  for (const c of cells.values()) {
    const next = {
      price: Number(c.price),
      note: null,
      set_by: null,
      set_at: a.p_set_at,
      cleared_at: null,
      cleared_by: null,
      source: "pms",
      pms_type: a.p_pms_type,
    };
    const row = tables.manual_price.find(
      (m) => m.hotel_id === a.p_hotel_id && m.stay_date === c.stay_date && m.room_type_id === c.room_type_id,
    );
    if (row) Object.assign(row, next);
    else tables.manual_price.push({ hotel_id: a.p_hotel_id, stay_date: c.stay_date, room_type_id: c.room_type_id, ...next });
  }

  const ruleIds = new Set((tables.pricing_rules ?? []).filter((r) => r.hotel_id === a.p_hotel_id).map((r) => r.id));
  let suppressed = 0;
  for (const s of tables.ladder_rule_state ?? []) {
    if (!ruleIds.has(s.rule_id) || !cells.has(`${s.room_type_id}|${s.stay_date}`)) continue;
    if (s.is_active !== true || s.suppressed_at != null) continue;
    s.suppressed_at = a.p_set_at;
    suppressed += 1;
  }
  let retired = 0;
  for (const e of tables.pickup_event ?? []) {
    if (e.hotel_id !== a.p_hotel_id || !cells.has(`${e.affected_room_type_id}|${e.stay_date}`) || e.retired_at != null) continue;
    e.retired_at = a.p_set_at;
    e.retired_reason = "manual_price";
    retired += 1;
  }
  return [{ cells: cells.size, suppressed_rules: suppressed, retired_pickups: retired }];
}

/** The functions this migration adds that fakeSupabase answers by default; null for any other. */
export function manualPriceRpc(fn: string, args: unknown, tables: Record<string, FakeRow[]>): unknown {
  return fn === "set_manual_prices_from_pms" ? setManualPricesFromPms(tables, args as Record<string, unknown>) : null;
}

describe("set_manual_prices_from_pms model", () => {
  it("resets exactly the cells a typed price resets, and says where the price came from", async () => {
    const seed = () => ({
      pricing_rules: [
        { id: "r1", hotel_id: "h1" },
        { id: "r9", hotel_id: "h2" },
      ],
      manual_price: [{ hotel_id: "h1", stay_date: "2026-10-02", room_type_id: "rt1", price: 90, set_by: "u1", note: "old", set_at: "2026-09-01T00:00:00Z", cleared_at: null, source: "maya", pms_type: null }],
      ladder_rule_state: [
        { rule_id: "r1", stay_date: "2026-10-01", room_type_id: "rt1", is_active: true, suppressed_at: null },
        { rule_id: "r1", stay_date: "2026-10-02", room_type_id: "rt1", is_active: false, suppressed_at: null },
        { rule_id: "r1", stay_date: "2026-10-03", room_type_id: "rt1", is_active: true, suppressed_at: null },
        { rule_id: "r1", stay_date: "2026-10-01", room_type_id: "rt2", is_active: true, suppressed_at: null },
        { rule_id: "r9", stay_date: "2026-10-01", room_type_id: "rt1", is_active: true, suppressed_at: null },
      ],
      pickup_event: [
        { id: "p1", hotel_id: "h1", rule_id: "r1", stay_date: "2026-10-02", affected_room_type_id: "rt1", retired_at: null },
        { id: "p2", hotel_id: "h1", rule_id: "r1", stay_date: "2026-10-03", affected_room_type_id: "rt1", retired_at: null },
      ],
    });
    const at = "2026-09-17T12:00:00.000Z";
    const cells = [
      { roomTypeId: "rt1", stayDate: "2026-10-01", price: 180 },
      { roomTypeId: "rt1", stayDate: "2026-10-02", price: 0 },
    ];
    const typed = fakeSupabase(seed());
    const typedRes = await setManualPrices(typed.client, "h1", cells, { source: "maya", setBy: "u2", note: null }, at);
    const pms = fakeSupabase(seed());
    const pmsRes = await setManualPrices(pms.client, "h1", cells, { source: "pms", pmsType: "cloudbeds" }, at);

    const counts = (r: Awaited<ReturnType<typeof setManualPrices>>) => ({
      cells: r.cells,
      suppressedRules: r.suppressedRules,
      retiredPickups: r.retiredPickups,
    });
    expect(counts(pmsRes)).toEqual(counts(typedRes));
    // Only the typed path counts the rules behind those rows, for the line the
    // person who typed the price reads. The PMS transaction returns counts.
    expect(typedRes.pausedRules).toBe(1);
    expect(pmsRes.pausedRules).toBeUndefined();
    expect(pms.tables.ladder_rule_state).toEqual(typed.tables.ladder_rule_state);
    expect(pms.tables.pickup_event).toEqual(typed.tables.pickup_event);
    const shape = (rows: FakeRow[]) => rows.map((r) => [r.stay_date, r.room_type_id, r.price, r.set_at, r.cleared_at]);
    expect(shape(pms.tables.manual_price)).toEqual(shape(typed.tables.manual_price));
    expect(pms.tables.manual_price.map((r) => [r.source, r.pms_type, r.set_by, r.note])).toEqual([
      ["pms", "cloudbeds", null, null],
      ["pms", "cloudbeds", null, null],
    ]);
  });
});
