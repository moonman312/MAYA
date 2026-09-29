/**
 * A database built from scratch gets the rate_updates the push code writes.
 *
 * 02_supabase_schema.sql used to carry an older rate_updates (old_rate,
 * new_rate, a rate_update_status enum) that nothing reads. Loaded first, it
 * turned 99_supabase_migration_rate_push_v1.sql's `create table if not exists`
 * into a no-op, so a fresh rebuild ended up with the wrong table and the later
 * migrations that alter it failed. The table now comes from the rate push
 * migration alone. The PGlite half only runs with MAYA_PGLITE_DIR set (see
 * large-property-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const read = (name: string) => readFileSync(resolve(ROOT, name), "utf8");
const SCHEMA = read("02_supabase_schema.sql");
const RATE_PUSH = read("99_supabase_migration_rate_push_v1.sql");

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

/** What Supabase provides and 02 assumes: the roles, auth's functions and users table, vault. */
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

describe("the base schema leaves rate_updates to the rate push migration", () => {
  it("02_supabase_schema.sql does not create rate_updates or the old status enum", () => {
    expect(SCHEMA).not.toMatch(/create table[^(]*\brate_updates\b/i);
    expect(SCHEMA).not.toMatch(/\brate_updates\b/);
    expect(SCHEMA).not.toMatch(/\brate_update_status\b/);
  });

  it("the rate push migration still creates it", () => {
    expect(RATE_PUSH).toMatch(/create table if not exists public\.rate_updates \(/);
  });
});

describe.skipIf(!PGLITE_DIR)("a fresh rebuild in PGlite", () => {
  let db: Db;
  const q = async (sql: string) => (await db.query(sql)).rows;

  beforeAll(async () => {
    const dist = `${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist`;
    const mod = await import(/* @vite-ignore */ pathToFileURL(`${dist}/index.js`).href);
    // The extensions 02_supabase_schema.sql creates.
    const { pgcrypto } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/pgcrypto.js`).href);
    const { citext } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/citext.js`).href);
    db = new mod.PGlite({ extensions: { pgcrypto, citext } }) as Db;
    await db.exec(PLATFORM);
    // Supabase's vault extension isn't in PGlite; its functions are never called here.
    await db.exec(SCHEMA.replace(/create extension if not exists supabase_vault[^;]*;/gi, ""));
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it("has no rate_updates and no old enum after 02 alone", async () => {
    expect(await q(`select to_regclass('public.rate_updates')::text as t`)).toEqual([{ t: null }]);
    expect(await q(`select count(*)::int as n from pg_type where typname = 'rate_update_status'`)).toEqual([{ n: 0 }]);
  });

  it("gets the push ledger from the rate push migration, run twice, with RLS on", async () => {
    await db.exec(RATE_PUSH);
    await db.exec(RATE_PUSH);
    const cols = (
      await q(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'rate_updates' order by ordinal_position`,
      )
    ).map((r) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(["pms_type", "external_room_type_id", "price", "status", "attempts", "pushed_at"]));
    expect(cols).not.toContain("old_rate");
    expect(cols).not.toContain("new_rate");
    expect(await q(`select relrowsecurity as rls from pg_class where oid = 'public.rate_updates'::regclass`)).toEqual([
      { rls: true },
    ]);
    expect(await q(`select policyname from pg_policies where tablename = 'rate_updates' order by 1`)).toEqual([
      { policyname: "rate_updates_read" },
    ]);
  });
});
