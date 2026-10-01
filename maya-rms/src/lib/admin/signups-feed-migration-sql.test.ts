/**
 * 99_supabase_migration_signups_feed_v1.sql run for real in PGlite, twice, on
 * top of every migration before it, under Supabase's default privileges:
 *
 *   1. calendar_daily_revenue_v3: per night, the revenue a calendar day
 *      counts for its RevPAR (room types that count as rooms, the imported
 *      rate first), which the colours now rank.
 *   2. platform_pilot_health v5: a rate removed in the property system is
 *      counted under no_rate_count, unless a price was typed after it.
 *   3. Test-property signup codes: the property is flagged test where the
 *      code is bound, before its own events are written; a property's events
 *      and snapshots follow its flag both ways.
 *   4. The #maya-signups feed: the line for each real milestone through
 *      pg_net to the webhook in Vault, nothing for test or staff, never a
 *      failed insert, once per event; and the admin's test line.
 *
 * pg_net and Vault are stand-ins here (a table each), as in the watchdog's
 * test. Only runs with MAYA_PGLITE_DIR set (see pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_signups_feed_v1.sql";
const STAFF_ROLES = "99_supabase_migration_staff_roles_v1.sql";
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

/** What Supabase provides and the files assume; auth.jwt() reads the whole claims object, as staff_can_read needs. */
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

/** Stand-ins for pg_net and Vault, as in pricing-watchdog-migration-sql.test.ts. */
const STAND_INS = `
create schema if not exists net;
create table net.zz_calls (
  id bigserial primary key,
  url text,
  body jsonb,
  headers jsonb,
  timeout_milliseconds integer,
  called_at timestamptz not null default now()
);
create table net.zz_refuse (reason text);
create or replace function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint language plpgsql as $$
declare v_id bigint; v_reason text;
begin
  select reason into v_reason from net.zz_refuse limit 1;
  if v_reason is not null then raise exception '%', v_reason; end if;
  insert into net.zz_calls (url, body, headers, timeout_milliseconds)
  values (url, body, headers, timeout_milliseconds) returning id into v_id;
  return v_id;
end $$;
grant usage on schema net to service_role;
create table vault.decrypted_secrets (name text, decrypted_secret text, created_at timestamptz default now());
`;

/** Supabase's default privileges for what the postgres role creates in public (see definer-functions-sql.test.ts). */
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

const WEBHOOK = "https://hooks.slack.example.test/services/T0/B0/signups";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SALES = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const OWNER = "33333333-3333-4333-8333-333333333333";
const OTHER = "33333333-3333-4333-8333-333333333334";

// Properties.
const HARBOUR = "11111111-1111-4111-8111-111111111111";
const CLIFF = "11111111-1111-4111-8111-111111111112";
const DUNE = "11111111-1111-4111-8111-111111111113";
const PENDING = "11111111-1111-4111-8111-111111111114";
const OURS = "11111111-1111-4111-8111-111111111115";
const TESTED = "11111111-1111-4111-8111-111111111116";
const REDEEMED = "11111111-1111-4111-8111-111111111117";
const PLAIN = "11111111-1111-4111-8111-111111111118";
const FLIPPED = "11111111-1111-4111-8111-111111111119";

const KING = "55555555-5555-4555-8555-555555555551";
const COURT = "55555555-5555-4555-8555-555555555552";
const OLDWING = "55555555-5555-4555-8555-555555555553";

const TEST_CODE = "66666666-6666-4666-8666-666666666661";
const REAL_CODE = "66666666-6666-4666-8666-666666666662";

/** A night n days from today (UTC; the properties are on UTC). */
const night = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const strip = (s: string) => s.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();

/** platform_pilot_health as a file writes it: the create through to its comment. */
function pilotHealthOf(sql: string): string {
  const start = sql.indexOf("create or replace function public.platform_pilot_health(");
  const end = sql.indexOf("comment on function public.platform_pilot_health", start);
  return strip(sql.slice(start, end));
}

const V4_WHERE = strip(`
         and mp.stay_date is null
         and (brc.stay_date is null
              or (pc.base_rates_returned_through is not null and g.d::date > pc.base_rates_returned_through))`);
const V5_WHERE = strip(`
         and (mp.stay_date is null
              or (brc.pms_removed_at is not null and mp.set_at <= brc.pms_removed_at))
         and (brc.stay_date is null
              or brc.pms_removed_at is not null
              or (pc.base_rates_returned_through is not null and g.d::date > pc.base_rates_returned_through))`);

describe("the migration file", () => {
  const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8");
  const code = sql.replace(/--.*$/gm, "");

  it("is last on the list the SQL tests build production's schema from, after the staff roles", () => {
    expect(MIGRATION_ORDER[MIGRATION_ORDER.length - 1]).toBe(MIGRATION);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBeGreaterThan(MIGRATION_ORDER.indexOf(STAFF_ROLES));
  });

  it("is one transaction, keeps row level security on and never grants anon anything", () => {
    expect(code.match(/\bbegin;/g)).toHaveLength(1);
    expect(code.match(/\bcommit;/g)).toHaveLength(1);
    expect(code).not.toMatch(/disable row level security/i);
    expect(code).not.toMatch(/\bgrant\b[^;]*\banon\b/i);
    expect(code).toMatch(/alter table public\.signup_feed_posts enable row level security;/);
  });

  it("revokes execute from public and anon on every new function that runs with the owner's rights", () => {
    for (const sig of [
      "public.calendar_daily_revenue_v3(uuid, date, int)",
      "public.platform_pilot_health(boolean)",
      "public.signup_feed_webhook()",
      "public.signup_feed_test()",
    ]) {
      const escaped = sig.replace(/[.()]/g, (c) => `\\${c}`);
      expect(code, sig).toMatch(new RegExp(`revoke all on function ${escaped} from public, anon[,;]`));
    }
  });

  it("restates platform_pilot_health from the staff roles file, with only the removed-rate count changed", () => {
    const before = pilotHealthOf(readFileSync(resolve(ROOT, STAFF_ROLES), "utf8"));
    const after = pilotHealthOf(sql);
    expect(before).toContain(V4_WHERE);
    expect(after).toContain(V5_WHERE);
    expect(after.replace(V5_WHERE, V4_WHERE)).toBe(before);
    // The staff roles access check, exactly as it was.
    expect(after).toContain(
      "if (select auth.role()) is distinct from 'service_role' and not public.staff_can_read('pilot_health') then raise exception 'Not authorized' using errcode = '42501';",
    );
  });

  it("names the code triggers to fire before the product events triggers on their tables", () => {
    expect("trg_code_test_property" < "trg_product_events_code_redemptions").toBe(true);
    expect("trg_hotel_subscriptions_code_test_property" < "trg_product_events_subscriptions").toBe(true);
    expect(code).toMatch(/create trigger trg_code_test_property\s+after insert on public\.signup_code_redemptions/);
    expect(code).toMatch(/create trigger trg_hotel_subscriptions_code_test_property\s+after insert or update of signup_code_id on public\.hotel_subscriptions/);
  });

  it("has no em dash in anything it posts", () => {
    expect(sql).not.toContain("—");
  });
});

describe.skipIf(!PGLITE_DIR)("the signups feed migration in PGlite", () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

  /** Runs `fn` as this signed-in person, then puts the session back. */
  const as = async <T>(userId: string, aal: "aal1" | "aal2", fn: () => Promise<T>): Promise<T> => {
    const now = Math.floor(Date.now() / 1000);
    const amr = aal === "aal2" ? [{ method: "totp", timestamp: now }, { method: "password", timestamp: now - 60 }] : [{ method: "password", timestamp: now }];
    const claims = JSON.stringify({ sub: userId, role: "authenticated", aal, amr, session_id: "sess-laptop" });
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
  const asService = async <T>(fn: () => Promise<T>): Promise<T> => {
    await db.exec(`select set_config('request.jwt.claim.role', 'service_role', false); set role service_role;`);
    try {
      return await fn();
    } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.role', '', false);`);
    }
  };

  const setWebhook = async (url: string | null) => {
    await db.exec(`delete from vault.decrypted_secrets`);
    if (url != null) await db.query(`insert into vault.decrypted_secrets (name, decrypted_secret) values ('maya_signups_webhook', $1)`, [url]);
  };
  /** The lines posted since the last reset, in order. */
  const posted = async () => (await q(`select url, body from net.zz_calls order by id`)) as { url: string; body: { text: string } }[];
  const lines = async () => (await posted()).map((c) => c.body.text);
  const reset = async () => {
    await db.exec(`delete from net.zz_calls; delete from net.zz_refuse;`);
    await setWebhook(WEBHOOK);
  };
  const isTest = async (hotel: string) => (await q(`select is_test from public.hotels where id = $1`, [hotel]))[0].is_test;
  const eventsTest = async (hotel: string) =>
    (await q(`select event, is_test from public.product_events where hotel_id = $1 order by id`, [hotel])) as { event: string; is_test: boolean }[];
  const sub = (hotel: string, cols: Record<string, unknown>) => {
    const keys = ["hotel_id", ...Object.keys(cols)];
    const vals = [hotel, ...Object.values(cols)];
    return db.query(`insert into public.hotel_subscriptions (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
  };
  const updateSub = (hotel: string, set: string, params: unknown[] = []) =>
    db.query(`update public.hotel_subscriptions set ${set} where hotel_id = $1`, [hotel, ...params]);
  /** A write the app makes with the service role (the claim only: the guards on memberships and going live read it). */
  const svc = async (sql: string, params: unknown[] = []) => {
    await db.exec(`select set_config('request.jwt.claim.role', 'service_role', false)`);
    try {
      return await q(sql, params);
    } finally {
      await db.exec(`select set_config('request.jwt.claim.role', '', false)`);
    }
  };
  const member = (hotel: string, user: string) =>
    svc(`insert into public.hotel_memberships (hotel_id, user_id, role) values ($1, $2, 'viewer')`, [hotel, user]);
  const simulation = (hotel: string, on: boolean) =>
    svc(`update public.hotel_settings set simulation_mode = $2 where hotel_id = $1`, [hotel, on]);

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
    // Supabase's default privileges: signed-in people reach the tables and RLS decides the rows.
    await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated;`);
    // A property that was running before the file, with history and a snapshot.
    await db.exec(`
      select set_config('request.jwt.claim.role', 'service_role', false);
      insert into auth.users (id, email, email_confirmed_at) values
        ('${ADMIN}', 'jake@example.com', now()), ('${SALES}', 'sam@example.com', now()),
        ('${OWNER}', 'priya@example.com', now()), ('${OTHER}', 'lee@example.com', now());
      insert into public.app_roles (user_id, role) values ('${ADMIN}', 'platform_admin'), ('${SALES}', 'sales');
      insert into public.hotels (id, name, timezone) values
        ('${HARBOUR}', 'Harbour Inn & Spa <East>', 'UTC'), ('${CLIFF}', 'Cliff House', 'UTC'), ('${DUNE}', 'Dune Lodge', 'UTC'),
        ('${PENDING}', 'Pending setup ab12cd34', 'UTC'), ('${OURS}', 'Our Sandbox', 'UTC'), ('${TESTED}', 'Test Code Inn', 'UTC'),
        ('${REDEEMED}', 'Redeemed Inn', 'UTC'), ('${PLAIN}', 'Plain Code Inn', 'UTC'), ('${FLIPPED}', 'Flipped Inn', 'UTC');
      insert into public.hotel_memberships (hotel_id, user_id, role) values ('${HARBOUR}', '${OWNER}', 'hotel_admin');
      insert into public.hotel_settings (hotel_id, simulation_mode) values ('${HARBOUR}', true), ('${CLIFF}', true)
        on conflict (hotel_id) do update set simulation_mode = excluded.simulation_mode;
      insert into public.room_types (id, hotel_id, external_room_type_id, name, total_rooms, is_active, counts_as_room) values
        ('${KING}', '${HARBOUR}', 'K', 'King', 10, true, true),
        ('${COURT}', '${HARBOUR}', 'C', 'Tennis court', 2, true, false),
        ('${OLDWING}', '${HARBOUR}', 'W', 'Old wing', 4, false, true);
      insert into public.signup_codes (id, code, kind, trial_days) values
        ('${TEST_CODE}', 'WALKTHROUGH', 'trial', 14), ('${REAL_CODE}', 'DRIFTWOOD', 'trial', 14);
      insert into public.hotel_metrics_daily (day, hotel_id, status, entitled) values (current_date - 1, '${FLIPPED}', 'active', true);
      select set_config('request.jwt.claim.role', '', false);
    `);
    await db.exec(SUPABASE_DEFAULT_PRIVILEGES);
    // The file under test, twice: it is safe to run again.
    await db.exec(fileSql(MIGRATION));
    await db.exec(fileSql(MIGRATION));
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  describe("the calendar colours' revenue", () => {
    beforeAll(async () => {
      await db.exec(`
        insert into public.reservations (id, external_reservation_id, hotel_id, stay_date, room_type_id, base_rate, current_rate) values
          (gen_random_uuid(), 'r1', '${HARBOUR}', '2026-11-02', '${KING}', 100, 120),
          (gen_random_uuid(), 'r2', '${HARBOUR}', '2026-11-02', '${KING}', null, 90),
          (gen_random_uuid(), 'r3', '${HARBOUR}', '2026-11-02', '${KING}', null, null),
          (gen_random_uuid(), 'r4', '${HARBOUR}', '2026-11-02', '${COURT}', 40, 40),
          (gen_random_uuid(), 'r5', '${HARBOUR}', '2026-11-02', '${OLDWING}', 70, 70),
          (gen_random_uuid(), 'r6', '${HARBOUR}', '2026-11-02', null, 5, 5),
          (gen_random_uuid(), 'r7', '${HARBOUR}', '2026-11-03', '${COURT}', 40, 40),
          (gen_random_uuid(), 'r8', '${HARBOUR}', '2026-11-04', '${KING}', 150.5, 160),
          (gen_random_uuid(), 'r9', '${CLIFF}', '2026-11-02', null, 500, 500);
      `);
    });
    const v3 = (after: string | null = null, limit = 1000) =>
      asService(async () =>
        (await q(`select stay_date::text as d, revenue::float8 as r from public.calendar_daily_revenue_v3($1, $2, $3)`, [HARBOUR, after, limit])).map((x) => [x.d, x.r]),
      );

    it("counts the room types that count as rooms, at the imported rate first, as the day card does", async () => {
      // King: 100 (imported) + 90 (latest, nothing imported) + 0; the court, the
      // switched-off wing and a booking with no room type count nothing.
      expect(await v3()).toEqual([
        ["2026-11-02", 190],
        ["2026-11-03", 0],
        ["2026-11-04", 150.5],
      ]);
    });

    it("pages by date like v2", async () => {
      expect(await v3("2026-11-02", 1)).toEqual([["2026-11-03", 0]]);
    });

    it("answers a property's own people and refuses everyone else", async () => {
      expect(await as(OWNER, "aal1", async () => (await q(`select count(*)::int as n from public.calendar_daily_revenue_v3($1)`, [HARBOUR]))[0].n)).toBe(3);
      await as(OTHER, "aal1", async () => {
        await expect(q(`select * from public.calendar_daily_revenue_v3($1)`, [HARBOUR])).rejects.toThrow(/Not authorized/);
      });
      const grants = await q(`select has_function_privilege('anon', 'public.calendar_daily_revenue_v3(uuid, date, int)', 'execute') as anon`);
      expect(grants[0].anon).toBe(false);
    });
  });

  describe("Pilot Health's nights with no rate", () => {
    const noRate = async () =>
      asService(async () => (await q(`select no_rate_count from public.platform_pilot_health(true) where hotel_id = $1`, [HARBOUR]))[0]?.no_rate_count);

    beforeAll(async () => {
      // A Cloudbeds property with a rate on record for every night of a 20-night pass window (nights 1..18 count).
      await db.exec(`
        insert into public.pms_connections (hotel_id, pms_type, status, last_sync_at) values ('${HARBOUR}', 'cloudbeds', 'connected', now());
        insert into public.hotel_pricing_state (hotel_id, pass_horizon_days) values ('${HARBOUR}', 20)
          on conflict (hotel_id) do update set pass_horizon_days = excluded.pass_horizon_days;
        insert into public.base_rate_calendar (hotel_id, stay_date, room_type_id, price, source)
          select '${HARBOUR}', ((now() at time zone 'utc')::date + g)::date, '${KING}', 150, 'pms' from generate_series(1, 18) g;
        delete from net.zz_calls;
      `);
    });

    it("counts a rate removed in the property system as no rate on record", async () => {
      expect(await noRate()).toBe(0);
      await q(`update public.base_rate_calendar set pms_removed_at = now() - interval '1 hour' where hotel_id = $1 and stay_date in ($2, $3, $4)`, [
        HARBOUR,
        night(3),
        night(4),
        night(5),
      ]);
      expect(await noRate()).toBe(3);
    });

    it("leaves out a removed night once a price is typed after the removal, not before", async () => {
      await q(`insert into public.manual_price (hotel_id, stay_date, room_type_id, price, set_at) values ($1, $2, $3, 180, now() - interval '2 hours')`, [HARBOUR, night(3), KING]);
      expect(await noRate()).toBe(3);
      await q(`insert into public.manual_price (hotel_id, stay_date, room_type_id, price, set_at) values ($1, $2, $3, 180, now())`, [HARBOUR, night(4), KING]);
      expect(await noRate()).toBe(2);
      // A rate back again: the night counts as on record.
      await q(`update public.base_rate_calendar set pms_removed_at = null where hotel_id = $1 and stay_date = $2`, [HARBOUR, night(5)]);
      expect(await noRate()).toBe(1);
    });

    it("keeps the staff roles access check: a sales login needs its code, a property's people never", async () => {
      await as(SALES, "aal1", async () => {
        await expect(q(`select * from public.platform_pilot_health(false)`)).rejects.toThrow(/Not authorized/);
      });
      expect(await as(SALES, "aal2", async () => (await q(`select count(*)::int as n from public.platform_pilot_health(true)`))[0].n)).toBeGreaterThan(0);
      await as(OWNER, "aal1", async () => {
        await expect(q(`select * from public.platform_pilot_health(false)`)).rejects.toThrow(/Not authorized/);
      });
      expect(await as(ADMIN, "aal1", async () => (await q(`select count(*)::int as n from public.platform_pilot_health(true)`))[0].n)).toBeGreaterThan(0);
    });
  });

  describe("test-property signup codes", () => {
    beforeAll(async () => {
      await db.exec(`update public.signup_codes set test_property = true where id = '${TEST_CODE}'`);
      await reset();
    });

    it("adds the checkbox off for every code", async () => {
      expect(await q(`select code, test_property from public.signup_codes order by code`)).toEqual([
        { code: "DRIFTWOOD", test_property: false },
        { code: "WALKTHROUGH", test_property: true },
      ]);
    });

    it("flags a property whose subscription arrives with the code, before its subscription events are written", async () => {
      await sub(TESTED, {
        stripe_customer_id: "cus_t",
        stripe_subscription_id: "sub_t",
        status: "trialing",
        billing_interval: "month",
        billed_rooms: 5,
        trial_end: new Date(Date.now() + 14 * 86_400_000).toISOString(),
        signup_code_id: TEST_CODE,
      });
      expect(await isTest(TESTED)).toBe(true);
      expect(await eventsTest(TESTED)).toEqual([
        { event: "property.created", is_test: true },
        { event: "property.activated", is_test: true },
        { event: "subscription.created", is_test: true },
        { event: "subscription.trialing", is_test: true },
      ]);
      expect(await lines()).toEqual([]);
    });

    it("flags a property whose redemption row lands first, before the redeemed event", async () => {
      await q(`insert into public.signup_code_redemptions (code_id, hotel_id, user_id, email) values ($1, $2, $3, 'priya@example.com')`, [TEST_CODE, REDEEMED, OWNER]);
      expect(await isTest(REDEEMED)).toBe(true);
      expect((await eventsTest(REDEEMED)).find((e) => e.event === "signup_code.redeemed")).toEqual({ event: "signup_code.redeemed", is_test: true });
    });

    it("leaves a property on an ordinary code real", async () => {
      await q(`insert into public.signup_code_redemptions (code_id, hotel_id, user_id, email) values ($1, $2, $3, 'lee@example.com')`, [REAL_CODE, PLAIN, OTHER]);
      await sub(PLAIN, { stripe_customer_id: "cus_p", stripe_subscription_id: "sub_p", status: "active", billing_interval: "month", billed_rooms: 3, signup_code_id: REAL_CODE });
      expect(await isTest(PLAIN)).toBe(false);
      expect((await lines()).filter((l) => l.startsWith("Plain Code Inn"))).toEqual(["Plain Code Inn started paying: 3 rooms, monthly."]);
    });

    it("never flags a property again that an admin set back to real, when its subscription is written again", async () => {
      await q(`update public.hotels set is_test = false where id = $1`, [TESTED]);
      await updateSub(TESTED, "signup_code_id = $2, billed_rooms = 6", [TEST_CODE]);
      expect(await isTest(TESTED)).toBe(false);
    });

    it("carries a property's flag to its events and daily snapshots, both ways", async () => {
      const metrics = async () => (await q(`select is_test from public.hotel_metrics_daily where hotel_id = $1`, [FLIPPED])).map((r) => r.is_test);
      const flags = async () => (await eventsTest(FLIPPED)).map((e) => e.is_test);
      expect(await flags()).toEqual([false, false]);
      await q(`update public.hotels set is_test = true where id = $1`, [FLIPPED]);
      expect(await flags()).toEqual([true, true]);
      expect(await metrics()).toEqual([true]);
      await q(`update public.hotels set is_test = false where id = $1`, [FLIPPED]);
      expect(await flags()).toEqual([false, false]);
      expect(await metrics()).toEqual([false]);
    });

    it("keeps codes, and whether one is a test code, a platform admin's to read", async () => {
      expect(await as(SALES, "aal2", async () => q(`select code, test_property from public.signup_codes`))).toEqual([]);
      expect((await as(ADMIN, "aal1", async () => q(`select code from public.signup_codes`))).length).toBe(2);
      await as(SALES, "aal2", async () => {
        await expect(q(`insert into public.signup_codes (code, kind, trial_days, test_property) values ('SNEAKY', 'trial', 7, true)`)).rejects.toThrow(
          /row-level security|permission denied/,
        );
      });
    });
  });

  describe("the #maya-signups feed", () => {
    beforeEach(reset);

    it("posts each real milestone of a property, once, with its name and system", async () => {
      await q(`insert into public.pms_connections (hotel_id, pms_type, status) values ($1, 'think', 'connected')`, [CLIFF]);
      await sub(CLIFF, {
        stripe_customer_id: "cus_c",
        stripe_subscription_id: "sub_c",
        status: "trialing",
        billing_interval: "month",
        billed_rooms: 24,
        trial_end: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      });
      await updateSub(CLIFF, "status = 'active'");
      // A late payment and its recovery are not milestones.
      await updateSub(CLIFF, "status = 'past_due'");
      await updateSub(CLIFF, "status = 'active'");
      await simulation(CLIFF, false);
      // Back to simulation and live again: only the first time is a milestone.
      await simulation(CLIFF, true);
      await simulation(CLIFF, false);
      await updateSub(CLIFF, "cancel_at_period_end = true, current_period_end = '2026-10-30T12:00:00Z', cancellation_feedback = 'too_expensive'");
      // The scheduled end arrives: already said.
      await updateSub(CLIFF, "status = 'canceled'");
      expect(await lines()).toEqual([
        "Cliff House connected ThinkReservations.",
        "Cliff House (ThinkReservations) started a 14-day trial: 24 rooms, monthly.",
        "Cliff House (ThinkReservations) moved from the trial to paying: 24 rooms, monthly.",
        "Cliff House (ThinkReservations) went live.",
        "Cliff House (ThinkReservations) cancelled. Ends Oct 30, 2026. Reason: too expensive.",
      ]);
      expect((await posted()).every((c) => c.url === WEBHOOK)).toBe(true);
      const kept = await q(`select event from public.signup_feed_posts where hotel_id = $1 order by event_id`, [CLIFF]);
      expect(kept.map((r) => r.event)).toEqual([
        "pms.connected",
        "subscription.trialing",
        "subscription.active",
        "property.went_live",
        "subscription.cancel_scheduled",
      ]);
    });

    it("says a cancellation straight away, during a trial, and why a payment ended it", async () => {
      await q(`insert into public.pms_connections (hotel_id, pms_type, status) values ($1, 'mews', 'pending')`, [DUNE]);
      await sub(DUNE, { stripe_customer_id: "cus_d", stripe_subscription_id: "sub_d", status: "trialing", billing_interval: "year", billed_rooms: 1 });
      await updateSub(DUNE, "status = 'canceled', cancellation_reason = 'payment_failed'");
      expect(await lines()).toEqual(["Dune Lodge (Mews) started a trial: 1 room, yearly.", "Dune Lodge (Mews) cancelled during the trial. Reason: payment failed."]);
    });

    it("escapes a name for Slack, and says a new signup for checkout's placeholder", async () => {
      await sub(PENDING, { stripe_customer_id: "cus_x", stripe_subscription_id: "sub_x", status: "active", billing_interval: "month", billed_rooms: 3 });
      await simulation(HARBOUR, false);
      expect(await lines()).toEqual(["A new signup started paying: 3 rooms, monthly.", "Harbour Inn &amp; Spa &lt;East&gt; (Cloudbeds) went live."]);
    });

    it("posts an account once its email is confirmed, and names the property an invitation joined", async () => {
      const NEWBIE = "77777777-7777-4777-8777-777777777771";
      const INVITED = "77777777-7777-4777-8777-777777777772";
      await q(`insert into auth.users (id, email) values ($1, 'newbie@example.com'), ($2, 'frontdesk@example.com')`, [NEWBIE, INVITED]);
      await member(CLIFF, INVITED);
      expect(await lines()).toEqual([]);
      await q(`update auth.users set email_confirmed_at = now() where id in ($1, $2)`, [NEWBIE, INVITED]);
      expect((await lines()).sort()).toEqual(["New account: email confirmed.", "New account: joined Cliff House."]);
    });

    it("never posts for a + address, MAYA staff, a test property, a backfill or MAYA's internal plan", async () => {
      const PLUS = "77777777-7777-4777-8777-777777777773";
      const STAFF = "77777777-7777-4777-8777-777777777774";
      const TESTER = "77777777-7777-4777-8777-777777777775";
      await q(`insert into auth.users (id, email) values ($1, 'jake+demo@example.com'), ($2, 'dev@example.com'), ($3, 'tester@example.com')`, [PLUS, STAFF, TESTER]);
      await q(`insert into public.app_roles (user_id, role) values ($1, 'developer')`, [STAFF]);
      await member(REDEEMED, TESTER);
      await q(`update auth.users set email_confirmed_at = now() where id in ($1, $2, $3)`, [PLUS, STAFF, TESTER]);
      // A test property's milestones.
      await q(`insert into public.pms_connections (hotel_id, pms_type, status) values ($1, 'cloudbeds', 'connected')`, [REDEEMED]);
      // MAYA's own plan.
      await sub(OURS, { status: "active", billing_interval: "month", billed_rooms: 2, plan_kind: "internal" });
      // A backfill.
      await q(`select public.product_event_emit('pms.connected', $1, null, '{}'::jsonb, 'backfill')`, [OURS]);
      expect(await lines()).toEqual([]);
    });

    it("posts nothing, and still records the event, with no webhook in Vault, a webhook that is not https, or pg_net refusing", async () => {
      const count = async () => (await q(`select count(*)::int as n from public.product_events where event = 'account.created'`))[0].n as number;
      const confirm = async (id: string, email: string) => {
        await q(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
        await q(`update auth.users set email_confirmed_at = now() where id = $1`, [id]);
      };
      const before = await count();
      await setWebhook(null);
      await confirm("77777777-7777-4777-8777-777777777781", "a@example.com");
      await setWebhook("http://hooks.slack.example.test/plain");
      await confirm("77777777-7777-4777-8777-777777777782", "b@example.com");
      await setWebhook(WEBHOOK);
      await db.exec(`insert into net.zz_refuse values ('pg_net is not installed')`);
      await confirm("77777777-7777-4777-8777-777777777783", "c@example.com");
      expect(await count()).toBe(before + 3);
      expect(await lines()).toEqual([]);
      // pg_net refused, so it is not on record as posted.
      expect(await q(`select 1 from public.signup_feed_posts p join public.product_events e on e.id = p.event_id where e.user_id = '77777777-7777-4777-8777-777777777783'`)).toEqual([]);
    });

    it("posts an event row once at most", async () => {
      const next = Number((await q(`select nextval(pg_get_serial_sequence('public.product_events', 'id')) as n`))[0].n) + 1;
      await q(`insert into public.signup_feed_posts (event_id, event) values ($1, 'account.created')`, [next]);
      await q(`insert into auth.users (id, email) values ('77777777-7777-4777-8777-777777777791', 'd@example.com')`);
      await q(`update auth.users set email_confirmed_at = now() where id = '77777777-7777-4777-8777-777777777791'`);
      expect(await q(`select id::int as id from public.product_events where user_id = '77777777-7777-4777-8777-777777777791'`)).toEqual([{ id: next }]);
      expect(await lines()).toEqual([]);
    });

    it("previews the line for any event, and says nothing for the rest", async () => {
      const preview = async (where: string) =>
        (await q(`select public.signup_feed_line(e) as l from public.product_events e where ${where} order by e.id desc limit 1`))[0]?.l ?? null;
      expect(await preview(`e.hotel_id = '${CLIFF}' and e.event = 'subscription.created'`)).toBeNull();
      expect(await preview(`e.hotel_id = '${CLIFF}' and e.event = 'subscription.trialing'`)).toBe(
        "Cliff House (ThinkReservations) started a 14-day trial: 24 rooms, monthly.",
      );
    });

    it("keeps its record and the webhook to the owner's side", async () => {
      await as(ADMIN, "aal1", async () => {
        await expect(q(`select * from public.signup_feed_posts`)).rejects.toThrow(/permission denied/);
        await expect(q(`select public.signup_feed_webhook()`)).rejects.toThrow(/permission denied/);
      });
      await asService(async () => {
        expect((await q(`select count(*)::int as n from public.signup_feed_posts`))[0].n).toBeGreaterThan(0);
        await expect(q(`select public.signup_feed_webhook()`)).rejects.toThrow(/permission denied/);
        await expect(q(`delete from public.signup_feed_posts`)).rejects.toThrow(/permission denied/);
      });
      const rls = await q(`select relrowsecurity as r from pg_class where relname = 'signup_feed_posts' and relnamespace = 'public'::regnamespace`);
      expect(rls).toEqual([{ r: true }]);
    });
  });

  describe("signup_feed_test", () => {
    beforeEach(reset);

    it("posts one test line for a platform admin, and says what it found", async () => {
      const r = await as(ADMIN, "aal1", async () => (await q(`select public.signup_feed_test() as r`))[0].r);
      expect(r).toMatchObject({ sent: true, state: "ready" });
      expect(await lines()).toEqual(["Test line from the Command Center, sent by jake@example.com. Real signups post here."]);
      await setWebhook(null);
      expect(await as(ADMIN, "aal1", async () => (await q(`select public.signup_feed_test() as r`))[0].r)).toEqual({ sent: false, state: "missing" });
      await setWebhook("http://plain.example.test");
      expect(await as(ADMIN, "aal1", async () => (await q(`select public.signup_feed_test() as r`))[0].r)).toEqual({ sent: false, state: "not_https" });
      await setWebhook(WEBHOOK);
      await db.exec(`insert into net.zz_refuse values ('pg_net is not installed')`);
      expect(await as(ADMIN, "aal1", async () => (await q(`select public.signup_feed_test() as r`))[0].r)).toMatchObject({ sent: false, state: "post_failed" });
    });

    it("refuses anyone but a platform admin and the service role", async () => {
      for (const who of [SALES, OWNER]) {
        await as(who, "aal2", async () => {
          await expect(q(`select public.signup_feed_test()`)).rejects.toThrow(/Not authorized/);
        });
      }
      expect(await asService(async () => (await q(`select public.signup_feed_test() as r`))[0].r)).toMatchObject({ sent: true });
      const grants = await q(`select has_function_privilege('anon', 'public.signup_feed_test()', 'execute') as anon`);
      expect(grants[0].anon).toBe(false);
    });
  });
});
