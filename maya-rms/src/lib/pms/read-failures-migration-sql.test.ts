/**
 * 99_supabase_migration_read_failures_v1.sql run for real in PGlite, twice,
 * on top of every migration before it: a failed run is due again in 10, then
 * 15 minutes, never an hour; a good run resets the count. Only runs with
 * MAYA_PGLITE_DIR set (see pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_read_failures_v1.sql";

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

const H = "00000000-0000-4000-8000-000000000001";

describe("the migration file", () => {
  it("is on the list the SQL tests build production's schema from, after the function it replaces", () => {
    expect(MIGRATION_ORDER).toContain(MIGRATION);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBeGreaterThan(MIGRATION_ORDER.indexOf("99_supabase_migration_sync_claim_enum_cast_v1.sql"));
  });

  it("is one transaction, and changes no table or policy", () => {
    const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8").replace(/--.*$/gm, "");
    expect(sql.match(/\bbegin;/g)).toHaveLength(1);
    expect(sql.match(/\bcommit;/g)).toHaveLength(1);
    expect(sql).not.toMatch(/create table|alter table|create policy|drop policy/i);
  });
});

describe.skipIf(!PGLITE_DIR)("the retry cadence in PGlite", () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const release = (ok: boolean, interval = 300) =>
    db.query(`select public.release_pms_sync($1, 'cloudbeds', $2, $3)`, [H, ok, interval]);
  /** Seconds from now until the connection is due, and the failure count. */
  const state = async () => {
    const [r] = await q(
      `select sync_failures, round(extract(epoch from (sync_due_at - now())))::int as due_in
         from public.pms_connections where hotel_id = $1`,
      [H],
    );
    return { failures: Number(r.sync_failures), dueIn: Number(r.due_in) };
  };

  beforeAll(async () => {
    const dist = `${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist`;
    const mod = await import(/* @vite-ignore */ pathToFileURL(`${dist}/index.js`).href);
    const { pgcrypto } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/pgcrypto.js`).href);
    const { citext } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/citext.js`).href);
    db = new mod.PGlite({ extensions: { pgcrypto, citext } }) as Db;
    await db.exec(PLATFORM);
    for (const name of ["01_supabase_base_schema.sql", "02_supabase_schema.sql", ...MIGRATION_ORDER.slice(0, MIGRATION_ORDER.indexOf(MIGRATION))]) {
      try {
        await db.exec(fileSql(name));
      } catch (e) {
        throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await db.exec(fileSql(MIGRATION));
    await db.exec(fileSql(MIGRATION));
    await db.exec(`
      select set_config('request.jwt.claim.role', 'service_role', false);
      insert into public.hotels (id, name, timezone) values ('${H}', 'Retry Inn', 'UTC');
      insert into public.pms_connections (hotel_id, pms_type, status) values ('${H}', 'cloudbeds', 'connected');
    `);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it("is due again in 10 minutes after the first failed run, then 15, never an hour", async () => {
    await release(false);
    expect(await state()).toEqual({ failures: 1, dueIn: 600 });
    await release(false);
    expect(await state()).toEqual({ failures: 2, dueIn: 900 });
    await release(false);
    expect(await state()).toEqual({ failures: 3, dueIn: 900 });
    for (let i = 0; i < 10; i++) await release(false);
    expect(await state()).toEqual({ failures: 10, dueIn: 900 });
  });

  it("goes back to the interval, with the count at 0, after a good run", async () => {
    await release(true);
    expect(await state()).toEqual({ failures: 0, dueIn: 300 });
  });

  it("never retries a failure sooner than a healthy interval longer than 15 minutes", async () => {
    await release(false, 1200);
    expect(await state()).toEqual({ failures: 1, dueIn: 1200 });
    await release(true, 1200);
    expect(await state()).toEqual({ failures: 0, dueIn: 1200 });
  });

  it("stays service-role only", async () => {
    const rows = await q(
      `select has_function_privilege('anon', 'public.release_pms_sync(uuid, text, boolean, integer)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.release_pms_sync(uuid, text, boolean, integer)', 'execute') as authenticated,
              has_function_privilege('service_role', 'public.release_pms_sync(uuid, text, boolean, integer)', 'execute') as service_role`,
    );
    expect(rows).toEqual([{ anon: false, authenticated: false, service_role: true }]);
  });
});
