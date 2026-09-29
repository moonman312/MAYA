/**
 * 99_supabase_migration_onboarding_stats_lockdown_v1.sql run for real in
 * PGlite: the two onboarding stats functions start open to everyone, as the
 * onboarding migration left them, and end open to the service role only. A
 * second run changes nothing. Only runs with MAYA_PGLITE_DIR set.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const MIGRATION = readFileSync(
  resolve(__dirname, "../../../../99_supabase_migration_onboarding_stats_lockdown_v1.sql"),
  "utf8",
);

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

const FUNCTIONS = ["public.onboarding_daily_room_nights(uuid)", "public.onboarding_room_type_stats(uuid)"];

async function access(db: Db) {
  const out: Record<string, boolean[]> = {};
  for (const fn of FUNCTIONS) {
    const { rows } = await db.query(
      `select has_function_privilege('anon', $1, 'execute') as anon,
              has_function_privilege('authenticated', $1, 'execute') as authenticated,
              has_function_privilege('service_role', $1, 'execute') as service_role`,
      [fn],
    );
    out[fn] = [rows[0].anon === true, rows[0].authenticated === true, rows[0].service_role === true];
  }
  return out;
}

describe.skipIf(!PGLITE_DIR)("onboarding stats lockdown migration in PGlite", () => {
  let db: Db;

  beforeAll(async () => {
    const mod = await import(
      /* @vite-ignore */ pathToFileURL(`${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist/index.js`).href
    );
    db = new mod.PGlite() as Db;
    // The roles Supabase has, and the two functions as the onboarding
    // migration made them: owner's rights, open to every caller.
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.reservations (hotel_id uuid, stay_date date);
      create function public.onboarding_daily_room_nights(p_hotel_id uuid)
        returns table (stay_date date, nights bigint) language sql security definer as
        $$ select r.stay_date, count(*)::bigint from public.reservations r where r.hotel_id = p_hotel_id group by 1 $$;
      create function public.onboarding_room_type_stats(p_hotel_id uuid)
        returns table (row_count bigint) language sql security definer as
        $$ select count(*)::bigint from public.reservations r where r.hotel_id = p_hotel_id $$;
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("starts open to everyone and ends open to the service role only, twice over", async () => {
    for (const fn of FUNCTIONS) expect((await access(db))[fn]).toEqual([true, true, true]);

    await db.exec(MIGRATION);
    for (const fn of FUNCTIONS) expect((await access(db))[fn]).toEqual([false, false, true]);

    await db.exec(MIGRATION);
    for (const fn of FUNCTIONS) expect((await access(db))[fn]).toEqual([false, false, true]);
  });

  it("refuses a signed-out caller and still answers the service role", async () => {
    await db.exec("set role anon");
    await expect(
      db.query("select * from public.onboarding_daily_room_nights('00000000-0000-0000-0000-000000000001')"),
    ).rejects.toThrow(/permission denied/);
    await db.exec("reset role; set role service_role");
    const { rows } = await db.query(
      "select * from public.onboarding_room_type_stats('00000000-0000-0000-0000-000000000001')",
    );
    expect(rows).toHaveLength(1);
    await db.exec("reset role");
  });

  it("says which file to run first when a function is missing", async () => {
    const mod = await import(
      /* @vite-ignore */ pathToFileURL(`${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist/index.js`).href
    );
    const empty = new mod.PGlite() as Db;
    await empty.exec("create role anon; create role authenticated; create role service_role;");
    await expect(empty.exec(MIGRATION)).rejects.toThrow(/onboarding_v1/);
    await empty.close();
  });
});
