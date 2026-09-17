/**
 * The calendar is the hotel's own rate. The rule that keeps it that way is
 * that a cell MAYA has already pushed to is never re-captured — after we push,
 * the PMS is quoting our own adjustment back at us. Every other cell is
 * re-read on a throttle, so a rate the hotel changes in its PMS is what MAYA
 * prices on, and an unchanged calendar costs no writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBaseRateCalendar, seedBaseRateCalendar } from "./base-rate-calendar";
import type { PmsRatePushAdapter, RateCalendarEntry } from "../../../supabase/functions/_shared/pms/rate-push";
import type { HotelClock } from "../../../supabase/functions/_shared/pms/pricing-window";
import { fakeSupabase, missingColumn, type FakeRow } from "../engine/fake-supabase.test";

const HOTEL = "h1";

const ROOM_TYPES: FakeRow[] = [
  { id: "local-1", hotel_id: HOTEL, external_room_type_id: "EXT-1", is_active: true },
  { id: "local-2", hotel_id: HOTEL, external_room_type_id: "EXT-2", is_active: true },
];

function db(seed: Record<string, FakeRow[]> = {}, opts: Parameters<typeof fakeSupabase>[1] = {}) {
  return fakeSupabase(
    {
      hotels: [{ id: HOTEL, timezone: "UTC" }],
      room_types: ROOM_TYPES,
      pms_connections: [{ id: "conn-1", hotel_id: HOTEL, pms_type: "think", base_rates_refreshed_at: null }],
      base_rate_calendar: [],
      rate_updates: [],
      ...seed,
    },
    // PostgREST's row cap, so an unpaged read would show.
    { maxRows: 1000, ...opts },
  );
}

type Entry = RateCalendarEntry;

function makeAdapter(entries: Entry[] | (() => Entry[])) {
  const calls: { resolve: unknown[]; fetch: unknown[][] } = { resolve: [], fetch: [] };
  const adapter = {
    pmsType: "think",
    resolveRateTargets: async (opts?: unknown) => (calls.resolve.push(opts), { "EXT-1": "rate-a", "EXT-2": "rate-a" }),
    pushCells: async () => [],
    fetchRateCalendar: async (...args: unknown[]) => {
      calls.fetch.push(args);
      return typeof entries === "function" ? entries() : entries;
    },
  } as unknown as PmsRatePushAdapter;
  return { adapter, calls };
}

const calendar = (d: ReturnType<typeof db>) =>
  (d.tables.base_rate_calendar ?? [])
    .map((r) => `${r.stay_date}|${r.room_type_id}|${r.price}`)
    .sort();

const upserts = (d: ReturnType<typeof db>) => d.calls.filter((c) => c.table === "base_rate_calendar" && c.op === "upsert");

function clock(at: string, timeZone = "UTC", today = at.slice(0, 10)): HotelClock {
  return { at, today, timeZone };
}

beforeEach(() => {
  vi.stubEnv("MAYA_EVAL_HORIZON_DAYS", "");
  vi.stubEnv("MAYA_BASE_RATE_REFRESH_MINUTES", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("seedBaseRateCalendar", () => {
  it("captures the PMS rate for each cell, mapped to local room type ids", async () => {
    const d = db();
    const { adapter } = makeAdapter([
      { stayDate: "2026-10-01", externalRoomTypeId: "EXT-1", price: 200 },
      { stayDate: "2026-10-01", externalRoomTypeId: "EXT-2", price: 240 },
    ]);

    const res = await seedBaseRateCalendar(d.client, HOTEL, adapter, { horizonDays: 3, today: "2026-10-01" });

    expect(res).toMatchObject({ ok: true, captured: 2, unchanged: 0, skippedAlreadyPushed: 0, pmsEditedPushedNights: 0 });
    expect(d.tables.base_rate_calendar).toEqual([
      expect.objectContaining({ hotel_id: HOTEL, stay_date: "2026-10-01", room_type_id: "local-1", price: 200, source: "pms" }),
      expect.objectContaining({ room_type_id: "local-2", price: 240 }),
    ]);
  });

  it("never re-captures a cell MAYA has already pushed to, whatever the ledger row says", async () => {
    // The whole safety property: that PMS number is our own adjustment. A
    // failed or skipped row may have overwritten the row of an earlier send.
    const d = db({
      rate_updates: [
        { hotel_id: HOTEL, stay_date: "2026-10-01", room_type_id: "local-1", price: 230, status: "sent" },
        { hotel_id: HOTEL, stay_date: "2026-10-02", room_type_id: "local-1", price: 250, status: "failed" },
      ],
    });
    const { adapter } = makeAdapter([
      { stayDate: "2026-10-01", externalRoomTypeId: "EXT-1", price: 230 }, // ours, tainted
      { stayDate: "2026-10-02", externalRoomTypeId: "EXT-1", price: 230 }, // ours from before the failure
      { stayDate: "2026-10-01", externalRoomTypeId: "EXT-2", price: 240 }, // untouched
    ]);

    const res = await seedBaseRateCalendar(d.client, HOTEL, adapter, { horizonDays: 3, today: "2026-10-01" });

    expect(res).toMatchObject({ ok: true, captured: 1, skippedAlreadyPushed: 2 });
    expect(calendar(d)).toEqual(["2026-10-01|local-2|240"]);
  });

  it("ignores rates for room types this hotel does not track", async () => {
    const d = db();
    const { adapter } = makeAdapter([
      { stayDate: "2026-10-01", externalRoomTypeId: "EXT-UNKNOWN", price: 999 },
      { stayDate: "2026-10-01", externalRoomTypeId: "EXT-1", price: 200 },
    ]);

    const res = await seedBaseRateCalendar(d.client, HOTEL, adapter, { horizonDays: 1, today: "2026-10-01" });

    expect(res).toMatchObject({ captured: 1 });
    expect(calendar(d)).toEqual(["2026-10-01|local-1|200"]);
  });

  it("asks the PMS for exactly the 60-night window by default, on the hotel's date", async () => {
    const d = db();
    const { adapter, calls } = makeAdapter([]);
    await seedBaseRateCalendar(d.client, HOTEL, adapter, { today: "2026-10-01" });
    expect(calls.fetch[0].slice(0, 2)).toEqual(["2026-10-01", "2026-11-29"]); // 60 nights inclusive
    expect(calls.resolve).toEqual([{ today: "2026-10-01" }]);
  });

  it("makes one read when the adapter can return targets and rates together", async () => {
    const d = db();
    const read = vi.fn(async () => ({
      targets: { "EXT-1": "base-1" },
      entries: [{ stayDate: "2026-10-01", externalRoomTypeId: "EXT-1", price: 200 }],
    }));
    const { adapter, calls } = makeAdapter([]);
    adapter.readBaseRateCalendar = read;

    const res = await seedBaseRateCalendar(d.client, HOTEL, adapter, { horizonDays: 60, today: "2026-10-01" });

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("2026-10-01", "2026-11-29");
    expect(calls.resolve).toEqual([]);
    expect(calls.fetch).toEqual([]);
    expect(res).toMatchObject({ ok: true, captured: 1 });
  });

  it("reports unsupported rather than failing when an adapter has no rate read", async () => {
    const adapter = { pmsType: "mews", resolveRateTargets: async () => ({}), pushCells: async () => [] } as unknown as PmsRatePushAdapter;
    expect(await seedBaseRateCalendar(db().client, HOTEL, adapter)).toEqual({ ok: false, reason: "unsupported", captured: 0 });
  });

  it("writes one row per cell when the PMS repeats a night, so the upsert is not rejected", async () => {
    // Postgres refuses an upsert that touches one key twice ("ON CONFLICT DO
    // UPDATE command cannot affect row a second time"), and the whole chunk
    // was dropped.
    const d = db({}, {
      fault: (c) => {
        if (c.table !== "base_rate_calendar" || c.op !== "upsert") return null;
        const keys = (c.payload as FakeRow[]).map((r) => `${r.stay_date}|${r.room_type_id}`);
        return new Set(keys).size !== keys.length
          ? { code: "21000", message: "ON CONFLICT DO UPDATE command cannot affect row a second time" }
          : null;
      },
    });
    const { adapter } = makeAdapter([
      { stayDate: "2026-10-01", externalRoomTypeId: "EXT-1", price: 200 },
      { stayDate: "2026-10-01", externalRoomTypeId: "EXT-1", price: 260 },
      { stayDate: "2026-10-02", externalRoomTypeId: "EXT-1", price: 210 },
    ]);

    const res = await seedBaseRateCalendar(d.client, HOTEL, adapter, { horizonDays: 2, today: "2026-10-01" });

    expect(res).toMatchObject({ ok: true, captured: 2 });
    expect(calendar(d)).toEqual(["2026-10-01|local-1|200", "2026-10-02|local-1|210"]);
  });

  it("fails on a write error and writes nothing past the hole", async () => {
    // 2 room types x 300 nights = 600 rows: two chunks, nearest nights first.
    const entries: Entry[] = [];
    for (let i = 0; i < 300; i++) {
      const day = new Date(Date.UTC(2026, 9, 1) + i * 86_400_000).toISOString().slice(0, 10);
      entries.push({ stayDate: day, externalRoomTypeId: "EXT-2", price: 200 }, { stayDate: day, externalRoomTypeId: "EXT-1", price: 200 });
    }
    let writes = 0;
    const d = db({}, {
      fault: (c) => (c.table === "base_rate_calendar" && c.op === "upsert" && ++writes === 1 ? { message: "statement timeout" } : null),
    });
    const { adapter } = makeAdapter(entries);

    await expect(
      seedBaseRateCalendar(d.client, HOTEL, adapter, { horizonDays: 300, today: "2026-10-01" }),
    ).rejects.toThrow(/Failed to write base rates from 2026-10-01: statement timeout/);
    expect(writes).toBe(1);
    expect(d.tables.base_rate_calendar).toEqual([]);
  });

  it("never re-captures a pushed cell past the first 1,000 pushed rows", async () => {
    // A 365-night horizon over 4 room types is 1,460 pushed cells. An unpaged
    // read saw only the first 1,000 and re-captured our own rate for the rest.
    const types = Array.from({ length: 4 }, (_, i) => ({ id: `local-${i}`, hotel_id: HOTEL, external_room_type_id: `EXT-${i}`, is_active: true }));
    const pushed: FakeRow[] = [];
    const entries: Entry[] = [];
    for (let i = 0; i < 365; i++) {
      const day = new Date(Date.UTC(2026, 9, 1) + i * 86_400_000).toISOString().slice(0, 10);
      for (let t = 0; t < 4; t++) {
        pushed.push({ id: `${day}-${t}`, hotel_id: HOTEL, stay_date: day, room_type_id: `local-${t}`, price: 230, status: "sent" });
        entries.push({ stayDate: day, externalRoomTypeId: `EXT-${t}`, price: 230 });
      }
    }
    const d = db({ room_types: types, rate_updates: pushed });
    const { adapter } = makeAdapter(entries);
    const res = await seedBaseRateCalendar(d.client, HOTEL, adapter, { horizonDays: 365, today: "2026-10-01" });
    expect(res).toMatchObject({ ok: true, captured: 0, skippedAlreadyPushed: 1460, pmsEditedPushedNights: 0 });
    expect(upserts(d)).toHaveLength(0);
  });

  it("leaves a stored base alone when the PMS has no rate for the night, and keeps an explicit zero", async () => {
    const d = db({
      base_rate_calendar: [
        { hotel_id: HOTEL, stay_date: "2026-10-01", room_type_id: "local-1", price: 200, source: "pms" },
        { hotel_id: HOTEL, stay_date: "2026-10-02", room_type_id: "local-1", price: 200, source: "pms" },
      ],
    });
    // The adapters drop a null rate, so a missing night simply has no entry.
    const { adapter } = makeAdapter([{ stayDate: "2026-10-02", externalRoomTypeId: "EXT-1", price: 0 }]);

    await seedBaseRateCalendar(d.client, HOTEL, adapter, { horizonDays: 2, today: "2026-10-01" });

    expect(calendar(d)).toEqual(["2026-10-01|local-1|200", "2026-10-02|local-1|0"]);
  });
});

describe("ensureBaseRateCalendar refresh", () => {
  const STORED: FakeRow[] = [
    { hotel_id: HOTEL, stay_date: "2026-10-01", room_type_id: "local-1", price: 200, source: "pms", captured_at: "2026-09-01T00:00:00Z" },
    { hotel_id: HOTEL, stay_date: "2026-10-02", room_type_id: "local-1", price: 200, source: "pms", captured_at: "2026-09-01T00:00:00Z" },
  ];

  it("picks up a rate the hotel changed in the PMS on a night MAYA hasn't pushed", async () => {
    const d = db({ base_rate_calendar: STORED.map((r) => ({ ...r })) });
    const { adapter } = makeAdapter([
      { stayDate: "2026-10-01", externalRoomTypeId: "EXT-1", price: 200 },
      { stayDate: "2026-10-02", externalRoomTypeId: "EXT-1", price: 215 },
    ]);

    const res = await ensureBaseRateCalendar(d.client, HOTEL, adapter, { horizonDays: 2, clock: clock("2026-10-01T12:00:00.000Z") });

    expect(res).toMatchObject({ ok: true, captured: 1, unchanged: 1 });
    expect(calendar(d)).toEqual(["2026-10-01|local-1|200", "2026-10-02|local-1|215"]);
    // Only the changed cell was written.
    expect(upserts(d).map((c) => (c.payload as FakeRow[]).length)).toEqual([1]);
  });

  it("leaves a pushed night alone and counts it when the PMS rate no longer matches what MAYA sent", async () => {
    const d = db({
      base_rate_calendar: STORED.map((r) => ({ ...r })),
      rate_updates: [
        // Sent at 230; someone has since typed 250 into the PMS.
        { id: "1", hotel_id: HOTEL, stay_date: "2026-10-01", room_type_id: "local-1", price: 230, status: "sent" },
        // Sent at 240 and the PMS still says 240 (within half a cent).
        { id: "2", hotel_id: HOTEL, stay_date: "2026-10-02", room_type_id: "local-1", price: 240, status: "sent" },
        // Failed attempt: no known sent price to compare, still off limits.
        { id: "3", hotel_id: HOTEL, stay_date: "2026-10-01", room_type_id: "local-2", price: 300, status: "failed" },
      ],
    });
    const { adapter } = makeAdapter([
      { stayDate: "2026-10-01", externalRoomTypeId: "EXT-1", price: 250 },
      { stayDate: "2026-10-02", externalRoomTypeId: "EXT-1", price: 240.004 },
      { stayDate: "2026-10-01", externalRoomTypeId: "EXT-2", price: 260 },
    ]);

    const res = await ensureBaseRateCalendar(d.client, HOTEL, adapter, { horizonDays: 2, clock: clock("2026-10-01T12:00:00.000Z") });

    expect(res).toMatchObject({ ok: true, captured: 0, skippedAlreadyPushed: 3, pmsEditedPushedNights: 1 });
    expect(calendar(d)).toEqual(["2026-10-01|local-1|200", "2026-10-02|local-1|200"]);
    expect(upserts(d)).toHaveLength(0);
  });

  it("writes nothing when nothing changed", async () => {
    const d = db({ base_rate_calendar: STORED.map((r) => ({ ...r })) });
    const { adapter } = makeAdapter([
      { stayDate: "2026-10-01", externalRoomTypeId: "EXT-1", price: 200 },
      // A third decimal is still the stored rate once numeric(10,2) rounds it.
      { stayDate: "2026-10-02", externalRoomTypeId: "EXT-1", price: 199.995 },
    ]);

    const res = await ensureBaseRateCalendar(d.client, HOTEL, adapter, { horizonDays: 2, clock: clock("2026-10-01T12:00:00.000Z") });

    expect(res).toMatchObject({ ok: true, captured: 0, unchanged: 2 });
    expect(upserts(d)).toHaveLength(0);
    // The only write is the refresh stamp.
    expect(d.calls.filter((c) => c.op !== "select").map((c) => c.table)).toEqual(["pms_connections"]);
  });

  it("stamps the refresh with the tick's instant, and not when the refresh fails", async () => {
    const ok = db();
    await ensureBaseRateCalendar(ok.client, HOTEL, makeAdapter([]).adapter, { horizonDays: 2, clock: clock("2026-10-01T12:00:00.000Z") });
    expect(ok.tables.pms_connections[0].base_rates_refreshed_at).toBe("2026-10-01T12:00:00.000Z");

    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = db({}, { fault: (c) => (c.table === "base_rate_calendar" && c.op === "upsert" ? { message: "timeout" } : null) });
    const res = await ensureBaseRateCalendar(
      broken.client,
      HOTEL,
      makeAdapter([{ stayDate: "2026-10-01", externalRoomTypeId: "EXT-1", price: 200 }]).adapter,
      { horizonDays: 2, clock: clock("2026-10-01T12:00:00.000Z") },
    );
    expect(res).toEqual({ ok: false, reason: "failed", captured: 0 });
    expect(broken.tables.pms_connections[0].base_rates_refreshed_at).toBeNull();
  });

  describe("throttle", () => {
    function stamped(at: string) {
      return db({ pms_connections: [{ id: "conn-1", hotel_id: HOTEL, pms_type: "think", base_rates_refreshed_at: at }] });
    }

    it("does not read the PMS again within the hour", async () => {
      const d = stamped("2026-10-01T11:30:00.000Z");
      const { adapter, calls } = makeAdapter([]);
      const res = await ensureBaseRateCalendar(d.client, HOTEL, adapter, { clock: clock("2026-10-01T12:00:00.000Z") });
      expect(res).toEqual({ ok: false, reason: "throttled", captured: 0 });
      expect(calls.fetch).toHaveLength(0);
      expect(calls.resolve).toHaveLength(0);
    });

    it("reads it again once the interval has passed, and the interval is configurable", async () => {
      const d = stamped("2026-10-01T10:59:00.000Z");
      const { adapter, calls } = makeAdapter([]);
      expect(await ensureBaseRateCalendar(d.client, HOTEL, adapter, { clock: clock("2026-10-01T12:00:00.000Z") })).toMatchObject({ ok: true });
      expect(calls.fetch).toHaveLength(1);

      vi.stubEnv("MAYA_BASE_RATE_REFRESH_MINUTES", "15");
      const e = stamped("2026-10-01T11:40:00.000Z");
      const second = makeAdapter([]);
      expect(await ensureBaseRateCalendar(e.client, HOTEL, second.adapter, { clock: clock("2026-10-01T12:00:00.000Z") })).toMatchObject({ ok: true });
      expect(second.calls.fetch).toHaveLength(1);
    });

    it("refreshes early when the hotel's date has moved since, so the new last night has a base", async () => {
      // 23:30 then 00:10 in Chicago: forty minutes apart, but a new night has
      // entered the window. Both instants fall on Oct 1 in UTC, so a UTC
      // check would have waited up to an hour.
      const d = stamped("2026-10-01T04:30:00.000Z");
      const { adapter, calls } = makeAdapter([]);
      const res = await ensureBaseRateCalendar(d.client, HOTEL, adapter, {
        clock: clock("2026-10-01T05:10:00.000Z", "America/Chicago", "2026-10-01"),
      });
      expect(res).toMatchObject({ ok: true });
      expect(calls.fetch[0].slice(0, 2)).toEqual(["2026-10-01", "2026-11-29"]);
    });

    it("fills gaps only, as before, while the stamp column has not been migrated", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const covered: FakeRow[] = [{ hotel_id: HOTEL, stay_date: "2026-11-29", room_type_id: "local-1", price: 200 }];
      const fault = (c: { table: string; columns: string }) =>
        c.table === "pms_connections" && c.columns.includes("base_rates_refreshed_at")
          ? missingColumn("pms_connections", "base_rates_refreshed_at")
          : null;

      const full = db({ base_rate_calendar: covered }, { fault });
      const a = makeAdapter([]);
      expect(await ensureBaseRateCalendar(full.client, HOTEL, a.adapter, { clock: clock("2026-10-01T12:00:00.000Z") })).toEqual({
        ok: false,
        reason: "covered",
        captured: 0,
      });
      expect(a.calls.fetch).toHaveLength(0);

      const short = db({ base_rate_calendar: [{ ...covered[0], stay_date: "2026-11-28" }] }, { fault });
      const b = makeAdapter([]);
      expect(await ensureBaseRateCalendar(short.client, HOTEL, b.adapter, { clock: clock("2026-10-01T12:00:00.000Z") })).toMatchObject({ ok: true });
      expect(b.calls.fetch).toHaveLength(1);
    });
  });

  describe("on the hotel's calendar", () => {
    it("starts the window on the hotel's date when it is a day behind UTC", async () => {
      const d = db({ hotels: [{ id: HOTEL, timezone: "America/Los_Angeles" }] });
      const { adapter, calls } = makeAdapter([]);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-02T05:00:00Z")); // 22:00 Oct 1 in Los Angeles
      try {
        await ensureBaseRateCalendar(d.client, HOTEL, adapter);
      } finally {
        vi.useRealTimers();
      }
      expect(calls.fetch[0].slice(0, 2)).toEqual(["2026-10-01", "2026-11-29"]);
    });

    it("starts the window on the hotel's date when it is a day ahead of UTC", async () => {
      const d = db({ hotels: [{ id: HOTEL, timezone: "Asia/Tokyo" }] });
      const { adapter, calls } = makeAdapter([]);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-01T20:00:00Z")); // 05:00 Oct 2 in Tokyo
      try {
        await ensureBaseRateCalendar(d.client, HOTEL, adapter);
      } finally {
        vi.useRealTimers();
      }
      expect(calls.fetch[0].slice(0, 2)).toEqual(["2026-10-02", "2026-11-30"]);
    });

    it("counts a refresh from yesterday on the hotel's calendar as due, though it is the same UTC day", async () => {
      // Tokyo: stamped 23:50 Oct 1 local (14:50Z), now 00:05 Oct 2 local (15:05Z).
      const d = db({
        hotels: [{ id: HOTEL, timezone: "Asia/Tokyo" }],
        pms_connections: [{ id: "conn-1", hotel_id: HOTEL, pms_type: "think", base_rates_refreshed_at: "2026-10-01T14:50:00.000Z" }],
      });
      const { adapter, calls } = makeAdapter([]);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-01T15:05:00Z"));
      try {
        expect(await ensureBaseRateCalendar(d.client, HOTEL, adapter)).toMatchObject({ ok: true });
      } finally {
        vi.useRealTimers();
      }
      expect(calls.fetch[0].slice(0, 2)).toEqual(["2026-10-02", "2026-11-30"]);
    });
  });

  it("skips this tick when the pushed-cell read fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = db({}, { fault: (c) => (c.table === "rate_updates" ? { message: "statement timeout" } : null) });
    const { adapter } = makeAdapter([{ stayDate: "2026-10-01", externalRoomTypeId: "EXT-1", price: 230 }]);
    const res = await ensureBaseRateCalendar(d.client, HOTEL, adapter, { horizonDays: 1, clock: clock("2026-10-01T12:00:00.000Z") });
    expect(res).toEqual({ ok: false, reason: "failed", captured: 0 });
    expect(upserts(d)).toHaveLength(0);
    expect(String(spy.mock.calls[0]?.[0])).toContain("Failed to read pushed cells");
  });
});
