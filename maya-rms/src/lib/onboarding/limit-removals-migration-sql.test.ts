/**
 * 99_supabase_migration_room_type_limit_removals_v1.sql run for real in
 * PGlite, twice, on top of every migration before it: the two stamps the
 * review's remove writes beside a floor or ceiling (audit A21), written
 * under the owner's own session as the remove does, and no one else's.
 * Only runs with MAYA_PGLITE_DIR set (see engine/pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_room_type_limit_removals_v1.sql";
const CADENCE_FILE = "99_supabase_migration_pricing_cadence_v1.sql";

const CADENCE_TEST = readFileSync(resolve(__dirname, "../engine/pricing-cadence-sql.test.ts"), "utf8");

/** The order production ran the migrations in, read off the cadence test's list. */
const MIGRATION_ORDER: string[] = (() => {
  const start = CADENCE_TEST.indexOf("MIGRATION_ORDER = [");
  const list = CADENCE_TEST.slice(start, CADENCE_TEST.indexOf("];", start));
  return [...list.matchAll(/"(99_supabase_migration_[^"]+\.sql)"/g)].map((m) => m[1]);
})();

/** Every file before this one, with the cadence file where production ran it. */
const BEFORE: string[] = (() => {
  const before = MIGRATION_ORDER.slice(0, MIGRATION_ORDER.indexOf(MIGRATION));
  const m = CADENCE_TEST.match(/CADENCE_RUNS_BEFORE = "([^"]+)"/);
  const at = m ? before.indexOf(m[1]) : -1;
  return at < 0 ? [...before, CADENCE_FILE] : [...before.slice(0, at), CADENCE_FILE, ...before.slice(at)];
})();

/** What Supabase provides and the files assume, read off the cadence test so there is one copy. */
const PLATFORM: string = (() => {
  const start = CADENCE_TEST.indexOf("export const PLATFORM = `") + "export const PLATFORM = `".length;
  return CADENCE_TEST.slice(start, CADENCE_TEST.indexOf("`;", start));
})();

/** Supabase's default privileges: every new function and table open to anon and authenticated until revoked. */
const SUPABASE_DEFAULT_PRIVILEGES = `
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

function fileSql(name: string): string {
  let sql = readFileSync(resolve(ROOT, name), "utf8");
  sql = sql.replace(/create extension if not exists supabase_vault[^;]*;/gi, "");
  if (name === "99_supabase_migration_rate_push_v1.sql") sql = `drop table if exists public.rate_updates cascade;\n${sql}`;
  return sql;
}

const HOTEL = "11111111-1111-4111-8111-111111111301";
const ELSEWHERE = "11111111-1111-4111-8111-111111111302";
const KING = "55555555-5555-4555-8555-555555555301";
const QUEEN = "55555555-5555-4555-8555-555555555302";
const OWNER = "33333333-3333-4333-8333-333333333301";
const FRONT_DESK = "33333333-3333-4333-8333-333333333302";
const STRANGER = "33333333-3333-4333-8333-333333333303";

describe("the migration file", () => {
  const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8");
  const code = sql.replace(/--.*$/gm, "");

  it("is on the list the SQL tests build production's schema from, right after the property changes file", () => {
    expect(MIGRATION_ORDER).toContain(MIGRATION);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBe(MIGRATION_ORDER.indexOf("99_supabase_migration_pms_property_changes_v1.sql") + 1);
  });

  it("is one transaction, keeps row level security on, grants nothing and defines no function", () => {
    expect(code.match(/\bbegin;/g)).toHaveLength(1);
    expect(code.match(/\bcommit;/g)).toHaveLength(1);
    expect(code).not.toMatch(/disable row level security/i);
    expect(code).not.toMatch(/\bgrant\b/i);
    expect(code).not.toMatch(/create (or replace )?function/i);
  });
});

describe.skipIf(!PGLITE_DIR)("the limit removals migration in PGlite", () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

  /** Runs `fn` as this signed-in person (null: anon), then puts the session back. */
  const as = async <T>(userId: string | null, fn: () => Promise<T>): Promise<T> => {
    const role = userId ? "authenticated" : "anon";
    await db.exec(`
      select set_config('request.jwt.claim.sub', '${userId ?? ""}', false);
      select set_config('request.jwt.claim.role', '${role}', false);
      set role ${role};`);
    try {
      return await fn();
    } finally {
      await db.exec(`
        reset role;
        select set_config('request.jwt.claim.sub', '', false);
        select set_config('request.jwt.claim.role', 'service_role', false);`);
    }
  };

  /** The remove, as POST /api/room-types/limits writes it under the person's session. */
  const removeFloor = (id: string) =>
    q(
      `update public.room_types set floor_price = 1, floor_cleared_at = timestamptz '2026-10-01 12:00:00+00'
        where id = $1 returning id`,
      [id],
    );

  beforeAll(async () => {
    const dist = `${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist`;
    const mod = await import(/* @vite-ignore */ pathToFileURL(`${dist}/index.js`).href);
    const { pgcrypto } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/pgcrypto.js`).href);
    const { citext } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/citext.js`).href);
    db = new mod.PGlite({ extensions: { pgcrypto, citext } }) as Db;
    await db.exec(PLATFORM);
    await db.exec(SUPABASE_DEFAULT_PRIVILEGES);
    for (const name of ["01_supabase_base_schema.sql", "02_supabase_schema.sql", ...BEFORE]) {
      try {
        await db.exec(fileSql(name));
      } catch (e) {
        throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await db.exec(`
      select set_config('request.jwt.claim.role', 'service_role', false);
      insert into auth.users (id, email) values
        ('${OWNER}', 'owner@example.com'), ('${FRONT_DESK}', 'desk@example.com'), ('${STRANGER}', 'stranger@example.com');
      insert into public.hotels (id, name, timezone, currency) values
        ('${HOTEL}', 'Juniper Lodge', 'UTC', 'USD'), ('${ELSEWHERE}', 'Harbour Inn', 'UTC', 'USD');
      insert into public.hotel_memberships (hotel_id, user_id, role) values
        ('${HOTEL}', '${OWNER}', 'general_manager'), ('${HOTEL}', '${FRONT_DESK}', 'viewer'),
        ('${ELSEWHERE}', '${STRANGER}', 'general_manager');
      insert into public.room_types (id, hotel_id, external_room_type_id, name, total_rooms, is_active, floor_price, ceiling_price) values
        ('${KING}', '${HOTEL}', 'RT-K', 'Deluxe King', 10, true, 90, 600),
        ('${QUEEN}', '${HOTEL}', 'RT-Q', 'Harbour Queen', 6, true, 80, 500);
    `);
    // The file under test, twice: it is safe to run again.
    await db.exec(fileSql(MIGRATION));
    await db.exec(fileSql(MIGRATION));
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it("adds both stamps, empty on every room type", async () => {
    expect(
      await q(`select column_name, data_type from information_schema.columns
                where table_schema = 'public' and table_name = 'room_types'
                  and column_name in ('floor_cleared_at', 'ceiling_cleared_at') order by column_name`),
    ).toEqual([
      { column_name: "ceiling_cleared_at", data_type: "timestamp with time zone" },
      { column_name: "floor_cleared_at", data_type: "timestamp with time zone" },
    ]);
    expect(await q(`select count(*)::int as n from public.room_types where floor_cleared_at is not null or ceiling_cleared_at is not null`)).toEqual([
      { n: 0 },
    ]);
  });

  it("keeps row security on room_types", async () => {
    expect(await q(`select relrowsecurity from pg_class where oid = 'public.room_types'::regclass`)).toEqual([{ relrowsecurity: true }]);
  });

  it("lets the property's manager stamp a remove, and nobody else", async () => {
    expect(await as(STRANGER, () => removeFloor(KING))).toEqual([]);
    await expect(as(FRONT_DESK, () => removeFloor(KING))).resolves.toEqual([]);
    // Signed out: refused outright, or nothing to see.
    expect(await as(null, () => q(`select floor_cleared_at from public.room_types where id = $1`, [KING])).catch(() => [])).toEqual([]);
    expect(await as(OWNER, () => removeFloor(KING))).toEqual([{ id: KING }]);
    expect(
      await as(OWNER, () =>
        q(`select floor_price::float8 as floor, to_char(floor_cleared_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as at, ceiling_cleared_at from public.room_types where id = $1`, [KING]),
      ),
    ).toEqual([{ floor: 1, at: "2026-10-01 12:00:00", ceiling_cleared_at: null }]);
  });
});
