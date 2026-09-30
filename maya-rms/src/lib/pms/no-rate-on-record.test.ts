/**
 * A night the property system has no rate for (audit A6, decided 2026-09-29).
 *
 * The whole scheduled tick on a live Cloudbeds hotel: the refresh reads the
 * hotel's own rates, the engine prices, the push sends. The PMS has rates
 * loaded for only part of the window. A night with no rate on record and no
 * typed price is not priced and never sent, whatever its bookings paid; a
 * typed price on such a night is priced and sent; a night whose rate
 * arrives on a later read is priced and sent on the next run; and "rates
 * read through" is the last night the PMS actually returned, so a row an
 * earlier read stored past it is not priced on.
 *
 * Each case runs the app's engine and the edge functions' copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateHotel as edgeEvaluateHotel } from "../../../supabase/functions/_shared/engine/evaluate";
import { resetCadenceMissingSeen, runPricingTick } from "../../../supabase/functions/_shared/pms/pricing-tick";
import type { CellPushResult, PmsRatePushAdapter, RateCell } from "../../../supabase/functions/_shared/pms/rate-push";
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
const HORIZON = 30;
const LOCAL0 = "2026-10-06";
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const night = (n: number) => addDays(LOCAL0, n);
/** 10:00 in New York on the story's first day. */
const T0 = Date.parse(`${LOCAL0}T14:00:00Z`);

function booking(id: string, stay: string, rate: number): FakeRow {
  return {
    id: `f0000000-0000-4000-8000-0000000000${id}`,
    hotel_id: H,
    external_reservation_id: `e${id}`,
    stay_date: stay,
    room_type_id: RT,
    booking_date: addDays(LOCAL0, -3),
    booking_window_days: 8,
    current_rate: rate,
    base_rate: rate,
    created_at: `${addDays(LOCAL0, -3)}T10:00:00Z`,
  };
}

/**
 * A live hotel whose PMS has a 150 rate loaded for the nights in `rated`
 * (a set the test can grow), and nothing for the others.
 */
function hotel(extra: Record<string, FakeRow[]> = {}) {
  const fake = fakeSupabase(
    {
      hotels: [{ id: H, timezone: "America/New_York" }],
      hotel_settings: [{ hotel_id: H, simulation_mode: false }],
      room_types: [
        { id: RT, hotel_id: H, name: "King", external_room_type_id: "CB-KING", is_active: true, total_rooms: 10, floor_price: 1, ceiling_price: 99999.99, counts_as_room: true },
      ],
      pms_connections: [{ id: "conn-1", hotel_id: H, pms_type: "cloudbeds", status: "connected", base_rates_refreshed_at: null, push_rate_targets: null, updated_at: `${LOCAL0}T00:00:00Z` }],
      pricing_rules: [],
      reservations: [],
      base_rate_calendar: [],
      published_price: [],
      rate_updates: [],
      ladder_rule_state: [],
      manual_price: [],
      hotel_closed_periods: [],
      assumption_challenges: [],
      room_type_out_of_service: [],
      pickup_event: [],
      rule_repeat_alerts: [],
      rule_repeat_alert_nights: [],
      evaluation_run_log: [],
      ...extra,
    },
    { rpc: (fn, args, tables) => cadenceRpc(fn, args, tables) },
  );
  const rated = new Set<string>();
  const inPms = new Map<string, number>();
  const sends: { stayDate: string; price: number }[][] = [];
  const adapter: PmsRatePushAdapter = {
    pmsType: "cloudbeds",
    async resolveRateTargets() {
      return { "CB-KING": "base-1" };
    },
    async readBaseRateCalendar(start, end) {
      const entries = [];
      for (let d = start; d <= end; d = addDays(d, 1)) {
        if (!rated.has(d)) continue;
        entries.push({ stayDate: d, externalRoomTypeId: "CB-KING", price: inPms.get(d) ?? 150 });
      }
      return { targets: { "CB-KING": "base-1" }, entries };
    },
    async pushCells(cells: Array<RateCell & { externalRateId: string }>): Promise<CellPushResult[]> {
      sends.push(cells.map((c) => ({ stayDate: c.stayDate, price: c.price })));
      for (const c of cells) inPms.set(c.stayDate, c.price);
      return cells.map((cell) => ({ cell, ok: true, jobReference: "accepted:202" }));
    },
  };
  return {
    ...fake,
    rated,
    sends,
    sentTo: () => new Set(sends.flat().map((s) => s.stayDate)),
    priceOf: (stay: string) => {
      const row = fake.tables.published_price.find((p) => p.stay_date === stay && p.room_type_id === RT);
      return row ? Number(row.price) : null;
    },
    ledgerOf: (stay: string) => fake.tables.rate_updates.find((r) => r.stay_date === stay && r.room_type_id === RT) ?? null,
    connection: () => fake.tables.pms_connections[0],
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
        {
          evaluate: engine.evaluateHotel,
          now: () => atMs,
          alert: async () => ({ sent: true }),
        },
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

describe.each(ENGINES)("$name: a night the PMS has no rate for", (engine) => {
  it("is neither priced nor sent, whatever its guest paid; a typed price on such a night is priced and sent", async () => {
    const w = hotel({
      // Bookings on a night with a rate and on two without: what the guests paid never becomes a base.
      reservations: [booking("01", night(3), 260), booking("02", night(15), 260), booking("03", night(16), 90)],
      // The owner typed 400 for a night the PMS has no rate for.
      manual_price: [{ id: "m1", hotel_id: H, stay_date: night(20), room_type_id: RT, price: 400, set_by: "u1", set_at: `${addDays(LOCAL0, -1)}T12:00:00Z`, cleared_at: null, source: "maya", pms_type: null }],
      // Rows left over from before, on nights with no rate: one never sent to, one MAYA sent 150 to.
      published_price: [
        { hotel_id: H, stay_date: night(25), room_type_id: RT, price: 275, base_price: 250, computed_at: `${addDays(LOCAL0, -1)}T12:00:00Z` },
        { hotel_id: H, stay_date: night(26), room_type_id: RT, price: 999, base_price: 250, computed_at: `${addDays(LOCAL0, -1)}T12:00:00Z` },
      ],
      rate_updates: [
        { id: "l1", hotel_id: H, pms_type: "cloudbeds", room_type_id: RT, external_room_type_id: "CB-KING", stay_date: night(26), price: 150, status: "sent", attempts: 1, pushed_at: `${addDays(LOCAL0, -1)}T12:00:00Z`, external_rate_id: "base-1" },
      ],
    });
    // The PMS has rates loaded for the first ten nights only.
    for (let n = 0; n < 10; n++) w.rated.add(night(n));

    const res = await w.tick(engine, T0);
    expect(res.evaluate).not.toHaveProperty("error");
    expect(res.calendar).toMatchObject({ ok: true, returnedThrough: night(9) });
    expect(w.connection().base_rates_returned_through).toBe(night(9));

    // Nights with a rate are priced on it and sent.
    for (const n of [0, 3, 9]) expect(w.priceOf(night(n))).toBe(150);
    // Nights without one are not priced, booked or not, and never sent.
    for (const n of [10, 15, 16, 29]) expect(w.priceOf(night(n))).toBeNull();
    // The typed price is a base of its own: priced and sent as typed.
    expect(w.priceOf(night(20))).toBe(400);
    const sent = w.sentTo();
    expect(sent.has(night(20))).toBe(true);
    for (const n of [10, 15, 16, 25, 26, 29]) expect(sent.has(night(n))).toBe(false);
    expect(w.sends.flat().filter((s) => s.stayDate === night(20))).toEqual([{ stayDate: night(20), price: 400 }]);
    // Ten nights at the hotel's own rate, plus the typed one.
    expect(sent.size).toBe(11);

    // The leftover row on a night MAYA never sent to is gone; the one MAYA
    // sent to stays (its rate is still in the PMS), and the push holds it
    // under its own code rather than send 999 on no base at all.
    expect(w.priceOf(night(25))).toBeNull();
    expect(w.priceOf(night(26))).toBe(999);
    expect(w.ledgerOf(night(26))).toMatchObject({ status: "skipped", error: "guardrail:no_rate_on_record", attempts: 1 });
    expect(w.ledgerOf(night(25))).toBeNull();
    expect(res.push).toMatchObject({ guardrails: { "guardrail:no_rate_on_record": 1 } });
    // What the PMS holds: 150 on the rated nights and 400 on the typed one, nothing else.
    expect(new Set(w.sends.flat().map((s) => s.price))).toEqual(new Set([150, 400]));
  }, 120_000);

  it("is priced and sent on the next run once the PMS has a rate for it", async () => {
    const w = hotel({ reservations: [booking("01", night(12), 260)] });
    for (let n = 0; n < 10; n++) w.rated.add(night(n));
    await w.tick(engine, T0);
    expect(w.priceOf(night(12))).toBeNull();
    expect(w.sentTo().has(night(12))).toBe(false);

    // The hotel loads rates for the next five nights; the hourly read picks them up.
    for (let n = 10; n < 15; n++) w.rated.add(night(n));
    const later = await w.tick(engine, T0 + 61 * MIN);
    expect(later.calendar).toMatchObject({ ok: true, captured: 5, returnedThrough: night(14) });
    expect(w.connection().base_rates_returned_through).toBe(night(14));
    for (const n of [10, 12, 14]) expect(w.priceOf(night(n))).toBe(150);
    expect(w.priceOf(night(15))).toBeNull();
    const sentLater = w.sends.slice(1).flat();
    expect(sentLater.map((s) => s.stayDate).sort()).toEqual([10, 11, 12, 13, 14].map(night));
    expect(new Set(sentLater.map((s) => s.price))).toEqual(new Set([150]));
  }, 120_000);

  it("does not price a row an earlier read stored past the last night the PMS returned", async () => {
    // A rate on record for night 12 from an earlier read; the PMS now returns
    // rates through night 9 only, and a leftover published row sits on 12.
    const w = hotel({
      base_rate_calendar: [{ hotel_id: H, stay_date: night(12), room_type_id: RT, price: 150, source: "pms", captured_at: `${addDays(LOCAL0, -2)}T12:00:00Z` }],
      published_price: [{ hotel_id: H, stay_date: night(12), room_type_id: RT, price: 150, base_price: 150, computed_at: `${addDays(LOCAL0, -2)}T12:00:00Z` }],
    });
    for (let n = 0; n < 10; n++) w.rated.add(night(n));

    // Before any read has recorded how far the rates go, the stored row counts.
    w.tables.pms_connections[0].base_rates_returned_through = null;
    const res = await w.tick(engine, T0);
    expect(res.calendar).toMatchObject({ ok: true, returnedThrough: night(9) });
    // The read that just ran said the rates stop at night 9, but the engine
    // priced on the row before the stamp was read back... no: the refresh
    // runs before the engine, so the stamp is already there.
    expect(w.priceOf(night(12))).toBeNull();
    expect(w.sentTo().has(night(12))).toBe(false);
    expect(w.tables.base_rate_calendar.some((r) => r.stay_date === night(12))).toBe(true);

    // The PMS loads rates out to night 12 again: the row is a rate on record once more.
    for (let n = 10; n <= 12; n++) w.rated.add(night(n));
    await w.tick(engine, T0 + 61 * MIN);
    expect(w.connection().base_rates_returned_through).toBe(night(12));
    expect(w.priceOf(night(12))).toBe(150);
    expect(w.sentTo().has(night(12))).toBe(true);
  }, 120_000);
});
