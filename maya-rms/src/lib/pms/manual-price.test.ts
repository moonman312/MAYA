/**
 * The reset a manual price makes, shared by a price typed in MAYA and a rate
 * changed in the PMS on a night MAYA had sent: the rows say where they came
 * from, and only the cells written lose the effects already holding on them.
 */
import { describe, expect, it } from "vitest";
import { nightRuns, setManualPrices } from "./manual-price";
import { FakeRpcError, fakeSupabase, missingColumn, missingFunction, type FakeRow } from "../engine/fake-supabase.test";

const NOW = "2026-09-16T12:00:00.000Z";

function db(extra: Record<string, FakeRow[]> = {}, opts: Parameters<typeof fakeSupabase>[1] = {}) {
  return fakeSupabase(
    {
      pricing_rules: [
        { id: "r1", hotel_id: "h1" },
        { id: "other-rule", hotel_id: "h2" },
      ],
      manual_price: [],
      ladder_rule_state: [
        { rule_id: "r1", stay_date: "2026-09-20", room_type_id: "rt1", is_active: true, suppressed_at: null },
        { rule_id: "r1", stay_date: "2026-09-21", room_type_id: "rt1", is_active: true, suppressed_at: null },
        { rule_id: "r1", stay_date: "2026-09-22", room_type_id: "rt1", is_active: true, suppressed_at: null },
        { rule_id: "r1", stay_date: "2026-09-20", room_type_id: "rt2", is_active: true, suppressed_at: null },
        { rule_id: "other-rule", stay_date: "2026-09-20", room_type_id: "rt1", is_active: true, suppressed_at: null },
      ],
      pickup_event: [
        { id: "p1", hotel_id: "h1", stay_date: "2026-09-21", affected_room_type_id: "rt1", retired_at: null },
        { id: "p2", hotel_id: "h1", stay_date: "2026-09-21", affected_room_type_id: "rt2", retired_at: null },
      ],
      ...extra,
    },
    opts,
  );
}

describe("nightRuns", () => {
  it("joins consecutive nights of a room type, across a month end, and splits on a gap", () => {
    expect(
      nightRuns([
        { roomTypeId: "rt1", stayDate: "2026-09-30", price: 1 },
        { roomTypeId: "rt1", stayDate: "2026-10-01", price: 1 },
        { roomTypeId: "rt2", stayDate: "2026-10-01", price: 1 },
        { roomTypeId: "rt1", stayDate: "2026-10-03", price: 1 },
        { roomTypeId: "rt1", stayDate: "2026-09-29", price: 1 },
      ]),
    ).toEqual([
      { roomTypeId: "rt1", from: "2026-09-29", to: "2026-10-01" },
      { roomTypeId: "rt1", from: "2026-10-03", to: "2026-10-03" },
      { roomTypeId: "rt2", from: "2026-10-01", to: "2026-10-01" },
    ]);
  });
});

describe("setManualPrices", () => {
  it("writes a PMS change with its PMS and no person, and resets only the cells it wrote", async () => {
    const d = db();
    const res = await setManualPrices(
      d.client,
      "h1",
      [
        { roomTypeId: "rt1", stayDate: "2026-09-20", price: 180 },
        { roomTypeId: "rt1", stayDate: "2026-09-21", price: 0 },
      ],
      { source: "pms", pmsType: "cloudbeds" },
      NOW,
    );

    expect(res).toEqual({ cells: 2, suppressedRules: 2, retiredPickups: 1 });
    expect(d.tables.manual_price).toEqual([
      expect.objectContaining({ hotel_id: "h1", room_type_id: "rt1", stay_date: "2026-09-20", price: 180, set_by: null, note: null, set_at: NOW, cleared_at: null, cleared_by: null, source: "pms", pms_type: "cloudbeds" }),
      expect.objectContaining({ stay_date: "2026-09-21", price: 0, source: "pms" }),
    ]);
    const suppressed = d.tables.ladder_rule_state.map((r) => `${r.rule_id}|${r.stay_date}|${r.room_type_id}|${r.suppressed_at ?? "-"}|${r.is_active}`);
    expect(suppressed).toEqual([
      `r1|2026-09-20|rt1|${NOW}|true`,
      `r1|2026-09-21|rt1|${NOW}|true`,
      "r1|2026-09-22|rt1|-|true",
      "r1|2026-09-20|rt2|-|true",
      "other-rule|2026-09-20|rt1|-|true",
    ]);
    expect(d.tables.pickup_event.map((r) => r.retired_at)).toEqual([NOW, null]);
    // One call, one transaction: never the rows without their reset.
    expect(d.calls.map((c) => `${c.op} ${c.table}`)).toEqual(["select rpc:set_manual_prices_from_pms"]);
    expect(d.calls[0].payload).toEqual({
      p_hotel_id: "h1",
      p_pms_type: "cloudbeds",
      p_set_at: NOW,
      p_cells: [
        { room_type_id: "rt1", stay_date: "2026-09-20", price: 180 },
        { room_type_id: "rt1", stay_date: "2026-09-21", price: 0 },
      ],
    });
  });

  it("leaves nothing behind when the PMS change's transaction fails", async () => {
    const d = db({}, { rpc: (fn) => (fn === "set_manual_prices_from_pms" ? new FakeRpcError({ code: "57014", message: "canceling statement due to statement timeout" }) : undefined) });
    await expect(
      setManualPrices(d.client, "h1", [{ roomTypeId: "rt1", stayDate: "2026-09-20", price: 180 }], { source: "pms", pmsType: "cloudbeds" }, NOW),
    ).rejects.toMatchObject({ code: "57014" });
    expect(d.tables.manual_price).toEqual([]);
    expect(d.tables.ladder_rule_state.every((r) => r.suppressed_at == null)).toBe(true);
    expect(d.tables.pickup_event.every((r) => r.retired_at == null)).toBe(true);
  });

  it("writes a typed price with its person and note, and without the source columns on a database that lacks them", async () => {
    const d = db({}, { fault: (c) => (c.table === "manual_price" && c.op === "upsert" && JSON.stringify(c.payload).includes('"source"') ? missingColumn("manual_price", "source") : null) });
    const res = await setManualPrices(d.client, "h1", [{ roomTypeId: "rt2", stayDate: "2026-09-20", price: 150 }], { source: "maya", setBy: "user-1", note: "event" }, NOW);

    expect(res).toEqual({ cells: 1, suppressedRules: 1, retiredPickups: 0 });
    expect(d.tables.manual_price).toEqual([{ id: expect.any(String), hotel_id: "h1", room_type_id: "rt2", stay_date: "2026-09-20", price: 150, note: "event", set_by: "user-1", set_at: NOW, cleared_at: null, cleared_by: null }]);
  });

  it("writes nothing from the PMS, and resets nothing, until the database can say where a price came from", async () => {
    const d = db({}, { rpc: (fn) => (fn === "set_manual_prices_from_pms" ? new FakeRpcError(missingFunction(fn)) : undefined) });
    await expect(
      setManualPrices(d.client, "h1", [{ roomTypeId: "rt1", stayDate: "2026-09-20", price: 180 }], { source: "pms", pmsType: "think" }, NOW),
    ).rejects.toMatchObject({ code: "PGRST202" });
    expect(d.tables.manual_price).toEqual([]);
    expect(d.tables.ladder_rule_state.every((r) => r.suppressed_at == null)).toBe(true);
  });
});
