/**
 * 99_supabase_migration_booking_speed_counts_bookings_v1.sql run for real in
 * PGlite: booking_key() against bookingKeyOf, and the booking-counting
 * booking_speed_windows against the TypeScript that counts the same rows
 * (the rpc model, indexBookingRows, and the engine's own row fallback).
 *
 * Only runs with MAYA_PGLITE_DIR set (see large-property-sql.test.ts).
 *
 *   MAYA_PGLITE_DIR=/path/to/dir npx vitest run src/lib/engine/booking-speed-counts-bookings-sql.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import { bookingKeyOf, indexBookingRows, type SlimReservationRow } from "@/lib/observations/booking-rows";
import { makeFixture, rng, type Fixture } from "./booking-speed-legacy.test";
import { loadBookingSpeedContext, observeForStayDate, resetBookingSpeedLogOnce } from "./booking-speed-provider";
import { FakeRpcError, fakeSupabase, missingFunction, type FakeRow } from "./fake-supabase.test";
import {
  COUNTS_BOOKINGS_MIGRATION,
  insertReservations,
  openPglite,
  pgliteRpc,
  uuidFor,
  type Db,
} from "./large-property-sql.test";
import { bookingSpeedHistorySummary, bookingSpeedWindows } from "./scale-rpc-model.test";
import { loadReservationCells } from "./snapshots";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const LARGE_PROPERTY = resolve(__dirname, "../../../../99_supabase_migration_large_property_scale_v1.sql");
const H1 = uuidFor("h1");
const MEWS_GUID = "0d3a8c2e-1f4b-4c5d-9e6f-7a8b9c0d1e2f";

/**
 * The seeded fixture with PMS-shaped ids: on each stay date the rows are
 * dealt into reservations of one to four rooms, keyed the Cloudbeds way
 * (`<n>-<k>`), the Think way (`<n>:<k>`), or left bare, so the same booking
 * has rooms with different booking dates and sometimes none.
 */
function withBookingIds(fx: Fixture, seed: number): Fixture {
  const r = rng(seed);
  const byDate = new Map<string, FakeRow[]>();
  for (const row of fx.reservations) {
    const list = byDate.get(String(row.stay_date)) ?? [];
    list.push(row);
    byDate.set(String(row.stay_date), list);
  }
  let booking = 1000;
  const out: FakeRow[] = [];
  for (const rows of byDate.values()) {
    let i = 0;
    while (i < rows.length) {
      const size = Math.min(rows.length - i, 1 + Math.floor(r() * 4));
      const shape = r();
      const id = String(++booking);
      for (let k = 1; k <= size; k++) {
        const ext = shape < 0.5 ? `${id}-${k}` : shape < 0.8 ? `${id}:${k}` : size === 1 ? id : `${id}-${k}`;
        out.push({ ...rows[i], external_reservation_id: ext });
        i++;
      }
    }
  }
  return {
    ...fx,
    exclude: new Set([...fx.exclude].map(uuidFor)),
    reservations: out.map((x) => ({
      ...x,
      id: uuidFor(String(x.id)),
      hotel_id: uuidFor(String(x.hotel_id)),
      room_type_id: x.room_type_id == null ? null : uuidFor(String(x.room_type_id)),
    })),
    closed: fx.closed.map((c) => ({ ...c, hotel_id: uuidFor(String(c.hotel_id)) })),
    challenges: fx.challenges.map((c) => ({ ...c, hotel_id: uuidFor(String(c.hotel_id)) })),
  };
}

/** The SQL's rows for `dates`, from indexBookingRows over the same slim rows. */
function windowsFromIndex(rows: FakeRow[], dates: string[], keep: (r: FakeRow) => boolean): FakeRow[] {
  const slim: SlimReservationRow[] = rows
    .filter((x) => x.hotel_id === H1 && keep(x))
    .map((x) => ({
      stay_date: String(x.stay_date),
      booking_date: x.booking_date != null ? String(x.booking_date) : null,
      booking_window_days: x.booking_window_days != null ? Number(x.booking_window_days) : null,
      external_reservation_id: x.external_reservation_id != null ? String(x.external_reservation_id) : null,
    }));
  const index = indexBookingRows(slim);
  const out: FakeRow[] = [];
  for (const d of [...new Set(dates)].sort()) {
    const entry = index.get(d);
    if (!entry) continue;
    const sorted = [...entry.windows].sort((a, b) => (a.bw === null ? 1 : b.bw === null ? -1 : a.bw - b.bw));
    out.push({ stay_date: d, n: entry.n, bws: sorted.map((w) => w.bw), counts: sorted.map((w) => w.n) });
  }
  return out;
}

describe.skipIf(!PGLITE_DIR)("booking speed counts bookings, in PGlite", () => {
  let db: Db;

  beforeAll(async () => {
    db = await openPglite();
  }, 120_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(() => {
    resetBookingSpeedLogOnce();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("booking_key says what bookingKeyOf says, over every shape the parsers write and a few they never will", async () => {
    const ids = [
      "6364686337417", "6364686337417-1", "6364686337417-20", "77-3", "R1-1", "1234-01",
      "res_1:book_1", "res_1:3", "res_p:b1", "res_1:b-1", "a-1:b", ":x", "x:",
      MEWS_GUID, "0d3a8c2e-1f4b-4c5d-9e6f-123456789012",
      "cb-260920-0001234", "cb4-260920-0001234", "think-1001-20260920-001", "e2e-think-1001-20260920-001", "demo-a-b-20260920-001",
      "R4", "ext-12", "RES-1234", "abc-", "-1", "1234-1a", "1234-x1", "1234-", "a-b-1", "res_1", "x",
    ];
    const { rows } = await db.query(
      `select id, public.booking_key(id) as key from unnest($1::text[]) as t(id)`,
      [ids],
    );
    expect(rows.map((x) => [x.id, x.key])).toEqual(ids.map((id) => [id, bookingKeyOf(id)]));
    // Strict: a null id stays null, and the caller falls back to the row.
    const { rows: nul } = await db.query(`select public.booking_key(null) as key`);
    expect(nul).toEqual([{ key: null }]);
  });

  describe.each([withBookingIds(makeFixture(21, 8), 1), withBookingIds(makeFixture(23, 500), 3), withBookingIds(makeFixture(24, 30, { thin: true }), 4)])(
    "$name, with multi-room reservations",
    (fx) => {
      const HORIZON = 30;
      const targets = Array.from({ length: HORIZON }, (_, i) => addDays(fx.localDate, i));
      const dates = [...new Set(fx.reservations.map((r) => String(r.stay_date)))].sort().filter((_, i) => i % 3 === 0).slice(0, 400);

      it("booking_speed_windows counts bookings the way the rpc model and indexBookingRows do", async () => {
        await insertReservations(db, fx.reservations);
        const rpc = pgliteRpc(db);
        const cases: { p_exclude: string[]; p_include?: string[] | null }[] = [
          { p_exclude: [...fx.exclude] },
          { p_exclude: [...fx.exclude], p_include: [uuidFor("rt-a")] },
          { p_exclude: [...fx.exclude], p_include: [uuidFor("rt-a"), uuidFor("rt-b")] },
          { p_exclude: [...fx.exclude], p_include: null },
          { p_exclude: [], p_include: [] },
        ];
        for (const c of cases) {
          const args = { p_hotel_id: H1, p_dates: dates, ...c };
          const { data, error } = await rpc("booking_speed_windows", args).order("stay_date");
          expect(error).toBeNull();
          const model = bookingSpeedWindows(fx.reservations, args);
          expect(data).toEqual(model);
          const include = c.p_include === undefined ? null : c.p_include;
          const keep = (x: FakeRow) =>
            include != null
              ? x.room_type_id != null && include.includes(String(x.room_type_id))
              : x.room_type_id == null || !c.p_exclude.includes(String(x.room_type_id));
          expect(data).toEqual(windowsFromIndex(fx.reservations, dates, keep));
        }
        // Fewer bookings than rows on the nights that have a multi-room reservation.
        const { data: all } = await rpc("booking_speed_windows", { p_hotel_id: H1, p_dates: dates, p_exclude: [] }).order("stay_date");
        const bookings = (all as FakeRow[]).reduce((s, x) => s + Number(x.n), 0);
        const rows = fx.reservations.filter((x) => x.hotel_id === H1 && dates.includes(String(x.stay_date))).length;
        expect(bookings).toBeLessThan(rows);
        expect(bookings).toBeGreaterThan(rows / 4);
      }, 120_000);

      it("the engine reads the same observations from the SQL and from its row fallback", async () => {
        await insertReservations(db, fx.reservations);
        const tables = { reservations: fx.reservations, hotel_closed_periods: fx.closed, assumption_challenges: fx.challenges };
        const { client: viaSql } = fakeSupabase(tables);
        (viaSql as unknown as { rpc: unknown }).rpc = pgliteRpc(db);
        const { client: viaRows } = fakeSupabase(tables, { rpc: (fn) => new FakeRpcError(missingFunction(fn)) });
        const counting = [uuidFor("rt-a"), uuidFor("rt-b")];
        const set = [uuidFor("rt-b")];
        const last = targets[targets.length - 1];
        const sql = await loadBookingSpeedContext(viaSql as SupabaseClient, H1, fx.localDate, fx.capacity, fx.exclude, last, counting, [counting, set]);
        const rows = await loadBookingSpeedContext(viaRows, H1, fx.localDate, fx.capacity, fx.exclude, last, counting, [counting, set]);
        expect(sql).not.toBeNull();
        expect(rows).not.toBeNull();
        // The season model's inputs count rooms on both paths.
        expect(rows!.dailyDemand).toEqual(sql!.dailyDemand);
        expect(rows!.seasonModel).toEqual(sql!.seasonModel);
        const summary = bookingSpeedHistorySummary(fx.reservations, {
          p_hotel_id: H1, p_from: addDays(fx.localDate, -1098), p_to: null, p_exclude: [...fx.exclude], p_ranks: [],
        });
        expect(sql!.dailyDemand).toEqual(
          summary.filter((s) => String(s.stay_date) < fx.localDate).map((s) => ({ stay_date: s.stay_date, value: s.n })),
        );
        // The observations count bookings on both paths, hotel-wide and per set.
        for (const t of targets) {
          for (const w of [1, 7, 30]) {
            expect(observeForStayDate(sql!, t, w)).toEqual(observeForStayDate(rows!, t, w));
            expect(observeForStayDate(sql!, t, w, set)).toEqual(observeForStayDate(rows!, t, w, set));
          }
        }
      }, 120_000);
    },
  );

  it("a 20-room reservation is one booking for pace and twenty rooms for occupancy and the season model", async () => {
    const night = "2026-10-10";
    const rt = uuidFor("rt-a");
    const rows: FakeRow[] = [
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `a0000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        hotel_id: H1,
        stay_date: night,
        room_type_id: rt,
        // Two rooms added to the wedding a month after the rest.
        booking_date: i < 18 ? "2026-06-01" : "2026-07-01",
        external_reservation_id: `6364686337417-${i + 1}`,
        current_rate: 200,
        base_rate: 200,
      })),
      { id: "a0000000-0000-4000-8000-000000000099", hotel_id: H1, stay_date: night, room_type_id: rt, booking_date: "2026-06-01", external_reservation_id: "55", current_rate: 150, base_rate: 150 },
    ];
    await insertReservations(db, rows);
    const rpc = pgliteRpc(db);
    const { data: windows } = await rpc("booking_speed_windows", { p_hotel_id: H1, p_dates: [night], p_exclude: [] });
    expect(windows).toEqual([{ stay_date: night, n: 2, bws: [131], counts: [2] }]);
    const { data: summary } = await rpc("booking_speed_history_summary", { p_hotel_id: H1, p_from: night, p_to: night, p_exclude: [], p_ranks: [1, 19, 21] });
    expect(summary).toEqual([{ stay_date: night, n: 21, usable: 21, rank_windows: [131, 131, 101] }]);
    const { client } = fakeSupabase({});
    (client as unknown as { rpc: unknown }).rpc = rpc;
    const cells = await loadReservationCells(client as SupabaseClient, H1, night, night);
    expect(cells!.booked.get(`${night}|${rt}`)!.units).toBe(21);
  }, 120_000);

  it("a replay of the large property migration leaves the booking count in place", async () => {
    await db.exec(readFileSync(LARGE_PROPERTY, "utf8"));
    const { rows } = await db.query(
      `select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'booking_speed_windows'`,
    );
    expect(rows).toHaveLength(1);
    expect(String(rows[0].def)).toContain("booking_key");
    // And the new file is safe to run again.
    await db.exec(readFileSync(COUNTS_BOOKINGS_MIGRATION, "utf8"));
    // On a database that never had the function, the large property file still creates it.
    await db.exec("drop function public.booking_speed_windows(uuid, date[], uuid[], uuid[]);");
    await db.exec(readFileSync(LARGE_PROPERTY, "utf8"));
    const { rows: old } = await db.query(
      `select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'booking_speed_windows'`,
    );
    expect(old).toHaveLength(1);
    expect(String(old[0].def)).not.toContain("booking_key");
    await db.exec(readFileSync(COUNTS_BOOKINGS_MIGRATION, "utf8"));
  }, 120_000);

  it("refuses a caller who is neither service_role nor a member of the hotel", async () => {
    const rpc = pgliteRpc(db, "authenticated");
    await db.exec("select set_config('test.accessible_hotel', '', false);");
    const denied = await rpc("booking_speed_windows", { p_hotel_id: H1, p_dates: ["2026-01-01"], p_exclude: [] });
    expect(denied.error?.code).toBe("42501");
    await db.exec(`select set_config('test.accessible_hotel', '${H1}', false);`);
    const allowed = await rpc("booking_speed_windows", { p_hotel_id: H1, p_dates: ["2026-01-01"], p_exclude: [] });
    expect(allowed.error).toBeNull();
    await db.exec("select set_config('test.accessible_hotel', '', false);");
  });
});
