/**
 * 99_supabase_migration_booking_history_cache_v1.sql run for real in PGlite,
 * twice, on a production-shaped base: the number the reservation triggers
 * move whenever the booking history of nights already over changes, and the
 * store the engine keeps that history in for the hotel day, against the
 * contract history-cache-rpc-model.test.ts gives the fake Supabase (which
 * the engine, preview and reuse tests run on).
 *
 * Only runs with MAYA_PGLITE_DIR set (see large-property-sql.test.ts):
 *
 *   MAYA_PGLITE_DIR=/path/to/dir npx vitest run src/lib/engine/booking-history-cache-sql.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATION_ORDER, PLATFORM, fileSql } from "./pricing-cadence-sql.test";
import { historyCacheGet, historyCachePut } from "./history-cache-rpc-model.test";
import type { FakeRow } from "./fake-supabase.test";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_booking_history_cache_v1.sql";
const CADENCE = "99_supabase_migration_pricing_cadence_v1.sql";

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

const H = "11111111-1111-4111-8111-111111111111";
const H2 = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const RT1 = "44444444-4444-4444-8444-444444444441";
const RT2 = "44444444-4444-4444-8444-444444444442";

const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe("the migration file", () => {
  it("is listed last in the order the SQL tests build production's base in", () => {
    expect(MIGRATION_ORDER[MIGRATION_ORDER.length - 1]).toBe(MIGRATION);
  });

  it("keeps the number, the store, the triggers and the two functions together, in one transaction", () => {
    const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8");
    for (const bit of [
      "begin;",
      "create table if not exists public.booking_history_seq",
      "create table if not exists public.booking_history_cache",
      "alter table public.booking_history_seq enable row level security",
      "alter table public.booking_history_cache enable row level security",
      "after insert on public.reservations",
      "after update on public.reservations",
      "after delete on public.reservations",
      "after truncate on public.reservations",
      "create or replace function public.booking_history_cache_get(",
      "create or replace function public.booking_history_cache_put(",
      "commit;",
    ]) {
      expect(sql).toContain(bit);
    }
    expect(sql).not.toMatch(/—/);
  });
});

describe.skipIf(!PGLITE_DIR)("the booking history store migration in PGlite", () => {
  let db: Db;
  const today = new Date().toISOString().slice(0, 10);
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const asService = async <T>(fn: () => Promise<T>): Promise<T> => {
    await db.exec(`select set_config('request.jwt.claim.role', 'service_role', false)`);
    try {
      return await fn();
    } finally {
      await db.exec(`select set_config('request.jwt.claim.role', '', false)`);
    }
  };
  const seq = async (hotel = H) => Number((await q(`select seq from public.booking_history_seq where hotel_id = $1`, [hotel]))[0]?.seq ?? 0);
  let resNo = 0;
  const reservation = async (o: { stay: string; hotel?: string; rt?: string | null; booked?: string | null; bw?: number | null; ext?: string; rate?: number }) => {
    resNo++;
    const id = `66666666-6666-4666-8666-${String(resNo).padStart(12, "0")}`;
    await q(
      `insert into public.reservations (id, hotel_id, external_reservation_id, stay_date, room_type_id, current_rate, base_rate, booking_date, booking_window_days)
       values ($1, $2, $3, $4, $5, $6, $6, $7, $8)`,
      [id, o.hotel ?? H, o.ext ?? `R${resNo}:1`, o.stay, o.rt === undefined ? RT1 : o.rt, o.rate ?? 100, o.booked ?? null, o.bw ?? null],
    );
    return id;
  };
  const get = async (hotel: string, date: string, keys: string[], dates: string[] | null = null) =>
    (await q(`select public.booking_history_cache_get($1, $2, $3, $4) as r`, [hotel, date, keys, dates]))[0].r as {
      seq: number;
      entries: Record<string, Record<string, unknown>>;
    };
  const put = async (hotel: string, date: string, s: number, entries: unknown) =>
    Number((await q(`select public.booking_history_cache_put($1, $2, $3, $4::jsonb) as n`, [hotel, date, s, JSON.stringify(entries)]))[0].n);

  beforeAll(async () => {
    const dist = `${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist`;
    const mod = await import(/* @vite-ignore */ pathToFileURL(`${dist}/index.js`).href);
    const { pgcrypto } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/pgcrypto.js`).href);
    const { citext } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/citext.js`).href);
    db = new mod.PGlite({ extensions: { pgcrypto, citext } }) as Db;
    await db.exec(PLATFORM);
    // Production's order: everything before this file, the cadence migration, then this file twice.
    const before = MIGRATION_ORDER.filter((m) => m !== MIGRATION);
    for (const name of ["01_supabase_base_schema.sql", "02_supabase_schema.sql", ...before, CADENCE, MIGRATION, MIGRATION]) {
      try {
        await db.exec(fileSql(name));
      } catch (e) {
        throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await db.exec(`
      select set_config('request.jwt.claim.role', 'service_role', false);
      insert into auth.users (id, email) values ('${USER}', 'owner@example.com');
      insert into public.hotels (id, name, timezone) values ('${H}', 'History Inn', 'America/New_York'), ('${H2}', 'Other Inn', 'Pacific/Kiritimati');
      insert into public.hotel_memberships (hotel_id, user_id, role) values ('${H}', '${USER}', 'general_manager');
      insert into public.room_types (id, hotel_id, external_room_type_id, name, total_rooms) values
        ('${RT1}', '${H}', 'K', 'King', 10), ('${RT2}', '${H}', 'Q', 'Queen', 8);
      select set_config('request.jwt.claim.role', '', false);
    `);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.exec(`delete from public.reservations; delete from public.booking_history_cache; delete from public.booking_history_seq;`);
  });

  it("keeps both tables behind row level security with no policies, and only the service role may touch them or call the functions", async () => {
    const rows = await q(
      `select c.relname as t, c.relrowsecurity as rls,
              (select count(*) from pg_policies p where p.tablename = c.relname)::int as policies
         from pg_class c where c.relname in ('booking_history_seq', 'booking_history_cache') order by 1`,
    );
    expect(rows).toEqual([
      { t: "booking_history_cache", rls: true, policies: 0 },
      { t: "booking_history_seq", rls: true, policies: 0 },
    ]);
    for (const table of ["booking_history_seq", "booking_history_cache"]) {
      const grants = await q(
        `select grantee, privilege_type from information_schema.role_table_grants
          where table_name = $1 and grantee in ('anon', 'authenticated', 'service_role') order by 1, 2`,
        [table],
      );
      expect(grants.every((g) => g.grantee === "service_role")).toBe(true);
    }
    const exec = await q(
      `select p.proname as f,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authed,
              has_function_privilege('service_role', p.oid, 'execute') as service
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'booking_history_%' order by 1`,
    );
    for (const f of exec) {
      expect([f.f, f.anon, f.authed]).toEqual([f.f, false, false]);
    }
    expect(exec.filter((f) => f.service).map((f) => f.f)).toEqual(["booking_history_cache_get", "booking_history_cache_put"]);
  });

  it("moves the hotel's number for a booking added, changed or taken off on a night already over, and for nothing on a night ahead", async () => {
    const past = addDays(today, -40);
    const ahead = addDays(today, 30);
    await asService(async () => {
      const id = await reservation({ stay: past, booked: addDays(past, -10), bw: 10 });
      expect(await seq()).toBe(1);
      const later = await reservation({ stay: ahead, booked: today, bw: 30 });
      expect(await seq()).toBe(1);
      // What the history doesn't read: the rate, the payload.
      await q(`update public.reservations set current_rate = 150, raw_payload = '{"a":1}'::jsonb where id = $1`, [id]);
      expect(await seq()).toBe(1);
      // What it reads.
      await q(`update public.reservations set booking_date = $2 where id = $1`, [id, addDays(past, -12)]);
      expect(await seq()).toBe(2);
      await q(`update public.reservations set room_type_id = $2 where id = $1`, [id, RT2]);
      expect(await seq()).toBe(3);
      await q(`update public.reservations set external_reservation_id = 'X9:1' where id = $1`, [id]);
      expect(await seq()).toBe(4);
      // The same values written again, as a sync's upsert does: nothing moves.
      await q(
        `insert into public.reservations (id, hotel_id, external_reservation_id, stay_date, room_type_id, booking_date, booking_window_days)
         select id, hotel_id, external_reservation_id, stay_date, room_type_id, booking_date, booking_window_days from public.reservations where id = $1
         on conflict (id) do update set booking_date = excluded.booking_date, booking_window_days = excluded.booking_window_days`,
        [id],
      );
      expect(await seq()).toBe(4);
      // A night ahead moved into the past moves it; one moved further ahead doesn't.
      await q(`update public.reservations set stay_date = $2 where id = $1`, [later, addDays(ahead, 5)]);
      expect(await seq()).toBe(4);
      await q(`update public.reservations set stay_date = $2 where id = $1`, [later, addDays(today, -1)]);
      expect(await seq()).toBe(5);
      // Tomorrow (UTC) is still in: some hotel's yesterday can be as late as today in UTC.
      await reservation({ stay: addDays(today, 1) });
      expect(await seq()).toBe(6);
      await reservation({ stay: addDays(today, 2) });
      expect(await seq()).toBe(6);
      // One statement, many rows: moved once. Another hotel's booking moves only its own.
      await q(`delete from public.reservations where hotel_id = $1 and stay_date < $2`, [H, today]);
      expect(await seq()).toBe(7);
      await reservation({ stay: past, hotel: H2, rt: null });
      expect([await seq(), await seq(H2)]).toEqual([7, 1]);
      await q(`delete from public.reservations where stay_date > $1`, [addDays(today, 1)]);
      expect([await seq(), await seq(H2)]).toEqual([7, 1]);
    });
  });

  it("answers only under the hotel's current number and day, narrows a key's nights to those asked, and merges what is saved under one number", async () => {
    const day = today;
    await asService(async () => {
      const w = "windows|1|except:";
      const s = "summary|1|x";
      const first = await get(H, day, [w, s]);
      expect(first).toEqual({ seq: 0, entries: {} });
      expect(await put(H, day, 0, { [w]: { "2025-01-01": { n: 2, bws: [3, null], counts: [1, 1] }, "2025-01-02": null }, [s]: { rows: [{ stay_date: "2025-01-01", n: 2, usable: 1, rank_windows: [3, null] }] } })).toBe(2);
      expect(await get(H, day, [w], ["2025-01-02", "2025-01-09"])).toEqual({ seq: 0, entries: { [w]: { "2025-01-02": null } } });
      expect(await get(H, day, [s])).toEqual({ seq: 0, entries: { [s]: { rows: [{ stay_date: "2025-01-01", n: 2, usable: 1, rank_windows: [3, null] }] } } });
      // Another day, another hotel, a key not asked: nothing.
      expect((await get(H, addDays(day, 1), [w])).entries).toEqual({});
      expect((await get(H2, day, [w])).entries).toEqual({});
      expect((await get(H, day, ["windows|1|only:x"])).entries).toEqual({});
      // More nights under the same number are merged in.
      expect(await put(H, day, 0, { [w]: { "2025-01-03": { n: 1, bws: [0], counts: [1] } } })).toBe(1);
      expect(Object.keys((await get(H, day, [w])).entries[w]).sort()).toEqual(["2025-01-01", "2025-01-02", "2025-01-03"]);
      // A booking on a past night: nothing is answered any more, and what was read before it is not saved.
      await reservation({ stay: addDays(today, -3) });
      expect(await get(H, day, [w, s])).toEqual({ seq: 1, entries: {} });
      expect(await put(H, day, 0, { [w]: { "2025-01-04": null } })).toBe(0);
      expect(await put(H, day, 1, { [w]: { "2025-01-04": null } })).toBe(1);
      expect(await get(H, day, [w])).toEqual({ seq: 1, entries: { [w]: { "2025-01-04": null } } });
      // Saving drops the hotel's older numbers and days before yesterday, and anyone's older than a week.
      const kept = await q(`select cache_key, history_seq::int as s from public.booking_history_cache order by 1`);
      expect(kept).toEqual([{ cache_key: w, s: 1 }]);
      await q(
        `insert into public.booking_history_cache (hotel_id, hotel_date, cache_key, history_seq, entries) values
           ($1, $3::date - 1, 'yesterday', 1, '{}'), ($1, $3::date - 2, 'older', 1, '{}'), ($2, $3::date - 3, 'other', 0, '{}'), ($2, $3::date - 8, 'stale', 0, '{}')`,
        [H, H2, day],
      );
      await put(H, day, 1, {});
      expect((await q(`select cache_key from public.booking_history_cache order by 1`)).map((r) => r.cache_key)).toEqual(["other", "windows|1|except:", "yesterday"]);
    });
  });

  it("gives what the fake's model gives for the same saves, reads and bookings", async () => {
    const day = today;
    const tables: Record<string, FakeRow[]> = { reservations: [] };
    const both = async (label: string, op: (hotel: string) => Promise<unknown> | unknown, model: () => unknown) => {
      const real = await op(H);
      const fake = model();
      return { label, real, fake };
    };
    const w = "windows|1|only:a,b";
    const f = "first|1|2023-01-01|a,b";
    await asService(async () => {
      const steps: { label: string; real: unknown; fake: unknown }[] = [];
      const realSeq = async () => (await get(H, day, [])).seq;
      const fakeSeq = () => (historyCacheGet(tables, { p_hotel_id: H, p_hotel_date: day, p_keys: [] }) as { seq: number }).seq;
      const entries = (x: unknown) => (x as { entries: unknown }).entries;
      let rs = await realSeq();
      let fs = fakeSeq();
      steps.push(await both("put", (h) => put(h, day, rs, { [w]: { "2024-05-01": { n: 1, bws: [2], counts: [1] } }, [f]: { first: "2023-02-03" } }), () => historyCachePut(tables, { p_hotel_id: H, p_hotel_date: day, p_seq: fs, p_entries: { [w]: { "2024-05-01": { n: 1, bws: [2], counts: [1] } }, [f]: { first: "2023-02-03" } } })));
      steps.push(await both("get", async (h) => entries(await get(h, day, [w, f], ["2024-05-01"])), () => entries(historyCacheGet(tables, { p_hotel_id: H, p_hotel_date: day, p_keys: [w, f], p_dates: ["2024-05-01"] }))));
      // A booking ahead: both still answer.
      await reservation({ stay: addDays(today, 20) });
      tables.reservations.push({ id: "a", hotel_id: H, stay_date: addDays(today, 20), room_type_id: RT1, external_reservation_id: "a" });
      steps.push(await both("get after a booking ahead", async (h) => entries(await get(h, day, [w])), () => entries(historyCacheGet(tables, { p_hotel_id: H, p_hotel_date: day, p_keys: [w] }))));
      // A booking on a past night: neither does, and a save under the old number is refused by both.
      await reservation({ stay: addDays(today, -2) });
      tables.reservations.push({ id: "b", hotel_id: H, stay_date: addDays(today, -2), room_type_id: RT1, external_reservation_id: "b" });
      steps.push(await both("get after a past booking", async (h) => entries(await get(h, day, [w, f])), () => entries(historyCacheGet(tables, { p_hotel_id: H, p_hotel_date: day, p_keys: [w, f] }))));
      steps.push(await both("put under the old number", (h) => put(h, day, rs, { [w]: { "2024-05-02": null } }), () => historyCachePut(tables, { p_hotel_id: H, p_hotel_date: day, p_seq: fs, p_entries: { [w]: { "2024-05-02": null } } })));
      rs = await realSeq();
      fs = fakeSeq();
      steps.push(await both("put under the new number", (h) => put(h, day, rs, { [w]: { "2024-05-02": null } }), () => historyCachePut(tables, { p_hotel_id: H, p_hotel_date: day, p_seq: fs, p_entries: { [w]: { "2024-05-02": null } } })));
      steps.push(await both("get", async (h) => entries(await get(h, day, [w, f])), () => entries(historyCacheGet(tables, { p_hotel_id: H, p_hotel_date: day, p_keys: [w, f] }))));
      for (const step of steps) expect({ label: step.label, got: step.real }).toEqual({ label: step.label, got: step.fake });
    });
  });

  it("forgets every hotel's kept history when reservations is emptied in one go", async () => {
    await asService(async () => {
      await put(H, today, 0, { k: { first: "2024-01-01" } });
      expect(await q(`select count(*)::int as n from public.booking_history_cache`)).toEqual([{ n: 1 }]);
      await db.exec(`truncate public.reservations cascade`);
      expect(await q(`select count(*)::int as n from public.booking_history_cache`)).toEqual([{ n: 0 }]);
    });
  });
});
