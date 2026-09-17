/**
 * The SQL in 99_supabase_migration_large_property_scale_v1.sql, run for real
 * in PGlite (Postgres compiled to WebAssembly, in memory) against the
 * TypeScript it replaces.
 *
 * PGlite is not a dependency of this app, so the suite only runs when
 * MAYA_PGLITE_DIR points at a directory whose node_modules has
 * @electric-sql/pglite:
 *
 *   MAYA_PGLITE_DIR=/path/to/dir npx vitest run src/lib/engine/large-property-sql.test.ts
 *
 * The tables are the minimal columns the functions read; auth.role() and
 * is_hotel_accessible() are stubbed from session settings. The function
 * bodies come straight from the migration file.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import { legacy, makeFixture, rng, type Fixture } from "./booking-speed-legacy.test";
import { loadBookingSpeedContext, observeForStayDate, resetBookingSpeedLogOnce } from "./booking-speed-provider";
import { loadLastAuditSignatures } from "./audit";
import { FakeRpcError, fakeSupabase, missingFunction, type FakeRow } from "./fake-supabase.test";
import { findSnapshotAt } from "./snapshots";
import { bookingSpeedHistorySummary, bookingSpeedWindows, roomTypeMaxRates } from "./scale-rpc-model.test";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const MIGRATION = resolve(__dirname, "../../../../99_supabase_migration_large_property_scale_v1.sql");

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

export const STUBS = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
create or replace function public.is_hotel_accessible(target_hotel_id uuid) returns boolean
language sql stable as $$
  select coalesce(current_setting('test.accessible_hotel', true), '') = target_hotel_id::text
$$;
create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  external_reservation_id text,
  room_type_id uuid,
  stay_date date not null,
  booking_date date,
  booking_window_days integer,
  current_rate numeric(12,2),
  base_rate numeric(12,2),
  created_at timestamptz not null default now()
);
create index if not exists idx_reservations_hotel_stay_date on public.reservations(hotel_id, stay_date);
create table if not exists public.stay_date_snapshot (
  hotel_id uuid not null,
  snapshot_ts timestamptz not null,
  stay_date date not null,
  room_type_id uuid not null,
  sellable_units integer not null,
  booked_units integer not null,
  booked_revenue numeric(12,2) not null,
  primary key (hotel_id, snapshot_ts, stay_date, room_type_id)
);
create table if not exists public.evaluation_audit (
  id uuid primary key default gen_random_uuid(),
  evaluation_run_id uuid,
  hotel_id uuid not null,
  stay_date date not null,
  room_type_id uuid not null,
  evaluated_at timestamptz not null,
  base_price numeric(10,2),
  final_price numeric(10,2) not null,
  details jsonb not null
);
`;

/** Fixture ids are readable strings; the tables want uuids. */
export function uuidFor(label: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(label)) return label;
  let h = 0;
  for (const ch of label) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return `00000000-0000-4000-a000-${h.toString(16).padStart(12, "0")}`;
}

export async function openPglite(): Promise<Db> {
  const mod = await import(
    /* @vite-ignore */ pathToFileURL(`${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist/index.js`).href
  );
  // Dates and timestamps come back as text, the way PostgREST sends them.
  const db = new mod.PGlite({ parsers: { 1082: (v: string) => v, 1184: (v: string) => v } }) as Db;
  await db.exec("set timezone = 'UTC';");
  await db.exec(STUBS);
  await db.exec(readFileSync(MIGRATION, "utf8"));
  return db;
}

async function insertReservations(db: Db, rows: FakeRow[]): Promise<void> {
  await db.exec("truncate public.reservations;");
  const CHUNK = 2000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    for (const r of chunk) {
      const p = params.length;
      values.push(`($${p + 1}::uuid, $${p + 2}::uuid, $${p + 3}::uuid, $${p + 4}::date, $${p + 5}::date, $${p + 6}::int, $${p + 7}::numeric, $${p + 8}::numeric, coalesce($${p + 9}::timestamptz, now()))`);
      params.push(
        uuidFor(String(r.id)),
        uuidFor(String(r.hotel_id)),
        r.room_type_id == null ? null : uuidFor(String(r.room_type_id)),
        r.stay_date,
        r.booking_date ?? null,
        r.booking_window_days ?? null,
        r.current_rate ?? null,
        r.base_rate ?? null,
        r.created_at ?? null,
      );
    }
    await db.query(
      `insert into public.reservations (id, hotel_id, room_type_id, stay_date, booking_date, booking_window_days, current_rate, base_rate, created_at) values ${values.join(",")}`,
      params,
    );
  }
}

/** Argument types per function, for casting the named parameters. */
const SIGNATURES: Record<string, Record<string, string>> = {
  booking_speed_history_summary: { p_hotel_id: "uuid", p_from: "date", p_to: "date", p_exclude: "uuid[]", p_ranks: "int[]" },
  booking_speed_windows: { p_hotel_id: "uuid", p_dates: "date[]", p_exclude: "uuid[]" },
  audit_last_signatures: { p_hotel_id: "uuid", p_from: "date", p_to: "date" },
  room_type_max_rates: { p_hotel_id: "uuid" },
  snapshot_cells_at: { p_hotel_id: "uuid", p_ts: "timestamptz", p_from: "date", p_to: "date", p_room_types: "uuid[]" },
};

/**
 * A supabase-js-shaped `rpc` that runs the real function in PGlite with
 * PostgREST's ordering and paging, under the given session role.
 */
export function pgliteRpc(db: Db, role = "service_role") {
  return (fn: string, args: Record<string, unknown>) => {
    const orders: string[] = [];
    let range: [number, number] | null = null;
    const run = async () => {
      const sig = SIGNATURES[fn];
      const names = Object.keys(args);
      const params = names.map((k) => args[k]);
      const call = names.map((k, i) => `${k} => $${i + 1}::${sig?.[k] ?? "text"}`).join(", ");
      const order = orders.length ? ` order by ${orders.join(", ")}` : "";
      const page = range ? ` limit ${range[1] - range[0] + 1} offset ${range[0]}` : "";
      try {
        await db.exec(`select set_config('request.jwt.claim.role', '${role}', false);`);
        const res = await db.query(`select * from public.${fn}(${call})${order}${page}`, params);
        return { data: res.rows, error: null };
      } catch (e) {
        const err = e as { code?: string; message?: string };
        return { data: null, error: { code: err.code, message: err.message ?? String(e) } };
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      order: (col: string, o?: { ascending?: boolean }) => (orders.push(`${col} ${o?.ascending === false ? "desc" : "asc"}`), b),
      range: (a: number, z: number) => ((range = [a, z]), b),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej),
    };
    return b;
  };
}

/** The fixture with every id mapped to the uuid PGlite stores. */
function asUuids(fx: Fixture): Fixture {
  return {
    ...fx,
    exclude: new Set([...fx.exclude].map(uuidFor)),
    reservations: fx.reservations.map((r) => ({
      ...r,
      id: uuidFor(String(r.id)),
      hotel_id: uuidFor(String(r.hotel_id)),
      room_type_id: r.room_type_id == null ? null : uuidFor(String(r.room_type_id)),
    })),
    closed: fx.closed.map((c) => ({ ...c, hotel_id: uuidFor(String(c.hotel_id)) })),
    challenges: fx.challenges.map((c) => ({ ...c, hotel_id: uuidFor(String(c.hotel_id)) })),
  };
}

const H1 = uuidFor("h1");

describe.skipIf(!PGLITE_DIR)("large property SQL in PGlite", () => {
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

  describe.each([makeFixture(21, 8), makeFixture(22, 60), makeFixture(23, 500), makeFixture(24, 30, { thin: true })])(
    "Booking Speed: $name",
    (raw) => {
      const fx = asUuids(raw);
      const HORIZON = 30;
      const targets = Array.from({ length: HORIZON }, (_, i) => addDays(fx.localDate, i));

      it("SQL summary and windows equal the TypeScript models row for row", async () => {
        await insertReservations(db, fx.reservations);
        const rpc = pgliteRpc(db);
        const summaryArgs = {
          p_hotel_id: H1,
          p_from: addDays(fx.localDate, -1098),
          p_to: null,
          p_exclude: [...fx.exclude],
          p_ranks: [1, 3, 7, 7, 40, 150],
        };
        const { data: summary, error } = await rpc("booking_speed_history_summary", summaryArgs).order("stay_date");
        expect(error).toBeNull();
        expect(summary).toEqual(bookingSpeedHistorySummary(fx.reservations, summaryArgs));

        const dates = [...new Set(fx.reservations.map((r) => String(r.stay_date)))].sort().filter((_, i) => i % 3 === 0);
        const windowArgs = { p_hotel_id: H1, p_dates: dates.slice(0, 400), p_exclude: [...fx.exclude] };
        const { data: windows, error: wErr } = await rpc("booking_speed_windows", windowArgs).order("stay_date");
        expect(wErr).toBeNull();
        expect(windows).toEqual(bookingSpeedWindows(fx.reservations, windowArgs));
      }, 120_000);

      it("the engine on the SQL path observes exactly what the old row-by-row code did", async () => {
        await insertReservations(db, fx.reservations);
        const { client } = fakeSupabase({ hotel_closed_periods: fx.closed, assumption_challenges: fx.challenges });
        (client as unknown as { rpc: unknown }).rpc = pgliteRpc(db);
        const ctx = await loadBookingSpeedContext(
          client as SupabaseClient,
          H1,
          fx.localDate,
          fx.capacity,
          fx.exclude,
          targets[targets.length - 1],
        );
        const closed = fx.closed.map((c) => ({ start_date: String(c.start_date), end_date: String(c.end_date) }));
        const old = legacy.run(
          fx.reservations.map((r) => ({ ...r, hotel_id: r.hotel_id === H1 ? "h1" : "other" })),
          closed,
          fx.challenges,
          fx.localDate,
          fx.capacity,
          fx.exclude,
          targets,
          [1, 7, 30],
        );
        expect(ctx).not.toBeNull();
        expect(ctx!.dailyDemand).toEqual(old!.daily);
        expect(ctx!.seasonModel).toEqual(old!.seasonModel);
        for (const t of targets) {
          for (const w of [1, 7, 30]) {
            expect(observeForStayDate(ctx!, t, w)).toEqual(old!.observations.get(`${t}|${w}`));
          }
        }
      }, 120_000);
    },
  );

  it("snapshot_cells_at returns what findSnapshotAt reads cell by cell, over a grid with gaps", async () => {
    const r = rng(77);
    const types = ["t1", "t2", "t3"].map(uuidFor);
    const other = uuidFor("h-other");
    const rows: FakeRow[] = [];
    const base = Date.parse("2026-06-01T00:00:00Z");
    for (let run = 0; run < 40; run++) {
      const ts = new Date(base + run * 3 * 3600_000 + Math.floor(r() * 600) * 1000).toISOString();
      for (let d = 0; d < 20; d++) {
        for (const t of types) {
          if (r() < 0.3) continue; // gaps: not every run wrote every cell
          rows.push({
            hotel_id: r() < 0.05 ? other : H1,
            snapshot_ts: ts,
            stay_date: addDays("2026-06-10", d),
            room_type_id: t,
            sellable_units: 10,
            booked_units: Math.floor(r() * 10),
            booked_revenue: Math.round(r() * 200000) / 100,
          });
        }
      }
    }
    await db.exec("truncate public.stay_date_snapshot;");
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      await db.query(
        `insert into public.stay_date_snapshot select * from json_populate_recordset(null::public.stay_date_snapshot, $1::json)`,
        [JSON.stringify(chunk)],
      );
    }
    const { client } = fakeSupabase({ stay_date_snapshot: rows });
    const rpc = pgliteRpc(db);
    for (const probe of [base - 1, base + 5 * 3600_000, base + 50 * 3600_000 + 1234, base + 200 * 3600_000]) {
      const ts = new Date(probe).toISOString();
      const args = { p_hotel_id: H1, p_ts: ts, p_from: "2026-06-12", p_to: "2026-06-25", p_room_types: types.slice(0, 2) };
      const { data, error } = await rpc("snapshot_cells_at", args).order("stay_date").order("room_type_id");
      expect(error).toBeNull();
      const got = new Map(
        (data as Record<string, unknown>[]).map((x) => [
          `${x.stay_date}|${x.room_type_id}`,
          { booked_units: Number(x.booked_units), booked_revenue: Number(x.booked_revenue), snapshot_ts: Date.parse(String(x.snapshot_ts)) },
        ]),
      );
      let cells = 0;
      for (let d = "2026-06-12"; d <= "2026-06-25"; d = addDays(d, 1)) {
        for (const t of types.slice(0, 2)) {
          const one = (await findSnapshotAt(client, H1, d, [t], ts)).get(t);
          const want = one
            ? { booked_units: one.booked_units, booked_revenue: one.booked_revenue, snapshot_ts: Date.parse(one.snapshot_ts) }
            : undefined;
          expect(got.get(`${d}|${t}`)).toEqual(want);
          cells++;
        }
      }
      expect(cells).toBe(28);
    }
  }, 120_000);

  it("audit_last_signatures gives the signatures the paged JS loader builds, ties included", async () => {
    const r = rng(31);
    const rows: FakeRow[] = [];
    const types = ["x1", "x2"].map(uuidFor);
    let id = 0;
    for (let run = 0; run < 30; run++) {
      const at = new Date(Date.parse("2026-08-01T00:00:00Z") + run * 300_000).toISOString();
      for (let d = 0; d < 45; d++) {
        for (const t of types) {
          if (r() < 0.5) continue;
          const copies = r() < 0.15 ? 2 : 1;
          for (let c = 0; c < copies; c++) {
            const manual = r() < 0.15;
            rows.push({
              id: `e0000000-0000-4000-8000-${(0xfffffff - ++id * 7919).toString(16).padStart(12, "0")}`,
              hotel_id: r() < 0.05 ? uuidFor("other") : H1,
              stay_date: addDays("2026-08-01", d),
              room_type_id: t,
              evaluated_at: at,
              final_price: Math.round((90 + r() * 40) * 100) / 100,
              details: {
                application_order: r() < 0.3 ? [] : [`ladder:${uuidFor("r" + Math.floor(r() * 3))}`],
                ...(r() < 0.9 ? { clamped_by: r() < 0.2 ? "floor" : "none" } : {}),
                base_source: manual ? "manual" : "reservation",
                ...(manual ? { manual_override: { set_by: null, set_at: "2026-07-31T10:00:00.000Z" } } : {}),
              },
            });
          }
        }
      }
    }
    await db.exec("truncate public.evaluation_audit;");
    for (let i = 0; i < rows.length; i += 1000) {
      await db.query(
        `insert into public.evaluation_audit (id, hotel_id, stay_date, room_type_id, evaluated_at, final_price, details)
         select id, hotel_id, stay_date, room_type_id, evaluated_at, final_price, details
         from json_populate_recordset(null::public.evaluation_audit, $1::json)`,
        [JSON.stringify(rows.slice(i, i + 1000))],
      );
    }
    const { client: viaSql } = fakeSupabase({});
    (viaSql as unknown as { rpc: unknown }).rpc = pgliteRpc(db);
    const { client: viaJs } = fakeSupabase(
      { evaluation_audit: rows },
      { maxRows: 1000, rpc: (fn) => new FakeRpcError(missingFunction(fn)) },
    );
    const fromSql = await loadLastAuditSignatures(viaSql as SupabaseClient, H1, "2026-08-01", "2026-09-30");
    const fromJs = await loadLastAuditSignatures(viaJs, H1, "2026-08-01", "2026-09-30");
    expect(fromSql.size).toBeGreaterThan(50);
    expect(fromSql).toEqual(fromJs);
  }, 120_000);

  it("room_type_max_rates equals each type's maximum over the same rows", async () => {
    const fx = asUuids(makeFixture(41, 60));
    const r = rng(41);
    const rows = fx.reservations.map((x) => ({ ...x, current_rate: r() < 0.1 ? null : Math.round(r() * 50000) / 100 }));
    await insertReservations(db, rows);
    const { data, error } = await pgliteRpc(db)("room_type_max_rates", { p_hotel_id: H1 }).order("room_type_id");
    expect(error).toBeNull();
    const norm = (list: Record<string, unknown>[]) =>
      list.map((x) => `${x.room_type_id}|${Number(x.max_rate).toFixed(2)}`).sort();
    expect(norm(data as Record<string, unknown>[])).toEqual(norm(roomTypeMaxRates(rows, { p_hotel_id: H1 })));
    expect((data as unknown[]).length).toBeGreaterThan(1);
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

  it("is safe to run twice", async () => {
    await db.exec(readFileSync(MIGRATION, "utf8"));
  });
});
