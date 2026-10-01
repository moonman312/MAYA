/**
 * 99_supabase_migration_pricing_records_v1.sql run for real in PGlite, twice,
 * on top of every migration before it (audits A24, A28, A29, A31):
 *
 *   - a rule can only name room types of its own hotel;
 *   - the audit clean-up keeps each night's newest row while the night is
 *     ahead (engine_audit_purge, and the nightly sweep in both its forms);
 *   - every change to a send ledger row lands in the send log, which is only
 *     ever added to and kept 13 months, with the push run and build that
 *     wrote it; the run log carries the build;
 *   - Pilot health counts MAYA's own holds and shows the latest run's build.
 *
 * Only runs with MAYA_PGLITE_DIR set (see engine/pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { causeFacts } from "../../../supabase/functions/_shared/pms/push-failure";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_pricing_records_v1.sql";
const CADENCE_FILE = "99_supabase_migration_pricing_cadence_v1.sql";

const CADENCE_TEST = readFileSync(resolve(__dirname, "./pricing-cadence-sql.test.ts"), "utf8");

/** The order production ran the migrations in, read off the cadence test's list. */
const MIGRATION_ORDER: string[] = (() => {
  const start = CADENCE_TEST.indexOf("MIGRATION_ORDER = [");
  const list = CADENCE_TEST.slice(start, CADENCE_TEST.indexOf("];", start));
  return [...list.matchAll(/"(99_supabase_migration_[^"]+\.sql)"/g)].map((m) => m[1]);
})();

/** Every file before this one, with the cadence file where production ran it. */
const BEFORE: string[] = (() => {
  const before = MIGRATION_ORDER.slice(0, MIGRATION_ORDER.indexOf(MIGRATION));
  const m = CADENCE_TEST.match(/CADENCE_RUNS_BEFORE = "([^"]+)"/);
  const at = m ? before.indexOf(m[1]) : -1;
  return at < 0 ? [...before, CADENCE_FILE] : [...before.slice(0, at), CADENCE_FILE, ...before.slice(at)];
})();

/** What Supabase provides and the files assume, read off the cadence test so there is one copy. */
const PLATFORM: string = (() => {
  const start = CADENCE_TEST.indexOf("export const PLATFORM = `") + "export const PLATFORM = `".length;
  return CADENCE_TEST.slice(start, CADENCE_TEST.indexOf("`;", start));
})();

/** Supabase's default privileges: every new function and table open to anon and authenticated until revoked. */
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

/** The file with the bodies of its functions and procedures left out. */
function outsideBodies(sql: string): string {
  return sql.replace(/--.*$/gm, "").replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
}

const H1 = "11111111-1111-4111-8111-111111111401";
const H2 = "11111111-1111-4111-8111-111111111402";
const GARDEN = "44444444-4444-4444-8444-444444444401";
const LOFT = "44444444-4444-4444-8444-444444444402";
const GARDEN_2 = "44444444-4444-4444-8444-444444444403";
const RULE = "55555555-5555-4555-8555-555555555401";
const GM = "33333333-3333-4333-8333-333333333401";

describe("the migration file", () => {
  const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8");
  const code = outsideBodies(sql);

  it("is on the list the SQL tests build production's schema from, right after the paying-only claim file", () => {
    expect(MIGRATION_ORDER).toContain(MIGRATION);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBe(MIGRATION_ORDER.indexOf("99_supabase_migration_sync_claim_paying_only_v1.sql") + 1);
  });

  it("is one transaction, keeps row level security on and never grants anon anything", () => {
    expect(code.match(/\bbegin;/g)).toHaveLength(1);
    expect(code.match(/\bcommit;/g)).toHaveLength(1);
    expect(code).not.toMatch(/disable row level security/i);
    expect(code).not.toMatch(/grant[^;]*\banon\b/i);
  });

  it("revokes execute from public and anon on every function it defines", () => {
    const defined = [...code.matchAll(/create (?:or replace )?(?:function|procedure) (public\.[a-z_]+)\(/g)].map((m) => m[1]);
    expect(defined.sort()).toEqual(
      [
        "public.engine_audit_purge",
        "public.engine_data_sweep",
        "public.engine_data_sweep_proc",
        "public.platform_pilot_health",
        "public.pricing_rule_stays_with_its_room_types",
        "public.rate_send_log_guard",
        "public.rate_updates_send_log",
        "public.rule_room_type_same_hotel",
      ].sort(),
    );
    for (const fn of defined) {
      expect(code).toMatch(new RegExp(`revoke all on (?:function|procedure) ${fn.replace(".", "\\.")}\\([^)]*\\) from public, anon`));
    }
  });

  it("restates the sweep and Pilot health from their newest definitions, keeping what they had", () => {
    const sweep = sql.slice(sql.indexOf("create or replace function public.engine_data_sweep("));
    expect(sweep).toContain("snapshot_ts < now() - make_interval(days => p_snapshot_days)");
    expect(sweep).toContain("evaluated_at < now() - make_interval(days => p_run_log_days)");
    const proc = sql.slice(sql.indexOf("create or replace procedure public.engine_data_sweep_proc("));
    expect(proc).toContain("v_snapshot_cut timestamptz := now() - make_interval(days => p_snapshot_days);");
    const health = sql.slice(sql.indexOf("create function public.platform_pilot_health("));
    for (const kept of ["staff_can_read('pilot_health')", "guardrail:no_rate_on_record", "brc.pms_removed_at is not null", "h.data_purged_at is null"]) {
      expect(health).toContain(kept);
    }
  });

  it("counts as MAYA's own holds exactly the guardrails push-failure.ts marks as should never happen", () => {
    const m = sql.match(/and i\.cause in \(([^)]*)\)/);
    const listed = [...(m?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    const causes = ["guardrail_invalid_price", "guardrail_invalid_bounds", "guardrail_stale_price", "guardrail_below_floor", "guardrail_inactive_room_type", "guardrail_outside_window", "guardrail_not_a_room", "guardrail_zero_base", "guardrail_no_rate_on_record", "guardrail_above_ceiling"];
    expect(listed).toEqual(causes.filter((c) => causeFacts(c).mayaBug).sort());
  });
});

describe.skipIf(!PGLITE_DIR)("the pricing records migration in PGlite", () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

  /** Runs `fn` as `role` (a signed-in member, or the service role), then puts the session back. */
  const as = async <T>(role: "authenticated" | "service_role", fn: () => Promise<T>, userId = ""): Promise<T> => {
    await db.exec(`
      select set_config('request.jwt.claim.sub', '${userId}', false);
      select set_config('request.jwt.claim.role', '${role}', false);
      set role ${role};`);
    try {
      return await fn();
    } finally {
      await db.exec(`
        reset role;
        select set_config('request.jwt.claim.sub', '', false);
        select set_config('request.jwt.claim.role', 'service_role', false);`);
    }
  };

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
    // A rule naming another hotel's room type, written before this file.
    await db.exec(`
      select set_config('request.jwt.claim.role', 'service_role', false);
      insert into auth.users (id, email) values ('${GM}', 'gm@example.com');
      insert into public.hotels (id, name, timezone, is_active) values
        ('${H1}', 'Juniper Lodge', 'UTC', true), ('${H2}', 'Harbour Inn', 'UTC', true);
      insert into public.hotel_memberships (hotel_id, user_id, role) values ('${H1}', '${GM}', 'general_manager');
      insert into public.room_types (id, hotel_id, external_room_type_id, name) values
        ('${GARDEN}', '${H1}', 'g', 'Garden Room'), ('${GARDEN_2}', '${H1}', 'g2', 'Garden Room 2'), ('${LOFT}', '${H2}', 'l', 'Loft');
      insert into public.pricing_rules (id, hotel_id, name, action_type, action_direction, action_value)
        values ('${RULE}', '${H1}', 'Busy', 'percent', 'decrease', 10);
      insert into public.rule_affected_room_type (rule_id, room_type_id) values ('${RULE}', '${LOFT}');
    `);

    // The file under test, twice: it is safe to run again.
    await db.exec(fileSql(MIGRATION));
    await db.exec(fileSql(MIGRATION));
    await db.exec(`select set_config('request.jwt.claim.role', 'service_role', false);`);
  }, 240_000);

  afterAll(async () => {
    await db?.close();
  });

  describe("a rule's room types are its hotel's own (A24)", () => {
    it("refuses a rule naming another hotel's room type, as changed or as measured", async () => {
      await expect(db.exec(`insert into public.rule_signal_room_type (rule_id, room_type_id) values ('${RULE}', '${LOFT}')`)).rejects.toThrow(
        /only name room types of its own property/,
      );
      await db.exec(`insert into public.rule_affected_room_type (rule_id, room_type_id) values ('${RULE}', '${GARDEN}'), ('${RULE}', '${GARDEN_2}')`);
      await db.exec(`insert into public.rule_signal_room_type (rule_id, room_type_id) values ('${RULE}', '${GARDEN}')`);
      await expect(
        db.exec(`update public.rule_affected_room_type set room_type_id = '${LOFT}' where rule_id = '${RULE}' and room_type_id = '${GARDEN_2}'`),
      ).rejects.toThrow(/only name room types of its own property/);
      await db.exec(`delete from public.rule_affected_room_type where rule_id = '${RULE}' and room_type_id = '${GARDEN_2}'`);
    });

    it("leaves a row written before it where it is, for the engine to ignore", async () => {
      const rows = await q(`select room_type_id::text as rt from public.rule_affected_room_type where rule_id = $1 order by 1`, [RULE]);
      expect(rows.map((r) => r.rt)).toEqual([GARDEN, LOFT].sort());
    });

    it("refuses moving a rule to another hotel while it names room types, and allows a rename", async () => {
      await expect(db.exec(`update public.pricing_rules set hotel_id = '${H2}' where id = '${RULE}'`)).rejects.toThrow(
        /only name room types of its own property/,
      );
      await db.exec(`update public.pricing_rules set name = 'Busy nights' where id = '${RULE}'`);
      const [{ name }] = await q(`select name from public.pricing_rules where id = $1`, [RULE]);
      expect(name).toBe("Busy nights");
    });
  });

  describe("the audit clean-up keeps each night's newest row (A31)", () => {
    const seedAudit = async () => {
      await db.exec(`
        truncate public.evaluation_audit;
        insert into public.evaluation_audit (id, evaluation_run_id, hotel_id, stay_date, room_type_id, evaluated_at, base_price, floor_price, ceiling_price, ladder_subtotal_delta, pickup_subtotal_delta, pre_clamp_price, final_price, details) values
          -- A night ahead nothing has moved for 120 days: its only row.
          ('a0000000-0000-4000-8000-000000000001', gen_random_uuid(), '${H1}', (now() at time zone 'utc')::date + 150, '${GARDEN}', now() - interval '120 days', 100, 1, 999, 0, 0, 100, 100, '{}'),
          -- A night ahead with a newer row: the old one goes.
          ('b0000000-0000-4000-8000-000000000001', gen_random_uuid(), '${H1}', (now() at time zone 'utc')::date + 60, '${GARDEN}', now() - interval '150 days', 100, 1, 999, 0, 0, 100, 100, '{}'),
          ('b0000000-0000-4000-8000-000000000002', gen_random_uuid(), '${H1}', (now() at time zone 'utc')::date + 60, '${GARDEN}', now() - interval '10 days', 100, 1, 999, 0, 0, 110, 110, '{}'),
          -- Two old rows of one run instant on a night ahead: the larger id is the newer.
          ('c0000000-0000-4000-8000-000000000001', gen_random_uuid(), '${H1}', (now() at time zone 'utc')::date + 90, '${GARDEN_2}', now() - interval '100 days', 100, 1, 999, 0, 0, 100, 100, '{}'),
          ('c0000000-0000-4000-8000-000000000002', gen_random_uuid(), '${H1}', (now() at time zone 'utc')::date + 90, '${GARDEN_2}', (select now() - interval '100 days'), 100, 1, 999, 0, 0, 100, 100, '{}'),
          -- A night that has passed: its old row goes, newest or not.
          ('d0000000-0000-4000-8000-000000000001', gen_random_uuid(), '${H1}', (now() at time zone 'utc')::date - 30, '${GARDEN}', now() - interval '120 days', 100, 1, 999, 0, 0, 100, 100, '{}'),
          -- Yesterday in UTC may still be tonight somewhere: kept.
          ('e0000000-0000-4000-8000-000000000001', gen_random_uuid(), '${H1}', (now() at time zone 'utc')::date - 1, '${GARDEN}', now() - interval '120 days', 100, 1, 999, 0, 0, 100, 100, '{}'),
          -- Another hotel's.
          ('f0000000-0000-4000-8000-000000000001', gen_random_uuid(), '${H2}', (now() at time zone 'utc')::date - 30, '${LOFT}', now() - interval '120 days', 100, 1, 999, 0, 0, 100, 100, '{}');
      `);
    };
    const left = async () => (await q(`select left(id::text, 1) || right(id::text, 1) as k from public.evaluation_audit order by 1`)).map((r) => String(r.k));

    beforeEach(seedAudit);

    it("engine_audit_purge deletes an old row only once a newer one stands for its night, or the night has passed", async () => {
      const [{ removed }] = await q(`select public.engine_audit_purge($1::uuid) as removed`, [H1]);
      expect(removed).toBe(3);
      expect(await left()).toEqual(["a1", "b2", "c2", "e1", "f1"]);
    });

    it("leaves a night's only row alone run after run", async () => {
      await q(`select public.engine_audit_purge($1::uuid, 90)`, [H1]);
      const [{ removed }] = await q(`select public.engine_audit_purge($1::uuid, 90) as removed`, [H1]);
      expect(removed).toBe(0);
      expect(await left()).toContain("a1");
    });

    it("the nightly sweep, in both forms, keeps the same rows across every hotel", async () => {
      await db.exec(`select public.engine_data_sweep(60, 90, 90, 2);`);
      const viaFunction = await left();
      await seedAudit();
      await db.exec(`call public.engine_data_sweep_proc(60, 90, 90, 2);`);
      expect(await left()).toEqual(viaFunction);
      expect(viaFunction).toEqual(["a1", "b2", "c2", "e1"]);
    });

    it("is for the service role only", async () => {
      const rows = await q(
        `select has_function_privilege('anon', 'public.engine_audit_purge(uuid, integer)', 'execute') as anon,
                has_function_privilege('authenticated', 'public.engine_audit_purge(uuid, integer)', 'execute') as members,
                has_function_privilege('service_role', 'public.engine_audit_purge(uuid, integer)', 'execute') as service`,
      );
      expect(rows).toEqual([{ anon: false, members: false, service: true }]);
    });
  });

  describe("the send log and the build stamp (A29)", () => {
    const night = "2026-12-12";
    const log = async () =>
      q(
        `select write_kind, status, price::float as price, price_before::float as price_before, status_before,
                sent_price_before::float as sent_price_before, pms_job_reference as job, push_run_id::text as run, build
           from public.rate_send_log where hotel_id = $1 and stay_date = $2 order by id`,
        [H1, night],
      );
    const RUN_1 = "99999999-9999-4999-8999-999999999401";
    const RUN_2 = "99999999-9999-4999-8999-999999999402";

    it("keeps every send of a night, with what each replaced, and which run and build sent it", async () => {
      // 10:00 MAYA sends 89, confirmed later; 10:20 it sends 219.
      await db.exec(`
        insert into public.rate_updates (hotel_id, pms_type, room_type_id, stay_date, price, status, attempts, pushed_at, sent_price, pms_job_reference, push_run_id, build)
          values ('${H1}', 'cloudbeds', '${GARDEN}', '${night}', 89, 'sent', 1, now(), 89, 'job-1', '${RUN_1}', 'edge@abc123');
        update public.rate_updates set confirmed_at = now() where hotel_id = '${H1}' and stay_date = '${night}';
        update public.rate_updates set retry_requested_at = now() where hotel_id = '${H1}' and stay_date = '${night}';
        update public.rate_updates set price = 219, sent_price = 219, pms_job_reference = 'job-2', confirmed_at = null, push_run_id = '${RUN_2}'
         where hotel_id = '${H1}' and stay_date = '${night}';
      `);
      expect(await log()).toEqual([
        { write_kind: "insert", status: "sent", price: 89, price_before: null, status_before: null, sent_price_before: null, job: "job-1", run: RUN_1, build: "edge@abc123" },
        // Confirmed: not a push, so no run or build.
        { write_kind: "update", status: "sent", price: 89, price_before: 89, status_before: "sent", sent_price_before: 89, job: "job-1", run: null, build: null },
        // The Try again press changed nothing about the send: no row.
        { write_kind: "update", status: "sent", price: 219, price_before: 89, status_before: "sent", sent_price_before: 89, job: "job-2", run: RUN_2, build: "edge@abc123" },
      ]);
    });

    it("is only ever added to, and nobody but the trigger writes it", async () => {
      await expect(db.exec(`update public.rate_send_log set price = 1`)).rejects.toThrow(/only ever added to/);
      await expect(db.exec(`delete from public.rate_send_log`)).rejects.toThrow(/kept 13 months/);
      await expect(
        as("service_role", () =>
          q(`insert into public.rate_send_log (hotel_id, pms_type, stay_date, write_kind, status, price) values ('${H1}', 'cloudbeds', '${night}', 'insert', 'sent', 1)`),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(as("service_role", () => q(`update public.rate_send_log set price = 1`))).rejects.toThrow(/permission denied/);
    });

    it("lets a member read their own hotel's rows, and nobody else's", async () => {
      await db.exec(`
        insert into public.rate_updates (hotel_id, pms_type, room_type_id, stay_date, price, status, attempts)
          values ('${H2}', 'cloudbeds', '${LOFT}', '${night}', 150, 'failed', 1);`);
      const rows = await as("authenticated", () => q(`select distinct hotel_id::text as h from public.rate_send_log`), GM);
      expect(rows.map((r) => r.h)).toEqual([H1]);
    });

    it("the sweep removes rows older than 13 months, and only those", async () => {
      await db.exec(`
        alter table public.rate_send_log disable trigger trg_rate_send_log_guard;
        insert into public.rate_send_log (logged_at, hotel_id, pms_type, stay_date, write_kind, status, price)
          values (now() - interval '14 months', '${H1}', 'cloudbeds', '2025-07-01', 'insert', 'sent', 99);
        alter table public.rate_send_log enable trigger trg_rate_send_log_guard;`);
      const count = async () => Number((await q(`select count(*)::int as n from public.rate_send_log`))[0].n);
      const before = await count();
      await db.exec(`select public.engine_data_sweep();`);
      expect(await count()).toBe(before - 1);
    });

    it("the run log carries the build", async () => {
      await db.exec(`
        insert into public.evaluation_run_log (hotel_id, evaluation_run_id, evaluated_at, build)
          values ('${H1}', gen_random_uuid(), now() - interval '1 hour', 'edge@old111'),
                 ('${H1}', gen_random_uuid(), now(), 'edge@new222');`);
      const [{ build }] = await q(`select last_run_build as build from public.platform_pilot_health(true) where hotel_id = $1`, [H1]);
      expect(build).toBe("edge@new222");
    });
  });

  describe("Pilot health counts MAYA's own holds (A28)", () => {
    it("counts the open room-nights of a hold that should never happen, and since when, and nothing else", async () => {
      await db.exec(`
        insert into public.rate_push_incidents (id, hotel_id, pms_type, cause, known, severity, admin_only, opened_at) values
          ('77777777-7777-4777-8777-777777777401', '${H1}', 'cloudbeds', 'guardrail_stale_price', true, 'critical', true, now() - interval '40 minutes'),
          ('77777777-7777-4777-8777-777777777402', '${H1}', 'cloudbeds', 'guardrail_below_floor', true, 'transient', true, now() - interval '40 minutes');
        insert into public.rate_push_incident_cells (incident_id, hotel_id, room_type_id, stay_date, price, state, first_attempt_at, last_attempt_at) values
          ('77777777-7777-4777-8777-777777777401', '${H1}', '${GARDEN}', '2026-12-20', 120, 'open', now() - interval '40 minutes', now()),
          ('77777777-7777-4777-8777-777777777401', '${H1}', '${GARDEN}', '2026-12-21', 120, 'open', now() - interval '35 minutes', now()),
          ('77777777-7777-4777-8777-777777777401', '${H1}', '${GARDEN}', '2026-12-22', 120, 'landed', now() - interval '50 minutes', now()),
          ('77777777-7777-4777-8777-777777777402', '${H1}', '${GARDEN}', '2026-12-23', 120, 'open', now() - interval '40 minutes', now());`);
      const [row] = await q(
        `select maya_holds, round(extract(epoch from (now() - maya_holds_since)) / 60)::int as minutes, open_incidents_admin_only
           from public.platform_pilot_health(true) where hotel_id = $1`,
        [H1],
      );
      expect(row).toEqual({ maya_holds: 2, minutes: 40, open_incidents_admin_only: 2 });
      const [other] = await q(`select maya_holds, maya_holds_since from public.platform_pilot_health(true) where hotel_id = $1`, [H2]);
      expect(other).toEqual({ maya_holds: 0, maya_holds_since: null });
    });

    it("keeps its gate and its grants", async () => {
      await expect(as("authenticated", () => q(`select * from public.platform_pilot_health(true)`), GM)).rejects.toThrow(/Not authorized/);
      const rows = await q(
        `select has_function_privilege('anon', 'public.platform_pilot_health(boolean)', 'execute') as anon,
                has_function_privilege('authenticated', 'public.platform_pilot_health(boolean)', 'execute') as members`,
      );
      expect(rows).toEqual([{ anon: false, members: true }]);
    });
  });
});
