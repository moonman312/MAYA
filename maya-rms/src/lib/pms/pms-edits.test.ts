/**
 * A rate the hotel changed in its PMS on a night MAYA had sent to becomes a
 * manual price, exactly as if it had been typed in MAYA. The danger is taking
 * MAYA's own output for the hotel's, so most of this is what is NOT adopted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptPmsEdits,
  planPmsEdits,
  pmsEditSettleMs,
  pmsHoldsPrice,
  type OpenManualPrice,
  type PushedNightRead,
} from "../../../supabase/functions/_shared/pms/pms-edits";
import { runPricingTick } from "../../../supabase/functions/_shared/pms/pricing-tick";
import type { CellPushResult, PmsRatePushAdapter, RateCalendarEntry, RateCell } from "../../../supabase/functions/_shared/pms/rate-push";
import { ensureBaseRateCalendar } from "./base-rate-calendar";
import { evaluateHotel } from "../engine/evaluate";
import { FakeRpcError, fakeSupabase, missingColumn, type FakeRow } from "../engine/fake-supabase.test";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const TARGETS = { "CB-KING": "rate-1", "CB-QUEEN": "rate-2" };

/** A settled send two hours old to the rate the read quotes, unless told otherwise. */
function read(over: Partial<PushedNightRead> & { ledger?: Record<string, unknown> } = {}): PushedNightRead {
  return {
    stayDate: "2026-10-05",
    roomTypeId: "rt-king",
    externalRoomTypeId: "CB-KING",
    pmsRate: 250,
    ...over,
    ledger: {
      status: "sent",
      price: 220,
      sent_price: 220,
      attempts: 1,
      pms_type: "cloudbeds",
      external_room_type_id: "CB-KING",
      external_rate_id: "rate-1",
      pms_job_reference: "job-1",
      confirmed_at: hoursAgo(2),
      pushed_at: hoursAgo(2),
      ...over.ledger,
    },
  };
}

function plan(reads: PushedNightRead[], manual: Record<string, OpenManualPrice> = {}) {
  return planPmsEdits({ reads, targets: TARGETS, manual: new Map(Object.entries(manual)), nowMs: NOW, settleMs: 60 * 60_000 });
}

describe("pmsEditSettleMs", () => {
  it("is an hour unless MAYA_PMS_EDIT_SETTLE_MINUTES says otherwise", () => {
    expect(pmsEditSettleMs(undefined)).toBe(60 * 60_000);
    expect(pmsEditSettleMs("15")).toBe(15 * 60_000);
    expect(pmsEditSettleMs("0")).toBe(60 * 60_000);
    expect(pmsEditSettleMs("later")).toBe(60 * 60_000);
  });
});

describe("pmsHoldsPrice", () => {
  it("is MAYA's price to the half cent, or that price rounded to a whole unit", () => {
    expect(pmsHoldsPrice(220, 220)).toBe(true);
    expect(pmsHoldsPrice(220.004, 220)).toBe(true);
    expect(pmsHoldsPrice(220.01, 220)).toBe(false);
    // A PMS keeping whole units, or a currency without cents.
    expect(pmsHoldsPrice(230, 230.45)).toBe(true);
    expect(pmsHoldsPrice(231, 230.45)).toBe(true);
    expect(pmsHoldsPrice(12346, 12345.67)).toBe(true);
    expect(pmsHoldsPrice(232, 230.45)).toBe(false);
    expect(pmsHoldsPrice(230.5, 230.45)).toBe(false);
  });
});

describe("planPmsEdits", () => {
  it("adopts a settled send the hotel changed, confirmed by its vendor or found in the PMS since", () => {
    const p = plan([
      read(),
      // Think: no job to ask about, and a refresh an hour ago read the price back.
      read({ stayDate: "2026-10-06", ledger: { pms_job_reference: "accepted:202", confirmed_at: hoursAgo(1) } }),
      read({ stayDate: "2026-10-07", pmsRate: 199.999 }),
    ]);
    expect(p.edits.map((e) => [e.read.stayDate, e.price])).toEqual([
      ["2026-10-05", 250],
      ["2026-10-06", 250],
      ["2026-10-07", 200],
    ]);
  });

  it("never takes a send the vendor only accepted as settled, so a batch it dropped is not a hotel's change", () => {
    // MAYA sent 220 to a Think night and it landed; later it sent 240, which
    // Think answered 202 for and never applied. The PMS still has 220.
    const dropped = read({ pmsRate: 220, ledger: { price: 240, sent_price: 240, pms_job_reference: "accepted:202", confirmed_at: null, pushed_at: hoursAgo(3) } });
    expect(plan([dropped])).toMatchObject({ edits: [], landed: [], waiting: 1 });
    // Still queued, or a hotel's change made before MAYA saw its own price there: the same.
    expect(plan([read({ ledger: { pms_job_reference: "accepted:202", confirmed_at: null } })])).toMatchObject({ edits: [], waiting: 1 });
    // Every older send has no stamp: none is taken on the first refresh after deploy.
    const older = Array.from({ length: 15 }, (_, i) =>
      read({ stayDate: `2026-10-${String(i + 10).padStart(2, "0")}`, pmsRate: 300 + i, ledger: { pms_job_reference: i % 2 ? "accepted:202" : "job-1", confirmed_at: null, pushed_at: hoursAgo(72) } }),
    );
    expect(plan(older)).toMatchObject({ edits: [], waiting: 15 });
  });

  it("stamps a send whose price the PMS has as settled, and takes a change after that", () => {
    const unstamped = { pms_job_reference: "accepted:202", confirmed_at: null };
    const p = plan([
      read({ pmsRate: 220, ledger: unstamped }),
      // Rounded to a whole unit by the PMS: there too.
      read({ stayDate: "2026-10-06", pmsRate: 220, ledger: { ...unstamped, price: 219.6, sent_price: 219.6 } }),
      // Minutes old: found there all the same.
      read({ stayDate: "2026-10-07", pmsRate: 220, ledger: { ...unstamped, pushed_at: hoursAgo(0.1) } }),
      // Already stamped, to another rate, or not a send.
      read({ stayDate: "2026-10-08", pmsRate: 220 }),
      read({ stayDate: "2026-10-09", pmsRate: 220, ledger: { ...unstamped, external_rate_id: "rate-old" } }),
      read({ stayDate: "2026-10-10", pmsRate: 220, ledger: { ...unstamped, status: "failed", error: "send in progress" } }),
    ]);
    expect(p.landed.map((r) => r.stayDate)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(p.edits).toEqual([]);
  });

  it("takes a comp night the hotel set to 0 in the PMS as an edit", () => {
    expect(plan([read({ pmsRate: 0 })]).edits.map((e) => e.price)).toEqual([0]);
  });

  it("never takes as an edit anything MAYA's own sending can explain", () => {
    const cases: [string, PushedNightRead][] = [
      ["the PMS still has MAYA's price", read({ pmsRate: 220 })],
      ["MAYA's price rounded to a whole unit", read({ pmsRate: 220, ledger: { price: 219.6 } })],
      ["a job not confirmed yet", read({ ledger: { confirmed_at: null } })],
      ["a send still marked in progress", read({ ledger: { status: "failed", error: "send in progress", confirmed_at: null } })],
      ["a refused send", read({ ledger: { status: "failed", error: "Rate must be greater than 500" } })],
      ["a rejected or unconfirmed job", read({ ledger: { status: "failed", error: "rate job never confirmed" } })],
      ["a guardrail skip", read({ ledger: { status: "skipped", error: "guardrail:stale_price" } })],
      ["a no-target skip", read({ ledger: { status: "skipped", error: "no rate target for room type" } })],
      ["a send inside the settle window", read({ ledger: { pushed_at: hoursAgo(0.5), confirmed_at: hoursAgo(0.4) } })],
      ["a send with no time on record", read({ ledger: { pushed_at: null } })],
      ["a send to another rate id", read({ ledger: { external_rate_id: "rate-old" } })],
      ["a send with no rate id on record", read({ ledger: { external_rate_id: null } })],
      ["a send to another room type id", read({ ledger: { external_room_type_id: "CB-OLD" } })],
      ["a room type the read has no target for", read({ externalRoomTypeId: "CB-SUITE", ledger: { external_room_type_id: "CB-SUITE" } })],
      ["an accepted send never found in the PMS", read({ pmsRate: 200, ledger: { pms_job_reference: "accepted:202", confirmed_at: null } })],
      ["a negative rate", read({ pmsRate: -5 })],
    ];
    for (const [label, r] of cases) {
      expect({ label, edits: plan([r]).edits.length }).toEqual({ label, edits: 0 });
    }
  });

  it("counts a differing send that has not settled as waiting", () => {
    const p = plan([read({ ledger: { confirmed_at: null } }), read({ stayDate: "2026-10-06", ledger: { pushed_at: hoursAgo(0.2) } })]);
    expect(p).toMatchObject({ edits: [], waiting: 2 });
  });

  it("leaves a night whose open manual price is the PMS rate already, and brings a hold at that price in step", () => {
    const key = "2026-10-05|rt-king";
    // Typed in MAYA since the send, and in the PMS alike: not a change, and the sent row stays as it is.
    const same = plan([read()], { [key]: { price: 250, source: "maya", setAtMs: NOW - 30 * 60_000 } });
    expect(same).toMatchObject({ edits: [], inStep: [], typedSinceSend: 1 });

    // A comp night MAYA would not send, set to 0 in the PMS by hand: the hold goes in step.
    const zeroHold = { status: "skipped", error: "guardrail:zero_rate_unsupported", price: 0 };
    const comp = plan([read({ pmsRate: 0, ledger: zeroHold })], { [key]: { price: 0, source: "pms", setAtMs: NOW - 5 * 3_600_000 } });
    expect(comp).toMatchObject({ edits: [], inStep: [expect.objectContaining({ price: 0 })] });

    // A hold at another price, one written minutes ago, or to another rate: nothing to do.
    const zeroManual = { [key]: { price: 0, source: "pms" as const, setAtMs: NOW - 5 * 3_600_000 } };
    expect(plan([read({ pmsRate: 0, ledger: { ...zeroHold, price: 20 } })], zeroManual).inStep).toEqual([]);
    expect(plan([read({ pmsRate: 0, ledger: { ...zeroHold, pushed_at: hoursAgo(0.2) } })], zeroManual).inStep).toEqual([]);
    expect(plan([read({ pmsRate: 0, ledger: { ...zeroHold, external_rate_id: "rate-old" } })], zeroManual).inStep).toEqual([]);
  });

  it("takes a manual price the hotel set back by hand over the rule MAYA stacked on it", () => {
    const key = "2026-10-05|rt-king";
    // A +10% rule stacked on a manual price of 250 went out as 275 and settled; the hotel set 250 again.
    for (const source of ["pms", "maya"] as const) {
      const p = plan([read({ pmsRate: 250, ledger: { price: 275, sent_price: 275 } })], { [key]: { price: 250, source, setAtMs: NOW - 5 * 3_600_000 } });
      expect({ source, edits: p.edits.map((e) => e.price) }).toEqual({ source, edits: [250] });
    }
    // Not while the 275 is still settling, or never confirmed.
    const manual = { [key]: { price: 250, source: "pms" as const, setAtMs: NOW - 5 * 3_600_000 } };
    expect(plan([read({ ledger: { price: 275, pushed_at: hoursAgo(0.5) } })], manual).edits).toEqual([]);
    expect(plan([read({ ledger: { price: 275, confirmed_at: null } })], manual).edits).toEqual([]);
  });

  it("does not adopt over a price typed in MAYA after the send that is still on its way", () => {
    const key = "2026-10-05|rt-king";
    const typedSince = plan([read()], { [key]: { price: 180, source: "maya", setAtMs: NOW - 30 * 60_000 } });
    expect(typedSince).toMatchObject({ edits: [], typedSinceSend: 1 });

    // Typed before the send, or already what MAYA sent: the PMS change came after it.
    expect(plan([read()], { [key]: { price: 180, source: "maya", setAtMs: NOW - 3 * 3_600_000 } }).edits).toHaveLength(1);
    expect(plan([read()], { [key]: { price: 220, source: "maya", setAtMs: NOW - 30 * 60_000 } }).edits).toHaveLength(1);
    // A second change in the PMS over one adopted before is adopted again.
    expect(plan([read({ ledger: { price: 230, pms_edited_at: hoursAgo(1) } })], { [key]: { price: 230, source: "pms", setAtMs: NOW - 3_600_000 } }).edits).toHaveLength(1);
  });

  it("adopts nothing when every settled night differs by one ratio, which is the PMS's own rule, not a person", () => {
    const nights = (n: number, rate: (i: number) => number) =>
      Array.from({ length: n }, (_, i) =>
        read({ stayDate: `2026-10-${String(i + 1).padStart(2, "0")}`, pmsRate: rate(i), ledger: { price: 200 + i * 10, sent_price: 200 + i * 10 } }),
      );
    const taxed = plan(nights(12, (i) => (200 + i * 10) * 1.1));
    expect(taxed).toMatchObject({ edits: [], systematic: 12 });
    // Fewer nights than that, varied changes, or one night MAYA's price is still on: edits.
    expect(plan(nights(5, (i) => (200 + i * 10) * 1.1)).edits).toHaveLength(5);
    expect(plan(nights(12, (i) => (i % 2 ? 300 : 150))).edits).toHaveLength(12);
    const oneUntouched = nights(12, (i) => (i === 0 ? 200 : (200 + i * 10) * 1.1));
    expect(plan(oneUntouched).edits).toHaveLength(11);
  });
});

describe("adoptPmsEdits", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const AT = new Date(NOW).toISOString();
  const WINDOW = { firstDate: "2026-10-01", lastDate: "2026-11-29" };

  function db(extra: Record<string, FakeRow[]> = {}, opts: Parameters<typeof fakeSupabase>[1] = {}) {
    return fakeSupabase(
      {
        hotel_settings: [{ hotel_id: "h1", simulation_mode: false }],
        pricing_rules: [{ id: "r1", hotel_id: "h1" }],
        ladder_rule_state: [
          { rule_id: "r1", stay_date: "2026-10-05", room_type_id: "rt-king", is_active: true, suppressed_at: null },
          { rule_id: "r1", stay_date: "2026-10-06", room_type_id: "rt-king", is_active: true, suppressed_at: null },
        ],
        pickup_event: [{ id: "p1", hotel_id: "h1", stay_date: "2026-10-05", affected_room_type_id: "rt-king", retired_at: null }],
        manual_price: [],
        rate_updates: [],
        ...extra,
      },
      opts,
    );
  }

  it("writes the manual price with the same reset a typed one makes, and records in the ledger that the PMS holds it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const d = db();
    const res = await adoptPmsEdits(
      d.client,
      "h1",
      "cloudbeds",
      [read(), read({ stayDate: "2026-10-06", pmsRate: 220 }), read({ stayDate: "2026-10-07", ledger: { confirmed_at: null } })],
      TARGETS,
      WINDOW,
      AT,
    );

    expect(res).toEqual({ adopted: 1, inStep: 0, landed: 0, suppressedRules: 1, retiredPickups: 1 });
    expect(d.tables.manual_price).toEqual([
      expect.objectContaining({ hotel_id: "h1", stay_date: "2026-10-05", room_type_id: "rt-king", price: 250, source: "pms", pms_type: "cloudbeds", set_by: null, note: null, set_at: AT, cleared_at: null }),
    ]);
    expect(d.tables.ladder_rule_state.map((r) => r.suppressed_at)).toEqual([AT, null]);
    expect(d.tables.pickup_event[0].retired_at).toBe(AT);
    expect(d.tables.rate_updates).toEqual([
      expect.objectContaining({
        stay_date: "2026-10-05", room_type_id: "rt-king", status: "sent", price: 250, sent_price: 250, pms_edited_at: AT,
        pms_job_reference: "job-1", external_rate_id: "rate-1", confirmed_at: hoursAgo(2), pushed_at: hoursAgo(2), attempts: 1, error: null,
      }),
    ]);
    // One line, counts only.
    const lines = log.mock.calls.map((c) => JSON.parse(String(c[0]))).filter((l) => l.fn === "adoptPmsEdits");
    expect(lines).toEqual([
      { fn: "adoptPmsEdits", hotelId: "h1", pmsType: "cloudbeds", found: 1, adopted: 1, inStep: 0, landed: 0, suppressedRules: 1, retiredPickups: 1, waiting: 1, typedSinceSend: 0, systematic: 0 },
    ]);
  });

  it("stamps the sends it finds in the PMS as settled, keeping the rest of the row", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const d = db();
    const unstamped = { pms_job_reference: "accepted:202", pms_type: "think", confirmed_at: null, pms_edited_at: hoursAgo(30) };
    const res = await adoptPmsEdits(
      d.client,
      "h1",
      "think",
      [read({ pmsRate: 220, ledger: unstamped }), read({ stayDate: "2026-10-06", pmsRate: 230, ledger: unstamped })],
      TARGETS,
      WINDOW,
      AT,
    );
    expect(res).toEqual({ adopted: 0, inStep: 0, landed: 1, suppressedRules: 0, retiredPickups: 0 });
    expect(d.tables.manual_price).toEqual([]);
    expect(d.tables.rate_updates).toEqual([
      expect.objectContaining({
        stay_date: "2026-10-05", status: "sent", price: 220, sent_price: 220, pms_job_reference: "accepted:202", pms_type: "think",
        pushed_at: hoursAgo(2), attempts: 1, confirmed_at: AT, pms_edited_at: hoursAgo(30),
      }),
    ]);
  });

  it("never adopts on a simulating hotel, or a hotel with no settings row", async () => {
    for (const settings of [[{ hotel_id: "h1", simulation_mode: true }], []]) {
      const d = db({ hotel_settings: settings });
      expect(await adoptPmsEdits(d.client, "h1", "cloudbeds", [read()], TARGETS, WINDOW, AT)).toMatchObject({ adopted: 0 });
      expect(d.tables.manual_price).toEqual([]);
    }
  });

  it("reads nothing more when every night still has MAYA's price", async () => {
    const d = db();
    await adoptPmsEdits(d.client, "h1", "cloudbeds", [read({ pmsRate: 220 })], TARGETS, WINDOW, AT);
    expect(d.calls).toEqual([]);
  });

  it("leaves a night outside the window alone", async () => {
    const d = db();
    const res = await adoptPmsEdits(d.client, "h1", "cloudbeds", [read({ stayDate: "2026-11-30" })], TARGETS, WINDOW, AT);
    expect(res.adopted).toBe(0);
    expect(d.tables.manual_price).toEqual([]);
  });

  it("adopts nothing on a database that can't say where a price came from yet", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const d = db({}, { fault: (c) => (c.table === "manual_price" && c.columns.includes("source") ? missingColumn("manual_price", "source") : null) });
    expect(await adoptPmsEdits(d.client, "h1", "cloudbeds", [read()], TARGETS, WINDOW, AT)).toMatchObject({ adopted: 0 });
    expect(d.tables.manual_price).toEqual([]);
  });

  it("adopts nothing through the refresh on a database whose ledger can't say a send settled", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const d = db(
      {
        hotels: [{ id: "h1", timezone: "UTC" }],
        room_types: [{ id: "rt-king", hotel_id: "h1", external_room_type_id: "CB-KING", is_active: true }],
        pms_connections: [{ id: "conn-1", hotel_id: "h1", pms_type: "cloudbeds", base_rates_refreshed_at: null }],
        base_rate_calendar: [],
        rate_updates: [{ id: "1", hotel_id: "h1", stay_date: "2026-10-05", room_type_id: "rt-king", ...read().ledger }],
      },
      { fault: (c) => (c.table === "rate_updates" && c.columns.includes("confirmed_at") ? missingColumn("rate_updates", "confirmed_at") : null) },
    );
    const adapter = {
      pmsType: "cloudbeds",
      resolveRateTargets: async () => TARGETS,
      pushCells: async () => [],
      readBaseRateCalendar: async () => ({ targets: TARGETS, entries: [{ stayDate: "2026-10-05", externalRoomTypeId: "CB-KING", price: 250 }] }),
    } as PmsRatePushAdapter;

    const res = await ensureBaseRateCalendar(d.client, "h1", adapter, {
      horizonDays: 60,
      clock: { at: AT, today: "2026-10-01", timeZone: "UTC" },
    });

    expect(res).toMatchObject({ ok: true, skippedAlreadyPushed: 1, pmsEditsAdopted: 0 });
    expect(d.tables.manual_price).toEqual([]);
  });

  it("logs a failed write and carries on, so the refresh still counts", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = db({}, { rpc: (fn) => (fn === "set_manual_prices_from_pms" ? new FakeRpcError({ code: "57014", message: "canceling statement due to statement timeout" }) : undefined) });
    expect(await adoptPmsEdits(d.client, "h1", "cloudbeds", [read()], TARGETS, WINDOW, AT)).toMatchObject({ adopted: 0 });
    expect(errors.mock.calls.some((c) => String(c[0]).includes("statement timeout"))).toBe(true);
    expect(d.tables.rate_updates).toEqual([]);
  });
});

describe("a rate changed in the PMS, through the tick", () => {
  // 12:00 UTC; the hotel is on UTC so the tick's date is Oct 1.
  const T0 = Date.parse("2026-10-01T12:00:00Z");
  const NIGHT = "2026-10-05";
  const HOTEL = "h1";

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(T0));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const busyRule = (id: string, created_at: string) => ({
    id, hotel_id: HOTEL, name: `Busy ${id}`, is_active: true, version: 1, priority: 100,
    start_date: null, end_date: null, is_annual: false, dow_mask: 127,
    action_type: "percent", action_direction: "increase", action_value: 10, is_pickup_rule: false,
    created_at, updated_at: created_at,
    rule_condition: [{ occupancy_operator: "gt", occupancy_threshold: 0.5 }],
    rule_signal_room_type: [{ room_type_id: "rt-king" }],
    rule_affected_room_type: [{ room_type_id: "rt-king" }],
  });

  function setup(ledger: FakeRow[]) {
    const d = fakeSupabase({
      hotels: [{ id: HOTEL, timezone: "UTC" }],
      hotel_settings: [{ hotel_id: HOTEL, simulation_mode: false }],
      room_types: [
        { id: "rt-king", hotel_id: HOTEL, name: "King", external_room_type_id: "CB-KING", is_active: true, total_rooms: 20, floor_price: 89, ceiling_price: 1000, counts_as_room: true },
      ],
      pms_connections: [{ id: "conn-1", hotel_id: HOTEL, pms_type: "cloudbeds", base_rates_refreshed_at: null, push_rate_targets: { "CB-KING": "rate-1" } }],
      base_rate_calendar: [{ hotel_id: HOTEL, stay_date: NIGHT, room_type_id: "rt-king", price: 200, source: "pms" }],
      // 16 of 20 booked: the busy rule holds.
      reservations: Array.from({ length: 16 }, (_, i) => ({
        id: `b${i}`, hotel_id: HOTEL, stay_date: NIGHT, room_type_id: "rt-king", base_rate: 200, current_rate: 220, created_at: "2026-09-01T00:00:00Z",
      })),
      pricing_rules: [busyRule("r1", "2026-01-01T00:00:00Z")],
      ladder_rule_state: [
        { rule_id: "r1", rule_version: 1, stay_date: NIGHT, room_type_id: "rt-king", is_active: true, suppressed_at: null, action_kind: "percent", action_direction: "increase", action_value: 10 },
      ],
      published_price: [{ hotel_id: HOTEL, stay_date: NIGHT, room_type_id: "rt-king", price: 220, base_price: 200, computed_at: new Date(T0 - 3 * 3_600_000).toISOString() }],
      manual_price: [],
      rate_updates: ledger,
    });
    const sent: { price: number; stayDate: string }[] = [];
    let pmsRate = 250;
    const adapter: PmsRatePushAdapter = {
      pmsType: "cloudbeds",
      async resolveRateTargets() {
        return { "CB-KING": "rate-1" };
      },
      async readBaseRateCalendar(): Promise<{ targets: Record<string, string>; entries: RateCalendarEntry[] }> {
        return { targets: { "CB-KING": "rate-1" }, entries: [{ stayDate: NIGHT, externalRoomTypeId: "CB-KING", price: pmsRate }] };
      },
      async pushCells(cells: Array<RateCell & { externalRateId: string }>): Promise<CellPushResult[]> {
        sent.push(...cells.map((c) => ({ price: c.price, stayDate: c.stayDate })));
        return cells.map((cell) => ({ cell, ok: true, jobReference: "accepted:202" }));
      },
    };
    const tick = (at: number) =>
      runPricingTick(
        d.client,
        HOTEL,
        { horizonDays: 7, adapter, runEvaluate: true, pushEnabled: true, evaluateBy: at + 60_000, pushDeadlineAt: at + 120_000 },
        { evaluate: evaluateHotel, now: () => at },
      );
    return { d, sent, tick, setPmsRate: (r: number) => (pmsRate = r) };
  }

  const settledSend = (price: number, over: FakeRow = {}): FakeRow => ({
    hotel_id: HOTEL, pms_type: "cloudbeds", stay_date: NIGHT, room_type_id: "rt-king", external_room_type_id: "CB-KING",
    external_rate_id: "rate-1", price, sent_price: price, status: "sent", attempts: 1, pms_job_reference: "job-9",
    confirmed_at: new Date(T0 - 2 * 3_600_000).toISOString(), pushed_at: new Date(T0 - 2 * 3_600_000).toISOString(), ...over,
  });

  const published = (d: ReturnType<typeof setup>["d"]) => d.tables.published_price.find((r) => r.stay_date === NIGHT)!.price;

  it("adopts it, publishes the PMS rate and sends nothing; a later rule stacks on it; clearing hands the night back to MAYA", async () => {
    const { d, sent, tick, setPmsRate } = setup([settledSend(220)]);

    // Tick 1: MAYA sent 220 (200 + 10%); the hotel typed 250 into Cloudbeds.
    const first = await tick(T0);
    expect(first.pmsEditsAdopted).toBe(1);
    expect(d.tables.manual_price).toEqual([expect.objectContaining({ price: 250, source: "pms", pms_type: "cloudbeds", set_by: null })]);
    // The busy rule that had fired is suppressed, not deactivated.
    expect(d.tables.ladder_rule_state[0]).toMatchObject({ is_active: true, suppressed_at: new Date(T0).toISOString() });
    expect(published(d)).toBe(250);
    expect(sent).toEqual([]);
    expect(first.push).toMatchObject({ pushed: true, sent: 0, skippedUnchanged: 1 });
    // The change log says where it came from.
    const audit = d.tables.evaluation_audit.filter((r) => r.stay_date === NIGHT).at(-1)!;
    expect((audit.details as Record<string, unknown>).manual_override).toMatchObject({ source: "pms", pms_type: "cloudbeds", set_by: null });

    // Tick 2, ten minutes on: nothing bounces.
    const second = await tick(T0 + 10 * 60_000);
    expect(second.pmsEditsAdopted ?? 0).toBe(0);
    expect(published(d)).toBe(250);
    expect(sent).toEqual([]);

    // A rule created after the change fires, and stacks on the hotel's rate.
    d.tables.pricing_rules.push(busyRule("r2", new Date(T0 + 15 * 60_000).toISOString()));
    await tick(T0 + 20 * 60_000);
    expect(published(d)).toBe(275);
    expect(sent).toEqual([{ price: 275, stayDate: NIGHT }]);
    setPmsRate(275);

    // Cleared in MAYA, as the manual price route does it: MAYA's own pricing comes back.
    const clearedAt = new Date(T0 + 30 * 60_000).toISOString();
    d.tables.manual_price[0].cleared_at = clearedAt;
    for (const row of d.tables.ladder_rule_state) row.suppressed_at = null;
    await tick(T0 + 31 * 60_000);
    expect(published(d)).toBe(242);
    expect(sent.at(-1)).toEqual({ price: 242, stayDate: NIGHT });
    expect(d.tables.manual_price).toHaveLength(1);
  });

  it("does not adopt over a send still settling, refused or never confirmed, and a comp night set in the PMS stays at 0", async () => {
    const cases: [string, FakeRow, number, number][] = [
      // label, ledger row, PMS rate, what MAYA then publishes
      ["a send ten minutes ago", settledSend(220, { pushed_at: new Date(T0 - 10 * 60_000).toISOString() }), 250, 220],
      ["a job not confirmed", settledSend(220, { confirmed_at: null }), 250, 220],
      ["a refused send", settledSend(220, { status: "failed", error: "Rate must be greater than 500", sent_price: null, confirmed_at: null }), 250, 220],
      ["a send still in progress", settledSend(220, { status: "failed", error: "send in progress", sent_price: null, confirmed_at: null }), 250, 220],
    ];
    for (const [label, row, pmsRate, publishedPrice] of cases) {
      const { d, tick, setPmsRate } = setup([row]);
      setPmsRate(pmsRate);
      const res = await tick(T0);
      expect({ label, adopted: res.pmsEditsAdopted, manual: d.tables.manual_price.length, published: published(d) }).toEqual({
        label,
        adopted: 0,
        manual: 0,
        published: publishedPrice,
      });
    }

    // The hotel comped the night in Cloudbeds.
    const { d, sent, tick, setPmsRate } = setup([settledSend(220)]);
    setPmsRate(0);
    await tick(T0);
    expect(d.tables.manual_price).toEqual([expect.objectContaining({ price: 0, source: "pms" })]);
    expect(published(d)).toBe(0);
    expect(sent).toEqual([]);
  });

  it("never takes a Think batch that was accepted and dropped for a change, and settles a send once it reads the price back", async () => {
    // MAYA's 220 landed; its later 242 was answered 202 and never applied.
    const dropped = settledSend(242, { pms_job_reference: "accepted:202", confirmed_at: null, pushed_at: new Date(T0 - 3 * 3_600_000).toISOString() });
    const { d, tick, setPmsRate } = setup([dropped]);
    setPmsRate(220);
    const first = await tick(T0);
    expect(first.pmsEditsAdopted).toBe(0);
    expect(d.tables.manual_price).toEqual([]);
    expect(d.tables.ladder_rule_state[0].suppressed_at).toBeNull();

    // A later read finds MAYA's price there: that send is settled from then.
    const later = setup([settledSend(242, { pms_job_reference: "accepted:202", confirmed_at: null })]);
    later.setPmsRate(242);
    await later.tick(T0);
    const stamps = later.d.calls.filter((c) => c.table === "rate_updates" && c.op === "upsert").flatMap((c) => c.payload as FakeRow[]);
    expect(stamps[0]).toMatchObject({ price: 242, status: "sent", confirmed_at: new Date(T0).toISOString() });
  });

  it("takes the manual price back when the hotel sets it again over a rule MAYA stacked on it, and sends nothing", async () => {
    const { d, sent, tick, setPmsRate } = setup([settledSend(275)]);
    const adoptedAt = new Date(T0 - 5 * 3_600_000).toISOString();
    // 250 changed in Cloudbeds earlier, the busy rule it answered suppressed;
    // a second rule fired later and went out as 275.
    d.tables.manual_price.push({ hotel_id: HOTEL, stay_date: NIGHT, room_type_id: "rt-king", price: 250, set_by: null, set_at: adoptedAt, cleared_at: null, source: "pms", pms_type: "cloudbeds" });
    d.tables.ladder_rule_state[0].suppressed_at = adoptedAt;
    d.tables.pricing_rules.push(busyRule("r2", new Date(T0 - 4 * 3_600_000).toISOString()));
    d.tables.ladder_rule_state.push({ rule_id: "r2", rule_version: 1, stay_date: NIGHT, room_type_id: "rt-king", is_active: true, suppressed_at: null, action_kind: "percent", action_direction: "increase", action_value: 10 });
    d.tables.published_price[0].price = 275;
    d.tables.published_price[0].base_price = 250;
    setPmsRate(250);

    const res = await tick(T0);

    expect(res.pmsEditsAdopted).toBe(1);
    expect(d.tables.ladder_rule_state.find((r) => r.rule_id === "r2")).toMatchObject({ is_active: true, suppressed_at: new Date(T0).toISOString() });
    expect(published(d)).toBe(250);
    expect(sent).toEqual([]);
    expect(d.tables.rate_updates[0]).toMatchObject({ price: 250, status: "sent" });
  });

  it("does not adopt a night whose manual price is already the PMS rate", async () => {
    const { d, sent, tick } = setup([settledSend(220)]);
    // Typed in MAYA half an hour ago (the route suppressed the busy rule), and typed into Cloudbeds too.
    const typedAt = new Date(T0 - 30 * 60_000).toISOString();
    d.tables.manual_price.push({
      hotel_id: HOTEL, stay_date: NIGHT, room_type_id: "rt-king", price: 250, set_by: "user-1", set_at: typedAt,
      cleared_at: null, source: "maya", pms_type: null,
    });
    d.tables.ladder_rule_state[0].suppressed_at = typedAt;

    const res = await tick(T0);

    expect(res.pmsEditsAdopted).toBe(0);
    expect(d.tables.manual_price).toEqual([expect.objectContaining({ price: 250, source: "maya", set_by: "user-1" })]);
    // The typed price goes out as it would have, the same number Cloudbeds has.
    expect(published(d)).toBe(250);
    expect(sent).toEqual([{ price: 250, stayDate: NIGHT }]);
    expect(d.tables.rate_updates[0]).toMatchObject({ price: 250, status: "sent" });
  });
});
