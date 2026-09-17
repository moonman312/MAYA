/**
 * Snapshots write the SELLABLE count: physical rooms minus whatever the
 * owner has marked out of service for the night. These tests pin the
 * arithmetic and the degrade-to-physical path when the table is not there.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, missingRelation, missingRelationPg } from "./fake-supabase.test";
import { fetchAllRows, purgeOldSnapshots, sellableUnitsFor, snapshotCurrentState, type OutOfServiceRow } from "./snapshots";
import type { RoomTypeRow } from "./types";

const rt = (id: string, total_rooms: number): RoomTypeRow => ({
  id,
  hotel_id: "h1",
  name: id,
  is_active: true,
  total_rooms,
  floor_price: 50,
  ceiling_price: 500,
});

const oos = (room_type_id: string, start_date: string, end_date: string, units: number): OutOfServiceRow => ({
  room_type_id,
  start_date,
  end_date,
  units,
});

describe("sellableUnitsFor", () => {
  it("subtracts units out of service on that night", () => {
    expect(sellableUnitsFor(20, [oos("rt1", "2026-10-01", "2026-10-05", 4)], "2026-10-03", "rt1")).toBe(16);
  });

  it("sums overlapping rows", () => {
    const rows = [oos("rt1", "2026-10-01", "2026-10-05", 4), oos("rt1", "2026-10-03", "2026-10-03", 2)];
    expect(sellableUnitsFor(20, rows, "2026-10-03", "rt1")).toBe(14);
    expect(sellableUnitsFor(20, rows, "2026-10-04", "rt1")).toBe(16);
  });

  it("leaves nights outside the range and other room types alone", () => {
    const rows = [oos("rt1", "2026-10-01", "2026-10-05", 4)];
    expect(sellableUnitsFor(20, rows, "2026-10-06", "rt1")).toBe(20);
    expect(sellableUnitsFor(20, rows, "2026-09-30", "rt1")).toBe(20);
    expect(sellableUnitsFor(20, rows, "2026-10-03", "rt2")).toBe(20);
  });

  it("never goes below zero", () => {
    expect(sellableUnitsFor(3, [oos("rt1", "2026-10-01", "2026-10-05", 10)], "2026-10-03", "rt1")).toBe(0);
  });
});

describe("snapshotCurrentState with out-of-service rows", () => {
  const dates = ["2026-10-01", "2026-10-02", "2026-10-03"];
  const TS = "2026-09-16T12:00:00Z";

  afterEach(() => vi.restoreAllMocks());

  it("writes the sellable count and ignores cleared rows", async () => {
    const { client, tables } = fakeSupabase({
      room_type_out_of_service: [
        { id: "o1", hotel_id: "h1", room_type_id: "rt1", start_date: "2026-10-02", end_date: "2026-10-02", units: 4, cleared_at: null },
        { id: "o2", hotel_id: "h1", room_type_id: "rt1", start_date: "2026-10-02", end_date: "2026-10-03", units: 1, cleared_at: null },
        { id: "o3", hotel_id: "h1", room_type_id: "rt1", start_date: "2026-10-01", end_date: "2026-10-03", units: 9, cleared_at: "2026-09-10T00:00:00Z" },
        { id: "o4", hotel_id: "other", room_type_id: "rt1", start_date: "2026-10-01", end_date: "2026-10-03", units: 9, cleared_at: null },
      ],
      reservations: [
        { id: "b1", hotel_id: "h1", stay_date: "2026-10-02", room_type_id: "rt1", current_rate: 120 },
      ],
    });
    await snapshotCurrentState(client, "h1", TS, dates, [rt("rt1", 20), rt("rt2", 5)]);

    const by = (sd: string, r: string) =>
      tables.stay_date_snapshot.find((s) => s.stay_date === sd && s.room_type_id === r)!;
    expect(by("2026-10-01", "rt1").sellable_units).toBe(20);
    expect(by("2026-10-02", "rt1").sellable_units).toBe(15);
    expect(by("2026-10-02", "rt1").booked_units).toBe(1);
    expect(by("2026-10-03", "rt1").sellable_units).toBe(19);
    expect(by("2026-10-02", "rt2").sellable_units).toBe(5);
    expect(tables.stay_date_snapshot).toHaveLength(6);
  });

  // Both shapes the server can send: PostgREST's schema-cache PGRST205 (what
  // the client actually sees on the linked project) and Postgres's 42P01.
  it.each([
    ["PGRST205", missingRelation("room_type_out_of_service")],
    ["42P01", missingRelationPg("room_type_out_of_service")],
  ])("falls back to the physical count and names the migration when the table is missing (%s)", async (_label, fault) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, tables } = fakeSupabase(
      {},
      { fault: (c) => (c.table === "room_type_out_of_service" ? fault : null) },
    );
    await snapshotCurrentState(client, "h1", TS, dates, [rt("rt1", 20)]);
    expect(tables.stay_date_snapshot.every((s) => s.sellable_units === 20)).toBe(true);
    expect(err).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(err.mock.calls[0][0]));
    expect(line.schema).toBe("pre-migration");
    expect(line.migration).toBe("99_supabase_migration_room_type_out_of_service_v1.sql");
  });

  it("any other failure reading the blocks fails the run rather than pricing on the physical count", async () => {
    // 3 of 12 Kings under renovation and the read times out: snapshotting 12
    // would read 9/12 as 75%, drop an "above 90%" increase, and push the lower
    // price as a successful run. Loud, not empty — same stance as ladder effects.
    const { client, tables } = fakeSupabase(
      {},
      {
        fault: (c) =>
          c.table === "room_type_out_of_service"
            ? { code: "57014", message: "canceling statement due to statement timeout" }
            : null,
      },
    );
    await expect(snapshotCurrentState(client, "h1", TS, dates, [rt("rt1", 12)])).rejects.toThrow(
      /Failed to load rooms out of service/,
    );
    expect(tables.stay_date_snapshot).toEqual([]);
  });
});

describe("fetchAllRows", () => {
  it("throws instead of returning a silently truncated set past its page guard", async () => {
    // Every page comes back full, so there is always "more".
    const makeQuery = () => ({
      range: (from: number, to: number) =>
        Promise.resolve({ data: Array.from({ length: to - from + 1 }, (_, i) => ({ i: from + i })), error: null }),
    });
    await expect(fetchAllRows(makeQuery, 10)).rejects.toThrow(/there are more/);
  });

  it("reads every page past PostgREST's 1,000-row cap", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ id: `r${String(i).padStart(5, "0")}`, hotel_id: "h1" }));
    const { client } = fakeSupabase({ t: rows }, { maxRows: 1000 });
    const got = await fetchAllRows(() => client.from("t").select("id").eq("hotel_id", "h1").order("id"));
    expect(got.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });
});

describe("purgeOldSnapshots", () => {
  const NOW = Date.parse("2026-09-16T12:00:00Z");
  const snapshotsEvery = (hours: number, count: number, startMs: number) =>
    Array.from({ length: count }, (_, i) => new Date(startMs + i * hours * 3_600_000).toISOString()).flatMap((ts) =>
      ["2026-09-20", "2026-09-21"].map((d) => ({
        hotel_id: "h1", snapshot_ts: ts, stay_date: d, room_type_id: "rt1", sellable_units: 5, booked_units: 1, booked_revenue: 10,
      })),
    );

  afterEach(() => vi.useRealTimers());

  it("works through a backlog a slice at a time and ends where one big delete would", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    // 20 days of snapshots every 20 minutes, plus another hotel's rows.
    const rows = [
      ...snapshotsEvery(1 / 3, 20 * 72, NOW - 20 * 86_400_000),
      ...snapshotsEvery(24, 30, NOW - 30 * 86_400_000).map((r) => ({ ...r, hotel_id: "h2" })),
    ];
    const cutoff = new Date(NOW - 14 * 86_400_000).toISOString();
    const expected = rows.filter((r) => !(r.hotel_id === "h1" && r.snapshot_ts < cutoff));

    const { client, tables, calls } = fakeSupabase({ stay_date_snapshot: rows });
    let ticks = 0;
    let done = false;
    while (!done && ticks < 100) {
      done = await purgeOldSnapshots(client, "h1", 14, { maxSlices: 24 });
      ticks++;
      // Every delete is bounded to one slice past the oldest row it found.
      const deletes = calls.filter((c) => c.op === "delete");
      expect(deletes.every((c) => c.filters.some((f) => f.kind === "lt"))).toBe(true);
    }
    expect(done).toBe(true);
    expect(ticks).toBeGreaterThan(1);
    const key = (r: Record<string, unknown>) => `${r.hotel_id}|${r.snapshot_ts}|${r.stay_date}`;
    expect(tables.stay_date_snapshot.map(key).sort()).toEqual(expected.map(key).sort());
  });

  it("does nothing when there is nothing to purge", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { client, calls } = fakeSupabase({ stay_date_snapshot: snapshotsEvery(1, 5, NOW - 3_600_000 * 5) });
    expect(await purgeOldSnapshots(client, "h1", 14)).toBe(true);
    expect(calls.filter((c) => c.op === "delete")).toHaveLength(0);
  });
});
