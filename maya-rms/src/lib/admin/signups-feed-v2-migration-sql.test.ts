/**
 * 99_supabase_migration_signups_feed_v2.sql run for real in PGlite, twice, on
 * top of every migration before it (v1 included), under Supabase's default
 * privileges:
 *
 *   1. A subscription that ends gets its "cancelled" line unless the line for
 *      its scheduled cancellation was actually posted (one scheduled while
 *      the feed had no webhook still gets a line when it ends).
 *   2. The test line names nobody.
 *
 * pg_net and Vault are stand-ins (a table each), as in the v1 test. Only runs
 * with MAYA_PGLITE_DIR set (see pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_signups_feed_v2.sql";
const V1 = "99_supabase_migration_signups_feed_v1.sql";
const CADENCE_FILE = "99_supabase_migration_pricing_cadence_v1.sql";

const CADENCE_TEST = readFileSync(resolve(__dirname, "../engine/pricing-cadence-sql.test.ts"), "utf8");

/** The order production ran the migrations in, read off the cadence test's list. */
const MIGRATION_ORDER: string[] = (() => {
  const list = CADENCE_TEST.slice(CADENCE_TEST.indexOf("MIGRATION_ORDER = ["), CADENCE_TEST.indexOf("];", CADENCE_TEST.indexOf("MIGRATION_ORDER = [")));
  return [...list.matchAll(/"(99_supabase_migration_[^"]+\.sql)"/g)].map((m) => m[1]);
})();

/** Every file before this one, with the cadence file where production ran it. */
const BEFORE: string[] = (() => {
  const before = MIGRATION_ORDER.slice(0, MIGRATION_ORDER.indexOf(MIGRATION));
  const m = CADENCE_TEST.match(/CADENCE_RUNS_BEFORE = "([^"]+)"/);
  const at = m ? before.indexOf(m[1]) : -1;
  return at < 0 ? [...before, CADENCE_FILE] : [...before.slice(0, at), CADENCE_FILE, ...before.slice(at)];
})();

/** What Supabase provides and the files assume. */
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
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
create schema vault;
`;

/** Stand-ins for pg_net and Vault. */
const STAND_INS = `
create schema if not exists net;
create table net.zz_calls (
  id bigserial primary key, url text, body jsonb, headers jsonb, timeout_milliseconds integer,
  called_at timestamptz not null default now()
);
create or replace function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint language plpgsql as $$
declare v_id bigint;
begin
  insert into net.zz_calls (url, body, headers, timeout_milliseconds)
  values (url, body, headers, timeout_milliseconds) returning id into v_id;
  return v_id;
end $$;
grant usage on schema net to service_role;
create table vault.decrypted_secrets (name text, decrypted_secret text, created_at timestamptz default now());
`;

/** Supabase's default privileges for what the postgres role creates in public. */
const SUPABASE_DEFAULT_PRIVILEGES = `
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
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

const strip = (s: string) => s.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();

/** A function as a file writes it: its create through to its comment. */
function functionOf(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  const end = sql.indexOf(`comment on function public.${name}`, start);
  return strip(sql.slice(start, end));
}

const WEBHOOK = "https://hooks.slack.example.test/services/T0/B0/signups";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIFF = "11111111-1111-4111-8111-111111111112";
const DUNE = "11111111-1111-4111-8111-111111111113";
const KELP = "11111111-1111-4111-8111-111111111114";

describe("the v2 migration file", () => {
  const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8");
  const code = sql.replace(/--.*$/gm, "");
  const v1 = readFileSync(resolve(ROOT, V1), "utf8");

  it("is last on the list the SQL tests build production's schema from, right after v1", () => {
    expect(MIGRATION_ORDER[MIGRATION_ORDER.length - 1]).toBe(MIGRATION);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBe(MIGRATION_ORDER.indexOf(V1) + 1);
  });

  it("is one transaction, never grants anon anything, and revokes execute from public and anon on its owner's-rights function", () => {
    expect(code.match(/\bbegin;/g)).toHaveLength(1);
    expect(code.match(/\bcommit;/g)).toHaveLength(1);
    expect(code).not.toMatch(/\bgrant\b[^;]*\banon\b/i);
    expect(code).toMatch(/revoke all on function public\.signup_feed_test\(\) from public, anon;/);
    expect(code).toMatch(/revoke all on function public\.signup_feed_line\(public\.product_events\) from public, anon, authenticated;/);
    expect(sql).not.toContain("—");
  });

  it("restates signup_feed_line from v1 with only the posted check added", () => {
    const before = functionOf(v1, "signup_feed_line");
    const after = functionOf(sql, "signup_feed_line");
    const added = strip("join public.signup_feed_posts p on p.event_id = s.id");
    expect(after).toContain(added);
    expect(after.replace(` ${added}`, "")).toBe(before);
  });

  it("restates signup_feed_test from v1 with only the sender's email taken out", () => {
    const before = functionOf(v1, "signup_feed_test");
    const after = functionOf(sql, "signup_feed_test");
    expect(before).toContain("sent by");
    expect(after).not.toMatch(/sent by|auth\.users|email/);
    expect(after).toContain("'Test line from the Command Center. Real signups post here.'");
    // Its access check, exactly as it was.
    const check = strip(`if v_role is not null
     and v_role <> 'service_role'
     and not public.is_platform_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;`);
    expect(before).toContain(check);
    expect(after).toContain(check);
  });
});

describe.skipIf(!PGLITE_DIR)("the signups feed v2 migration in PGlite", () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

  const as = async <T>(userId: string, fn: () => Promise<T>): Promise<T> => {
    const claims = JSON.stringify({ sub: userId, role: "authenticated", aal: "aal1", amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) }] });
    await db.exec(`
      select set_config('request.jwt.claim.sub', '${userId}', false);
      select set_config('request.jwt.claim.role', 'authenticated', false);
      select set_config('request.jwt.claims', '${claims}', false);
      set role authenticated;`);
    try {
      return await fn();
    } finally {
      await db.exec(`
        reset role;
        select set_config('request.jwt.claim.sub', '', false);
        select set_config('request.jwt.claim.role', '', false);
        select set_config('request.jwt.claims', '', false);`);
    }
  };
  const setWebhook = async (url: string | null) => {
    await db.exec(`delete from vault.decrypted_secrets`);
    if (url != null) await db.query(`insert into vault.decrypted_secrets (name, decrypted_secret) values ('maya_signups_webhook', $1)`, [url]);
  };
  const lines = async () => ((await q(`select body from net.zz_calls order by id`)) as { body: { text: string } }[]).map((c) => c.body.text);
  const sub = (hotel: string, cols: Record<string, unknown>) => {
    const keys = ["hotel_id", ...Object.keys(cols)];
    return db.query(`insert into public.hotel_subscriptions (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, [hotel, ...Object.values(cols)]);
  };
  const updateSub = (hotel: string, set: string) => db.query(`update public.hotel_subscriptions set ${set} where hotel_id = $1`, [hotel]);

  beforeAll(async () => {
    const dist = `${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist`;
    const mod = await import(/* @vite-ignore */ pathToFileURL(`${dist}/index.js`).href);
    const { pgcrypto } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/pgcrypto.js`).href);
    const { citext } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/citext.js`).href);
    db = new mod.PGlite({ extensions: { pgcrypto, citext } }) as Db;
    await db.exec(PLATFORM);
    await db.exec(STAND_INS);
    for (const name of ["01_supabase_base_schema.sql", "02_supabase_schema.sql", ...BEFORE]) {
      try {
        await db.exec(fileSql(name));
      } catch (e) {
        throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated;`);
    await db.exec(`
      insert into auth.users (id, email, email_confirmed_at) values ('${ADMIN}', 'jake@example.com', now());
      insert into public.app_roles (user_id, role) values ('${ADMIN}', 'platform_admin');
      insert into public.hotels (id, name, timezone) values
        ('${CLIFF}', 'Cliff House', 'UTC'), ('${DUNE}', 'Dune Lodge', 'UTC'), ('${KELP}', 'Kelp Cottage', 'UTC');
      insert into public.pms_connections (hotel_id, pms_type, status) values
        ('${CLIFF}', 'think', 'connected'), ('${DUNE}', 'mews', 'connected'), ('${KELP}', 'cloudbeds', 'connected');
    `);
    await db.exec(SUPABASE_DEFAULT_PRIVILEGES);
    // The file under test, twice: it is safe to run again.
    await db.exec(fileSql(MIGRATION));
    await db.exec(fileSql(MIGRATION));
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.exec(`delete from net.zz_calls;`);
    await setWebhook(WEBHOOK);
  });

  it("says a cancellation scheduled while the feed had no webhook when it ends", async () => {
    await setWebhook(null);
    await sub(CLIFF, { stripe_customer_id: "cus_c", stripe_subscription_id: "sub_c", status: "active", billing_interval: "month", billed_rooms: 24 });
    await updateSub(CLIFF, "cancel_at_period_end = true, current_period_end = '2026-10-30T12:00:00Z', cancellation_feedback = 'too_expensive'");
    expect(await lines()).toEqual([]);
    // The webhook goes in; the cancellation ends.
    await setWebhook(WEBHOOK);
    await updateSub(CLIFF, "status = 'canceled'");
    expect(await lines()).toEqual(["Cliff House (ThinkReservations) cancelled. Reason: too expensive."]);
  });

  it("still says a cancellation once when its scheduled line was posted", async () => {
    await sub(DUNE, { stripe_customer_id: "cus_d", stripe_subscription_id: "sub_d", status: "active", billing_interval: "year", billed_rooms: 6 });
    await updateSub(DUNE, "cancel_at_period_end = true, current_period_end = '2026-11-15T12:00:00Z'");
    await updateSub(DUNE, "status = 'canceled'");
    expect(await lines()).toEqual(["Dune Lodge (Mews) started paying: 6 rooms, yearly.", "Dune Lodge (Mews) cancelled. Ends Nov 15, 2026."]);
  });

  it("says a cancellation straight away when none was scheduled", async () => {
    await sub(KELP, { stripe_customer_id: "cus_k", stripe_subscription_id: "sub_k", status: "trialing", billing_interval: "month", billed_rooms: 3 });
    await updateSub(KELP, "status = 'canceled', cancellation_reason = 'payment_failed'");
    expect(await lines()).toEqual(["Kelp Cottage (Cloudbeds) started a trial: 3 rooms, monthly.", "Kelp Cottage (Cloudbeds) cancelled during the trial. Reason: payment failed."]);
  });

  it("posts a test line that names nobody", async () => {
    expect(await as(ADMIN, async () => (await q(`select public.signup_feed_test() as r`))[0].r)).toMatchObject({ sent: true, state: "ready" });
    expect((await q(`select public.signup_feed_test() as r`))[0].r).toMatchObject({ sent: true });
    expect(await lines()).toEqual(["Test line from the Command Center. Real signups post here.", "Test line from the Command Center. Real signups post here."]);
    const grants = await q(`select has_function_privilege('anon', 'public.signup_feed_test()', 'execute') as anon`);
    expect(grants[0].anon).toBe(false);
  });
});
