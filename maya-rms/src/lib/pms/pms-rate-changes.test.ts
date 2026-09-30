/**
 * A rate MAYA sent, then changed or removed in the property system (Jake,
 * 2026-09-30): the whole scheduled tick on a live Cloudbeds hotel, on the
 * app's engine and the edge functions' copy.
 *
 *   Keep the change (the default): a changed rate is kept as the owner's
 *   price, as before; a removed one stops MAYA pricing and sending the night
 *   until a read returns a rate, which is then judged like any change.
 *   MAYA's price wins: nothing is kept, MAYA's price goes out again on the
 *   same run through the normal push, one change log item per night, and a
 *   price typed in MAYA is never replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateHotel as edgeEvaluateHotel } from "../../../supabase/functions/_shared/engine/evaluate";
import { resetCadenceMissingSeen, runPricingTick } from "../../../supabase/functions/_shared/pms/pricing-tick";
import type { CellPushResult, PmsRatePushAdapter, RateCell } from "../../../supabase/functions/_shared/pms/rate-push";
import { PMS_RATE_REMOVED_REASON } from "../../../supabase/functions/_shared/pms/push-guardrails";
import { cadenceRpc } from "../engine/cadence-rpc-model.test";
import { evaluateHotel as appEvaluateHotel } from "../engine/evaluate";
import { fakeSupabase, type FakeRow } from "../engine/fake-supabase.test";

const ENGINES = [
  { name: "app engine", evaluateHotel: appEvaluateHotel },
  { name: "edge engine", evaluateHotel: edgeEvaluateHotel },
];
type Engine = (typeof ENGINES)[number];

const H = "h1";
const RT = "a0000000-0000-4000-8000-000000000001";
const MIN = 60_000;
const HOUR = 60 * MIN;
const HORIZON = 30;
const LOCAL0 = "2026-10-06";
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const night = (n: number) => addDays(LOCAL0, n);
/** 10:00 on the story's first day; the property is on UTC. */
const T0 = Date.parse(`${LOCAL0}T10:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString();

/** A send of `price` that went out and was confirmed two hours before T0. */
function settled(n: number, price: number, over: FakeRow = {}): FakeRow {
  return {
    id: `l${n}`, hotel_id: H, pms_type: "cloudbeds", room_type_id: RT, external_room_type_id: "CB-KING", stay_date: night(n),
    price, sent_price: price, status: "sent", attempts: 1, pms_job_reference: `job-${n}`, external_rate_id: "base-1",
    pushed_at: iso(T0 - 2 * HOUR), confirmed_at: iso(T0 - 2 * HOUR), pms_edited_at: null, ...over,
  };
}

/**
 * A live hotel, on MAYA for a while: every night of the window has the
 * hotel's own 150 on record, MAYA published and sent 150 to each, and
 * Cloudbeds holds 150 on each. `inPms` is Cloudbeds: change or delete a
 * night to change or remove its rate there.
 */
function hotel(mode: "keep" | "maya_wins" | null, extra: Record<string, FakeRow[]> = {}) {
  const nights = Array.from({ length: HORIZON }, (_, n) => n);
  const fake = fakeSupabase(
    {
      hotels: [{ id: H, name: "Harbour Inn", timezone: "UTC" }],
      hotel_settings: [
        { hotel_id: H, simulation_mode: false, live_since: iso(T0 - 10 * 24 * HOUR), ...(mode ? { pms_rate_changes: mode } : {}) },
      ],
      room_types: [
        { id: RT, hotel_id: H, name: "King", external_room_type_id: "CB-KING", is_active: true, total_rooms: 10, floor_price: 1, ceiling_price: 99999.99, counts_as_room: true },
      ],
      pms_connections: [
        {
          id: "conn-1", hotel_id: H, pms_type: "cloudbeds", status: "connected", base_rates_refreshed_at: null, push_rate_targets: { "CB-KING": "base-1" },
          base_rates_through: night(HORIZON - 1), base_rates_returned_through: night(HORIZON - 1), updated_at: iso(T0 - 24 * HOUR),
        },
      ],
      pricing_rules: [],
      reservations: [],
      base_rate_calendar: nights.map((n) => ({ hotel_id: H, stay_date: night(n), room_type_id: RT, price: 150, source: "pms", captured_at: iso(T0 - 5 * 24 * HOUR), pms_removed_at: null })),
      published_price: nights.map((n) => ({ hotel_id: H, stay_date: night(n), room_type_id: RT, price: 150, base_price: 150, computed_at: iso(T0 - 2 * HOUR) })),
      rate_updates: nights.map((n) => settled(n, 150)),
      ladder_rule_state: [],
      manual_price: [],
      hotel_closed_periods: [],
      assumption_challenges: [],
      room_type_out_of_service: [],
      pickup_event: [],
      rule_repeat_alerts: [],
      rule_repeat_alert_nights: [],
      evaluation_run_log: [],
      pms_change_notices: [],
      pms_change_watch: [],
      ...extra,
    },
    { rpc: (fn, args, tables) => cadenceRpc(fn, args, tables) },
  );
  const inPms = new Map<string, number>(nights.map((n) => [night(n), 150]));
  for (const r of extra.rate_updates ?? []) if (r.status === "sent") inPms.set(String(r.stay_date), Number(r.price));
  const sends: { stayDate: string; price: number }[][] = [];
  const adapter: PmsRatePushAdapter = {
    pmsType: "cloudbeds",
    async resolveRateTargets() {
      return { "CB-KING": "base-1" };
    },
    async readBaseRateCalendar(start, end) {
      const entries = [];
      for (let d = start; d <= end; d = addDays(d, 1)) {
        const price = inPms.get(d);
        if (price != null) entries.push({ stayDate: d, externalRoomTypeId: "CB-KING", price });
      }
      return { targets: { "CB-KING": "base-1" }, entries };
    },
    async pushCells(cells: Array<RateCell & { externalRateId: string }>): Promise<CellPushResult[]> {
      sends.push(cells.map((c) => ({ stayDate: c.stayDate, price: c.price })));
      for (const c of cells) inPms.set(c.stayDate, c.price);
      return cells.map((cell) => ({ cell, ok: true, jobReference: "job-new" }));
    },
  };
  return {
    ...fake,
    inPms,
    sent: () => sends.flat(),
    priceOf: (stay: string) => {
      const row = fake.tables.published_price.find((p) => p.stay_date === stay && p.room_type_id === RT);
      return row ? Number(row.price) : null;
    },
    ledgerOf: (stay: string) => fake.tables.rate_updates.find((r) => r.stay_date === stay && r.room_type_id === RT) ?? null,
    baseOf: (stay: string) => fake.tables.base_rate_calendar.find((r) => r.stay_date === stay && r.room_type_id === RT) ?? null,
    manualOf: (stay: string) => fake.tables.manual_price.filter((r) => r.stay_date === stay && r.room_type_id === RT),
    notices: () => fake.tables.pms_change_notices,
    async tick(engine: Engine, atMs: number) {
      vi.setSystemTime(new Date(atMs));
      return runPricingTick(
        fake.client,
        H,
        {
          horizonDays: HORIZON,
          adapter,
          runEvaluate: true,
          pushEnabled: true,
          evaluateBy: atMs + 10 * MIN,
          pushDeadlineAt: atMs + 10 * MIN,
          read: "ok",
          cadence: "every_tick",
        },
        { evaluate: engine.evaluateHotel, now: () => atMs, alert: async () => ({ sent: true }) },
      );
    },
  };
}

beforeEach(() => {
  resetCadenceMissingSeen();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(ENGINES)("$name: Keep the change (the default)", (engine) => {
  it("keeps a changed rate as the owner's price, as before, and sends nothing over it", async () => {
    // No setting saved: a database from before the setting reads as Keep.
    const w = hotel(null);
    w.inPms.set(night(4), 175);
    const res = await w.tick(engine, T0);
    expect(res.evaluate).not.toHaveProperty("error");
    expect(res.pmsEditsAdopted).toBe(1);
    expect(w.manualOf(night(4))).toEqual([expect.objectContaining({ price: 175, source: "pms", cleared_at: null })]);
    expect(w.priceOf(night(4))).toBe(175);
    expect(w.sent()).toEqual([]);
    expect(w.notices()).toEqual([]);
  }, 120_000);

  it("stops pricing and sending a night whose rate was removed, until a read returns a rate that is then kept as the owner's price", async () => {
    const w = hotel("keep");
    w.inPms.delete(night(5));
    const res = await w.tick(engine, T0);
    expect(res.evaluate).not.toHaveProperty("error");
    expect(res.calendar).toMatchObject({ ok: true, missingSent: 1, rateBack: 0 });
    // Stamped, not priced, and nothing goes out; what MAYA sent stays on the ledger.
    expect(w.baseOf(night(5))).toMatchObject({ price: 150, pms_removed_at: iso(T0) });
    expect(w.priceOf(night(5))).toBeNull();
    expect(w.ledgerOf(night(5))).toMatchObject({ status: "sent", price: 150 });
    expect(w.manualOf(night(5))).toEqual([]);
    expect(w.sent()).toEqual([]);
    expect(w.notices()).toEqual([]);

    // An hour on, still no rate there: nothing changes and nothing is sent.
    await w.tick(engine, T0 + 61 * MIN);
    expect(w.baseOf(night(5))).toMatchObject({ pms_removed_at: iso(T0) });
    expect(w.priceOf(night(5))).toBeNull();
    expect(w.sent()).toEqual([]);

    // The hotel loads 175 there: a change like any other, kept as their price.
    w.inPms.set(night(5), 175);
    const back = await w.tick(engine, T0 + 122 * MIN);
    expect(back.calendar).toMatchObject({ ok: true, rateBack: 1 });
    expect(w.baseOf(night(5))).toMatchObject({ price: 150, pms_removed_at: null });
    expect(w.manualOf(night(5))).toEqual([expect.objectContaining({ price: 175, source: "pms" })]);
    expect(w.priceOf(night(5))).toBe(175);
    expect(w.sent()).toEqual([]);
  }, 120_000);

  it("hands a night straight back to MAYA's pricing when its rate comes back at MAYA's price", async () => {
    const w = hotel("keep");
    w.inPms.delete(night(6));
    await w.tick(engine, T0);
    expect(w.priceOf(night(6))).toBeNull();
    w.inPms.set(night(6), 150);
    await w.tick(engine, T0 + 61 * MIN);
    expect(w.baseOf(night(6))).toMatchObject({ pms_removed_at: null });
    expect(w.manualOf(night(6))).toEqual([]);
    expect(w.priceOf(night(6))).toBe(150);
    expect(w.sent()).toEqual([]);
  }, 120_000);

  it("holds a price typed before the removal with the night, and sends one typed after it", async () => {
    const typedAt = iso(T0 - 5 * HOUR);
    const w = hotel("keep", {
      manual_price: [{ id: "m1", hotel_id: H, stay_date: night(7), room_type_id: RT, price: 200, set_by: "u1", set_at: typedAt, cleared_at: null, source: "maya", pms_type: null }],
      rate_updates: [...Array.from({ length: HORIZON }, (_, n) => (n === 7 ? settled(7, 200) : settled(n, 150)))],
      published_price: Array.from({ length: HORIZON }, (_, n) => ({
        hotel_id: H, stay_date: night(n), room_type_id: RT, price: n === 7 ? 200 : 150, base_price: n === 7 ? 200 : 150, computed_at: iso(T0 - 2 * HOUR),
      })),
    });
    w.inPms.delete(night(7));
    await w.tick(engine, T0);
    // The typed price waits with the night: it is still open, and nothing is published or sent.
    expect(w.baseOf(night(7))).toMatchObject({ pms_removed_at: iso(T0) });
    expect(w.manualOf(night(7))).toEqual([expect.objectContaining({ price: 200, source: "maya", cleared_at: null })]);
    expect(w.priceOf(night(7))).toBeNull();
    expect(w.sent()).toEqual([]);

    // The owner types 210 for it now: priced and sent as typed.
    const row = w.manualOf(night(7))[0];
    row.price = 210;
    row.set_at = iso(T0 + 10 * MIN);
    await w.tick(engine, T0 + 15 * MIN);
    expect(w.priceOf(night(7))).toBe(210);
    expect(w.sent()).toEqual([{ stayDate: night(7), price: 210 }]);
  }, 120_000);

  it("is not a removal on a night MAYA's send has not settled on, past the rates the PMS returns, or with no rate of the hotel's under it", async () => {
    const w = hotel("keep", {
      rate_updates: Array.from({ length: HORIZON }, (_, n) =>
        n === 3 ? settled(3, 150, { confirmed_at: null, pms_job_reference: "accepted:202" }) : n === 4 ? settled(4, 150, { pushed_at: iso(T0 - 10 * MIN), confirmed_at: iso(T0 - 5 * MIN) }) : settled(n, 150),
      ),
    });
    // Night 12's row is gone: MAYA sent a typed price there, and the hotel never had a rate.
    w.tables.base_rate_calendar.splice(w.tables.base_rate_calendar.findIndex((r) => r.stay_date === night(12)), 1);
    w.tables.manual_price.push({ id: "m2", hotel_id: H, stay_date: night(12), room_type_id: RT, price: 300, set_by: "u1", set_at: iso(T0 - 5 * HOUR), cleared_at: null, source: "maya", pms_type: null });
    for (const n of [3, 4, 12, 27, 28, 29]) w.inPms.delete(night(n));
    const res = await w.tick(engine, T0);
    // 27 to 29 are past the last night the PMS now returns: no rate on record, as for any night.
    expect(res.calendar).toMatchObject({ ok: true, returnedThrough: night(26), missingSent: 2 });
    for (const n of [3, 4, 12, 27, 28, 29]) expect(w.baseOf(night(n))?.pms_removed_at ?? null).toBeNull();
    expect(w.manualOf(night(12))).toEqual([expect.objectContaining({ price: 300, cleared_at: null })]);
  }, 120_000);

  it("reads nothing as removed while MAYA only simulates", async () => {
    const w = hotel("keep");
    w.tables.hotel_settings[0].simulation_mode = true;
    w.inPms.delete(night(5));
    await w.tick(engine, T0);
    expect(w.baseOf(night(5))).toMatchObject({ pms_removed_at: null });
    expect(w.sent()).toEqual([]);
  }, 120_000);
});

describe.each(ENGINES)("$name: MAYA's price wins", (engine) => {
  it("sends MAYA's price again over a changed rate on the same run, keeps nothing, and logs the night", async () => {
    const w = hotel("maya_wins");
    w.inPms.set(night(4), 175);
    const res = await w.tick(engine, T0);
    expect(res.evaluate).not.toHaveProperty("error");
    expect(res.pmsEditsAdopted ?? 0).toBe(0);
    expect(w.manualOf(night(4))).toEqual([]);
    expect(w.priceOf(night(4))).toBe(150);
    expect(w.sent()).toEqual([{ stayDate: night(4), price: 150 }]);
    expect(w.ledgerOf(night(4))).toMatchObject({ status: "sent", price: 150 });
    expect(w.notices()).toEqual([
      expect.objectContaining({ hotel_id: H, pms_type: "cloudbeds", kind: "overwrite", stay_date: night(4), room_type_id: RT, pms_rate: 175, maya_price: 150, found_at: iso(T0) }),
    ]);
    expect(w.tables.pms_change_watch).toEqual([expect.objectContaining({ hotel_id: H })]);

    // Next hour Cloudbeds has MAYA's price back: nothing more to do or log.
    await w.tick(engine, T0 + 61 * MIN);
    expect(w.sent()).toHaveLength(1);
    expect(w.notices()).toHaveLength(1);
  }, 120_000);

  it("sends MAYA's price again to a night whose rate was removed", async () => {
    const w = hotel("maya_wins");
    w.inPms.delete(night(5));
    const res = await w.tick(engine, T0);
    expect(res.calendar).toMatchObject({ ok: true, missingSent: 1 });
    expect(w.baseOf(night(5))).toMatchObject({ pms_removed_at: null });
    expect(w.priceOf(night(5))).toBe(150);
    expect(w.sent()).toEqual([{ stayDate: night(5), price: 150 }]);
    expect(w.ledgerOf(night(5))).toMatchObject({ status: "sent", price: 150 });
    expect(w.notices()).toEqual([expect.objectContaining({ kind: "overwrite", stay_date: night(5), pms_rate: null, maya_price: 150 })]);
    // The ledger said the price was gone before the push put it back.
    const upserts = w.calls.filter((c) => c.table === "rate_updates" && c.op === "upsert").flatMap((c) => c.payload as FakeRow[]);
    expect(upserts.find((r) => r.stay_date === night(5))).toMatchObject({ status: "skipped", error: PMS_RATE_REMOVED_REASON, sent_price: null });
  }, 120_000);

  it("never replaces a price typed in MAYA: it is what goes out again", async () => {
    const typedAt = iso(T0 - 5 * HOUR);
    const typed = (n: number, price: number, setAt: string): FakeRow => ({
      id: `m${n}`, hotel_id: H, stay_date: night(n), room_type_id: RT, price, set_by: "u1", set_at: setAt, cleared_at: null, source: "maya", pms_type: null,
    });
    const w = hotel("maya_wins", {
      // Night 8: typed and sent. Night 9: sent 150, then typed 220 half an hour ago, still on its way.
      manual_price: [typed(8, 200, typedAt), typed(9, 220, iso(T0 - 30 * MIN))],
      rate_updates: Array.from({ length: HORIZON }, (_, n) => (n === 8 ? settled(8, 200) : settled(n, 150))),
      published_price: Array.from({ length: HORIZON }, (_, n) => ({
        hotel_id: H, stay_date: night(n), room_type_id: RT, price: n === 8 ? 200 : n === 9 ? 220 : 150, base_price: n === 8 ? 200 : n === 9 ? 220 : 150,
        computed_at: iso(n === 9 ? T0 - 29 * MIN : T0 - 2 * HOUR),
      })),
    });
    w.inPms.set(night(8), 180);
    w.inPms.set(night(9), 180);
    await w.tick(engine, T0);
    expect(w.manualOf(night(8))).toEqual([expect.objectContaining({ price: 200, source: "maya", cleared_at: null, set_at: typedAt })]);
    expect(w.manualOf(night(9))).toEqual([expect.objectContaining({ price: 220, source: "maya", cleared_at: null })]);
    expect(w.sent().sort((a, b) => a.stayDate.localeCompare(b.stayDate))).toEqual([
      { stayDate: night(8), price: 200 },
      { stayDate: night(9), price: 220 },
    ]);
    // Only the typed price that had gone out was overwritten; the other was simply on its way.
    expect(w.notices()).toEqual([expect.objectContaining({ stay_date: night(8), pms_rate: 180, maya_price: 200 })]);
  }, 120_000);

  it("never clears a price typed in MAYA when the night is set to 0 there: the typed price goes out again", async () => {
    const typedAt = iso(T0 - 5 * HOUR);
    const w = hotel("maya_wins", {
      manual_price: [{ id: "m8", hotel_id: H, stay_date: night(8), room_type_id: RT, price: 200, set_by: "u1", set_at: typedAt, cleared_at: null, source: "maya", pms_type: null }],
      rate_updates: Array.from({ length: HORIZON }, (_, n) => (n === 8 ? settled(8, 200) : settled(n, 150))),
      published_price: Array.from({ length: HORIZON }, (_, n) => ({
        hotel_id: H, stay_date: night(n), room_type_id: RT, price: n === 8 ? 200 : 150, base_price: n === 8 ? 200 : 150, computed_at: iso(T0 - 2 * HOUR),
      })),
    });
    // Night 8 carries a typed price; night 3 only MAYA's. Both set to 0 in Cloudbeds.
    w.inPms.set(night(8), 0);
    w.inPms.set(night(3), 0);
    const res = await w.tick(engine, T0);
    expect(res.evaluate).not.toHaveProperty("error");
    expect(w.manualOf(night(8))).toEqual([expect.objectContaining({ price: 200, source: "maya", cleared_at: null, set_at: typedAt })]);
    expect(w.baseOf(night(8))).toMatchObject({ price: 150 });
    expect(w.priceOf(night(8))).toBe(200);
    expect(w.sent()).toEqual([{ stayDate: night(8), price: 200 }]);
    expect(w.notices()).toEqual([expect.objectContaining({ kind: "overwrite", stay_date: night(8), pms_rate: 0, maya_price: 200 })]);
    // A night with no typed price is closed, as a 0 always closes one.
    expect(w.baseOf(night(3))).toMatchObject({ price: 0 });
    expect(w.priceOf(night(3))).toBeNull();
  }, 120_000);

  it("hands back a rate kept from the PMS that is still open, and nights still marked removed", async () => {
    const keptAt = iso(T0 - 5 * HOUR);
    const w = hotel("maya_wins", {
      manual_price: [{ id: "m10", hotel_id: H, stay_date: night(10), room_type_id: RT, price: 175, set_by: null, set_at: keptAt, cleared_at: null, source: "pms", pms_type: "cloudbeds" }],
      rate_updates: Array.from({ length: HORIZON }, (_, n) => (n === 10 ? settled(10, 175) : settled(n, 150))),
    });
    w.tables.base_rate_calendar.find((r) => r.stay_date === night(11))!.pms_removed_at = keptAt;
    w.tables.published_price.splice(w.tables.published_price.findIndex((r) => r.stay_date === night(11)), 1);
    w.inPms.delete(night(11));
    await w.tick(engine, T0);
    expect(w.manualOf(night(10))).toEqual([expect.objectContaining({ price: 175, source: "pms", cleared_at: iso(T0) })]);
    expect(w.baseOf(night(11))).toMatchObject({ pms_removed_at: null });
    expect(w.priceOf(night(10))).toBe(150);
    expect(w.priceOf(night(11))).toBe(150);
    expect(w.sent().sort((a, b) => a.stayDate.localeCompare(b.stayDate))).toEqual([
      { stayDate: night(10), price: 150 },
      { stayDate: night(11), price: 150 },
    ]);
  }, 120_000);

  it("hands back a rate kept from the PMS just before the setting went on, though the PMS still quotes it and nothing else changed", async () => {
    // A refresh read Keep a moment before the owner confirmed MAYA's price wins, and kept 175 on night 10.
    const w = hotel("maya_wins", {
      manual_price: [{ id: "m10", hotel_id: H, stay_date: night(10), room_type_id: RT, price: 175, set_by: null, set_at: iso(T0 - 90 * MIN), cleared_at: null, source: "pms", pms_type: "cloudbeds" }],
      rate_updates: Array.from({ length: HORIZON }, (_, n) => (n === 10 ? settled(10, 175, { pms_edited_at: iso(T0 - 90 * MIN) }) : settled(n, 150))),
      published_price: Array.from({ length: HORIZON }, (_, n) => ({
        hotel_id: H, stay_date: night(n), room_type_id: RT, price: n === 10 ? 175 : 150, base_price: n === 10 ? 175 : 150, computed_at: iso(T0 - 90 * MIN),
      })),
    });
    expect(w.inPms.get(night(10))).toBe(175);
    await w.tick(engine, T0);
    expect(w.manualOf(night(10))).toEqual([expect.objectContaining({ price: 175, source: "pms", cleared_at: iso(T0) })]);
    expect(w.priceOf(night(10))).toBe(150);
    expect(w.sent()).toEqual([{ stayDate: night(10), price: 150 }]);
  }, 120_000);

  it("changes nothing while MAYA only simulates", async () => {
    const w = hotel("maya_wins");
    w.tables.hotel_settings[0].simulation_mode = true;
    w.inPms.set(night(4), 175);
    w.inPms.delete(night(5));
    await w.tick(engine, T0);
    expect(w.sent()).toEqual([]);
    expect(w.notices()).toEqual([]);
    expect(w.ledgerOf(night(4))).toMatchObject({ price: 150 });
  }, 120_000);

  it("never warns about another pricing tool, however many rates change", async () => {
    const w = hotel("maya_wins");
    // Each night its own rate: one shared percentage would read as the PMS's own markup.
    for (let n = 0; n < 25; n++) w.inPms.set(night(n), 170 + n);
    await w.tick(engine, T0);
    expect(w.notices().filter((r) => r.kind === "other_tool")).toEqual([]);
    expect(w.notices().filter((r) => r.kind === "overwrite")).toHaveLength(25);
    expect(w.tables.pms_change_watch[0]).not.toHaveProperty("other_tool_notice_at");
    expect(w.sent()).toHaveLength(25);
  }, 120_000);
});

describe.each(ENGINES)("$name: the warning that something else changes rates", (engine) => {
  it("warns once when 20 rates change in one read, and not again for 7 days", async () => {
    const w = hotel("keep");
    for (let n = 0; n < 20; n++) w.inPms.set(night(n), 175);
    await w.tick(engine, T0);
    expect(w.notices()).toEqual([expect.objectContaining({ kind: "other_tool", pms_type: "cloudbeds", rates: 20, found_at: iso(T0) })]);
    expect(w.tables.pms_change_watch[0]).toMatchObject({ other_tool_notice_at: iso(T0), change_days: { [night(0)]: 20 } });

    // Six days on, the other tool changes the rest: counted, not warned about again.
    for (let n = 20; n < HORIZON; n++) w.inPms.set(night(n), 185);
    await w.tick(engine, T0 + 6 * 24 * HOUR);
    expect(w.notices().filter((r) => r.kind === "other_tool")).toHaveLength(1);
  }, 120_000);

  it("does not warn about 19", async () => {
    const w = hotel("keep");
    for (let n = 0; n < 19; n++) w.inPms.set(night(n), 175);
    await w.tick(engine, T0);
    expect(w.notices()).toEqual([]);
    expect(w.tables.pms_change_watch[0]).toMatchObject({ change_days: { [night(0)]: 19 } });
  }, 120_000);
});
