/**
 * The grouped Booking Speed path has to give exactly what the old
 * row-by-row path gave. `legacy` (booking-speed-legacy.test.ts) is the
 * pre-change implementation, so every assertion here is old code against
 * new code on the same seeded data, for both the migrated (rpc) and
 * pre-migration (keyset) paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, daysBetween } from "@/lib/observations/calendar";
import {
  dailyPaceSeriesFromIndex,
  milestoneRanks,
  paceScoreFromRankWindows,
} from "@/lib/observations/booking-pace";
import { indexBookingRows } from "@/lib/observations/booking-rows";
import {
  HISTORY_YEARS_BACK,
  bookingSpeedAuditSnapshots,
  loadBookingSpeedContext,
  observeForStayDate,
  relevantDates,
  resetBookingSpeedLogOnce,
  signalSetKey,
} from "./booking-speed-provider";
import { legacy, legacySetObservations, makeFixture, type Fixture } from "./booking-speed-legacy.test";
import { FakeRpcError, fakeSupabase, missingFunction, type FakeRow } from "./fake-supabase.test";
import { bookingSpeedHistorySummary, scaleRpc } from "./scale-rpc-model.test";

const fixtures: Fixture[] = [
  makeFixture(1, 1),
  makeFixture(2, 12),
  makeFixture(3, 40),
  makeFixture(4, 137),
  makeFixture(5, 500),
  makeFixture(6, 25, { thin: true }),
  makeFixture(7, 20, { futureOnly: true }),
  makeFixture(8, 20, { futureOnly: true, closedHorizon: true }),
];

const WINDOWS = [1, 7, 30];
const methodsSeen = new Set<string>();
const HORIZON = 45;

beforeEach(() => {
  resetBookingSpeedLogOnce();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe.each(fixtures)("Booking Speed old vs new: $name", (fx) => {
  const targets = Array.from({ length: HORIZON }, (_, i) => addDays(fx.localDate, i));
  const horizonEnd = targets[targets.length - 1];
  const closed = fx.closed.map((c) => ({ start_date: String(c.start_date), end_date: String(c.end_date) }));
  const old = legacy.run(fx.reservations, closed, fx.challenges, fx.localDate, fx.capacity, fx.exclude, targets, WINDOWS);

  it.each([
    ["migrated", { rpc: scaleRpc }],
    ["pre-migration", { rpc: () => new FakeRpcError(missingFunction("booking_speed_history_summary")), maxRows: 1000 }],
  ] as const)("%s path matches", async (_label, opts) => {
    const { client } = fakeSupabase(
      { reservations: fx.reservations, hotel_closed_periods: fx.closed, assumption_challenges: fx.challenges },
      opts,
    );
    const ctx = await loadBookingSpeedContext(client, "h1", fx.localDate, fx.capacity, fx.exclude, horizonEnd);
    expect(old).not.toBeNull();
    expect(ctx).not.toBeNull();
    expect(ctx!.dailyDemand).toEqual(old!.daily);
    expect(ctx!.seasonModel).toEqual(old!.seasonModel);
    for (const target of targets) {
      for (const w of WINDOWS) {
        const got = observeForStayDate(ctx!, target, w);
        methodsSeen.add(got.method);
        expect(got).toEqual(old!.observations.get(`${target}|${w}`));
      }
    }
  });

  it("pace series agrees from the summary ranks and from the grouped index", () => {
    if (fx.capacity <= 0) return;
    const historyStart = addDays(fx.localDate, -(HISTORY_YEARS_BACK * 366));
    const historyEnd = addDays(fx.localDate, -1);
    const summary = bookingSpeedHistorySummary(fx.reservations, {
      p_hotel_id: "h1",
      p_from: historyStart,
      p_to: null,
      p_exclude: [...fx.exclude],
      p_ranks: milestoneRanks(fx.capacity),
    });
    const fromRanks = summary
      .filter((s) => String(s.stay_date) <= historyEnd && Number(s.usable) > 0)
      .map((s) => ({ stay_date: String(s.stay_date), value: paceScoreFromRankWindows(s.rank_windows as (number | null)[]) }));
    const keptHistory = fx.reservations
      .filter((r) => r.hotel_id === "h1" && String(r.stay_date) >= historyStart && String(r.stay_date) <= historyEnd)
      .filter((r) => !(r.room_type_id != null && fx.exclude.has(String(r.room_type_id))))
      .map((r) => ({
        stay_date: String(r.stay_date),
        booking_date: r.booking_date != null ? String(r.booking_date) : null,
        booking_window_days: r.booking_window_days != null ? Number(r.booking_window_days) : null,
      }));
    const legacyPace = legacy.dailyPaceSeries(keptHistory, fx.capacity);
    expect(fromRanks).toEqual(legacyPace);
    expect(dailyPaceSeriesFromIndex(indexBookingRows(keptHistory), fx.capacity)).toEqual(legacyPace);
  });
});

const COUNTING = ["rt-a", "rt-b"];
const PATHS = [
  ["migrated", { rpc: scaleRpc }],
  ["pre-migration", { rpc: () => new FakeRpcError(missingFunction("booking_speed_history_summary")), maxRows: 1000 }],
  [
    "migrated, windows without an include list",
    {
      rpc: (fn: string, args: unknown, tables: Record<string, FakeRow[]>) =>
        fn === "booking_speed_windows" && (args as Record<string, unknown>).p_include !== undefined
          ? new FakeRpcError(missingFunction("booking_speed_windows"))
          : scaleRpc(fn, args, tables),
    },
  ],
  [
    "migrated, without the first stay date function",
    {
      rpc: (fn: string, args: unknown, tables: Record<string, FakeRow[]>) =>
        fn === "booking_speed_first_stay_date"
          ? new FakeRpcError(missingFunction("booking_speed_first_stay_date"))
          : scaleRpc(fn, args, tables),
    },
  ],
] as const;

/** Suites that only started selling in March 2025, so older dates are no evidence for them. */
function withNewRoomType(fx: Fixture): Fixture {
  return {
    ...fx,
    name: `${fx.name}, rt-b new in 2025`,
    reservations: fx.reservations.filter((r) => !(r.room_type_id === "rt-b" && String(r.stay_date) < "2025-03-01")),
  };
}

describe.each([fixtures[1], fixtures[2], fixtures[3], fixtures[5], withNewRoomType(makeFixture(9, 30))])(
  "Booking Speed over measured sets: $name",
  (fx) => {
    const targets = Array.from({ length: HORIZON }, (_, i) => addDays(fx.localDate, i));
    const horizonEnd = targets[targets.length - 1];
    const closed = fx.closed.map((c) => ({ start_date: String(c.start_date), end_date: String(c.end_date) }));
    const old = legacy.run(fx.reservations, closed, fx.challenges, fx.localDate, fx.capacity, fx.exclude, targets, WINDOWS);
    const sets = [["rt-a"], ["rt-b"]];
    const expected = new Map(sets.map((set) => [signalSetKey(set), legacySetObservations(fx, set, targets, WINDOWS)]));

    it.each(PATHS)("%s path: the counting set is the hotel-wide observation, every other set matches the row model", async (_label, opts) => {
      const { client } = fakeSupabase(
        { reservations: fx.reservations, hotel_closed_periods: fx.closed, assumption_challenges: fx.challenges },
        opts,
      );
      const ctx = await loadBookingSpeedContext(client, "h1", fx.localDate, fx.capacity, fx.exclude, horizonEnd, COUNTING, [
        ["rt-b", "rt-a"],
        ...sets,
      ]);
      expect(ctx).not.toBeNull();
      expect(ctx!.seasonModel).toEqual(old!.seasonModel);
      for (const target of targets) {
        for (const w of WINDOWS) {
          const hotel = observeForStayDate(ctx!, target, w, ["rt-b", "rt-a", "rt-a"]);
          expect(hotel).toEqual(old!.observations.get(`${target}|${w}`));
          expect(hotel).not.toHaveProperty("measuredRoomTypeIds");
          for (const set of sets) {
            const got = observeForStayDate(ctx!, target, w, set);
            expect(got).toEqual(expected.get(signalSetKey(set))!.get(`${target}|${w}`));
            // The comparables are the hotel's, whatever is measured.
            expect(got.selection).toEqual(hotel.selection);
          }
        }
      }
      // The hotel-wide entries keep their old keys, so a default run's cache is unchanged.
      expect(ctx!.observationCache.has(`${targets[0]}|7`)).toBe(true);
      expect(ctx!.observationCache.size).toBe(targets.length * WINDOWS.length * 3);
    });
  },
);

describe("Booking Speed measured sets", () => {
  const fx = makeFixture(31, 40);
  const targets = Array.from({ length: 10 }, (_, i) => addDays(fx.localDate, i));
  const horizonEnd = targets[targets.length - 1];

  async function load(signalSets: string[][]) {
    const { client, calls } = fakeSupabase(
      { reservations: fx.reservations, hotel_closed_periods: fx.closed, assumption_challenges: fx.challenges },
      { rpc: scaleRpc },
    );
    const ctx = await loadBookingSpeedContext(client, "h1", fx.localDate, fx.capacity, fx.exclude, horizonEnd, COUNTING, signalSets);
    return { ctx: ctx!, calls };
  }

  it("shares one cache entry between rules measuring the same set in any order", async () => {
    const { ctx } = await load([["rt-a", "rt-court"], ["rt-court", "rt-a"]]);
    const a = observeForStayDate(ctx, targets[3], 7, ["rt-a", "rt-court"]);
    const b = observeForStayDate(ctx, targets[3], 7, ["rt-court", "rt-a", "rt-a"]);
    expect(b).toBe(a);
    expect(ctx.observationCache.size).toBe(1);
    // The court does not count as a room, so it is dropped before keying.
    expect(a.measuredRoomTypeIds).toEqual(["rt-a"]);
    expect(observeForStayDate(ctx, targets[3], 7, ["rt-a"])).toBe(a);
    expect(ctx.setWindows!.size).toBe(1);
  });

  it("asks for a default-only run's windows exactly as before", async () => {
    const plain = await load([]);
    const counting = await load([COUNTING, ["rt-b", "rt-a"]]);
    const rpcArgs = (calls: typeof plain.calls) => calls.filter((c) => c.table.startsWith("rpc:")).map((c) => JSON.stringify(c));
    expect(rpcArgs(counting.calls)).toEqual(rpcArgs(plain.calls));
    expect(counting.ctx.setWindows!.size).toBe(0);
  });

  it("a set with no bookings at all never makes a call", async () => {
    const { ctx } = await load([["rt-never-sold"]]);
    for (const t of targets) {
      for (const w of WINDOWS) {
        const obs = observeForStayDate(ctx, t, w, ["rt-never-sold"]);
        expect(obs.method).not.toBe("comparable");
        expect(obs.recentBookings).toBe(0);
        expect(obs.perComparable.every((c) => !c.hasData)).toBe(true);
        expect(obs.classification.speed).toBe("normal");
      }
    }
  });

  it("refuses a set that was not loaded rather than reading it as hotel-wide", async () => {
    const { ctx } = await load([]);
    expect(() => observeForStayDate(ctx, targets[0], 7, ["rt-a"])).toThrow(/not loaded/);
  });

  it("puts a narrower set's observation only in the audit of cells that asked for it", async () => {
    const { ctx } = await load([["rt-a"]]);
    observeForStayDate(ctx, targets[2], 7, COUNTING);
    observeForStayDate(ctx, targets[2], 30, ["rt-a"]);
    expect(bookingSpeedAuditSnapshots(ctx, targets[2])).toHaveLength(1);
    const both = bookingSpeedAuditSnapshots(ctx, targets[2], new Set([signalSetKey(["rt-a"])]));
    expect(both).toHaveLength(2);
    expect(both[1]).toHaveProperty("measuredRoomTypeIds", ["rt-a"]);
    expect(bookingSpeedAuditSnapshots(ctx, targets[1], new Set([signalSetKey(["rt-a"])]))).toHaveLength(0);
  });
});

describe("Booking Speed fixtures", () => {
  // Keep the seeded data honest: between them the fixtures have to reach
  // every way an observation can be decided, or equality proves little.
  it("exercise comparable, momentum and insufficient_data observations", () => {
    expect([...methodsSeen].sort()).toEqual(["comparable", "insufficient_data", "momentum"]);
  });
});

describe("Booking Speed boundaries", () => {
  it("returns null for a hotel with no rows, on both paths", async () => {
    for (const opts of [{ rpc: scaleRpc }, { rpc: () => new FakeRpcError(missingFunction("booking_speed_history_summary")) }]) {
      const { client } = fakeSupabase({ reservations: [] }, opts);
      expect(await loadBookingSpeedContext(client, "h1", "2026-09-16", 10, new Set(), "2026-09-20")).toBeNull();
    }
  });

  it("keeps the context when the only rows are past the horizon, as the unbounded read did", async () => {
    const rows = [{ id: "a", hotel_id: "h1", stay_date: "2027-06-01", booking_date: "2026-09-01", booking_window_days: 273, room_type_id: null }];
    for (const opts of [{ rpc: scaleRpc }, { rpc: () => new FakeRpcError(missingFunction("booking_speed_history_summary")) }]) {
      const { client } = fakeSupabase({ reservations: rows }, opts);
      expect(await loadBookingSpeedContext(client, "h1", "2026-09-16", 10, new Set(), "2026-09-20")).not.toBeNull();
    }
    // An excluded type past the horizon does not count as history.
    const court = [{ ...rows[0], room_type_id: "court" }];
    const { client } = fakeSupabase({ reservations: court }, { rpc: () => new FakeRpcError(missingFunction("x")) });
    expect(await loadBookingSpeedContext(client, "h1", "2026-09-16", 10, new Set(["court"]), "2026-09-20")).toBeNull();
  });

  it("refuses to observe a stay date outside the loaded horizon", async () => {
    const fx = makeFixture(11, 10);
    const { client } = fakeSupabase({ reservations: fx.reservations }, { rpc: scaleRpc });
    const ctx = await loadBookingSpeedContext(client, "h1", fx.localDate, 10, new Set(), addDays(fx.localDate, 4));
    expect(() => observeForStayDate(ctx!, addDays(fx.localDate, 5), 7)).toThrow(/not loaded/);
  });

  it("reads a history past the old 100,000-row ceiling without holding the rows", async () => {
    // 140 rooms, fully booked, 3 years plus the horizon: ~160k room-nights,
    // well past the MAX_PAGES * 1,000 = 100,000 rows the old read threw at.
    const localDate = "2026-09-16";
    const reservations: FakeRow[] = [];
    let id = 0;
    for (let off = -(3 * 366); off < 60; off++) {
      const stay = addDays(localDate, off);
      for (let k = 0; k < 140; k++) {
        reservations.push({
          id: `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
          hotel_id: "h1",
          stay_date: stay,
          booking_date: addDays(stay, -((k * 7) % 120)) > localDate ? localDate : addDays(stay, -((k * 7) % 120)),
          booking_window_days: null,
          room_type_id: k % 10 === 0 ? null : "rt-a",
        });
      }
    }
    expect(reservations.length).toBeGreaterThan(100_000);
    for (const opts of [
      { rpc: scaleRpc, maxRows: 1000 },
      { rpc: () => new FakeRpcError(missingFunction("booking_speed_history_summary")), maxRows: 1000 },
    ]) {
      const { client, calls } = fakeSupabase({ reservations }, opts);
      const ctx = await loadBookingSpeedContext(client, "h1", localDate, 140, new Set(), addDays(localDate, 44));
      expect(ctx).not.toBeNull();
      expect(ctx!.dailyDemand.length).toBe(3 * 366);
      expect(ctx!.dailyDemand.every((d) => d.value === 140)).toBe(true);
      const obs = observeForStayDate(ctx!, addDays(localDate, 10), 7);
      expect(obs.recentBookings).toBeGreaterThanOrEqual(0);
      if (opts.rpc === scaleRpc) {
        // The migrated path never reads reservations rows directly.
        expect(calls.some((c) => c.table === "reservations")).toBe(false);
      }
    }
  }, 60_000);

  it("reads a full 500-room history before the migration in bounded date ranges, with no row ceiling", async () => {
    // Two quiet years, then a 520-a-night property (rooms plus a few room-less
    // rows): 575k+ rows over history and horizon. The fixed 500,000-row budget
    // used to throw here; this serves the rows without holding them.
    const localDate = "2026-09-16";
    const denseFrom = addDays(localDate, -400);
    const perDay = (d: string) => (d < denseFrom ? 3 : 520);
    const { client } = fakeSupabase({}, { rpc: () => new FakeRpcError(missingFunction("booking_speed_history_summary")) });
    const realFrom = client.from.bind(client);
    const reads: { gte: string; lte: string; ordered: string[]; cursor: string | null; limit: number; ranged: boolean }[] = [];
    let served = 0;
    (client as unknown as { from: unknown }).from = (table: string) => {
      if (table !== "reservations") return realFrom(table);
      const q = { gte: "", lte: "", ordered: [] as string[], or: null as string | null, ranged: false };
      const serve = (limit: number) => {
        if (q.gte === "") return Promise.resolve({ data: [], error: null }); // hasKeptRowAfter
        reads.push({ gte: q.gte, lte: q.lte, ordered: q.ordered, cursor: q.or, limit, ranged: q.ranged });
        // The only cursor shape the reader writes: stay_date.gt.D,and(stay_date.eq.D,id.gt.I)
        const m = q.or ? /^stay_date\.gt\.([^,]+),and\(stay_date\.eq\.([^,]+),id\.gt\.(.+)\)$/.exec(q.or) : null;
        if (q.or && !m) throw new Error(`unexpected cursor ${q.or}`);
        const data: FakeRow[] = [];
        const start = m && m[1] > q.gte ? m[1] : q.gte;
        for (let d = start; d <= q.lte && data.length < limit; d = addDays(d, 1)) {
          for (let k = 0; k < perDay(d) && data.length < limit; k++) {
            const id = `${d}-${String(k).padStart(4, "0")}`;
            if (m && (d < m[1] || (d === m[2] && id <= m[3]))) continue;
            data.push({
              id,
              stay_date: d,
              booking_date: addDays(d, -(k % 90)),
              booking_window_days: null,
              room_type_id: k % 13 === 0 ? null : "rt-a",
            });
          }
        }
        served += data.length;
        return Promise.resolve({ data, error: null });
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {};
      b.select = () => b;
      b.eq = () => b;
      b.gte = (_c: string, v: string) => ((q.gte = v), b);
      b.lte = (_c: string, v: string) => ((q.lte = v), b);
      b.gt = () => b;
      b.or = (expr: string) => ((q.or = expr), b);
      b.order = (c: string) => (q.ordered.push(c), b);
      b.limit = (n: number) => serve(n);
      b.range = (from: number, to: number) => ((q.ranged = true), serve(to - from + 1));
      return b;
    };
    const horizonEnd = addDays(localDate, 44);
    const ctx = await loadBookingSpeedContext(client, "h1", localDate, 500, new Set(), horizonEnd);
    expect(ctx).not.toBeNull();
    expect(served).toBeGreaterThan(200_000);
    expect(ctx!.dailyDemand.find((d) => d.stay_date === addDays(localDate, -1))?.value).toBe(520);
    expect(ctx!.dailyDemand.find((d) => d.stay_date === addDays(localDate, -900))?.value).toBe(3);
    for (const [i, r] of reads.entries()) {
      expect(r.gte).not.toBe("");
      expect(r.lte).not.toBe("");
      expect(r.ordered).toEqual(["stay_date", "id"]);
      // Keyset pages, never an offset, and the cursor resets with each slice.
      expect(r.ranged).toBe(false);
      expect(r.limit).toBe(1000);
      if (i === 0 || reads[i - 1].gte !== r.gte) expect(r.cursor).toBeNull();
    }
    // Slices really are cut: dense years never read in one go.
    expect(new Set(reads.map((r) => r.gte)).size).toBeGreaterThan(50);
    // About one call per 1,000 rows plus one per slice, not one per date.
    expect(reads.length).toBeLessThan(served / 1000 + 250);
  }, 60_000);

  it("counts every row once when a row lands between pages before the migration", async () => {
    // One dense night past the page size, so the slice needs a second page.
    const localDate = "2026-09-16";
    const stay = addDays(localDate, -30);
    const reservations: FakeRow[] = [];
    for (let k = 1; k <= 1500; k++) {
      reservations.push({
        id: `00000000-0000-4000-8000-${String(k * 2).padStart(12, "0")}`,
        hotel_id: "h1",
        stay_date: stay,
        booking_date: addDays(stay, -7),
        booking_window_days: 7,
        room_type_id: null,
      });
    }
    let pages = 0;
    const { client, tables } = fakeSupabase(
      { reservations },
      {
        rpc: () => new FakeRpcError(missingFunction("booking_speed_history_summary")),
        fault: (call) => {
          if (call.table !== "reservations" || !call.filters.some((f) => f.kind === "gte")) return null;
          if (call.filters.some((f) => f.col === "stay_date" && f.kind === "lte" && String(f.value) >= stay) && ++pages === 2) {
            // A new booking sorts ahead of everything already read: under
            // offset paging it shifts the next page back by one row.
            tables.reservations.push({
              id: "00000000-0000-4000-8000-000000000001",
              hotel_id: "h1",
              stay_date: stay,
              booking_date: addDays(stay, -7),
              booking_window_days: 7,
              room_type_id: null,
            });
          }
          return null;
        },
      },
    );
    const ctx = await loadBookingSpeedContext(client, "h1", localDate, 2000, new Set(), addDays(localDate, 3));
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(tables.reservations).toHaveLength(1501);
    // The late row sorts before the cursor, so this read misses it and the next run counts it; nothing twice.
    expect(ctx!.dailyDemand.find((d) => d.stay_date === stay)?.value).toBe(1500);
  });

  it("logs the pre-migration fallback once", async () => {
    const spy = console.error as unknown as ReturnType<typeof vi.fn>;
    const fx = makeFixture(12, 5, { thin: true });
    for (let i = 0; i < 3; i++) {
      const { client } = fakeSupabase({ reservations: fx.reservations }, { rpc: () => new FakeRpcError(missingFunction("booking_speed_history_summary")) });
      await loadBookingSpeedContext(client, "h1", fx.localDate, 5, new Set(), addDays(fx.localDate, 3));
    }
    const lines = spy.mock.calls.filter((c) => String(c[0]).includes("large_property_scale"));
    expect(lines).toHaveLength(1);
  });

  it("throws on a real rpc failure instead of reading it as no history", async () => {
    const { client } = fakeSupabase({}, { rpc: () => new FakeRpcError({ code: "57014", message: "canceling statement due to statement timeout" }) });
    await expect(loadBookingSpeedContext(client, "h1", "2026-09-16", 10, new Set(), "2026-09-20")).rejects.toThrow(/Failed to load booking history/);
  });
});

describe("Booking Speed measured sets, whatever the horizon", () => {
  /**
   * rt-b sold once on a date only a long run consults, then nothing on the
   * next 20 dates a short run consults, then steadily. Where the set's
   * history starts must not depend on which run is asking.
   */
  async function probeFixture(): Promise<Fixture> {
    const base = makeFixture(9, 30);
    const noB = base.reservations.filter((r) => r.room_type_id !== "rt-b");
    const consultedBy = async (days: number) => {
      const { client } = fakeSupabase(
        { reservations: noB, hotel_closed_periods: base.closed, assumption_challenges: base.challenges },
        { rpc: scaleRpc },
      );
      const ctx = (await loadBookingSpeedContext(client, "h1", base.localDate, base.capacity, base.exclude, addDays(base.localDate, days - 1), COUNTING, [["rt-b"]]))!;
      const out = new Set<string>();
      for (let i = 0; i < days; i++) {
        const t = addDays(base.localDate, i);
        observeForStayDate(ctx, t, 7);
        for (const d of relevantDates(t, ctx.selectionCache.get(t)!)) if (d >= ctx.historyStart) out.add(d);
      }
      return out;
    };
    const short = await consultedBy(45);
    const long = await consultedBy(365);
    const longOnly = [...long].filter((d) => !short.has(d) && d > "2024-06-01").sort();
    expect(longOnly.length).toBeGreaterThan(0);
    const firstSale = longOnly[0];
    const later = [...short].filter((d) => d > firstSale).sort();
    const saleDates = new Set([firstSale, ...later.slice(20)]);
    for (let i = 0; i < 45; i++) saleDates.add(addDays(base.localDate, i));
    const extra: FakeRow[] = [];
    let id = 0;
    const row = (stay: string, bw: number): FakeRow => ({
      id: `bbbbbbbb-0000-4000-8000-${String(++id).padStart(12, "0")}`,
      hotel_id: "h1",
      stay_date: stay,
      booking_date: addDays(stay, -bw),
      booking_window_days: bw,
      room_type_id: "rt-b",
    });
    for (const d of [...saleDates].sort()) {
      if (d >= base.localDate) {
        const bw = daysBetween(base.localDate, d) + 1;
        for (let j = 0; j < 3; j++) extra.push(row(d, bw));
      } else {
        for (let bw = 0; bw < 60; bw++) extra.push(row(d, bw));
      }
    }
    return { ...base, name: `${base.name}, rt-b first sold on a long-run date`, reservations: [...noB, ...extra] };
  }

  it.each(PATHS)("%s path: a 45-day run and a 365-day run read every shared stay date the same", async (_label, opts) => {
    const fx = await probeFixture();
    const load = async (days: number) => {
      const { client } = fakeSupabase(
        { reservations: fx.reservations, hotel_closed_periods: fx.closed, assumption_challenges: fx.challenges },
        opts,
      );
      return (await loadBookingSpeedContext(client, "h1", fx.localDate, fx.capacity, fx.exclude, addDays(fx.localDate, days - 1), COUNTING, [
        ["rt-b"],
        ["rt-a", "rt-court"],
      ]))!;
    };
    const short = await load(45);
    const long = await load(365);
    const targets = Array.from({ length: 45 }, (_, i) => addDays(fx.localDate, i));
    const expected = legacySetObservations(fx, ["rt-b"], targets, WINDOWS)!;
    let fired = 0;
    for (const t of targets) {
      for (const w of WINDOWS) {
        for (const set of [["rt-b"], ["rt-court", "rt-a"]]) {
          const a = observeForStayDate(short, t, w, set);
          expect(observeForStayDate(long, t, w, set)).toEqual(a);
        }
        const got = observeForStayDate(short, t, w, ["rt-b"]);
        expect(got).toEqual(expected.get(`${t}|${w}`));
        if (got.method === "comparable") fired++;
      }
    }
    // The probe has to reach real comparisons, or equality proves little.
    expect(fired).toBeGreaterThan(0);
  }, 60_000);

  it.each(PATHS)("%s path: a non-room type in a set is dropped, the same as the row model", async (_label, opts) => {
    const fx = makeFixture(31, 40);
    const targets = Array.from({ length: 21 }, (_, i) => addDays(fx.localDate, i));
    const { client } = fakeSupabase(
      { reservations: fx.reservations, hotel_closed_periods: fx.closed, assumption_challenges: fx.challenges },
      opts,
    );
    const ctx = (await loadBookingSpeedContext(client, "h1", fx.localDate, fx.capacity, fx.exclude, targets[targets.length - 1], COUNTING, [
      ["rt-a", "rt-court"],
    ]))!;
    const expected = legacySetObservations(fx, ["rt-a", "rt-court"], targets, WINDOWS)!;
    for (const t of targets) {
      for (const w of WINDOWS) {
        expect(observeForStayDate(ctx, t, w, ["rt-a", "rt-court"])).toEqual(expected.get(`${t}|${w}`));
      }
    }
  });
});
