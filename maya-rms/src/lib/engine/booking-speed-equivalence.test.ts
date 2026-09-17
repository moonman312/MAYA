/**
 * The grouped Booking Speed path has to give exactly what the old
 * row-by-row path gave. `legacy` (booking-speed-legacy.test.ts) is the
 * pre-change implementation, so every assertion here is old code against
 * new code on the same seeded data, for both the migrated (rpc) and
 * pre-migration (keyset) paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import {
  dailyPaceSeriesFromIndex,
  milestoneRanks,
  paceScoreFromRankWindows,
} from "@/lib/observations/booking-pace";
import { indexBookingRows } from "@/lib/observations/booking-rows";
import {
  HISTORY_YEARS_BACK,
  loadBookingSpeedContext,
  observeForStayDate,
  resetBookingSpeedLogOnce,
} from "./booking-speed-provider";
import { legacy, makeFixture, type Fixture } from "./booking-speed-legacy.test";
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
