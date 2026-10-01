/**
 * 99_supabase_migration_signups_feed_v3.sql run for real in PGlite, twice, on
 * top of every migration before it: a property stopped at connect for its
 * currency after paying at checkout gets a #maya-signups line (audit A20
 * follow-up), and nothing else the app writes posts. pg_net and Vault are
 * stand-ins, as in the v1 and v2 tests. Only runs with MAYA_PGLITE_DIR set
 * (see pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_signups_feed_v3.sql";
const V1 = "99_supabase_migration_signups_feed_v1.sql";
const V2 = "99_supabase_migration_signups_feed_v2.sql";
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
const PAID = "11111111-1111-4111-8111-111111111131";
const TEST_PROP = "11111111-1111-4111-8111-111111111132";
const OWNER = "22222222-2222-4222-8222-222222222231";

/** The trigger's WHEN clause, as a file writes it. */
function triggerWhen(sql: string): string {
  const start = sql.indexOf("create trigger trg_signup_feed");
  return strip(sql.slice(start, sql.indexOf("execute function public.signup_feed_post();", start)));
}

describe("the v3 migration file", () => {
  const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8");
  const code = sql.replace(/--.*$/gm, "");
  const v1 = readFileSync(resolve(ROOT, V1), "utf8");
  const v2 = readFileSync(resolve(ROOT, V2), "utf8");

  it("is on the list the SQL tests build production's schema from, right after the limit removals file", () => {
    expect(MIGRATION_ORDER).toContain(MIGRATION);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBe(MIGRATION_ORDER.indexOf("99_supabase_migration_room_type_limit_removals_v1.sql") + 1);
  });

  it("is one transaction, grants nothing new and keeps signup_feed_line closed to everyone but the service role", () => {
    expect(code.match(/\bbegin;/g)).toHaveLength(1);
    expect(code.match(/\bcommit;/g)).toHaveLength(1);
    expect(code).not.toMatch(/\bgrant\b[^;]*\banon\b/i);
    expect(code).toMatch(/revoke all on function public\.signup_feed_line\(public\.product_events\) from public, anon, authenticated;/);
    expect(code).not.toMatch(/security definer/);
    expect(sql).not.toContain("\u2014");
  });

  it("stops before anything else when v2 isn't in", () => {
    const guard = code.indexOf("raise exception 'Run 99_supabase_migration_signups_feed_v2.sql first.'");
    expect(guard).toBeGreaterThan(code.indexOf("begin;"));
    expect(guard).toBeLessThan(code.indexOf("create or replace function"));
  });

  it("restates signup_feed_line from v2 with only the currency refusal added", () => {
    const before = functionOf(v2, "signup_feed_line");
    const after = functionOf(sql, "signup_feed_line");
    const added = strip(`    when 'pms.currency_refused' then
      if coalesce(v_props->>'paid', '') <> 'true' then
        return null;
      end if;
      return v_who || ' was stopped at connect: its system uses '
          || coalesce(public.signup_feed_escape(nullif(v_props->>'currency', '')), 'a currency')
          || ', which MAYA doesn''t price in yet. They have already paid: refund or cancel it in Stripe.';`);
    expect(before.split("else return null; end case;")).toHaveLength(2);
    expect(after).toBe(before.replace("else return null; end case;", `${added} else return null; end case;`));
  });

  it("restates v1's trigger with only the paid refusal let through", () => {
    expect(triggerWhen(v1)).toContain(
      "new.source = 'trigger' and new.event in ('account.created', 'subscription.trialing', 'subscription.active', 'pms.connected', 'property.went_live', 'subscription.cancel_scheduled', 'subscription.canceled')",
    );
    expect(triggerWhen(sql)).toBe(
      strip(`create trigger trg_signup_feed
        after insert on public.product_events
        for each row
        when (
          not new.is_test
          and (
            (new.source = 'trigger'
             and new.event in ('account.created', 'subscription.trialing', 'subscription.active', 'pms.connected',
                               'property.went_live', 'subscription.cancel_scheduled', 'subscription.canceled'))
            or (new.event = 'pms.currency_refused' and new.properties->>'paid' = 'true')
          )
        )`),
    );
  });
});

describe.skipIf(!PGLITE_DIR)("the signups feed v3 migration in PGlite", () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const lines = async () => ((await q(`select body from net.zz_calls order by id`)) as { body: { text: string } }[]).map((c) => c.body.text);
  /** What the app sends (currency-gate.ts recordCurrencyRefused), with the service role. */
  const refused = (hotel: string, properties: Record<string, unknown>, propertyName = "Juniper Lodge") =>
    q(
      `select public.product_event_emit('pms.currency_refused', $1::uuid, $2::uuid, $3::jsonb, 'app', null, null, 'cloudbeds', 'prop-1', $4)`,
      [hotel, OWNER, JSON.stringify(properties), propertyName],
    );

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
    // Checkout's placeholder rows, as a paid maya-rms.com signup leaves them.
    await db.exec(`
      insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'owner@example.com', now());
      insert into public.hotels (id, name, timezone, is_test) values
        ('${PAID}', 'Pending setup ${PAID}', 'UTC', false),
        ('${TEST_PROP}', 'Pending setup ${TEST_PROP}', 'UTC', true);
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
    await db.exec(`delete from vault.decrypted_secrets`);
    await db.query(`insert into vault.decrypted_secrets (name, decrypted_secret) values ('maya_signups_webhook', $1)`, [WEBHOOK]);
  });

  it("posts a line when a property that had paid is stopped at connect for its currency, named as its system names it", async () => {
    await refused(PAID, { currency: "JPY", via: "onboarding_oauth", paid: true });
    expect(await lines()).toEqual([
      "Juniper Lodge (Cloudbeds) was stopped at connect: its system uses JPY, which MAYA doesn't price in yet. They have already paid: refund or cancel it in Stripe.",
    ]);
  });

  it("posts nothing when nothing was paid, for a test property, or with no name to go by beyond the placeholder", async () => {
    await refused(PAID, { currency: "KRW", via: "marketplace_flow_a" });
    await refused(TEST_PROP, { currency: "KRW", via: "onboarding_oauth", paid: true });
    expect(await lines()).toEqual([]);
    await refused(PAID, { currency: "KRW", via: "onboarding_oauth", paid: true }, "Pending setup 11111111");
    expect(await lines()).toEqual([
      "A new signup (Cloudbeds) was stopped at connect: its system uses KRW, which MAYA doesn't price in yet. They have already paid: refund or cancel it in Stripe.",
    ]);
  });

  it("still posts nothing for any other event the app writes", async () => {
    await q(`select public.product_event_emit('pms.connected', $1::uuid, $2::uuid, '{}'::jsonb, 'app')`, [PAID, OWNER]);
    await q(`select public.product_event_emit('rule.created', $1::uuid, $2::uuid, '{"paid": true}'::jsonb, 'app')`, [PAID, OWNER]);
    expect(await lines()).toEqual([]);
  });
});
