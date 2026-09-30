/**
 * 99_supabase_migration_staff_roles_v1.sql run for real in PGlite, twice, on
 * top of every migration before it, under Supabase's default privileges and
 * with requests arriving as PostgREST sends them (session user
 * authenticator, role authenticated, the JWT's claims). For each of a
 * platform admin, a developer, a sales login, a property owner and a
 * stranger, at aal1 and at aal2: every staff read it widens and the ones it
 * leaves admin only, every write they must not make, God Mode, the role
 * picker, business numbers, and the staff analytics rule with its backfill.
 * The functions it restates are compared with what they were, so nothing
 * but the check changed.
 *
 * Only runs with MAYA_PGLITE_DIR set (see pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_staff_roles_v1.sql";
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

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

/**
 * What Supabase provides and the files assume. auth.jwt() reads the whole
 * claims object, so a test can act with an aal1 or an aal2 token, and
 * PostgREST's login role is here so session_user reads as it does there.
 */
const PLATFORM = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role supabase_admin nologin;
create role authenticator noinherit login;
grant anon, authenticated, service_role to authenticator;
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

/** Supabase's bootstrap default privileges, so each file's own revokes are the ones that count. */
const SUPABASE_DEFAULT_PRIVILEGES = `
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

function fileSql(name: string): string {
  let sql = readFileSync(resolve(ROOT, name), "utf8");
  sql = sql.replace(/create extension if not exists supabase_vault[^;]*;/gi, "");
  if (name === "99_supabase_migration_rate_push_v1.sql") sql = `drop table if exists public.rate_updates cascade;\n${sql}`;
  return sql;
}

const H = "11111111-1111-4111-8111-111111111111"; // Harbour Inn: real, live, paying
const HT = "11111111-1111-4111-8111-111111111112"; // Sandbox: a test property, the developer's own
const HS = "11111111-1111-4111-8111-111111111113"; // Dune Lodge: paid and stuck at payment
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEV = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SALES = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER = "33333333-3333-4333-8333-333333333333";
const OWNER2 = "33333333-3333-4333-8333-333333333334";
const STRANGER = "44444444-4444-4444-8444-444444444444";
const KING = "55555555-5555-4555-8555-555555555551";
const SUITE = "55555555-5555-4555-8555-555555555552";
const COURT = "55555555-5555-4555-8555-555555555553";
const SANDBOX_ROOM = "55555555-5555-4555-8555-555555555554";
const RULE = "66666666-6666-4666-8666-666666666666";
const CODE = "77777777-7777-4777-8777-777777777777";
const PENDING = "88888888-8888-4888-8888-888888888888";

/** A night n days from today (UTC). */
const night = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const DEVELOPER_SECTIONS = ["docs_questions", "home", "hotel_team", "hotels", "pilot_health", "pms_access", "users"];
const SALES_SECTIONS = ["analytics", "business_numbers", "docs_questions", "home", "hotels", "pilot_health", "stalled_signups"];
const ADMIN_SECTIONS = [
  "analytics",
  "business_numbers",
  "docs_questions",
  "home",
  "hotel_create",
  "hotel_team",
  "hotels",
  "pending_invites",
  "pilot_health",
  "pms_access",
  "signup_codes",
  "stalled_signups",
  "users",
];

/** The functions the file restates, whose bodies must be what they were but for the check. */
const RESTATED = [
  "platform_list_users",
  "platform_count_users",
  "platform_list_hotel_users",
  "platform_pilot_health",
  "platform_list_stalled_signups",
  "analytics_range",
] as const;

describe("the migration file", () => {
  const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8");
  const code = sql.replace(/--.*$/gm, "");

  it("is last on the list the SQL tests build production's schema from", () => {
    expect(MIGRATION_ORDER[MIGRATION_ORDER.length - 1]).toBe(MIGRATION);
  });

  it("is one transaction, keeps row level security on and never grants anon anything", () => {
    expect(code.match(/\bbegin;/g)).toHaveLength(1);
    expect(code.match(/\bcommit;/g)).toHaveLength(1);
    expect(code).not.toMatch(/disable row level security/i);
    expect(code).not.toMatch(/\bgrant\b[^;]*\banon\b/i);
  });

  it("never touches God Mode, the hotel access helpers or is_platform_admin itself", () => {
    for (const fn of ["god_mode_start", "god_mode_active", "god_mode_status", "god_mode_end", "is_platform_admin", "is_hotel_accessible", "can_manage_hotel", "can_manage_finances", "has_hotel_role"]) {
      expect(code, fn).not.toMatch(new RegExp(`create (or replace )?function public\\.${fn}\\(`, "i"));
    }
  });

  it("never names a new enum value as an enum literal before the transaction commits", () => {
    // 'developer'::public.app_role in a SQL function or a policy would fail when the file runs.
    expect(code).not.toMatch(/'(developer|sales)'::(public\.)?app_role/);
    expect(code).not.toMatch(/role\s*=\s*'(developer|sales)'/);
  });
});

describe.skipIf(!PGLITE_DIR)("the staff roles migration in PGlite", () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

  /** Runs `fn` as PostgREST would for this person's token, then puts the session back. */
  const as = async <T>(userId: string, aal: "aal1" | "aal2", fn: () => Promise<T>, session = "sess-laptop"): Promise<T> => {
    const now = Math.floor(Date.now() / 1000);
    const amr = aal === "aal2" ? [{ method: "totp", timestamp: now }, { method: "password", timestamp: now - 60 }] : [{ method: "password", timestamp: now }];
    const claims = JSON.stringify({ sub: userId, role: "authenticated", aal, amr, session_id: session });
    await db.exec(`
      select set_config('request.jwt.claim.sub', '${userId}', false);
      select set_config('request.jwt.claim.role', 'authenticated', false);
      select set_config('request.jwt.claims', '${claims}', false);
      set session authorization authenticator;
      set role authenticated;`);
    try {
      return await fn();
    } finally {
      await db.exec(`
        reset role;
        set session authorization postgres;
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

  /** True when the statement is refused outright or changes no row. */
  const refused = async (sql: string, params: unknown[] = []): Promise<boolean> => {
    try {
      const rows = await q(`with w as (${sql} returning 1) select count(*)::int as n from w`, params);
      return rows[0].n === 0;
    } catch {
      return true;
    }
  };
  const fails = async (sql: string, params: unknown[] = []): Promise<string | null> => {
    try {
      await q(sql, params);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const staffRoles = async (userId: string) =>
    (await q(`select coalesce(array_agg(role::text order by role::text), '{}') as r from public.app_roles where user_id = $1`, [userId]))[0].r;
  const eventTest = async (key: string) => (await q(`select is_test from public.product_events where dedupe_key = $1`, [key]))[0]?.is_test;
  const fnDef = async (name: string) =>
    (await q(`select pg_get_functiondef(p.oid) as d from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`, [name]))[0].d as string;

  /** What each restated function answered a platform admin before the file, to compare after. */
  const answersBefore: Record<string, unknown> = {};
  const definitionsBefore: Record<string, string> = {};
  const adminAnswers = () =>
    as(ADMIN, "aal1", async () => ({
      users: await q(`select * from public.platform_list_users() order by id`),
      count: await q(`select public.platform_count_users() as n`),
      team: await q(`select * from public.platform_list_hotel_users($1)`, [H]),
      pilot: await q(`select * from public.platform_pilot_health(true) order by hotel_id`),
      stalled: await q(`select * from public.platform_list_stalled_signups(0, true) order by hotel_id`),
      range: await q(`select public.analytics_range($1::date, $2::date, true) as r`, [night(-30), night(0)]),
      hotels: await q(
        `select id, name, timezone, currency, is_active, setup_pending_at, is_test, total_rooms_per_type, external_enterprise_id,
                created_at, updated_at, pms_type, pms_status, pms_last_sync_at, membership_count
           from public.platform_list_hotels() order by id`,
      ),
    }));

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

    // Production as it stood: one platform admin, a real paying property with
    // bookings, the developer's test property, a signup stuck at payment,
    // docs questions, alert channel lines and a signup code.
    await db.exec(`
      select set_config('request.jwt.claim.role', 'service_role', false);
      insert into auth.users (id, email, created_at) values
        ('${ADMIN}', 'jake@example.com', now() - interval '90 days'),
        ('${DEV}', 'developer@example.com', now() - interval '2 days'),
        ('${SALES}', 'sales@example.com', now() - interval '2 days'),
        ('${OWNER}', 'priya@example.com', now() - interval '60 days'),
        ('${OWNER2}', 'lee@example.com', now() - interval '5 days'),
        ('${STRANGER}', 'sam@example.com', now() - interval '1 day');
      insert into public.app_roles (user_id, role) values ('${ADMIN}', 'platform_admin');
      insert into public.hotels (id, name, timezone, is_test, created_at) values
        ('${H}', 'Harbour Inn', 'UTC', false, now() - interval '60 days'),
        ('${HT}', 'Sandbox', 'UTC', true, now() - interval '2 days'),
        ('${HS}', 'Dune Lodge', 'UTC', false, now() - interval '5 days');
      insert into public.hotel_memberships (hotel_id, user_id, role) values
        ('${H}', '${OWNER}', 'hotel_admin'), ('${HT}', '${DEV}', 'hotel_admin'), ('${HS}', '${OWNER2}', 'hotel_admin');
      insert into public.hotel_settings (hotel_id, simulation_mode) values ('${H}', false), ('${HT}', true)
        on conflict (hotel_id) do update set simulation_mode = excluded.simulation_mode;
      insert into public.pms_connections (hotel_id, pms_type, status, last_sync_at) values
        ('${H}', 'cloudbeds', 'connected', now() - interval '5 minutes');
      insert into public.signup_codes (id, code, kind, trial_days) values ('${CODE}', 'DRIFTWOOD', 'trial', 14);
      insert into public.hotel_subscriptions (hotel_id, stripe_customer_id, status, billing_interval, billed_rooms, plan_kind, created_at) values
        ('${H}', 'cus_harbour', 'active', 'month', 12, 'stripe', now() - interval '60 days');
      insert into public.hotel_subscriptions (hotel_id, stripe_customer_id, status, billing_interval, billed_rooms, plan_kind, signup_code_id, created_at) values
        ('${HS}', 'cus_dune', 'incomplete', 'year', 8, 'stripe', '${CODE}', now() - interval '3 days');
      insert into public.hotel_metrics_daily (day, hotel_id, status, entitled, plan_kind, rooms, list_mrr_cents, net_mrr_cents, simulation, is_test) values
        (current_date - 1, '${H}', 'active', true, 'stripe', 12, 25000, 20000, false, false),
        (current_date, '${H}', 'active', true, 'stripe', 12, 26000, 21000, false, false),
        (current_date, '${HT}', 'trialing', true, 'stripe', 3, 9900, 9900, true, true);
      insert into public.room_types (id, hotel_id, external_room_type_id, name, total_rooms, counts_as_room) values
        ('${KING}', '${H}', 'K', 'King', 10, true),
        ('${SUITE}', '${H}', 'S', 'Suite', 2, null),
        ('${COURT}', '${H}', 'C', 'Tennis court', 1, false),
        ('${SANDBOX_ROOM}', '${HT}', 'R', 'Room', 3, true);
      insert into public.room_type_out_of_service (hotel_id, room_type_id, start_date, end_date, units) values
        ('${H}', '${KING}', '${night(1)}', '${night(1)}', 2);
      insert into public.reservations (hotel_id, external_reservation_id, room_type_id, stay_date, base_rate, current_rate) values
        ('${H}', 'r1', '${KING}', '${night(1)}', 100, 95),
        ('${H}', 'r2', '${KING}', '${night(1)}', 120, 120),
        ('${H}', 'r3', '${KING}', '${night(1)}', null, 90),
        ('${H}', 'r4', '${SUITE}', '${night(1)}', 300, 300),
        ('${H}', 'r5', '${COURT}', '${night(1)}', 50, 50),
        ('${HT}', 't1', '${SANDBOX_ROOM}', '${night(1)}', 80, 80);
      insert into public.pricing_rules (id, hotel_id, name, action_type, action_direction, action_value)
        values ('${RULE}', '${H}', 'Busy', 'percent', 'increase', 10);
      insert into public.pending_memberships (id, email, hotel_id, role) values ('${PENDING}', 'new@example.com', '${H}', 'viewer');
      insert into public.docs_questions (source, question, page, signed_in) values ('unanswered', 'How do I take pricing live?', '/docs/live', true);
      insert into public.docs_ask_tally (outcome, section) values ('answered', 'rules'), ('none', '');
      insert into public.platform_audit_events (event_type, entity_type, entity_id, detail) values
        ('alert.channel', 'function', 'cloudbeds-sync', '{"state": "ready", "min_severity": "critical"}'),
        ('user.invited', 'pending_membership', '${PENDING}', '{"email": "new@example.com"}');
      -- Events already recorded: a platform admin's outside any property and
      -- inside a real one, and the owner's and the stranger's outside one.
      insert into public.product_events (event, hotel_id, user_id, source, is_test, dedupe_key) values
        ('screen.viewed', null, '${ADMIN}', 'app', false, 'seed:admin-alone'),
        ('rule.edited', '${H}', '${ADMIN}', 'trigger', false, 'seed:admin-harbour'),
        ('screen.viewed', null, '${OWNER}', 'app', false, 'seed:owner-alone'),
        ('screen.viewed', null, '${STRANGER}', 'app', false, 'seed:stranger-alone'),
        ('screen.viewed', null, '${DEV}', 'app', false, 'seed:dev-alone'),
        ('screen.viewed', '${HT}', '${DEV}', 'app', false, 'seed:dev-sandbox');
      select set_config('request.jwt.claim.role', '', false);
    `);

    Object.assign(answersBefore, await adminAnswers());
    for (const name of RESTATED) definitionsBefore[name] = await fnDef(name);

    // The file under test. Then the two new roles, which cannot exist before
    // it, with an event each from before they were staff; then the file again,
    // whose backfill must pick those up and change nothing else.
    await db.exec(fileSql(MIGRATION));
    await db.exec(`
      insert into public.app_roles (user_id, role) values ('${DEV}', 'developer'), ('${SALES}', 'sales');
      insert into public.product_events (event, hotel_id, user_id, source, is_test, dedupe_key) values
        ('screen.viewed', null, '${SALES}', 'app', false, 'seed:sales-alone');
    `);
    await db.exec(fileSql(MIGRATION));
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  describe("the roles and the one check", () => {
    it("adds developer and sales to the staff roles", async () => {
      expect((await q(`select enum_range(null::public.app_role)::text as r`))[0].r).toBe("{platform_admin,platform_support,developer,sales}");
    });

    it("tells each person their role, aal and sections, and asks staff for a code first", async () => {
      const access = async (user: string, aal: "aal1" | "aal2") =>
        as(user, aal, async () => (await q(`select public.staff_access() as a`))[0].a as Record<string, unknown>);
      expect(await access(ADMIN, "aal1")).toEqual({ role: "platform_admin", aal: "aal1", mfa_required: false, sections: ADMIN_SECTIONS });
      expect(await access(DEV, "aal1")).toEqual({ role: "developer", aal: "aal1", mfa_required: true, sections: [] });
      expect(await access(DEV, "aal2")).toEqual({ role: "developer", aal: "aal2", mfa_required: false, sections: DEVELOPER_SECTIONS });
      expect(await access(SALES, "aal1")).toEqual({ role: "sales", aal: "aal1", mfa_required: true, sections: [] });
      expect(await access(SALES, "aal2")).toEqual({ role: "sales", aal: "aal2", mfa_required: false, sections: SALES_SECTIONS });
      expect(await access(OWNER, "aal2")).toEqual({ role: null, aal: "aal2", mfa_required: false, sections: [] });
    });

    it("answers has_app_role and staff_can_read about the caller only", async () => {
      await as(DEV, "aal2", async () => {
        expect(await q(`select public.has_app_role('developer') as a, public.has_app_role('sales') as b, public.has_app_role('platform_admin') as c`)).toEqual([
          { a: true, b: false, c: false },
        ]);
        expect(await q(`select public.staff_can_read('users') as a, public.staff_can_read('analytics') as b, public.staff_can_read('nonsense') as c`)).toEqual([
          { a: true, b: false, c: false },
        ]);
      });
      await as(DEV, "aal1", async () => {
        expect(await q(`select public.has_app_role('developer') as a, public.staff_can_read('users') as b`)).toEqual([{ a: true, b: false }]);
      });
      await as(ADMIN, "aal1", async () => {
        expect(await q(`select public.staff_can_read('users') as a, public.staff_can_read('signup_codes') as b`)).toEqual([{ a: true, b: true }]);
      });
    });

    it("widens exactly the policies and functions the audit lists, and nothing else", async () => {
      const policies = await q(
        `select tablename || '.' || policyname as p from pg_policies
          where schemaname = 'public' and concat_ws(' ', qual, with_check) like '%staff_can_read%' order by 1`,
      );
      expect(policies.map((r) => r.p)).toEqual([
        "docs_ask_tally.docs_ask_tally_staff_read",
        "docs_questions.docs_questions_staff_read",
        "platform_audit_events.platform_audit_events_staff_alert_read",
        "pms_signup_gates.pms_signup_gates_staff_read",
      ]);
      const fns = await q(
        `select p.proname as f from pg_proc p where p.pronamespace = 'public'::regnamespace
            and p.prosrc like '%staff_can_read(%' and p.proname <> 'staff_access' order by 1`,
      );
      expect(fns.map((r) => r.f)).toEqual([
        "analytics_assert_reader",
        "platform_count_users",
        "platform_list_hotel_users",
        "platform_list_hotels",
        "platform_list_stalled_signups",
        "platform_list_users",
        "platform_pilot_health",
        "staff_hotel_business_numbers",
      ]);
      // Every table it touches keeps row level security on.
      const rls = await q(
        `select relname as t, relrowsecurity as on from pg_class where relnamespace = 'public'::regnamespace
            and relname in ('docs_questions', 'docs_ask_tally', 'platform_audit_events', 'pms_signup_gates', 'app_roles', 'product_events') order by 1`,
      );
      expect(rls.every((r) => r.on === true)).toBe(true);
      // And gives signed-in people nothing but a read of the PMS gates.
      expect(
        await q(`select string_agg(privilege_type, ',' order by privilege_type) as p from information_schema.role_table_grants
                  where table_name = 'pms_signup_gates' and grantee = 'authenticated'`),
      ).toEqual([{ p: "SELECT" }]);
    });

    it("leaves the functions it restates as they were, but for the check", async () => {
      const normalise: Record<(typeof RESTATED)[number], (d: string) => string> = {
        platform_list_users: (d) => d.replace("public.staff_can_read('users')", "public.is_platform_admin()"),
        platform_count_users: (d) => d.replace("public.staff_can_read('users')", "public.is_platform_admin()"),
        platform_list_hotel_users: (d) => d.replace("public.staff_can_read('hotel_team')", "public.is_platform_admin()"),
        platform_pilot_health: (d) => d.replace("public.staff_can_read('pilot_health')", "public.is_platform_admin()"),
        platform_list_stalled_signups: (d) =>
          d
            .replace("  -- staff_roles_v1: the code a signup used is for a platform admin's eyes only.\n  v_show_code boolean := public.is_platform_admin();\n", "")
            .replace("public.staff_can_read('stalled_signups')", "public.is_platform_admin()")
            .replace("case when v_show_code then sc.code end", "sc.code"),
        analytics_range: (d) =>
          d.replace(
            /and \(p_include_test\n\s+or \(strpos\(coalesce\(u\.email::text, ''\), '\+'\) = 0\n[\s\S]*?\('platform_admin', 'developer', 'sales'\)\)\)\)\),/,
            "and (p_include_test or strpos(coalesce(u.email::text, ''), '+') = 0)),",
          ),
      };
      for (const name of RESTATED) {
        const after = await fnDef(name);
        expect(after, name).not.toBe(definitionsBefore[name]);
        expect(normalise[name](after), name).toBe(definitionsBefore[name]);
      }
    });

    it("answers a platform admin exactly as before", async () => {
      const now = await adminAnswers();
      // The developer and the sales login have their roles now, which the Users list shows.
      const roles = new Map<unknown, unknown>([
        [DEV, ["developer"]],
        [SALES, ["sales"]],
      ]);
      expect(now.users.map((u) => u.platform_roles)).toEqual(
        (answersBefore.users as Record<string, unknown>[]).map((u) => roles.get(u.id) ?? u.platform_roles),
      );
      expect({ ...now, users: now.users.map((u) => ({ ...u, platform_roles: null })) }).toEqual({
        ...answersBefore,
        users: (answersBefore.users as Record<string, unknown>[]).map((u) => ({ ...u, platform_roles: null })),
      });
    });
  });

  describe("who reads what", () => {
    /** Each staff read, and two that stay admin only, as "could read" for the caller. */
    const probe = async () => {
      const ok = async (sql: string, params: unknown[] = []) => (await fails(sql, params)) === null;
      const rows = async (sql: string, params: unknown[] = []) => {
        try {
          return Number((await q(sql, params))[0].n) > 0;
        } catch {
          return false;
        }
      };
      return {
        users: await ok(`select * from public.platform_list_users()`),
        users_count: await ok(`select public.platform_count_users()`),
        hotels: await ok(`select * from public.platform_list_hotels()`),
        hotel_team: await ok(`select * from public.platform_list_hotel_users($1)`, [H]),
        pending_invites: await ok(`select * from public.platform_list_pending_invites()`),
        pilot_health: await ok(`select * from public.platform_pilot_health(true)`),
        stalled_signups: await ok(`select * from public.platform_list_stalled_signups(0, true)`),
        analytics: await ok(`select * from public.analytics_book(false)`),
        analytics_range: await ok(`select public.analytics_range(current_date - 7, current_date, false)`),
        owner_emails: await ok(`select * from public.analytics_owner_emails(array[$1]::uuid[])`, [OWNER]),
        business_numbers: await ok(`select * from public.staff_hotel_business_numbers($1, current_date, current_date + 3)`, [H]),
        docs_questions: await rows(`select count(*) as n from public.docs_questions`),
        docs_tally: await rows(`select count(*) as n from public.docs_ask_tally_counts(current_date - 7)`),
        alert_channel: await rows(`select count(*) as n from public.platform_audit_events where event_type = 'alert.channel'`),
        other_audit: await rows(`select count(*) as n from public.platform_audit_events where event_type <> 'alert.channel'`),
        pms_gates: await rows(`select count(*) as n from public.pms_signup_gates`),
        signup_codes: await rows(`select count(*) as n from public.signup_codes`),
        product_events: await rows(`select count(*) as n from public.product_events`),
        harbour_reservations: await rows(`select count(*) as n from public.reservations where hotel_id = $1`, [H]),
        harbour_row: await rows(`select count(*) as n from public.hotels where id = $1`, [H]),
      };
    };
    const NONE = {
      users: false,
      users_count: false,
      hotels: false,
      hotel_team: false,
      pending_invites: false,
      pilot_health: false,
      stalled_signups: false,
      analytics: false,
      analytics_range: false,
      owner_emails: false,
      business_numbers: false,
      docs_questions: false,
      docs_tally: false,
      alert_channel: false,
      other_audit: false,
      pms_gates: false,
      signup_codes: false,
      product_events: false,
      harbour_reservations: false,
      harbour_row: false,
    };

    it("a platform admin reads everything, with or without a code, as before", async () => {
      const all = Object.fromEntries(Object.keys(NONE).map((k) => [k, true]));
      expect(await as(ADMIN, "aal1", probe)).toEqual(all);
      expect(await as(ADMIN, "aal2", probe)).toEqual(all);
    });

    it("a developer reads nothing before the code, then only their sections", async () => {
      expect(await as(DEV, "aal1", probe)).toEqual(NONE);
      expect(await as(DEV, "aal2", probe)).toEqual({
        ...NONE,
        users: true,
        users_count: true,
        hotels: true,
        hotel_team: true,
        pilot_health: true,
        docs_questions: true,
        docs_tally: true,
        alert_channel: true,
        pms_gates: true,
      });
    });

    it("a sales login reads nothing before the code, then only their sections", async () => {
      expect(await as(SALES, "aal1", probe)).toEqual(NONE);
      expect(await as(SALES, "aal2", probe)).toEqual({
        ...NONE,
        hotels: true,
        pilot_health: true,
        stalled_signups: true,
        analytics: true,
        analytics_range: true,
        owner_emails: true,
        business_numbers: true,
        docs_questions: true,
        docs_tally: true,
        alert_channel: true,
      });
    });

    it("a property's owner and a stranger get no staff read, and the owner keeps their own property", async () => {
      expect(await as(OWNER, "aal2", probe)).toEqual({ ...NONE, hotel_team: true, harbour_reservations: true, harbour_row: true });
      expect(await as(STRANGER, "aal2", probe)).toEqual(NONE);
    });

    it("keeps guest-level rows from staff, and the developer's own test property his", async () => {
      for (const user of [DEV, SALES]) {
        await as(user, "aal2", async () => {
          expect(await q(`select count(*)::int as n from public.reservations where hotel_id = $1`, [H])).toEqual([{ n: 0 }]);
          expect(await q(`select count(*)::int as n from public.room_types where hotel_id = $1`, [H])).toEqual([{ n: 0 }]);
          await expect(q(`select count(*)::int as n from public.pending_memberships`)).rejects.toThrow(/permission denied/);
        });
      }
      await as(DEV, "aal1", async () => {
        expect(await q(`select external_reservation_id as r from public.reservations`)).toEqual([{ r: "t1" }]);
        expect(await q(`select name from public.hotels`)).toEqual([{ name: "Sandbox" }]);
      });
    });

    it("shows money on the hotel list for business numbers only, and a test property's to a platform admin only", async () => {
      const money = async (user: string) =>
        as(user, "aal2", async () =>
          Object.fromEntries(
            (await q(`select name, list_mrr_cents, net_mrr_cents, mrr_day is not null as dated from public.platform_list_hotels()`)).map((r) => [
              r.name,
              [r.list_mrr_cents, r.net_mrr_cents, r.dated],
            ]),
          ),
        );
      expect(await money(ADMIN)).toEqual({ "Harbour Inn": [26000, 21000, true], Sandbox: [9900, 9900, true], "Dune Lodge": [null, null, false] });
      expect(await money(SALES)).toEqual({ "Harbour Inn": [26000, 21000, true], Sandbox: [null, null, false], "Dune Lodge": [null, null, false] });
      expect(await money(DEV)).toEqual({ "Harbour Inn": [null, null, false], Sandbox: [null, null, false], "Dune Lodge": [null, null, false] });
    });

    it("gives every staff role the words a property's page shows: mode, plan, billing status, rooms", async () => {
      const row = await as(DEV, "aal2", async () => (await q(`select * from public.platform_list_hotels() where id = $1`, [H]))[0]);
      expect(row).toMatchObject({
        name: "Harbour Inn",
        simulation_mode: false,
        billing_status: "active",
        plan_kind: "stripe",
        billing_interval: "month",
        billed_rooms: 12,
        measured_rooms: 12,
        pms_type: "cloudbeds",
        pms_status: "connected",
        membership_count: 1,
      });
      const sandbox = await as(DEV, "aal2", async () => (await q(`select simulation_mode, billing_status from public.platform_list_hotels() where id = $1`, [HT]))[0]);
      expect(sandbox).toEqual({ simulation_mode: true, billing_status: null });
    });

    it("blanks a stalled signup's code for anyone but a platform admin", async () => {
      const code = async (user: string) =>
        as(user, "aal2", async () => (await q(`select signup_code, stage from public.platform_list_stalled_signups(0, true) where hotel_id = $1`, [HS]))[0]);
      expect(await code(ADMIN)).toEqual({ signup_code: "DRIFTWOOD", stage: "payment_incomplete" });
      expect(await code(SALES)).toEqual({ signup_code: null, stage: "payment_incomplete" });
    });

    it("shows only the alert channel lines of the audit log to staff", async () => {
      await as(DEV, "aal2", async () => {
        expect(await q(`select event_type from public.platform_audit_events`)).toEqual([{ event_type: "alert.channel" }]);
      });
    });
  });

  describe("business numbers", () => {
    it("adds a night up the way the calendar does: sellable rooms, rooms that count, every type's revenue", async () => {
      const rows = await as(SALES, "aal2", () =>
        q(
          `select stay_date::text as stay_date, rooms_sold, rooms_available, occupancy_pct::float8 as occupancy_pct,
                  room_revenue::float8 as room_revenue, adr::float8 as adr
             from public.staff_hotel_business_numbers($1, $2, $3)`,
          [H, night(1), night(2)],
        ),
      );
      expect(rows).toEqual([
        // King 10 less 2 out of service, Suite 2; the court is not a room. Sold 3 + 1.
        { stay_date: night(1), rooms_sold: 4, rooms_available: 10, occupancy_pct: 40, room_revenue: 660, adr: 152.5 },
        { stay_date: night(2), rooms_sold: 0, rooms_available: 12, occupancy_pct: 0, room_revenue: 0, adr: null },
      ]);
    });

    it("is for real properties only unless a platform admin asks, and for sales and admins only", async () => {
      expect(await as(SALES, "aal2", () => fails(`select * from public.staff_hotel_business_numbers($1, $2, $2)`, [HT, night(1)]))).toMatch(/real properties only/);
      expect(await as(ADMIN, "aal1", () => q(`select rooms_sold from public.staff_hotel_business_numbers($1, $2, $2)`, [HT, night(1)]))).toEqual([{ rooms_sold: 1 }]);
      expect(await as(DEV, "aal2", () => fails(`select * from public.staff_hotel_business_numbers($1, $2, $2)`, [H, night(1)]))).toMatch(/Not authorized/);
      expect(await as(OWNER, "aal2", () => fails(`select * from public.staff_hotel_business_numbers($1, $2, $2)`, [H, night(1)]))).toMatch(/Not authorized/);
      expect(await as(SALES, "aal2", () => fails(`select * from public.staff_hotel_business_numbers($1, $2, $3)`, [H, night(0), night(500)]))).toMatch(/401 nights/);
    });
  });

  describe("changing nothing", () => {
    beforeAll(async () => {
      // Even a support window in their name, in this very session, does nothing for them.
      await asService(() =>
        q(
          `insert into public.support_sessions (user_id, expires_at, auth_session_id) values
             ($1, now() + interval '30 minutes', 'sess-laptop'), ($2, now() + interval '30 minutes', 'sess-laptop')`,
          [DEV, SALES],
        ),
      );
    });

    for (const [who, user] of [
      ["developer", DEV],
      ["sales", SALES],
    ] as const) {
      it(`a ${who} login cannot turn on God Mode, even with a fresh code`, async () => {
        await as(user, "aal2", async () => {
          expect(await fails(`select public.god_mode_start()`)).toMatch(/Only MAYA staff/);
          expect(await q(`select public.god_mode_active() as on`)).toEqual([{ on: false }]);
          expect(await q(`select public.god_mode_status() ->> 'admin' as admin, public.god_mode_status() ->> 'active' as active`)).toEqual([
            { admin: "false", active: "false" },
          ]);
        });
      });

      it(`a ${who} login changes nothing on a customer's property, by table or by function`, async () => {
        await as(user, "aal2", async () => {
          expect(await refused(`update public.hotels set name = 'Hacked' where id = $1`, [H])).toBe(true);
          expect(await refused(`delete from public.hotels where id = $1`, [H])).toBe(true);
          expect(await refused(`insert into public.hotels (name) values ('New')`)).toBe(true);
          expect(await refused(`update public.hotel_settings set simulation_mode = true where hotel_id = $1`, [H])).toBe(true);
          expect(await refused(`update public.pricing_rules set name = 'Hacked' where id = $1`, [RULE])).toBe(true);
          expect(await refused(`insert into public.pricing_rules (hotel_id, name, action_type, action_direction, action_value) values ($1, 'x', 'percent', 'increase', 5)`, [H])).toBe(true);
          expect(await refused(`update public.hotel_memberships set role = 'viewer' where hotel_id = $1`, [H])).toBe(true);
          expect(await refused(`insert into public.hotel_memberships (hotel_id, user_id, role) values ($1, $2, 'hotel_admin')`, [H, user])).toBe(true);
          expect(await refused(`update public.pms_connections set status = 'disconnected' where hotel_id = $1`, [H])).toBe(true);
          expect(await refused(`update public.pms_signup_gates set requires_signup_code = false`)).toBe(true);
          expect(await refused(`update public.hotels set is_test = true where id = $1`, [H])).toBe(true);
          expect(await refused(`insert into public.app_roles (user_id, role) values ($1, 'platform_admin')`, [user])).toBe(true);
          expect(await refused(`insert into public.signup_codes (code, kind, trial_days) values ('MINE', 'trial', 30)`)).toBe(true);
          expect(await refused(`update public.docs_questions set note = 'x'`)).toBe(true);
          expect(await refused(`insert into public.support_sessions (user_id, expires_at) values ($1, now() + interval '1 hour')`, [user])).toBe(true);
          for (const [sql, params] of [
            [`select public.platform_invite_user('new2@example.com', $1, 'viewer')`, [H]],
            [`select public.platform_set_membership_role($1, $2, 'viewer')`, [H, OWNER]],
            [`select public.platform_remove_membership($1, $2)`, [H, OWNER]],
            [`select public.platform_revoke_pending($1)`, [PENDING]],
            [`select public.platform_flag_signup_abandoned($1, true, null)`, [HS]],
            [`select public.platform_log_event('hotel.changed', 'hotel', null, $1, '{}')`, [H]],
            [`select public.platform_grant_role($1, 'platform_admin')`, [user]],
            [`select public.platform_revoke_role($1, 'platform_admin')`, [ADMIN]],
            [`select public.platform_set_staff_role($1, 'platform_admin')`, [user]],
            [`select public.platform_set_staff_role($1, 'none')`, [ADMIN]],
            [`select public.set_pms_rate_changes($1, 'maya_wins', true)`, [H]],
            [`select public.staff_flag_test_events($1)`, [OWNER]],
          ] as const) {
            expect(await fails(sql, [...params]), sql).toMatch(/Not authorized|permission denied|God Mode|requires|not allowed/i);
          }
        });
        // Nothing moved.
        expect(await q(`select name, is_test from public.hotels where id = $1`, [H])).toEqual([{ name: "Harbour Inn", is_test: false }]);
        expect(await q(`select name from public.pricing_rules where id = $1`, [RULE])).toEqual([{ name: "Busy" }]);
        expect(await q(`select role::text as role from public.hotel_memberships where hotel_id = $1`, [H])).toEqual([{ role: "hotel_admin" }]);
        expect(await q(`select simulation_mode from public.hotel_settings where hotel_id = $1`, [H])).toEqual([{ simulation_mode: false }]);
        expect(await q(`select status::text as s from public.pending_memberships where id = $1`, [PENDING])).toEqual([{ s: "pending" }]);
        expect(await q(`select count(*)::int as n from public.pms_signup_gates where not requires_signup_code`)).toEqual([{ n: 0 }]);
        expect(await staffRoles(ADMIN)).toEqual(["platform_admin"]);
        expect(await staffRoles(user)).toEqual([who]);
      });
    }

    it("the developer keeps full use of his own property through his membership", async () => {
      await as(DEV, "aal1", async () => {
        expect(await refused(`update public.hotel_settings set strategy_floor = 70 where hotel_id = $1`, [HT])).toBe(false);
      });
    });
  });

  describe("the role picker", () => {
    it("refuses a platform admin outside God Mode, and staff always", async () => {
      await as(ADMIN, "aal1", async () => {
        expect(await fails(`select public.platform_set_staff_role($1, 'developer')`, [STRANGER])).toMatch(/God Mode/);
      });
      await as(ADMIN, "aal2", async () => {
        expect(await fails(`select public.platform_set_staff_role($1, 'developer')`, [STRANGER])).toMatch(/God Mode/);
      });
      for (const user of [DEV, SALES]) {
        await as(user, "aal2", async () => {
          expect(await fails(`select public.platform_set_staff_role($1, 'developer')`, [STRANGER])).toMatch(/God Mode/);
        });
      }
      expect(await staffRoles(STRANGER)).toEqual([]);
    });

    it("sets exactly one role in God Mode, logs every change, and marks the person's events outside a property as test", async () => {
      await asService(() => q(`delete from public.platform_audit_events where event_type like 'app_role.%'`));
      expect(await eventTest("seed:stranger-alone")).toBe(false);
      const set = (role: string) => q(`select public.platform_set_staff_role($1, $2) as r`, [STRANGER, role]).then((r) => r[0].r as Record<string, unknown>);
      await as(ADMIN, "aal2", async () => {
        await q(`select public.god_mode_start()`);
        expect(await set("developer")).toEqual({ user_id: STRANGER, role: "developer", previous: [], changed: true });
        expect(await set("Sales ")).toEqual({ user_id: STRANGER, role: "sales", previous: ["developer"], changed: true });
        expect(await set("sales")).toEqual({ user_id: STRANGER, role: "sales", previous: ["sales"], changed: false });
        expect(await set("platform_admin")).toMatchObject({ role: "platform_admin", previous: ["sales"], changed: true });
        expect(await set("none")).toEqual({ user_id: STRANGER, role: "none", previous: ["platform_admin"], changed: true });
        expect(await fails(`select public.platform_set_staff_role($1, 'owner')`, [STRANGER])).toMatch(/none, developer, sales or platform_admin/);
        expect(await fails(`select public.platform_set_staff_role($1, 'sales')`, ["99999999-9999-4999-8999-999999999999"])).toMatch(/No such user/);
        await q(`select public.god_mode_end()`);
      });
      expect(await staffRoles(STRANGER)).toEqual([]);
      const lines = await q(
        `select actor_user_id, event_type, entity_id, detail ->> 'role' as role, detail ->> 'via' as via
           from public.platform_audit_events where event_type like 'app_role.%' order by created_at, event_type desc`,
      );
      // One line per change and none for the repeat (lines written in the same instant have no order between them).
      expect(lines.map((l) => `${l.event_type} ${l.role}`).sort()).toEqual([
        "app_role.granted developer",
        "app_role.granted platform_admin",
        "app_role.granted sales",
        "app_role.revoked developer",
        "app_role.revoked platform_admin",
        "app_role.revoked sales",
      ]);
      expect(lines.every((l) => l.actor_user_id === ADMIN && l.entity_id === STRANGER && l.via === "staff_role")).toBe(true);
      // Once staff, the stranger's earlier event outside a property is a test one.
      expect(await eventTest("seed:stranger-alone")).toBe(true);
    });

    it("never removes the last platform admin, whoever asks", async () => {
      await as(ADMIN, "aal2", async () => {
        await q(`select public.god_mode_start()`);
        expect(await fails(`select public.platform_set_staff_role($1, 'developer')`, [ADMIN])).toMatch(/at least one platform admin/);
        expect(await fails(`select public.platform_revoke_role($1, 'platform_admin')`, [ADMIN])).toMatch(/last platform_admin/);
        await q(`select public.god_mode_end()`);
      });
      await asService(async () => {
        expect(await fails(`select public.platform_set_staff_role($1, 'none')`, [ADMIN])).toMatch(/at least one platform admin/);
        expect(await fails(`select public.platform_revoke_role($1, 'platform_admin')`, [ADMIN])).toMatch(/last platform_admin/);
        // With a second admin, either can go.
        await q(`select public.platform_set_staff_role($1, 'platform_admin')`, [OWNER2]);
        await q(`select public.platform_revoke_role($1, 'platform_admin')`, [OWNER2]);
        // Taking away a role the person does not have is not taking away the last admin.
        await q(`select public.platform_revoke_role($1, 'platform_admin')`, [OWNER]);
      });
      expect(await staffRoles(ADMIN)).toEqual(["platform_admin"]);
      expect(await staffRoles(OWNER2)).toEqual([]);
    });

    it("keeps the existing way of making someone a platform admin, and it marks their events too", async () => {
      await as(ADMIN, "aal2", async () => {
        await q(`select public.god_mode_start()`);
        await q(`select public.platform_grant_role($1, 'platform_admin')`, [OWNER2]);
        await q(`select public.platform_revoke_role($1, 'platform_admin')`, [OWNER2]);
        await q(`select public.god_mode_end()`);
      });
      expect(await staffRoles(OWNER2)).toEqual([]);
    });
  });

  describe("MAYA staff in analytics", () => {
    it("the backfill marked staff events outside a property as test, and left the rest alone", async () => {
      expect(await eventTest("seed:admin-alone")).toBe(true);
      expect(await eventTest("seed:dev-alone")).toBe(true);
      expect(await eventTest("seed:sales-alone")).toBe(true);
      // Inside a property, and everyone who is not staff: as before.
      expect(await eventTest("seed:admin-harbour")).toBe(false);
      expect(await eventTest("seed:dev-sandbox")).toBe(false);
      expect(await eventTest("seed:owner-alone")).toBe(false);
    });

    it("records a staff login's new events outside a real property as test ones, and inside one as before", async () => {
      const emit = (key: string, hotel: string | null, user: string | null, isTest: boolean | null = null) =>
        asService(() =>
          q(`select public.product_event_emit('screen.viewed', $1, $2, '{}'::jsonb, 'app', null, $3, null, null, null, $4) as id`, [hotel, user, key, isTest]),
        );
      await emit("new:dev-alone", null, DEV);
      await emit("new:dev-harbour", H, DEV);
      await emit("new:dev-sandbox", HT, DEV);
      await emit("new:admin-alone", null, ADMIN);
      await emit("new:admin-harbour", H, ADMIN);
      await emit("new:sales-said-real", null, SALES, false);
      await emit("new:owner-alone", null, OWNER);
      await emit("new:harbour-nobody", H, null);
      expect(
        Object.fromEntries(
          (await q(`select dedupe_key as k, is_test from public.product_events where dedupe_key like 'new:%' order by 1`)).map((r) => [r.k, r.is_test]),
        ),
      ).toEqual({
        "new:admin-alone": true,
        "new:admin-harbour": false,
        "new:dev-alone": true,
        "new:dev-harbour": false,
        "new:dev-sandbox": true,
        "new:harbour-nobody": false,
        "new:owner-alone": false,
        "new:sales-said-real": true,
      });
    });

    it("counts a confirmed staff login as a test account: its account.created, and the accounts tile", async () => {
      await db.exec(`update auth.users set email_confirmed_at = now() where id in ('${DEV}', '${OWNER}')`);
      expect(await q(`select user_id, is_test from public.product_events where event = 'account.created' order by is_test`)).toEqual([
        { user_id: OWNER, is_test: false },
        { user_id: DEV, is_test: true },
      ]);
      const accounts = async (includeTest: boolean) =>
        as(ADMIN, "aal1", async () => (await q(`select (public.analytics_range(current_date, current_date, $1) ->> 'accounts')::int as n`, [includeTest]))[0].n);
      expect(await accounts(false)).toBe(1);
      expect(await accounts(true)).toBe(2);
    });
  });
});
