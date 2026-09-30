/**
 * 99_supabase_migration_no_rate_on_record_v1.sql run for real in PGlite,
 * twice, on top of every migration before it: the column, the trigger that
 * marks nights when the last night the PMS returned moves, and what
 * platform_pilot_health() v4 counts as a room-night with no rate on record.
 * Only runs with MAYA_PGLITE_DIR set (see pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_no_rate_on_record_v1.sql";

/** The order production ran the migrations in, read off the cadence test's MIGRATION_ORDER. */
const MIGRATION_ORDER: string[] = (() => {
  const src = readFileSync(resolve(__dirname, "../engine/pricing-cadence-sql.test.ts"), "utf8");
  const list = src.slice(src.indexOf("MIGRATION_ORDER = ["), src.indexOf("];", src.indexOf("MIGRATION_ORDER = [")));
  return [...list.matchAll(/"(99_supabase_migration_[^"]+\.sql)"/g)].map((m) => m[1]);
})();

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

const PLATFORM = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role supabase_admin nologin;
grant usage on schema public to anon, authenticated, service_role;
create schema auth;
create table auth.users (
  id uuid primary key, email text, raw_user_meta_data jsonb, raw_app_meta_data jsonb,
  created_at timestamptz default now(), last_sign_in_at timestamptz, email_confirmed_at timestamptz,
  confirmed_at timestamptz, phone text, updated_at timestamptz, banned_until timestamptz, deleted_at timestamptz
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
create schema vault;
`;

function fileSql(name: string): string {
  let sql = readFileSync(resolve(ROOT, name), "utf8");
  sql = sql.replace(/create extension if not exists supabase_vault[^;]*;/gi, "");
  if (name === "99_supabase_migration_rate_push_v1.sql") sql = `drop table if exists public.rate_updates cascade;\n${sql}`;
  return sql;
}

const H = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const CLOUDBEDS = H(1);
const MEWS = H(2);
const UNREAD = H(3);
const RT = (hotel: number, n: number) => `10000000-0000-4000-8000-0000000000${hotel}${n}`;
const KING = RT(1, 1);
const BAY = RT(1, 2);
const OFF = RT(1, 3);

const today = new Date().toISOString().slice(0, 10);
const night = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe("the migration file", () => {
  it("is on the list the SQL tests build production's schema from, after the files it builds on", () => {
    expect(MIGRATION_ORDER).toContain(MIGRATION);
    for (const before of ["99_supabase_migration_pricing_cadence_v1.sql", "99_supabase_migration_non_room_types_v1.sql"]) {
      expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBeGreaterThan(MIGRATION_ORDER.indexOf(before));
    }
  });

  it("is one transaction, and changes no policy", () => {
    const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8").replace(/--.*$/gm, "");
    expect(sql.match(/\bbegin;/g)).toHaveLength(1);
    expect(sql.match(/\bcommit;/g)).toHaveLength(1);
    expect(sql).not.toMatch(/create table|create policy|drop policy/i);
  });
});

describe.skipIf(!PGLITE_DIR)("no rate on record in PGlite", () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const asService = async <T>(fn: () => Promise<T>): Promise<T> => {
    await db.exec(`select set_config('request.jwt.claim.role', 'service_role', false)`);
    try {
      return await fn();
    } finally {
      await db.exec(`select set_config('request.jwt.claim.role', '', false)`);
    }
  };
  const health = async () =>
    asService(() =>
      q(
        `select name, pms_type::text as pms_type, no_rate_count, rates_read_through::text as rates_read_through, unsent_count
           from public.platform_pilot_health($1)`,
        [false],
      ),
    );
  const rowFor = async (name: string) => (await health()).find((r) => r.name === name);
  const marked = async (hotel: string) =>
    (await q(`select stay_date::text as d from public.pricing_dirty_nights where hotel_id = $1 order by stay_date`, [hotel])).map(
      (r) => r.d,
    );
  const setReturned = (hotel: string, value: string | null) =>
    db.query(`update public.pms_connections set base_rates_returned_through = $2 where hotel_id = $1`, [hotel, value]);

  beforeAll(async () => {
    const dist = `${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist`;
    const mod = await import(/* @vite-ignore */ pathToFileURL(`${dist}/index.js`).href);
    const { pgcrypto } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/pgcrypto.js`).href);
    const { citext } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/citext.js`).href);
    db = new mod.PGlite({ extensions: { pgcrypto, citext } }) as Db;
    await db.exec(PLATFORM);
    for (const name of [
      "01_supabase_base_schema.sql",
      "02_supabase_schema.sql",
      ...MIGRATION_ORDER.slice(0, MIGRATION_ORDER.indexOf(MIGRATION)),
      // The cadence test's own file, which its list leaves out: the marking queue is made there.
      "99_supabase_migration_pricing_cadence_v1.sql",
    ]) {
      try {
        await db.exec(fileSql(name));
      } catch (e) {
        throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // The file under test, twice: it is safe to run again.
    await db.exec(fileSql(MIGRATION));
    await db.exec(fileSql(MIGRATION));

    await db.exec(`
      select set_config('request.jwt.claim.role', 'service_role', false);
      insert into public.hotels (id, name, timezone) values
        ('${CLOUDBEDS}', 'Cloudbeds Inn', 'UTC'),
        ('${MEWS}', 'Mews Inn', 'UTC'),
        ('${UNREAD}', 'Unread Inn', 'UTC');
      insert into public.hotel_settings (hotel_id, simulation_mode) values
        ('${CLOUDBEDS}', false), ('${MEWS}', false), ('${UNREAD}', true)
        on conflict (hotel_id) do update set simulation_mode = excluded.simulation_mode;
      -- Live for a week: a price published in simulation only starts waiting at go-live.
      update public.hotel_settings set live_since = now() - interval '7 days' where simulation_mode = false;
      insert into public.pms_connections (hotel_id, pms_type, status, last_sync_at) values
        ('${CLOUDBEDS}', 'cloudbeds', 'connected', now() - interval '3 minutes'),
        ('${MEWS}', 'mews', 'connected', now() - interval '3 minutes'),
        ('${UNREAD}', 'cloudbeds', 'connected', now() - interval '3 minutes');
      insert into public.room_types (id, hotel_id, external_room_type_id, name, total_rooms, is_active, counts_as_room) values
        ('${KING}', '${CLOUDBEDS}', 'K', 'King', 8, true, true),
        ('${BAY}', '${CLOUDBEDS}', 'P', 'Parking bay', 4, true, false),
        ('${OFF}', '${CLOUDBEDS}', 'OLD', 'Closed wing', 4, false, true),
        ('${RT(2, 1)}', '${MEWS}', 'K', 'King', 8, true, true),
        ('${RT(3, 1)}', '${UNREAD}', 'K', 'King', 8, true, true);
      -- A 20-night pass window for the Cloudbeds hotel: nights 1..18 are counted.
      insert into public.hotel_pricing_state (hotel_id, pass_horizon_days) values ('${CLOUDBEDS}', 20), ('${UNREAD}', 20)
        on conflict (hotel_id) do update set pass_horizon_days = excluded.pass_horizon_days;
      select set_config('request.jwt.claim.role', '', false);
    `);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it("adds the column, null until a read records it, and the pilot health row shows it as null", async () => {
    const cols = await q(
      `select data_type from information_schema.columns where table_name = 'pms_connections' and column_name = 'base_rates_returned_through'`,
    );
    expect(cols).toEqual([{ data_type: "date" }]);
    expect((await rowFor("Cloudbeds Inn"))?.rates_read_through).toBeNull();
  });

  it("counts the room-nights ahead with no rate on record, and leaves out typed prices, non-rooms and switched-off types", async () => {
    // King has rates for nights 1..10 of the 18 counted; night 15 has a typed price.
    await db.exec(`
      insert into public.base_rate_calendar (hotel_id, stay_date, room_type_id, price, source)
      select '${CLOUDBEDS}', d::date, '${KING}', 200, 'pms'
        from generate_series('${night(1)}'::timestamp, '${night(10)}'::timestamp, interval '1 day') g(d);
      insert into public.manual_price (hotel_id, stay_date, room_type_id, price)
      values ('${CLOUDBEDS}', '${night(15)}', '${KING}', 180);
    `);
    // 18 counted nights, 10 with a rate, 1 typed: 7 without.
    expect((await rowFor("Cloudbeds Inn"))?.no_rate_count).toBe(7);
    // Nothing is said about a Mews hotel, and a hotel with no rates at all counts every night.
    expect((await rowFor("Mews Inn"))?.no_rate_count).toBe(0);
    expect((await rowFor("Unread Inn"))?.no_rate_count).toBe(18);
  });

  it("counts a night past the last night the PMS returned, whatever an earlier read stored for it", async () => {
    await setReturned(CLOUDBEDS, night(6));
    const row = await rowFor("Cloudbeds Inn");
    expect(row?.rates_read_through).toBe(night(6));
    // Nights 7..10 have rows but are past what the PMS returned: 7 + 4.
    expect(row?.no_rate_count).toBe(11);
    await setReturned(CLOUDBEDS, night(18));
    expect((await rowFor("Cloudbeds Inn"))?.no_rate_count).toBe(7);
  });

  it("marks the nights whose standing changed when the last returned night moves", async () => {
    await db.exec(`delete from public.pricing_dirty_nights`);
    // 18 to 12: nights 13..18 lost their rate on record.
    await setReturned(CLOUDBEDS, night(12));
    expect(await marked(CLOUDBEDS)).toEqual([13, 14, 15, 16, 17, 18].map(night));
    await db.exec(`delete from public.pricing_dirty_nights`);
    // 12 to 14: nights 13 and 14 gained one.
    await setReturned(CLOUDBEDS, night(14));
    expect(await marked(CLOUDBEDS)).toEqual([13, 14].map(night));
    await db.exec(`delete from public.pricing_dirty_nights`);
    // The same value again marks nothing.
    await setReturned(CLOUDBEDS, night(14));
    expect(await marked(CLOUDBEDS)).toEqual([]);
    // First recorded (from null): the 400 nights after it, clipped by pricing_mark_range.
    await setReturned(UNREAD, night(3));
    const unread = await marked(UNREAD);
    expect(unread[0]).toBe(night(4));
    expect(unread).toHaveLength(400);
    expect(await marked(MEWS)).toEqual([]);
  });

  it("leaves a night held as no rate on record out of the prices waiting to be sent", async () => {
    await setReturned(CLOUDBEDS, night(18));
    await db.exec(`
      insert into public.published_price (hotel_id, stay_date, room_type_id, price, base_price, computed_at) values
        ('${CLOUDBEDS}', '${night(3)}', '${KING}', 210, 200, now() - interval '5 hours'),
        ('${CLOUDBEDS}', '${night(12)}', '${KING}', 210, 200, now() - interval '5 hours');
      insert into public.rate_updates (hotel_id, pms_type, room_type_id, stay_date, price, status, attempts, error, pushed_at) values
        ('${CLOUDBEDS}', 'cloudbeds', '${KING}', '${night(12)}', 210, 'skipped', 0, 'guardrail:no_rate_on_record', now() - interval '3 hours');
    `);
    // Night 3 is waiting; night 12 is held on purpose.
    expect((await rowFor("Cloudbeds Inn"))?.unsent_count).toBe(1);
  });

  it("keeps the function closed to anon and open to platform admins and the service role", async () => {
    const rows = await q(
      `select has_function_privilege('anon', 'public.platform_pilot_health(boolean)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.platform_pilot_health(boolean)', 'execute') as authenticated,
              has_function_privilege('service_role', 'public.platform_pilot_health(boolean)', 'execute') as service_role`,
    );
    expect(rows).toEqual([{ anon: false, authenticated: true, service_role: true }]);
    await expect(q(`select count(*) from public.platform_pilot_health(false)`)).rejects.toThrow(/Not authorized/);
  });
});
