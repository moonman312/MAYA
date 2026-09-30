/**
 * Every function that runs with the owner's rights, checked against who may
 * call it. Standing: it builds production's whole schema in PGlite
 * (01, 02, every migration in MIGRATION_ORDER and the cadence file) under
 * Supabase's default privileges, which grant EXECUTE on every new function to
 * anon, authenticated and service_role directly, so a `revoke from public`
 * alone leaves a function open. Then, for each SECURITY DEFINER function in
 * the public schema that is not a trigger function:
 *
 *   - anon must not be able to execute it. No exceptions: nothing MAYA does
 *     runs as anon against PostgREST.
 *   - if authenticated can execute it, its body must check the caller
 *     (is_hotel_accessible, can_manage_hotel, can_manage_finances,
 *     has_hotel_role, is_platform_admin, my_hotel_rank, auth.uid(),
 *     auth.role(), analytics_assert_reader, god_mode_active or
 *     god_mode_status), or the function must be listed below with the reason
 *     it needs no check of its own.
 *
 * This is how onboarding_daily_room_nights and onboarding_room_type_stats
 * were open to everyone for weeks (audit A3): the migration that made them
 * revoked from public only, and nothing looked. A new function that repeats
 * the mistake fails this test.
 *
 * Also runs 99_supabase_migration_definer_lockdown_v1.sql for real, twice,
 * on the schema as it was before it: what it closes, and what it leaves.
 *
 * Only runs with MAYA_PGLITE_DIR set (see pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_definer_lockdown_v1.sql";

const CADENCE_TEST = readFileSync(resolve(__dirname, "../engine/pricing-cadence-sql.test.ts"), "utf8");

/** The order production ran the migrations in, read off the cadence test's list. */
const MIGRATION_ORDER: string[] = (() => {
  const list = CADENCE_TEST.slice(CADENCE_TEST.indexOf("MIGRATION_ORDER = ["), CADENCE_TEST.indexOf("];", CADENCE_TEST.indexOf("MIGRATION_ORDER = [")));
  return [...list.matchAll(/"(99_supabase_migration_[^"]+\.sql)"/g)].map((m) => m[1]);
})();

/** What Supabase provides and the files assume, read off the cadence test so there is one copy. */
const PLATFORM: string = (() => {
  const start = CADENCE_TEST.indexOf("export const PLATFORM = `") + "export const PLATFORM = `".length;
  return CADENCE_TEST.slice(start, CADENCE_TEST.indexOf("`;", start));
})();

/**
 * Supabase's bootstrap default privileges for objects the postgres role
 * creates in public: EXECUTE on functions to anon, authenticated and
 * service_role directly. Without this the schema here would be stricter than
 * production, and the test would pass where production fails.
 */
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

async function buildSchema(migrations: string[]): Promise<Db> {
  const dist = `${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist`;
  const mod = await import(/* @vite-ignore */ pathToFileURL(`${dist}/index.js`).href);
  const { pgcrypto } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/pgcrypto.js`).href);
  const { citext } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/citext.js`).href);
  const db = new mod.PGlite({ extensions: { pgcrypto, citext } }) as Db;
  await db.exec(PLATFORM);
  await db.exec(SUPABASE_DEFAULT_PRIVILEGES);
  for (const name of ["01_supabase_base_schema.sql", "02_supabase_schema.sql", ...migrations]) {
    try {
      await db.exec(fileSql(name));
    } catch (e) {
      throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return db;
}

type DefinerFunction = {
  name: string;
  sig: string;
  anon: boolean;
  authenticated: boolean;
  serviceRole: boolean;
  /** pg_get_functiondef with the SQL comments taken out, so a check named in a comment does not count. */
  body: string;
};

async function definerFunctions(db: Db): Promise<DefinerFunction[]> {
  const { rows } = await db.query(`
    select p.proname as name, p.oid::regprocedure::text as sig,
           has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
           has_function_privilege('service_role', p.oid, 'execute') as service_role,
           pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.prokind in ('f', 'p')
       and p.prosecdef
       and p.prorettype <> 'trigger'::regtype
     order by p.proname, sig`);
  return rows.map((r) => ({
    name: String(r.name),
    sig: String(r.sig),
    anon: r.anon === true,
    authenticated: r.authenticated === true,
    serviceRole: r.service_role === true,
    body: String(r.def)
      .replace(/--[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, ""),
  }));
}

/** A body that asks who is calling before it answers. */
const CALLER_CHECKS = [
  "is_hotel_accessible(",
  "can_manage_hotel(",
  "can_manage_finances(",
  "has_hotel_role(",
  "is_platform_admin(",
  "my_hotel_rank(",
  "auth.uid()",
  "auth.role()",
  "analytics_assert_reader(",
  "god_mode_active(",
  "god_mode_status(",
];

function checksCaller(fn: DefinerFunction): boolean {
  // The definition's header repeats the function's own name, so a helper is
  // not taken as checking itself: only the body after `AS` counts.
  const bodyStart = fn.body.search(/\bAS\s+\$/);
  const body = bodyStart >= 0 ? fn.body.slice(bodyStart) : fn.body;
  return CALLER_CHECKS.some((token) => body.includes(token));
}

/**
 * Functions authenticated may execute without a check of their own, each
 * with the reason. Nothing else is excused: a new function that takes a
 * hotel id and answers any signed-in caller fails the test until it checks
 * is_hotel_accessible (or the right helper) or is listed here with a reason.
 */
const AUTHENTICATED_WITHOUT_CHECK: Record<string, string> = {
  rule_hotel_id:
    "Used inside the row level security policies of the rule child tables (rule_condition, rule_signal_room_type, " +
    "rule_affected_room_type) to find the rule's hotel, so authenticated must be able to execute it. It answers a " +
    "hotel id for a rule id and nothing else; the policy that calls it then asks is_hotel_accessible.",
  rule_repeat_alert_resume:
    "Every call is handed to rule_repeat_alert_resume_many, which checks can_manage_hotel on the alert's hotel " +
    "before it writes anything.",
};

describe("the migration file", () => {
  it("is on the list the SQL tests build production's schema from, right after the non-room types migration", () => {
    const at = MIGRATION_ORDER.indexOf(MIGRATION);
    expect(at).toBeGreaterThan(0);
    expect(MIGRATION_ORDER[at - 1]).toBe("99_supabase_migration_non_room_types_v1.sql");
  });

  it("is one transaction and creates no table, function or policy", () => {
    const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8").replace(/--.*$/gm, "");
    expect(sql.match(/\bbegin;/g)).toHaveLength(1);
    expect(sql.match(/\bcommit;/g)).toHaveLength(1);
    expect(sql).not.toMatch(/create table|alter table|create policy|drop policy|create (or replace )?function/i);
  });
});

describe.skipIf(!PGLITE_DIR)("every SECURITY DEFINER function in public, on production's whole schema", () => {
  let db: Db;
  let fns: DefinerFunction[];

  beforeAll(async () => {
    db = await buildSchema([...MIGRATION_ORDER, "99_supabase_migration_pricing_cadence_v1.sql"]);
    fns = await definerFunctions(db);
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  it("found the functions, the RLS helpers among them", () => {
    const names = new Set(fns.map((f) => f.name));
    expect(names.size).toBeGreaterThan(50);
    for (const helper of ["is_hotel_accessible", "can_manage_hotel", "can_manage_finances", "is_platform_admin", "pms_secret_get", "save_rule"]) {
      expect(names.has(helper)).toBe(true);
    }
  });

  it("none can be executed by anon", () => {
    expect(fns.filter((f) => f.anon).map((f) => f.sig)).toEqual([]);
  });

  it("every one authenticated can execute checks the caller inside, or is listed with the reason it need not", () => {
    const open = fns.filter((f) => f.authenticated && !checksCaller(f) && !(f.name in AUTHENTICATED_WITHOUT_CHECK));
    expect(open.map((f) => f.sig)).toEqual([]);
  });

  it("the listed exceptions are still real functions, still without a check of their own, so a stale entry is noticed", () => {
    for (const [name, reason] of Object.entries(AUTHENTICATED_WITHOUT_CHECK)) {
      expect(reason.length).toBeGreaterThan(40);
      const fn = fns.find((f) => f.name === name);
      expect(fn, `${name} is listed as an exception but no longer exists`).toBeDefined();
      expect(checksCaller(fn!), `${name} now checks the caller; drop it from the exceptions`).toBe(false);
    }
  });

  it("the reasons hold: rule_hotel_id is in the rule child tables' policies, and rule_repeat_alert_resume hands off to the checked function", async () => {
    const { rows: policies } = await db.query(
      `select c.relname as table_name from pg_policy p join pg_class c on c.oid = p.polrelid
        where pg_get_expr(p.polqual, p.polrelid) like '%rule_hotel_id(%' or pg_get_expr(p.polwithcheck, p.polrelid) like '%rule_hotel_id(%'
        group by c.relname order by 1`,
    );
    expect(policies.map((r) => r.table_name)).toEqual(expect.arrayContaining(["rule_affected_room_type", "rule_condition", "rule_signal_room_type"]));
    const resume = fns.find((f) => f.name === "rule_repeat_alert_resume")!;
    expect(resume.body).toContain("rule_repeat_alert_resume_many(");
    expect(checksCaller(fns.find((f) => f.name === "rule_repeat_alert_resume_many")!)).toBe(true);
  });

  it("the two onboarding statistics functions stay closed to everyone but the service role", () => {
    for (const name of ["onboarding_daily_room_nights", "onboarding_room_type_stats", "hotel_has_live_subscription"]) {
      const fn = fns.find((f) => f.name === name)!;
      expect(fn, name).toBeDefined();
      expect([fn.anon, fn.authenticated, fn.serviceRole], name).toEqual([false, false, true]);
    }
  });

  it("the check itself tells a real check from its name in a comment or in the header", async () => {
    await db.exec(`
      create function public.zz_probe_unchecked(p_hotel_id uuid) returns integer
        language sql security definer set search_path = public, pg_temp as
        $$ select 1 $$;
      comment on function public.zz_probe_unchecked(uuid) is 'is_hotel_accessible( is only mentioned here';
      create function public.zz_probe_checked(p_hotel_id uuid) returns integer
        language sql security definer set search_path = public, pg_temp as
        $$ select case when public.is_hotel_accessible(p_hotel_id) then 1 else 0 end $$;
      create function public.zz_probe_commented(p_hotel_id uuid) returns integer
        language sql security definer set search_path = public, pg_temp as
        $$ select 1 -- is_hotel_accessible(p_hotel_id) would go here
        $$;
      -- A helper's own name in its header is not a check of the caller.
      create function public.is_hotel_accessible_probe(p_hotel_id uuid) returns boolean
        language sql security definer set search_path = public, pg_temp as
        $$ select true $$;
    `);
    const probes = (await definerFunctions(db)).filter((f) => f.name.startsWith("zz_probe") || f.name === "is_hotel_accessible_probe");
    const byName = Object.fromEntries(probes.map((f) => [f.name, f]));
    expect(byName.zz_probe_unchecked.anon).toBe(true); // the default privileges left it open, as production would
    expect(checksCaller(byName.zz_probe_unchecked)).toBe(false);
    expect(checksCaller(byName.zz_probe_checked)).toBe(true);
    expect(checksCaller(byName.zz_probe_commented)).toBe(false);
    expect(checksCaller(byName.is_hotel_accessible_probe)).toBe(false);
    await db.exec(`
      drop function public.zz_probe_unchecked(uuid);
      drop function public.zz_probe_checked(uuid);
      drop function public.zz_probe_commented(uuid);
      drop function public.is_hotel_accessible_probe(uuid);
    `);
  });
});

describe.skipIf(!PGLITE_DIR)("the definer lockdown migration in PGlite", () => {
  let db: Db;
  let before: DefinerFunction[];

  beforeAll(async () => {
    db = await buildSchema([...MIGRATION_ORDER.slice(0, MIGRATION_ORDER.indexOf(MIGRATION)), "99_supabase_migration_pricing_cadence_v1.sql"]);
    before = await definerFunctions(db);
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  it("starts with the sixteen functions the audit found open to anon, closes every one, and leaves authenticated and the service role as they were", async () => {
    const openBefore = before.filter((f) => f.anon).map((f) => f.name).sort();
    expect(openBefore).toEqual(
      [
        "can_manage_finances",
        "my_hotel_rank",
        "platform_flag_signup_abandoned",
        "platform_invite_user",
        "platform_list_hotel_users",
        "platform_list_hotels",
        "platform_list_pending_invites",
        "platform_list_stalled_signups",
        "platform_list_users",
        "platform_log_event",
        "platform_remove_membership",
        "platform_revoke_pending",
        "platform_set_membership_role",
        "pms_secret_delete",
        "pms_secret_get",
        "pms_secret_set",
      ].sort(),
    );
    expect(before.find((f) => f.name === "hotel_has_live_subscription")).toMatchObject({ anon: false, authenticated: true, serviceRole: true });

    await db.exec(fileSql(MIGRATION));
    const after = await definerFunctions(db);
    expect(after.filter((f) => f.anon).map((f) => f.sig)).toEqual([]);
    expect(after.find((f) => f.name === "hotel_has_live_subscription")).toMatchObject({ anon: false, authenticated: false, serviceRole: true });
    // Everyone else keeps exactly what they had.
    const grants = (list: DefinerFunction[]) =>
      Object.fromEntries(list.filter((f) => f.name !== "hotel_has_live_subscription").map((f) => [f.sig, [f.authenticated, f.serviceRole]]));
    expect(grants(after)).toEqual(grants(before));
    expect(after.length).toBe(before.length);
  });

  it("changes nothing more on a second run", async () => {
    const once = await definerFunctions(db);
    await db.exec(fileSql(MIGRATION));
    expect(await definerFunctions(db)).toEqual(once);
  });

  it("keeps authenticated's and the service role's access to a function they could execute only through public", async () => {
    // Not how Supabase's default privileges create a function (they grant the
    // three roles directly), but how one created under other defaults, or
    // with its grants edited by hand, can stand: PostgreSQL's own default
    // gives EXECUTE to public, and the roles have nothing of their own. A
    // plain `revoke from public` would close it to a signed-in owner too, and
    // a policy calling it would answer 42501 to every signed-in query.
    await db.exec(`
      create function public.zz_probe_public_only(p_hotel_id uuid) returns boolean
        language sql security definer set search_path = public, pg_temp as
        $$ select public.is_hotel_accessible(p_hotel_id) $$;
      revoke all on function public.zz_probe_public_only(uuid) from anon, authenticated, service_role;
      grant execute on function public.zz_probe_public_only(uuid) to public;
      create function public.zz_probe_service_only(p_hotel_id uuid) returns boolean
        language sql security definer set search_path = public, pg_temp as
        $$ select true $$;
      revoke all on function public.zz_probe_service_only(uuid) from public, anon, authenticated;
    `);
    const probe = (list: DefinerFunction[], name: string) => list.find((f) => f.name === name)!;
    const before = await definerFunctions(db);
    expect(probe(before, "zz_probe_public_only")).toMatchObject({ anon: true, authenticated: true, serviceRole: true });
    expect(probe(before, "zz_probe_service_only")).toMatchObject({ anon: false, authenticated: false, serviceRole: true });

    await db.exec(fileSql(MIGRATION));
    const after = await definerFunctions(db);
    expect(probe(after, "zz_probe_public_only")).toMatchObject({ anon: false, authenticated: true, serviceRole: true });
    expect(probe(after, "zz_probe_service_only")).toMatchObject({ anon: false, authenticated: false, serviceRole: true });
    // The grant is now the role's own, not public's.
    const { rows } = await db.query(
      `select a.grantee::regrole::text as grantee from pg_proc p, aclexplode(p.proacl) a
        where p.oid = 'public.zz_probe_public_only(uuid)'::regprocedure and a.privilege_type = 'EXECUTE' order by 1`,
    );
    expect(rows.map((r) => r.grantee).sort()).toEqual(["authenticated", "postgres", "service_role"]);
    // Everyone else exactly as before.
    const rest = (list: DefinerFunction[]) => list.filter((f) => !f.name.startsWith("zz_probe"));
    expect(rest(after)).toEqual(rest(before));

    await db.exec(`
      drop function public.zz_probe_public_only(uuid);
      drop function public.zz_probe_service_only(uuid);
    `);
  });

  it("a signed-out caller is refused at the door, and a signed-in one still reaches the body's own check", async () => {
    await db.exec("set role anon");
    try {
      await expect(db.query("select public.can_manage_finances('00000000-0000-0000-0000-000000000001')")).rejects.toThrow(/permission denied/);
      await expect(db.query("select public.pms_secret_get('00000000-0000-0000-0000-000000000001', 'cloudbeds')")).rejects.toThrow(/permission denied/);
      await expect(db.query("select * from public.platform_list_hotels(null)")).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role");
    }
    await db.exec("set role authenticated");
    try {
      // No JWT: the body answers false, or refuses in its own words. Never a leak.
      const { rows } = await db.query("select public.can_manage_finances('00000000-0000-0000-0000-000000000001') as v");
      expect(rows[0].v).toBe(false);
      await expect(db.query("select * from public.platform_list_hotels(null)")).rejects.toThrow(/Not authorized|permission denied|42501/i);
      await expect(db.query("select public.hotel_has_live_subscription('00000000-0000-0000-0000-000000000001')")).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role");
    }
  });
});
