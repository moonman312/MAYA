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
import { loadBookingSpeedContext, loadSplitWindows, observeForStayDate, resetBookingSpeedLogOnce } from "./booking-speed-provider";
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
        // First seen some hour of its booking day (or of the night, when the
        // booking date is unknown), so a p_since inside a day splits it.
        const day = rows[i].booking_date != null ? String(rows[i].booking_date) : String(rows[i].stay_date);
        const created_at = `${day}T${String(Math.floor(r() * 24)).padStart(2, "0")}:${String(Math.floor(r() * 60)).padStart(2, "0")}:00.000Z`;
        out.push({ ...rows[i], external_reservation_id: ext, created_at });
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

/** A timestamptz as the SQL sends it back (text), as the ISO instant it is; null stays null. */
function isoSince(rows: unknown): FakeRow[] {
  return ((rows ?? []) as FakeRow[]).map((r) => ({ ...r, since: r.since == null ? null : new Date(Date.parse(String(r.since))).toISOString() }));
}

/**
 * The SQL's rows for (date, instant) pairs, from indexBookingRows over the
 * same slim rows given each instant: by date, then instant.
 */
function windowsFromIndexPairs(rows: FakeRow[], dates: string[], sinces: string[], keep: (r: FakeRow) => boolean): FakeRow[] {
  const pairs = new Map<string, [string, string]>();
  dates.forEach((d, i) => pairs.set(`${d}|${Date.parse(sinces[i])}`, [d, sinces[i]]));
  return [...pairs.values()]
    .sort((x, y) => x[0].localeCompare(y[0]) || Date.parse(x[1]) - Date.parse(y[1]))
    .flatMap(([d, since]) => windowsFromIndex(rows, [d], keep, since));
}

/** The SQL's rows for `dates`, from indexBookingRows over the same slim rows (with `since`, the builder given it). */
function windowsFromIndex(rows: FakeRow[], dates: string[], keep: (r: FakeRow) => boolean, since?: string): FakeRow[] {
  const slim: SlimReservationRow[] = rows
    .filter((x) => x.hotel_id === H1 && keep(x))
    .map((x) => ({
      stay_date: String(x.stay_date),
      booking_date: x.booking_date != null ? String(x.booking_date) : null,
      booking_window_days: x.booking_window_days != null ? Number(x.booking_window_days) : null,
      external_reservation_id: x.external_reservation_id != null ? String(x.external_reservation_id) : null,
      created_at: x.created_at != null ? String(x.created_at) : null,
    }));
  const index = indexBookingRows(slim, since);
  const out: FakeRow[] = [];
  for (const d of [...new Set(dates)].sort()) {
    const entry = index.get(d);
    if (!entry) continue;
    const sorted = [...entry.windows].sort((a, b) => (a.bw === null ? 1 : b.bw === null ? -1 : a.bw - b.bw));
    out.push({ stay_date: d, since: since ?? null, n: entry.n, bws: sorted.map((w) => w.bw), counts: sorted.map((w) => w.n) });
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
    // A null id stays null (every branch of the CASE does), and the caller
    // falls back to the row.
    const { rows: nul } = await db.query(`select public.booking_key(null) as key`);
    expect(nul).toEqual([{ key: null }]);
  });

  it("booking_key is not strict, so the planner inlines it into the windows query instead of calling it per row", async () => {
    // A strict SQL function is only inlined when every argument is provably
    // non-null, which a table column never is: declared strict, the function
    // ran as a real call per row and the windows query cost 2.5x.
    const { rows: flags } = await db.query(
      `select proisstrict, provolatile, proparallel from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'booking_key'`,
    );
    expect(flags).toEqual([{ proisstrict: false, provolatile: "i", proparallel: "s" }]);
    const { rows: plan } = await db.query(
      `explain (verbose, costs off)
        select coalesce(public.booking_key(r.external_reservation_id), r.id::text) as booking
          from public.reservations r where r.hotel_id = $1`,
      [H1],
    );
    const text = plan.map((r) => String(r["QUERY PLAN"])).join("\n");
    expect(text).toContain("CASE WHEN");
    expect(text).not.toContain("booking_key(");
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
        // Raises at noon 40 and 20 days before the run: the bookings first
        // seen after each are split off inside their booking day, hotel-wide
        // and per set. One instant per date, the two taking turns, and every
        // fifth date asked twice, once with each: one call answers them all.
        const early = `${addDays(fx.localDate, -40)}T12:00:00.000Z`;
        const late = `${addDays(fx.localDate, -20)}T12:00:00.000Z`;
        const pairDates = [...dates, ...dates.filter((_, i) => i % 5 === 0)];
        const pairSinces = pairDates.map((_, i) => (i < dates.length ? (i % 2 === 0 ? early : late) : (i % 2 === 0 ? late : early)));
        const cases: { p_exclude: string[]; p_include?: string[] | null; p_since?: string[] }[] = [
          { p_exclude: [...fx.exclude] },
          { p_exclude: [...fx.exclude], p_include: [uuidFor("rt-a")] },
          { p_exclude: [...fx.exclude], p_include: [uuidFor("rt-a"), uuidFor("rt-b")] },
          { p_exclude: [...fx.exclude], p_include: null },
          { p_exclude: [], p_include: [] },
          { p_exclude: [...fx.exclude], p_since: pairSinces },
          { p_exclude: [...fx.exclude], p_include: [uuidFor("rt-a")], p_since: pairSinces },
        ];
        for (const c of cases) {
          const args = { p_hotel_id: H1, p_dates: c.p_since ? pairDates : dates, ...c };
          const { data: raw, error } = await rpc("booking_speed_windows", args).order("stay_date").order("since");
          expect(error).toBeNull();
          const data = isoSince(raw);
          const model = bookingSpeedWindows(fx.reservations, args);
          expect(data).toEqual(model);
          const include = c.p_include === undefined ? null : c.p_include;
          const keep = (x: FakeRow) =>
            include != null
              ? x.room_type_id != null && include.includes(String(x.room_type_id))
              : x.room_type_id == null || !c.p_exclude.includes(String(x.room_type_id));
          expect(data).toEqual(
            c.p_since ? windowsFromIndexPairs(fx.reservations, pairDates, c.p_since, keep) : windowsFromIndex(fx.reservations, dates, keep),
          );
          if (c.p_since) {
            // Fewer than the whole count, only on dates that have a booking
            // first seen after the raise, and each pair exactly what asking
            // for it alone says.
            const whole = bookingSpeedWindows(fx.reservations, { ...args, p_dates: dates, p_since: undefined });
            const total = (rows: FakeRow[]) => rows.reduce((sum, x) => sum + Number(x.n), 0);
            const afterEarly = data.filter((x) => x.since === early);
            expect(total(afterEarly)).toBeGreaterThan(0);
            expect(total(afterEarly)).toBeLessThan(total(whole));
            for (const since of [early, late]) {
              const asked = pairDates.filter((_, i) => c.p_since![i] === since);
              const { data: alone } = await rpc("booking_speed_windows", { ...args, p_dates: asked, p_since: asked.map(() => since) }).order("stay_date");
              expect(isoSince(alone)).toEqual(data.filter((x) => x.since === since));
            }
          }
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
        // And so does the day of a raise, split at the raise: from
        // booking_speed_windows with p_since on one path, row by row on the
        // other (the function there predates p_since, like everything else).
        // Two raises that day, read together.
        // The fire's day: the newest booking day, in the last week, of a
        // one-room booking for a target night on a counting room type (a
        // booking with an earlier room sits at that room's date instead);
        // the fire at the very end of it, so that day's every booking is the
        // fire's and the split shows.
        const rowsPerBooking = new Map<string, number>();
        for (const r of fx.reservations) {
          if (r.hotel_id !== H1 || r.external_reservation_id == null) continue;
          const k = `${r.stay_date}|${bookingKeyOf(String(r.external_reservation_id))}`;
          rowsPerBooking.set(k, (rowsPerBooking.get(k) ?? 0) + 1);
        }
        const recent = fx.reservations
          .filter(
            (r) =>
              r.hotel_id === H1 &&
              targets.includes(String(r.stay_date)) &&
              r.booking_date != null &&
              String(r.booking_date) <= fx.localDate &&
              String(r.booking_date) >= addDays(fx.localDate, -6) &&
              r.room_type_id != null &&
              !fx.exclude.has(String(r.room_type_id)) &&
              r.external_reservation_id != null &&
              rowsPerBooking.get(`${r.stay_date}|${bookingKeyOf(String(r.external_reservation_id))}`) === 1,
          )
          .map((r) => String(r.booking_date));
        const fireDay = recent.length > 0 ? recent.sort().at(-1)! : addDays(fx.localDate, -2);
        const since = `${fireDay}T23:59:59.999Z`;
        const noon = `${fireDay}T12:00:00.000Z`;
        const needs = targets.flatMap((t, i) => [
          { since, stayDate: t, signalIds: counting },
          { since, stayDate: t, signalIds: set },
          ...(i % 2 === 0 ? [{ since: noon, stayDate: t, signalIds: counting }] : []),
        ]);
        await loadSplitWindows(viaSql as SupabaseClient, H1, sql!, needs);
        await loadSplitWindows(viaRows, H1, rows!, needs);
        expect(rows!.splitLoaded).toEqual(sql!.splitLoaded);
        // The same bookings at the same windows on both paths; the function
        // orders a date's windows and the builder keeps them as they came,
        // which no reader depends on.
        const sorted = (m: Map<string, Map<string, { n: number; windows: { bw: number | null; n: number }[] }>> | undefined) =>
          new Map(
            [...(m ?? [])].map(([k, byDate]) => [
              k,
              new Map(
                [...byDate].map(([d, e]) => [
                  d,
                  { n: e.n, windows: [...e.windows].sort((a, b) => (a.bw === null ? 1 : b.bw === null ? -1 : a.bw - b.bw)) },
                ]),
              ),
            ]),
          );
        expect(sorted(rows!.splitWindows)).toEqual(sorted(sql!.splitWindows));
        expect(sql!.splitWindows!.size).toBe(3);
        let splitCount = 0;
        for (const t of targets) {
          for (const w of [7, 30]) {
            const a = observeForStayDate(sql!, t, w, counting, fireDay, "increase", since);
            const b = observeForStayDate(rows!, t, w, counting, fireDay, "increase", since);
            expect(a).toEqual(b);
            expect(a.countedSince).toBe(since);
            expect(a.countedFrom).toBe(fireDay);
            expect(observeForStayDate(sql!, t, w, set, fireDay, "increase", since)).toEqual(
              observeForStayDate(rows!, t, w, set, fireDay, "increase", since),
            );
            if (targets.indexOf(t) % 2 === 0) {
              expect(observeForStayDate(sql!, t, w, counting, fireDay, "increase", noon)).toEqual(
                observeForStayDate(rows!, t, w, counting, fireDay, "increase", noon),
              );
            }
            // The fire's day counts only its afternoon: never more than the
            // whole days, and less than them somewhere.
            const whole = observeForStayDate(sql!, t, w, counting, fireDay, "increase");
            expect(a.recentBookings).toBeLessThanOrEqual(whole.recentBookings);
            if (a.recentBookings < whole.recentBookings) splitCount++;
          }
        }
        if (recent.length > 0) expect(splitCount).toBeGreaterThan(0);
        else expect(splitCount).toBe(0);
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
    expect(windows).toEqual([{ stay_date: night, since: null, n: 2, bws: [131], counts: [2] }]);
    const { data: summary } = await rpc("booking_speed_history_summary", { p_hotel_id: H1, p_from: night, p_to: night, p_exclude: [], p_ranks: [1, 19, 21] });
    expect(summary).toEqual([{ stay_date: night, n: 21, usable: 21, rank_windows: [131, 131, 101] }]);
    const { client } = fakeSupabase({});
    (client as unknown as { rpc: unknown }).rpc = rpc;
    const cells = await loadReservationCells(client as SupabaseClient, H1, night, night);
    expect(cells!.booked.get(`${night}|${rt}`)!.units).toBe(21);
  }, 120_000);

  it("rows with an empty id are each their own booking, in SQL as in the builder and the rpc model", async () => {
    // The schema only says not null and the parsers skip empty ids, so no
    // row carries one; the one shape where the two paths could drift.
    const night = "2026-10-11";
    const rt = uuidFor("rt-a");
    const row = (i: number, ext: string | null, bookedOn: string): FakeRow => ({
      id: `b0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      hotel_id: H1,
      stay_date: night,
      room_type_id: rt,
      booking_date: bookedOn,
      external_reservation_id: ext,
      current_rate: 100,
      base_rate: 100,
    });
    const rows = [row(1, "", "2026-09-01"), row(2, "", "2026-09-05"), row(3, "x", "2026-09-05"), row(4, null, "2026-09-05")];
    await insertReservations(db, rows);
    const args = { p_hotel_id: H1, p_dates: [night], p_exclude: [] };
    const { data } = await pgliteRpc(db)("booking_speed_windows", args);
    expect(data).toEqual([{ stay_date: night, since: null, n: 4, bws: [36, 40], counts: [3, 1] }]);
    expect(data).toEqual(bookingSpeedWindows(rows, args));
    expect(data).toEqual(windowsFromIndex(rows, [night], () => true));
  }, 120_000);

  it("with p_since, a booking counts only when its first row reached MAYA after that instant, at its earliest booking date", async () => {
    // The day of a raise at noon: two separate bookings before it, three
    // after it. A two-room reservation whose first room was there before
    // the raise and whose second room came after is not new; one whose
    // rooms both came after is, once, at its earliest booking date. A row
    // with a null created_at cannot exist (not null), so nothing to test.
    const night = "2026-10-12";
    const rt = uuidFor("rt-a");
    const noon = "2026-09-02T12:00:00.000Z";
    const row = (i: number, ext: string, bookedOn: string, createdAt: string): FakeRow => ({
      id: `c0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      hotel_id: H1,
      stay_date: night,
      room_type_id: rt,
      booking_date: bookedOn,
      external_reservation_id: ext,
      created_at: createdAt,
      current_rate: 100,
      base_rate: 100,
    });
    const rows = [
      row(1, "101", "2026-09-02", "2026-09-02T09:00:00.000Z"),
      row(2, "102", "2026-09-02", "2026-09-02T11:59:59.000Z"),
      row(3, "103", "2026-09-02", "2026-09-02T12:00:00.000Z"),
      row(4, "104", "2026-09-02", "2026-09-02T12:00:01.000Z"),
      row(5, "105", "2026-09-02", "2026-09-02T18:00:00.000Z"),
      row(6, "106", "2026-09-03", "2026-09-03T08:00:00.000Z"),
      // Second room added after the raise to a booking that was there before it.
      row(7, "6364686337417-1", "2026-09-02", "2026-09-02T10:00:00.000Z"),
      row(8, "6364686337417-2", "2026-09-02", "2026-09-02T15:00:00.000Z"),
      // Both rooms after the raise, the second at a later booking date.
      row(9, "6364686337418-1", "2026-09-02", "2026-09-02T14:00:00.000Z"),
      row(10, "6364686337418-2", "2026-09-03", "2026-09-03T09:00:00.000Z"),
      // Another night entirely: no row for it with p_since.
      { ...row(11, "107", "2026-09-02", "2026-09-02T09:00:00.000Z"), stay_date: "2026-10-13" },
    ];
    await insertReservations(db, rows);
    const rpc = pgliteRpc(db);
    const dates = [night, "2026-10-13"];
    const whole = await rpc("booking_speed_windows", { p_hotel_id: H1, p_dates: dates, p_exclude: [] });
    expect(whole.data).toEqual([
      { stay_date: night, since: null, n: 8, bws: [39, 40], counts: [1, 7] },
      { stay_date: "2026-10-13", since: null, n: 1, bws: [41], counts: [1] },
    ]);
    const args = { p_hotel_id: H1, p_dates: dates, p_exclude: [], p_since: [noon, noon] };
    const { data: raw, error } = await rpc("booking_speed_windows", args);
    expect(error).toBeNull();
    const data = isoSince(raw);
    // 104 and 105 at noon's booking day, 106 the day after, and the
    // reservation whose rooms both came after the raise, at its earliest
    // booking date (the 2nd): 40 days out three times, 39 days out once.
    expect(data).toEqual([{ stay_date: night, since: noon, n: 4, bws: [39, 40], counts: [1, 3] }]);
    expect(data).toEqual(bookingSpeedWindows(rows, args));
    expect(data).toEqual(windowsFromIndex(rows, dates, () => true, noon));
    // At the raise's own instant nothing is new; a moment before it, one
    // booking is. Asked together, each instant comes back on its own row,
    // in order, exactly as asked alone.
    const evening = "2026-09-02T18:00:00.000Z";
    const before = "2026-09-02T11:59:58.000Z";
    const together = { p_hotel_id: H1, p_dates: [night, night, night, "2026-10-13"], p_exclude: [], p_since: [evening, before, noon, noon] };
    const { data: all } = await rpc("booking_speed_windows", together).order("stay_date").order("since");
    expect(isoSince(all)).toEqual([
      { stay_date: night, since: before, n: 6, bws: [39, 40], counts: [1, 5] },
      { stay_date: night, since: noon, n: 4, bws: [39, 40], counts: [1, 3] },
      { stay_date: night, since: evening, n: 1, bws: [39], counts: [1] },
    ]);
    expect(isoSince(all)).toEqual(bookingSpeedWindows(rows, together));
    // One instant per date, or the call fails.
    const short = await rpc("booking_speed_windows", { ...args, p_since: [noon] });
    expect(short.data).toBeNull();
    expect(short.error?.code).toBe("22023");
  }, 120_000);

  it("adds window_since to pickup_event, nullable, and leaves it alone on a replay", async () => {
    const column = () =>
      db.query(
        `select data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'pickup_event' and column_name = 'window_since'`,
      );
    expect((await column()).rows).toEqual([{ data_type: "timestamp with time zone", is_nullable: "YES" }]);
    await db.exec(readFileSync(COUNTS_BOOKINGS_MIGRATION, "utf8"));
    expect((await column()).rows).toEqual([{ data_type: "timestamp with time zone", is_nullable: "YES" }]);
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
    await db.exec("drop function public.booking_speed_windows(uuid, date[], uuid[], uuid[], timestamptz[]);");
    await db.exec(readFileSync(LARGE_PROPERTY, "utf8"));
    const { rows: old } = await db.query(
      `select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'booking_speed_windows'`,
    );
    expect(old).toHaveLength(1);
    expect(String(old[0].def)).not.toContain("booking_key");
    // And this file replaces that four-argument one with its five-argument
    // one, leaving exactly one function, so PostgREST never has two to
    // choose between; a replay of the large property file after that
    // leaves it alone.
    await db.exec(readFileSync(COUNTS_BOOKINGS_MIGRATION, "utf8"));
    await db.exec(readFileSync(LARGE_PROPERTY, "utf8"));
    const { rows: signatures } = await db.query(
      `select pg_get_function_identity_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'booking_speed_windows'`,
    );
    expect(signatures).toEqual([{ args: "p_hotel_id uuid, p_dates date[], p_exclude uuid[], p_include uuid[], p_since timestamp with time zone[]" }]);
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

describe.skipIf(!PGLITE_DIR)("the raises open when the migration runs, recorded in rooms", () => {
  const RULE = uuidFor("r1");
  const fire = (
    n: number,
    over: { check: string; dir?: "increase" | "decrease"; retired?: string; window?: boolean },
  ) =>
    `('${String(n).padStart(8, "0")}-0000-4000-8000-000000000000', '${H1}', '${RULE}', '2026-09-15T10:00:00Z', ` +
    `${over.retired ? `'${over.retired}', 'bookings_cancelled'` : "null, null"}, '${over.dir ?? "increase"}', '${over.check}', ` +
    `${over.window === false ? "null, null, null, null" : "'2026-09-09', '2026-09-15', 20, 2"})`;
  const COLUMNS =
    "id, hotel_id, rule_id, applied_at, retired_at, retired_reason, action_direction, cancel_check, " +
    "window_from, window_to, window_bookings_at_fire, window_expected_at_fire";
  const seed = `insert into public.pickup_event (${COLUMNS}) values
    ${fire(1, { check: "window_bookings" })},
    ${fire(2, { check: "either" })},
    ${fire(3, { check: "net_units", window: false })},
    ${fire(4, { check: "none", window: false })},
    ${fire(5, { check: "window_bookings", retired: "2026-09-18T10:00:00Z" })},
    ${fire(6, { check: "none", dir: "decrease", window: false })};`;
  const checks = async (db: Db) =>
    (
      await db.query(
        `select left(id::text, 8) as id, cancel_check, window_from, window_to, window_bookings_at_fire, window_expected_at_fire
           from public.pickup_event order by id`,
      )
    ).rows.map((r) => [r.id, r.cancel_check, r.window_from, r.window_bookings_at_fire, r.window_expected_at_fire]);

  it("turns their frozen-window test off, keeps their window as history, and leaves cuts, retired fires and later raises alone", async () => {
    const db = await openPglite({ countsBookings: false });
    try {
      await db.exec(seed);
      await db.exec(readFileSync(COUNTS_BOOKINGS_MIGRATION, "utf8"));
      expect(await checks(db)).toEqual([
        // The two open raises with a window test lose it and keep the rest.
        ["00000001", "none", "2026-09-09", 20, "2.00"],
        ["00000002", "net_units", "2026-09-09", 20, "2.00"],
        ["00000003", "net_units", null, null, null],
        ["00000004", "none", null, null, null],
        // Already off: history is not rewritten.
        ["00000005", "window_bookings", "2026-09-09", 20, "2.00"],
        ["00000006", "none", null, null, null],
      ]);
      // A raise the engine makes after the switch records its window in
      // bookings, and a replay of the file must not touch it.
      await db.exec(`insert into public.pickup_event (${COLUMNS}) values ${fire(7, { check: "window_bookings" })};`);
      await db.exec(readFileSync(COUNTS_BOOKINGS_MIGRATION, "utf8"));
      expect((await checks(db))[6]).toEqual(["00000007", "window_bookings", "2026-09-09", 20, "2.00"]);
    } finally {
      await db.close();
    }
  }, 120_000);

  it("does the same on a database whose engine counted rooms on its row fallback, with no windows function at all", async () => {
    const db = await openPglite({ countsBookings: false });
    try {
      await db.exec("drop function public.booking_speed_windows(uuid, date[], uuid[], uuid[]);");
      await db.exec(seed);
      await db.exec(readFileSync(COUNTS_BOOKINGS_MIGRATION, "utf8"));
      expect((await checks(db)).slice(0, 2)).toEqual([
        ["00000001", "none", "2026-09-09", 20, "2.00"],
        ["00000002", "net_units", "2026-09-09", 20, "2.00"],
      ]);
    } finally {
      await db.close();
    }
  }, 120_000);
});
