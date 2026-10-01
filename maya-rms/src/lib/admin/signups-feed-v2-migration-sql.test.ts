/**
 * 99_supabase_migration_signups_feed_v2.sql run for real in PGlite, twice, on
 * top of every migration before it (v1 included), under Supabase's default
 * privileges:
 *
 *   1. A subscription that ends gets its "cancelled" line unless the line for
 *      its scheduled cancellation was actually posted (one scheduled while
 *      the feed had no webhook still gets a line when it ends).
 *   2. The test line names nobody.
 *   3. No "New account" line on MAYA's own email domains, case aside.
 *   4. No line at all for a property on MAYA's internal plan.
 *   And, unchanged: a property owned by a + address or MAYA staff posts
 *   until the property itself is flagged test.
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
const PLUS_INN = "11111111-1111-4111-8111-111111111115";
const STAFF_INN = "11111111-1111-4111-8111-111111111116";
const SANDBOX = "11111111-1111-4111-8111-111111111117";

describe("the v2 migration file", () => {
  const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8");
  const code = sql.replace(/--.*$/gm, "");
  const v1 = readFileSync(resolve(ROOT, V1), "utf8");

  it("is on the list the SQL tests build production's schema from, right after v1", () => {
    expect(MIGRATION_ORDER).toContain(MIGRATION);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBe(MIGRATION_ORDER.indexOf(V1) + 1);
  });

  it("is one transaction, never grants anon anything, and revokes execute from public and anon on its owner's-rights functions", () => {
    expect(code.match(/\bbegin;/g)).toHaveLength(1);
    expect(code.match(/\bcommit;/g)).toHaveLength(1);
    expect(code).not.toMatch(/\bgrant\b[^;]*\banon\b/i);
    expect(code).toMatch(/revoke all on function public\.signup_feed_test\(\) from public, anon;/);
    expect(code).toMatch(/revoke all on function public\.signup_feed_line\(public\.product_events\) from public, anon, authenticated;/);
    for (const fn of ["signup_feed_staff_domains\\(\\)", "signup_feed_staff_email\\(uuid\\)", "signup_feed_internal_plan\\(uuid\\)"]) {
      expect(code).toMatch(new RegExp(`revoke all on function public\\.${fn} from public, anon, authenticated;`));
    }
    expect(code.match(/security definer/g)).toHaveLength(2);
    expect(sql).not.toContain("—");
  });

  it("stops before anything else when v1 isn't in", () => {
    const guard = code.indexOf("raise exception 'Run 99_supabase_migration_signups_feed_v1.sql first.'");
    expect(guard).toBeGreaterThan(code.indexOf("begin;"));
    expect(guard).toBeLessThan(code.indexOf("create or replace function"));
  });

  it("keeps MAYA's own email domains in one function", () => {
    expect(functionOf(sql, "signup_feed_staff_domains")).toContain("select array['modern-hospitality-solutions.com', 'maya-rms.com']::text[]");
    expect(code.match(/modern-hospitality-solutions\.com/g)).toHaveLength(1);
    expect(code.match(/'maya-rms\.com'/g)).toHaveLength(1);
  });

  it("restates signup_feed_line from v1 with only the posted check, the staff domains and the internal plan added", () => {
    const before = functionOf(v1, "signup_feed_line");
    const after = functionOf(sql, "signup_feed_line");
    const changes: [string, string][] = [
      // The posted check: v1 read every cancel_scheduled event.
      ["from public.product_events s where", "from public.product_events s join public.signup_feed_posts p on p.event_id = s.id where"],
      [
        "= 'internal' then return null; end if;",
        "= 'internal' then return null; end if; if p_event.hotel_id is not null and public.signup_feed_internal_plan(p_event.hotel_id) then return null; end if;",
      ],
      [
        "if p_event.event = 'account.created' then",
        "if p_event.event = 'account.created' then if public.signup_feed_staff_email(p_event.user_id) then return null; end if;",
      ],
      ["and not h.is_test order by", "and not h.is_test and not public.signup_feed_internal_plan(h.id) order by"],
      ["and hm.status = 'active' and h.is_test )", "and hm.status = 'active' and (h.is_test or public.signup_feed_internal_plan(h.id)) )"],
    ];
    let expected = before;
    for (const [from, to] of changes) {
      expect(expected.split(from)).toHaveLength(2);
      expected = expected.replace(from, to);
    }
    expect(after).toBe(expected);
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
  /** A write the app makes with the service role (the guards on memberships and going live read the claim). */
  const svc = async (sql: string, params: unknown[] = []) => {
    await db.exec(`select set_config('request.jwt.claim.role', 'service_role', false)`);
    try {
      return await q(sql, params);
    } finally {
      await db.exec(`select set_config('request.jwt.claim.role', '', false)`);
    }
  };
  const member = (hotel: string, user: string, role = "viewer") =>
    svc(`insert into public.hotel_memberships (hotel_id, user_id, role) values ($1, $2, $3)`, [hotel, user, role]);
  const goLive = async (hotel: string) => {
    await svc(
      `insert into public.hotel_settings (hotel_id, simulation_mode) values ($1, true)
         on conflict (hotel_id) do update set simulation_mode = true`,
      [hotel],
    );
    await svc(`update public.hotel_settings set simulation_mode = false where hotel_id = $1`, [hotel]);
  };
  const confirm = (ids: string[]) =>
    q(`update auth.users set email_confirmed_at = now() where id in (${ids.map((_, i) => `$${i + 1}`).join(", ")})`, ids);

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

  it("keeps posting a property owned by a + address or MAYA staff, until the property itself is flagged test", async () => {
    const PLUS_OWNER = "22222222-2222-4222-8222-222222222221";
    const STAFF_OWNER = "22222222-2222-4222-8222-222222222222";
    await q(`insert into auth.users (id, email) values ($1, 'jake+harbour@example.com'), ($2, 'ops@maya-rms.com')`, [PLUS_OWNER, STAFF_OWNER]);
    await q(`insert into public.app_roles (user_id, role) values ($1, 'developer')`, [STAFF_OWNER]);
    await confirm([PLUS_OWNER, STAFF_OWNER]);
    await q(`insert into public.hotels (id, name, timezone) values ($1, 'Plus Inn', 'UTC'), ($2, 'Staff Inn', 'UTC')`, [PLUS_INN, STAFF_INN]);
    await member(PLUS_INN, PLUS_OWNER, "hotel_admin");
    await member(STAFF_INN, STAFF_OWNER, "hotel_admin");
    await q(`insert into public.pms_connections (hotel_id, pms_type, status) values ($1, 'cloudbeds', 'connected')`, [PLUS_INN]);
    await q(`insert into public.pms_connections (hotel_id, pms_type, status) values ($1, 'mews', 'connected')`, [STAFF_INN]);
    await sub(PLUS_INN, { stripe_customer_id: "cus_p", stripe_subscription_id: "sub_p", status: "active", billing_interval: "month", billed_rooms: 8 });
    await sub(STAFF_INN, { stripe_customer_id: "cus_s", stripe_subscription_id: "sub_s", status: "active", billing_interval: "month", billed_rooms: 5 });
    await goLive(STAFF_INN);
    expect(await lines()).toEqual([
      "Plus Inn connected Cloudbeds.",
      "Staff Inn connected Mews.",
      "Plus Inn (Cloudbeds) started paying: 8 rooms, monthly.",
      "Staff Inn (Mews) started paying: 5 rooms, monthly.",
      "Staff Inn (Mews) went live.",
    ]);
    // Flagged test (the Command Center toggle): nothing more from it.
    await db.exec(`delete from net.zz_calls;`);
    await q(`update public.hotels set is_test = true where id = $1`, [PLUS_INN]);
    await goLive(PLUS_INN);
    await updateSub(PLUS_INN, "cancel_at_period_end = true, current_period_end = '2026-12-01T12:00:00Z'");
    await updateSub(STAFF_INN, "cancel_at_period_end = true, current_period_end = '2026-12-01T12:00:00Z'");
    expect(await lines()).toEqual(["Staff Inn (Mews) cancelled. Ends Dec 1, 2026."]);
  });

  it("says no New account for MAYA's own email domains, case aside, and still records the account", async () => {
    const ANA = "33333333-3333-4333-8333-333333333331";
    const BEN = "33333333-3333-4333-8333-333333333332";
    const CY = "33333333-3333-4333-8333-333333333333";
    const EVE = "33333333-3333-4333-8333-333333333334";
    await q(
      `insert into auth.users (id, email) values
         ($1, 'ana@modern-hospitality-solutions.com'), ($2, 'Ben@MAYA-RMS.com'), ($3, 'cy@Maya-Rms.Com'), ($4, 'eve@notmaya-rms.com')`,
      [ANA, BEN, CY, EVE],
    );
    // An invitation to a real property, accepted from a staff address: nothing either.
    await member(CLIFF, CY);
    await confirm([ANA, BEN, CY, EVE]);
    expect(await lines()).toEqual(["New account: email confirmed."]);
    const recorded = await q(
      `select count(*)::int as n from public.product_events where event = 'account.created' and not is_test and user_id in ($1, $2, $3, $4)`,
      [ANA, BEN, CY, EVE],
    );
    expect(recorded[0].n).toBe(4);
    expect((await q(`select public.signup_feed_staff_domains() as d`))[0].d).toEqual(["modern-hospitality-solutions.com", "maya-rms.com"]);
    const grants = await q(`select has_function_privilege('authenticated', 'public.signup_feed_staff_email(uuid)', 'execute') as signed_in`);
    expect(grants[0].signed_in).toBe(false);
  });

  it("posts nothing for a property on MAYA's internal plan, connected and went live included, nor an invitation to it", async () => {
    const GUIDE = "44444444-4444-4444-8444-444444444441";
    await q(`insert into public.hotels (id, name, timezone) values ($1, 'Demo Inn', 'UTC')`, [SANDBOX]);
    await sub(SANDBOX, { status: "active", billing_interval: "month", billed_rooms: 4, plan_kind: "internal" });
    await q(`insert into public.pms_connections (hotel_id, pms_type, status) values ($1, 'cloudbeds', 'connected')`, [SANDBOX]);
    await goLive(SANDBOX);
    await q(`insert into auth.users (id, email) values ($1, 'guide@example.com')`, [GUIDE]);
    await member(SANDBOX, GUIDE);
    await confirm([GUIDE]);
    await updateSub(SANDBOX, "status = 'canceled'");
    expect(await lines()).toEqual([]);
    // Recorded as real events: the plan keeps them out of the feed, not a test flag.
    const events = await q(
      `select event, is_test from public.product_events where hotel_id = $1 and event in ('pms.connected', 'property.went_live') order by id`,
      [SANDBOX],
    );
    expect(events).toEqual([
      { event: "pms.connected", is_test: false },
      { event: "property.went_live", is_test: false },
    ]);
    // The same invitation to a real property as well names that one.
    await db.exec(`delete from net.zz_calls;`);
    const BOTH = "44444444-4444-4444-8444-444444444442";
    await q(`insert into auth.users (id, email) values ($1, 'host@example.com')`, [BOTH]);
    await member(SANDBOX, BOTH);
    await member(DUNE, BOTH);
    await confirm([BOTH]);
    expect(await lines()).toEqual(["New account: joined Dune Lodge."]);
  });

  it("posts a test line that names nobody", async () => {
    expect(await as(ADMIN, async () => (await q(`select public.signup_feed_test() as r`))[0].r)).toMatchObject({ sent: true, state: "ready" });
    expect((await q(`select public.signup_feed_test() as r`))[0].r).toMatchObject({ sent: true });
    expect(await lines()).toEqual(["Test line from the Command Center. Real signups post here.", "Test line from the Command Center. Real signups post here."]);
    const grants = await q(`select has_function_privilege('anon', 'public.signup_feed_test()', 'execute') as anon`);
    expect(grants[0].anon).toBe(false);
  });
});
