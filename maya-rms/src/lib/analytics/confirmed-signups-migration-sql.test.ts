/**
 * 99_supabase_migration_confirmed_signups_v1.sql run for real in PGlite, twice,
 * over the product events log and profile trigger exactly as
 * 99_supabase_migration_product_events_v1.sql made them (read straight from
 * that file). account.created is recorded once per user, when the address is
 * confirmed: nothing for an unconfirmed sign-up, one row on confirming, none
 * on any later update, and one row at insert for a user created confirmed
 * (confirmation off, or made by an admin). A + address is a test account. A
 * broken log never stops anyone signing up or confirming. Only runs with
 * MAYA_PGLITE_DIR set (see src/lib/engine/large-property-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const FILE = "99_supabase_migration_confirmed_signups_v1.sql";
const MIGRATION = readFileSync(resolve(ROOT, FILE), "utf8");
const EVENTS = readFileSync(resolve(ROOT, "99_supabase_migration_product_events_v1.sql"), "utf8");

/** The order production ran the migrations in, read off the cadence test's list. */
const MIGRATION_ORDER: string[] = (() => {
  const src = readFileSync(resolve(__dirname, "../engine/pricing-cadence-sql.test.ts"), "utf8");
  const list = src.slice(src.indexOf("MIGRATION_ORDER = ["), src.indexOf("];", src.indexOf("MIGRATION_ORDER = [")));
  return [...list.matchAll(/"(99_supabase_migration_[^"]+\.sql)"/g)].map((m) => m[1]);
})();

/** The part of the events migration between two of its own headings. */
function slice(from: string, to: string): string {
  const start = EVENTS.indexOf(from);
  const end = EVENTS.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`product_events_v1 no longer has "${from}" … "${to}"`);
  return EVENTS.slice(start, end);
}

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

/**
 * Supabase's roles and auth.users, the tables the log's hotel lookup reads,
 * and profiles with the auth.users insert trigger 02_supabase_schema.sql uses
 * to make one for every new user.
 */
const BASE = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  create schema auth;
  create table auth.users (
    id uuid primary key, email text, email_confirmed_at timestamptz,
    raw_user_meta_data jsonb, created_at timestamptz default now()
  );
  create function public.is_platform_admin() returns boolean language sql stable as $$ select false $$;
  create table public.hotels (
    id uuid primary key, name text, external_enterprise_id text, is_test boolean not null default false
  );
  create table public.pms_connections (hotel_id uuid, pms_type text, updated_at timestamptz default now());
  create table public.hotel_memberships (
    hotel_id uuid, user_id uuid, role text, status text, created_at timestamptz default now()
  );
  create table public.profiles (
    id uuid primary key references auth.users (id),
    created_at timestamptz not null default now(),
    onboarding_path text
  );
  create function public.accept_pending_memberships_for_user() returns trigger language plpgsql as $$
  begin
    insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
    return new;
  end $$;
  create trigger trg_accept_pending_memberships after insert on auth.users
    for each row execute function public.accept_pending_memberships_for_user();
`;

describe("the migration file", () => {
  it("is on the list the SQL tests build production's schema from, after the events log", () => {
    expect(MIGRATION_ORDER).toContain(FILE);
    expect(MIGRATION_ORDER.indexOf(FILE)).toBeGreaterThan(
      MIGRATION_ORDER.indexOf("99_supabase_migration_product_events_v1.sql"),
    );
  });

  it("is one transaction", () => {
    const sql = MIGRATION.replace(/--.*$/gm, "");
    expect(sql.match(/\bbegin;/g)).toHaveLength(1);
    expect(sql.match(/\bcommit;/g)).toHaveLength(1);
  });
});

const user = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe.skipIf(!PGLITE_DIR)("confirmed signups migration in PGlite", () => {
  let db: Db;

  async function accountRows(id: string) {
    const { rows } = await db.query(
      `select occurred_at, is_test, dedupe_key, source from public.product_events
        where event = 'account.created' and user_id = $1 order by id`,
      [id],
    );
    return rows;
  }

  async function signUp(id: string, email: string, confirmedAt: string | null = null) {
    await db.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, $3)`, [id, email, confirmedAt]);
  }

  async function confirm(id: string, at: string | null) {
    await db.query(`update auth.users set email_confirmed_at = $2 where id = $1`, [id, at]);
  }

  beforeAll(async () => {
    const mod = await import(
      /* @vite-ignore */ pathToFileURL(`${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist/index.js`).href
    );
    db = new mod.PGlite() as Db;
    await db.exec(BASE);
    // The log, product_event_emit, and the profile trigger as they are today.
    await db.exec(slice("-- ── 1. The table", "-- ── 2."));
    await db.exec(slice("-- ── 3. Emitting", "-- ── 4. Triggers"));
    await db.exec(slice("-- Accounts and the onboarding path", "-- Properties: created, activated"));

    await db.exec(MIGRATION);
    await db.exec(MIGRATION);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("records nothing for a sign-up that is not confirmed yet", async () => {
    await signUp(user(1), "sam@harbour.example");
    expect((await db.query(`select 1 from public.profiles where id = $1`, [user(1)])).rows).toHaveLength(1);
    expect(await accountRows(user(1))).toEqual([]);
  });

  it("records it once, dated the confirmation, when the address is confirmed", async () => {
    await confirm(user(1), "2026-10-01T10:00:00Z");
    const rows = await accountRows(user(1));
    expect(rows).toHaveLength(1);
    expect((rows[0].occurred_at as Date).toISOString()).toBe("2026-10-01T10:00:00.000Z");
    expect(rows[0]).toMatchObject({ is_test: false, dedupe_key: `account.created:${user(1)}`, source: "trigger" });
  });

  it("never records it again, however the confirmation is updated later", async () => {
    await confirm(user(1), "2026-10-02T10:00:00Z");
    await confirm(user(1), null);
    await confirm(user(1), "2026-10-03T10:00:00Z");
    await db.query(`update auth.users set email = 'sam@harbour.test' where id = $1`, [user(1)]);
    const rows = await accountRows(user(1));
    expect(rows).toHaveLength(1);
    expect((rows[0].occurred_at as Date).toISOString()).toBe("2026-10-01T10:00:00.000Z");
  });

  it("records a user created already confirmed once, at insert, and never on update", async () => {
    await signUp(user(2), "admin-made@harbour.example", "2026-10-01T09:00:00Z");
    const [profile] = (await db.query(`select created_at from public.profiles where id = $1`, [user(2)])).rows;
    let rows = await accountRows(user(2));
    expect(rows).toHaveLength(1);
    expect(rows[0].occurred_at).toEqual(profile.created_at);

    await confirm(user(2), null);
    await confirm(user(2), "2026-10-02T09:00:00Z");
    rows = await accountRows(user(2));
    expect(rows).toHaveLength(1);
    expect(rows[0].occurred_at).toEqual(profile.created_at);
  });

  it("records one with confirmation off, where Supabase inserts and confirms in one go", async () => {
    await db.exec(`
      begin;
      insert into auth.users (id, email) values ('${user(3)}', 'pat@harbour.example');
      update auth.users set email_confirmed_at = now() where id = '${user(3)}';
      commit;
    `);
    expect(await accountRows(user(3))).toHaveLength(1);
  });

  it("marks a + address as a test account on either path", async () => {
    await signUp(user(4), "sam+test@harbour.example");
    await confirm(user(4), "2026-10-01T11:00:00Z");
    await signUp(user(5), "pat+demo@harbour.example", "2026-10-01T11:00:00Z");
    expect((await accountRows(user(4))).map((r) => r.is_test)).toEqual([true]);
    expect((await accountRows(user(5))).map((r) => r.is_test)).toEqual([true]);
  });

  it("does not count again an account counted before this file (an invitation not yet accepted)", async () => {
    await signUp(user(6), "invited@harbour.example");
    // What the old trigger wrote when the invitation made the user: no key.
    await db.query(
      `insert into public.product_events (occurred_at, event, user_id, source, is_test)
       values ('2026-09-01T00:00:00Z', 'account.created', $1, 'trigger', false)`,
      [user(6)],
    );
    await confirm(user(6), "2026-10-01T12:00:00Z");
    expect(await accountRows(user(6))).toHaveLength(1);
  });

  it("still records the onboarding path as before", async () => {
    await db.query(`update public.profiles set onboarding_path = 'marketplace' where id = $1`, [user(1)]);
    const { rows } = await db.query(
      `select properties, is_test from public.product_events
        where event = 'onboarding.path_chosen' and user_id = $1`,
      [user(1)],
    );
    expect(rows).toEqual([{ properties: { path: "marketplace" }, is_test: false }]);
  });

  it("never stops anyone signing up or confirming when the log is broken", async () => {
    await db.exec(`
      begin;
      create or replace function public.product_event_emit(
        p_event text, p_hotel_id uuid default null, p_user_id uuid default null,
        p_properties jsonb default '{}'::jsonb, p_source text default 'trigger',
        p_occurred_at timestamptz default null, p_dedupe_key text default null,
        p_pms_type text default null, p_pms_property_id text default null,
        p_property_name text default null, p_is_test boolean default null
      ) returns bigint language plpgsql as $$ begin raise exception 'analytics is down'; end $$;
    `);
    try {
      await signUp(user(7), "kim@harbour.example");
      await confirm(user(7), "2026-10-01T13:00:00Z");
      await signUp(user(8), "lee@harbour.example", "2026-10-01T13:00:00Z");
      const { rows } = await db.query(
        `select count(*)::int as n from auth.users where id in ($1, $2) and email_confirmed_at is not null`,
        [user(7), user(8)],
      );
      expect(rows[0].n).toBe(2);
    } finally {
      await db.exec("rollback;");
    }
  });

  it("adds nothing on another run: no backfill", async () => {
    const before = (await db.query(`select count(*)::int as n from public.product_events`)).rows[0].n;
    await db.exec(MIGRATION);
    const after = (await db.query(`select count(*)::int as n from public.product_events`)).rows[0].n;
    expect(after).toBe(before);
    const { rows } = await db.query(
      `select count(*)::int as n from pg_trigger
        where tgrelid = 'auth.users'::regclass and tgname = 'trg_product_events_email_confirmed'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it("runs both trigger functions with the owner's rights, and lets nobody call them", async () => {
    for (const fn of ["public.product_events_profiles()", "public.product_events_email_confirmed()"]) {
      const { rows } = await db.query(
        `select p.prosecdef as definer, p.proconfig as config,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as authenticated
           from pg_proc p where p.oid = $1::regprocedure`,
        [fn],
      );
      expect(rows[0]).toEqual({
        definer: true,
        config: ["search_path=public, pg_temp"],
        anon: false,
        authenticated: false,
      });
    }
  });

  it("says which file to run first when the events log is missing", async () => {
    const mod = await import(
      /* @vite-ignore */ pathToFileURL(`${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist/index.js`).href
    );
    const empty = new mod.PGlite() as Db;
    await empty.exec("create role anon; create role authenticated; create role service_role;");
    await expect(empty.exec(MIGRATION)).rejects.toThrow(/product_events_v1/);
    await empty.close();
  });
});
