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

function plan(reads: PushedNightRead[], manual: Record<string, OpenManualPrice> = {}, liveSinceMs?: number) {
  return planPmsEdits({ reads, targets: TARGETS, manual: new Map(Object.entries(manual)), nowMs: NOW, settleMs: 60 * 60_000, liveSinceMs });
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

  it("takes a night the hotel set to 0 in the PMS as closed, never as a price", () => {
    const key = "2026-10-05|rt-king";
    expect(plan([read({ pmsRate: 0 })])).toMatchObject({ edits: [], closed: [expect.objectContaining({ stayDate: "2026-10-05" })] });
    // Over a manual price from before the send, too; not over one typed since, which still goes out.
    expect(plan([read({ pmsRate: 0 })], { [key]: { price: 180, source: "pms", setAtMs: NOW - 5 * 3_600_000 } }).closed).toHaveLength(1);
    expect(plan([read({ pmsRate: 0 })], { [key]: { price: 180, source: "maya", setAtMs: NOW - 30 * 60_000 } })).toMatchObject({ closed: [], typedSinceSend: 1 });
    // Not before the send there has settled.
    expect(plan([read({ pmsRate: 0, ledger: { confirmed_at: null } })])).toMatchObject({ closed: [], waiting: 1 });
    // A comp night typed at 0, a fixed rule sent on top, and the hotel set the 0 back: that manual price, taken again.
    const comp = plan([read({ pmsRate: 0, ledger: { price: 20 } })], { [key]: { price: 0, source: "maya", setAtMs: NOW - 5 * 3_600_000 } });
    expect(comp).toMatchObject({ closed: [], edits: [expect.objectContaining({ price: 0 })] });
    // A closed night says nothing about a ratio: the rest still read as the PMS's own rule.
    const reads = Array.from({ length: 12 }, (_, i) =>
      read({ stayDate: `2026-10-${String(i + 1).padStart(2, "0")}`, pmsRate: i < 2 ? 0 : (200 + i * 10) * 1.1, ledger: { price: 200 + i * 10 } }),
    );
    expect(plan(reads)).toMatchObject({ edits: [], systematic: 10, closed: [expect.anything(), expect.anything()] });
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

  it("takes a rate changed while MAYA only simulated as the night's base, and a change after going live again as the hotel's", () => {
    // Settled two days ago; the hotel went back to simulation, then live again six hours ago.
    const beforeLive = { confirmed_at: hoursAgo(48), pushed_at: hoursAgo(48) };
    const liveSince = NOW - 6 * 3_600_000;
    const p = plan(
      [
        read({ ledger: beforeLive }),
        // Still MAYA's price: stamped again, so a change from now on is taken.
        read({ stayDate: "2026-10-06", pmsRate: 220, ledger: beforeLive }),
        // Settled since going live: a change like any other.
        read({ stayDate: "2026-10-07", ledger: { confirmed_at: hoursAgo(5) } }),
        // Closed while simulating: closed all the same.
        read({ stayDate: "2026-10-08", pmsRate: 0, ledger: beforeLive }),
        // The night was the hotel's already (a manual price from the PMS): its new rate is too.
        read({ stayDate: "2026-10-09", pmsRate: 260, ledger: { ...beforeLive, price: 230 } }),
      ],
      { "2026-10-09|rt-king": { price: 230, source: "pms", setAtMs: NOW - 72 * 3_600_000 } },
      liveSince,
    );
    expect(p.rebased.map((e) => [e.read.stayDate, e.price])).toEqual([["2026-10-05", 250]]);
    expect(p.edits.map((e) => [e.read.stayDate, e.price])).toEqual([
      ["2026-10-07", 250],
      ["2026-10-09", 260],
    ]);
    expect(p.landed.map((r) => r.stayDate)).toEqual(["2026-10-06"]);
    expect(p.closed.map((r) => r.stayDate)).toEqual(["2026-10-08"]);
    // A hotel live since before the column, or never back in simulation: every settled send counts.
    expect(plan([read({ ledger: beforeLive })]).edits).toHaveLength(1);
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

  describe("a PMS reporting MAYA's prices through a ratio of its own", () => {
    const night = (i: number) => `2026-${String(10 + Math.floor(i / 28)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`;
    const nights = (n: number, sentAt: (i: number) => number, rate: (i: number, sent: number) => number) =>
      Array.from({ length: n }, (_, i) =>
        read({ stayDate: night(i), pmsRate: rate(i, sentAt(i)), ledger: { price: sentAt(i), sent_price: sentAt(i) } }),
      );
    const sent = (i: number) => 200 + i * 10;
    const taxed = (_: number, price: number) => Math.round(price * 1.1 * 100) / 100;

    it("adopts none of the nights the ratio explains", () => {
      expect(plan(nights(12, sent, taxed))).toMatchObject({ edits: [], systematic: 12 });
      // Fewer nights than that, or changes with no ratio in common: edits.
      expect(plan(nights(5, sent, taxed)).edits).toHaveLength(5);
      expect(plan(nights(12, sent, (i) => (i % 2 ? 300 : 150))).edits).toHaveLength(12);
    });

    it("still finds it with a price typed in MAYA since the send on one night", () => {
      const reads = nights(30, sent, taxed);
      const typed = { [`${night(3)}|rt-king`]: { price: 199, source: "maya" as const, setAtMs: NOW - 30 * 60_000 } };
      expect(plan(reads, typed)).toMatchObject({ edits: [], systematic: 29, typedSinceSend: 1 });
    });

    it("adopts only the night the hotel really changed", () => {
      const reads = nights(30, sent, (i, price) => (i === 7 ? 999 : taxed(i, price)));
      const p = plan(reads);
      expect(p.systematic).toBe(29);
      expect(p.edits.map((e) => [e.read.stayDate, e.price])).toEqual([[night(7), 999]]);
    });

    it("still finds it when the PMS rounds what it reports to whole units on low prices", () => {
      const low = (i: number) => 40 + ((i * 7) % 31) + 0.45;
      const p = plan(nights(30, low, (_, price) => Math.round(price * 1.1)));
      expect(p).toMatchObject({ edits: [], systematic: 30 });
    });

    it("takes a hotel raising some of its nights by one percentage while the rest still quote MAYA's price", () => {
      const p = plan(nights(42, sent, (i, price) => (i < 12 ? taxed(i, price) : price)));
      expect(p).toMatchObject({ systematic: 0 });
      expect(p.edits).toHaveLength(12);
      // A few untouched nights among many that fit are not enough to say so.
      expect(plan(nights(12, sent, (i, price) => (i === 0 ? price : taxed(i, price))))).toMatchObject({ edits: [], systematic: 11 });
    });
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

    expect(res).toEqual({ adopted: 1, inStep: 0, landed: 0, closed: 0, clearedManual: 0, rebased: 0, suppressedRules: 1, retiredPickups: 1, movedCells: ["2026-10-05|rt-king"] });
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
      { fn: "adoptPmsEdits", hotelId: "h1", pmsType: "cloudbeds", found: 1, adopted: 1, inStep: 0, landed: 0, closed: 0, clearedManual: 0, rebased: 0, suppressedRules: 1, retiredPickups: 1, waiting: 1, typedSinceSend: 0, systematic: 0 },
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
    expect(res).toEqual({ adopted: 0, inStep: 0, landed: 1, closed: 0, clearedManual: 0, rebased: 0, suppressedRules: 0, retiredPickups: 0, movedCells: [] });
    expect(d.tables.manual_price).toEqual([]);
    expect(d.tables.rate_updates).toEqual([
      expect.objectContaining({
        stay_date: "2026-10-05", status: "sent", price: 220, sent_price: 220, pms_job_reference: "accepted:202", pms_type: "think",
        pushed_at: hoursAgo(2), attempts: 1, confirmed_at: AT, pms_edited_at: hoursAgo(30),
      }),
    ]);
  });

  it("closes a night set to 0 in the PMS: base 0, its manual price cleared and the rules it paused let go, the ledger at 0", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const earlier = hoursAgo(5);
    const d = db({
      base_rate_calendar: [{ hotel_id: "h1", stay_date: "2026-10-05", room_type_id: "rt-king", price: 200, source: "pms", captured_at: hoursAgo(900) }],
      manual_price: [
        { hotel_id: "h1", stay_date: "2026-10-05", room_type_id: "rt-king", price: 180, set_by: null, set_at: earlier, cleared_at: null, cleared_by: null, source: "pms", pms_type: "cloudbeds" },
        { hotel_id: "h1", stay_date: "2026-10-06", room_type_id: "rt-king", price: 190, set_by: "u1", set_at: earlier, cleared_at: null, cleared_by: null, source: "maya", pms_type: null },
      ],
    });
    d.tables.ladder_rule_state[0].suppressed_at = earlier;
    d.tables.ladder_rule_state[1].suppressed_at = earlier;

    const res = await adoptPmsEdits(d.client, "h1", "cloudbeds", [read({ pmsRate: 0, ledger: { price: 180, sent_price: 180 } })], TARGETS, WINDOW, AT);

    expect(res).toMatchObject({ adopted: 0, closed: 1, clearedManual: 1 });
    expect(d.tables.base_rate_calendar).toEqual([expect.objectContaining({ stay_date: "2026-10-05", price: 0, source: "pms", captured_at: AT })]);
    expect(d.tables.manual_price.map((m) => [m.stay_date, m.cleared_at, m.cleared_by])).toEqual([
      ["2026-10-05", AT, null],
      ["2026-10-06", null, null],
    ]);
    expect(d.tables.ladder_rule_state.map((r) => r.suppressed_at)).toEqual([null, earlier]);
    expect(d.tables.rate_updates).toEqual([
      expect.objectContaining({ stay_date: "2026-10-05", status: "sent", price: 0, sent_price: 0, pms_edited_at: AT, confirmed_at: AT, pms_job_reference: "job-1" }),
    ]);
  });

  it("writes a rate changed while MAYA only simulated as the night's base, with no manual price, and the ledger read now", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const d = db({
      hotel_settings: [{ hotel_id: "h1", simulation_mode: false, live_since: hoursAgo(1) }],
      base_rate_calendar: [{ hotel_id: "h1", stay_date: "2026-10-05", room_type_id: "rt-king", price: 200, source: "pms", captured_at: hoursAgo(900) }],
    });
    const res = await adoptPmsEdits(d.client, "h1", "cloudbeds", [read()], TARGETS, WINDOW, AT);
    expect(res).toMatchObject({ adopted: 0, rebased: 1 });
    expect(d.tables.manual_price).toEqual([]);
    expect(d.tables.ladder_rule_state.map((r) => r.suppressed_at)).toEqual([null, null]);
    expect(d.tables.base_rate_calendar).toEqual([expect.objectContaining({ stay_date: "2026-10-05", price: 250, source: "pms", captured_at: AT })]);
    expect(d.tables.rate_updates).toEqual([expect.objectContaining({ stay_date: "2026-10-05", status: "sent", price: 250, sent_price: 250, confirmed_at: AT, pms_edited_at: AT })]);
  });

  it("adopts nothing on a database without the column that says when the hotel went live", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const d = db({}, { fault: (c) => (c.table === "hotel_settings" && c.columns.includes("live_since") ? missingColumn("hotel_settings", "live_since") : null) });
    expect(await adoptPmsEdits(d.client, "h1", "cloudbeds", [read()], TARGETS, WINDOW, AT)).toMatchObject({ adopted: 0, rebased: 0 });
    expect(d.tables.manual_price).toEqual([]);
    expect(d.tables.rate_updates).toEqual([]);
  });

  it("never adopts on a simulating hotel, or a hotel with no settings row", async () => {
    for (const settings of [[{ hotel_id: "h1", simulation_mode: true }], []]) {
      const d = db({ hotel_settings: settings });
      expect(await adoptPmsEdits(d.client, "h1", "cloudbeds", [read()], TARGETS, WINDOW, AT)).toMatchObject({ adopted: 0 });
      expect(d.tables.manual_price).toEqual([]);
    }
  });

  it("reads nothing but the hotel's settings when every night still has MAYA's price, known there since it went live", async () => {
    const d = db({ hotel_settings: [{ hotel_id: "h1", simulation_mode: false, live_since: hoursAgo(3) }] });
    await adoptPmsEdits(d.client, "h1", "cloudbeds", [read({ pmsRate: 220 })], TARGETS, WINDOW, AT);
    expect(d.calls.map((c) => c.table)).toEqual(["hotel_settings"]);
    // Nothing sent or held: not even that.
    const none = db();
    await adoptPmsEdits(none.client, "h1", "cloudbeds", [read({ ledger: { status: "failed", error: "send in progress" } })], TARGETS, WINDOW, AT);
    expect(none.calls).toEqual([]);
  });

  it("stamps again a send known there only from before the hotel last went live, so a change after going live is the hotel's", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const d = db({ hotel_settings: [{ hotel_id: "h1", simulation_mode: false, live_since: hoursAgo(1) }] });
    // Every night still has MAYA's price; the only stamp is from before going live.
    await adoptPmsEdits(d.client, "h1", "cloudbeds", [read({ pmsRate: 220 })], TARGETS, WINDOW, AT);
    expect(d.tables.rate_updates).toEqual([expect.objectContaining({ price: 220, confirmed_at: AT })]);

    // An hour on, the hotel changes it: taken as its change, not as a base.
    const later = new Date(NOW + 3_600_000).toISOString();
    const res = await adoptPmsEdits(d.client, "h1", "cloudbeds", [read({ pmsRate: 250, ledger: { confirmed_at: AT } })], TARGETS, WINDOW, later);
    expect(res).toMatchObject({ adopted: 1, rebased: 0 });
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

  it("does not adopt over a send still settling, refused or never confirmed", async () => {
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

  });

  it("takes a night the hotel closed in the PMS as closed: nothing is sent to it, not even when a rule fires, until the hotel opens it", async () => {
    const { d, sent, tick, setPmsRate } = setup([settledSend(220)]);
    // The hotel closes the 5th by setting its rate to 0; the King floor is $89.
    setPmsRate(0);
    const first = await tick(T0);
    expect(first.pmsEditsAdopted ?? 0).toBe(0);
    expect(d.tables.manual_price).toEqual([]);
    expect(d.tables.base_rate_calendar.find((r) => r.stay_date === NIGHT)).toMatchObject({ price: 0 });
    // MAYA shows no price of its own for a closed night, and sends nothing.
    expect(d.tables.published_price.find((r) => r.stay_date === NIGHT)).toBeUndefined();
    expect(sent).toEqual([]);
    expect(d.tables.rate_updates[0]).toMatchObject({ status: "sent", price: 0 });

    // A +$20 rule fires on it later: still nothing.
    const plus20 = { ...busyRule("r2", new Date(T0 + 15 * 60_000).toISOString()), action_type: "fixed", action_value: 20 };
    d.tables.pricing_rules.push(plus20);
    await tick(T0 + 20 * 60_000);
    await tick(T0 + 90 * 60_000);
    expect(sent).toEqual([]);
    expect(d.tables.published_price.find((r) => r.stay_date === NIGHT)).toBeUndefined();

    // Opened again at 150, a while later: the hotel's rate is the base, and MAYA prices on it.
    setPmsRate(150);
    await tick(T0 + 3 * 3_600_000);
    expect(d.tables.base_rate_calendar.find((r) => r.stay_date === NIGHT)).toMatchObject({ price: 150 });
    expect(sent.length).toBe(1);
    expect(sent[0].price).toBeGreaterThanOrEqual(150);
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

  it("prices on a rate the hotel set while MAYA only simulated, and sends MAYA's price on it, when the hotel goes live again", async () => {
    // Sent and confirmed two days ago; then simulation for a while, with the
    // night re-priced by hand at 260; then live again an hour ago.
    const { d, sent, tick, setPmsRate } = setup([
      settledSend(220, { confirmed_at: new Date(T0 - 48 * 3_600_000).toISOString(), pushed_at: new Date(T0 - 48 * 3_600_000).toISOString() }),
    ]);
    d.tables.hotel_settings[0].live_since = new Date(T0 - 3_600_000).toISOString();
    setPmsRate(260);

    const res = await tick(T0);

    expect(res.pmsEditsAdopted ?? 0).toBe(0);
    expect(d.tables.manual_price).toEqual([]);
    expect(d.tables.ladder_rule_state[0].suppressed_at).toBeNull();
    expect(d.tables.base_rate_calendar.find((r) => r.stay_date === NIGHT)).toMatchObject({ price: 260 });
    // 260 and the busy rule's 10%, sent as going live said it would be.
    expect(published(d)).toBe(286);
    expect(sent).toEqual([{ price: 286, stayDate: NIGHT }]);
  });

  it("reads the PMS before re-pricing a night it sent to between hourly reads, so a rate changed in between is kept, not written over", async () => {
    const { d, sent, tick, setPmsRate } = setup([settledSend(220)]);
    // Read at 11:40; the hotel set 250 in Cloudbeds at 11:50; at 12:00 a new rule fires on the night.
    d.tables.pms_connections[0].base_rates_refreshed_at = new Date(T0 - 20 * 60_000).toISOString();
    setPmsRate(250);
    d.tables.pricing_rules.push(busyRule("r2", new Date(T0 - 10 * 60_000).toISOString()));

    const first = await tick(T0);

    expect(first.calendar).toMatchObject({ reason: "throttled" });
    expect(first.push).toMatchObject({ sent: 0, changedInPms: 1 });
    expect(sent).toEqual([]);
    expect(d.tables.manual_price).toEqual([expect.objectContaining({ price: 250, source: "pms" })]);
    // Both rules that had fired are suppressed.
    expect(d.tables.ladder_rule_state.map((r) => r.suppressed_at)).toEqual([new Date(T0).toISOString(), new Date(T0).toISOString()]);

    // Next tick prices the night at the hotel's rate, and there is nothing to send.
    await tick(T0 + 5 * 60_000);
    expect(published(d)).toBe(250);
    expect(sent).toEqual([]);
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
