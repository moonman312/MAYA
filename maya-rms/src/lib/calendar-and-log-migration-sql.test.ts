/**
 * 99_supabase_migration_calendar_and_log_v1.sql run for real in PGlite,
 * twice, on top of every migration before it (audits A48, A46):
 *
 *   - the calendar's colours and the Command Center's business numbers count
 *     each booking at the rate it has now, the first rate only when the
 *     property system sent none since;
 *   - audit_rows_before also gives the row's standard rule changes and the
 *     rules as it kept them, for the change log, with the same access check.
 *
 * Only runs with MAYA_PGLITE_DIR set (see engine/pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../..");
const MIGRATION = "99_supabase_migration_calendar_and_log_v1.sql";
const CADENCE_FILE = "99_supabase_migration_pricing_cadence_v1.sql";

const CADENCE_TEST = readFileSync(resolve(__dirname, "./engine/pricing-cadence-sql.test.ts"), "utf8");

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

/** The file with the bodies of its functions left out. */
function outsideBodies(sql: string): string {
  return sql.replace(/--.*$/gm, "").replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
}

/** A function's last definition in a file, from its name to the end of its body, or null. */
function definitionIn(sql: string, fn: string): string | null {
  const all = [...sql.matchAll(new RegExp(`create (?:or replace )?function (public\\.${fn}\\()`, "g"))];
  const last = all.at(-1);
  if (!last) return null;
  const at = last.index! + last[0].length - last[1].length;
  return sql.slice(at, sql.indexOf("$$;", at));
}

/** The newest definition of a function among the files before this one. */
function newestBefore(fn: string): string {
  for (const name of [...BEFORE].reverse()) {
    const found = definitionIn(readFileSync(resolve(ROOT, name), "utf8"), fn);
    if (found) return found;
  }
  throw new Error(`${fn} is not defined before ${MIGRATION}`);
}

const H1 = "11111111-1111-4111-8111-111111111481";
const H2 = "11111111-1111-4111-8111-111111111482";
const GARDEN = "44444444-4444-4444-8444-444444444481";
const LOFT = "44444444-4444-4444-8444-444444444482";
const COURT = "44444444-4444-4444-8444-444444444483";
const GM = "33333333-3333-4333-8333-333333333481";
const RULE = "55555555-5555-4555-8555-555555555481";

describe("the migration file", () => {
  const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8");
  const code = outsideBodies(sql);

  it("is on the list the SQL tests build production's schema from, right after the billing watchdog", () => {
    expect(MIGRATION_ORDER).toContain(MIGRATION);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBe(MIGRATION_ORDER.indexOf("99_supabase_migration_billing_watchdog_v1.sql") + 1);
  });

  it("is one transaction, keeps row level security on and never grants anon anything", () => {
    expect(code.match(/\bbegin;/g)).toHaveLength(1);
    expect(code.match(/\bcommit;/g)).toHaveLength(1);
    expect(code).not.toMatch(/disable row level security/i);
    expect(code).not.toMatch(/grant[^;]*\banon\b/i);
  });

  it("revokes execute from public and anon on every function it defines", () => {
    const defined = [...code.matchAll(/create (?:or replace )?function (public\.[a-z0-9_]+)\(/g)].map((m) => m[1]);
    expect(defined.sort()).toEqual(["public.audit_rows_before", "public.calendar_daily_revenue_v3", "public.staff_hotel_business_numbers"]);
    for (const fn of defined) {
      expect(code).toMatch(new RegExp(`revoke all on function ${fn.replace(".", "\\.")}\\([^)]*\\) from public, anon`));
    }
  });

  it("restates each function from its newest definition, changing only what it says it changes", () => {
    const body = (fn: string) => definitionIn(sql, fn) ?? "";
    const swap = (s: string) => s.replace(/coalesce\(r\.base_rate, r\.current_rate, 0\)/g, "coalesce(r.current_rate, r.base_rate, 0)");
    expect(body("calendar_daily_revenue_v3")).toBe(swap(newestBefore("calendar_daily_revenue_v3")));
    expect(body("staff_hotel_business_numbers")).toBe(swap(newestBefore("staff_hotel_business_numbers")));
    // audit_rows_before: the same check and the same row, two more columns.
    const before = newestBefore("audit_rows_before");
    const now = body("audit_rows_before");
    for (const kept of ["public.is_hotel_accessible(p_hotel_id)", "using errcode = '42501'", "using errcode = '22023'", "order by x.evaluated_at desc, x.id desc"]) {
      expect(before).toContain(kept);
      expect(now).toContain(kept);
    }
    expect(now).toContain("a.details -> 'active_ladder_effects',");
    expect(now).toContain("a.details -> 'rule_snapshots'");
  });
});

describe.skipIf(!PGLITE_DIR)("the calendar and change log migration in PGlite", () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

  /** Runs `fn` as a signed-in member, then puts the session back to the service role. */
  const asMember = async <T>(userId: string, fn: () => Promise<T>): Promise<T> => {
    await db.exec(`
      select set_config('request.jwt.claim.sub', '${userId}', false);
      select set_config('request.jwt.claim.role', 'authenticated', false);
      set role authenticated;`);
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
    await db.exec(`
      select set_config('request.jwt.claim.role', 'service_role', false);
      insert into auth.users (id, email) values ('${GM}', 'gm@example.com');
      insert into public.hotels (id, name, timezone, is_active) values
        ('${H1}', 'Juniper Lodge', 'UTC', true), ('${H2}', 'Harbour Inn', 'UTC', true);
      insert into public.hotel_memberships (hotel_id, user_id, role) values ('${H1}', '${GM}', 'general_manager');
      insert into public.room_types (id, hotel_id, external_room_type_id, name, total_rooms, counts_as_room) values
        ('${GARDEN}', '${H1}', 'g', 'Garden Room', 10, true),
        ('${LOFT}', '${H1}', 'l', 'Loft', 2, true),
        ('${COURT}', '${H1}', 'c', 'Tennis court', 1, false);
      -- Read at 200, moved to 150 in the property system since: the trigger
      -- keeps base_rate at the first rate.
      insert into public.reservations (hotel_id, external_reservation_id, room_type_id, stay_date, current_rate) values
        ('${H1}', 'r1', '${GARDEN}', '2026-10-05', 200);
      update public.reservations set current_rate = 150 where external_reservation_id = 'r1';
      -- The property system sent no rate on its last read: the first one stands.
      insert into public.reservations (hotel_id, external_reservation_id, room_type_id, stay_date, current_rate) values
        ('${H1}', 'r2', '${LOFT}', '2026-10-05', 180);
      update public.reservations set current_rate = null where external_reservation_id = 'r2';
      -- No rate ever, and a court that isn't a room.
      insert into public.reservations (hotel_id, external_reservation_id, room_type_id, stay_date, base_rate, current_rate) values
        ('${H1}', 'r3', '${GARDEN}', '2026-10-05', null, null),
        ('${H1}', 'r4', '${COURT}', '2026-10-05', 40, 60);
    `);

    // The file under test, twice: it is safe to run again.
    await db.exec(fileSql(MIGRATION));
    await db.exec(fileSql(MIGRATION));
    await db.exec(`select set_config('request.jwt.claim.role', 'service_role', false);`);
  }, 240_000);

  afterAll(async () => {
    await db?.close();
  });

  describe("revenue at the rate a booking has now (A48)", () => {
    it("the trigger kept the first rate as base_rate, as the seed means", async () => {
      const rows = await q(`select external_reservation_id as r, base_rate::float as base, current_rate::float as cur from public.reservations order by 1`);
      expect(rows).toEqual([
        { r: "r1", base: 200, cur: 150 },
        { r: "r2", base: 180, cur: null },
        { r: "r3", base: null, cur: null },
        { r: "r4", base: 40, cur: 60 },
      ]);
    });

    it("the calendar's colours count 150 + 180 for the night, rooms only", async () => {
      const rows = await q(`select stay_date::text as d, revenue::float as revenue from public.calendar_daily_revenue_v3($1::uuid)`, [H1]);
      expect(rows).toEqual([{ d: "2026-10-05", revenue: 330 }]);
    });

    it("the business numbers count the rate now too: every type's revenue, rooms-only ADR", async () => {
      const [row] = await q(
        `select rooms_sold, room_revenue::float as revenue, adr::float as adr
           from public.staff_hotel_business_numbers($1::uuid, '2026-10-05', '2026-10-05')`,
        [H1],
      );
      expect(row).toEqual({ rooms_sold: 3, revenue: 390, adr: 110 });
    });

    it("keeps who may read them as it was", async () => {
      const rows = await q(
        `select p.proname as fn,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as members
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname in ('calendar_daily_revenue_v3', 'staff_hotel_business_numbers', 'audit_rows_before')
          order by 1`,
      );
      expect(rows).toEqual([
        { fn: "audit_rows_before", anon: false, members: true },
        { fn: "calendar_daily_revenue_v3", anon: false, members: true },
        { fn: "staff_hotel_business_numbers", anon: false, members: true },
      ]);
      await expect(asMember(GM, () => q(`select * from public.staff_hotel_business_numbers($1::uuid, '2026-10-05', '2026-10-05')`, [H1]))).rejects.toThrow(
        /Not authorized/,
      );
    });
  });

  describe("audit_rows_before with the row's rules (A46)", () => {
    const snapshots = { [RULE]: { name: "Busy bump", version: 1, condition: { occupancy_operator: "gt", occupancy_threshold: 0.7 } } };
    beforeAll(async () => {
      await db.query(
        `insert into public.evaluation_audit (id, evaluation_run_id, hotel_id, stay_date, room_type_id, evaluated_at, base_price, floor_price, ceiling_price,
                                              ladder_subtotal_delta, pickup_subtotal_delta, pre_clamp_price, final_price, details)
         values ('a0000000-0000-4000-8000-000000000481', gen_random_uuid(), $1, '2026-10-10', $2, '2026-09-25T10:00:00Z', 200, 1, 999, 20, 0, 220, 220, $3::jsonb),
                ('a0000000-0000-4000-8000-000000000482', gen_random_uuid(), $1, '2026-10-10', $2, '2026-09-20T10:00:00Z', 200, 1, 999, 0, 0, 200, 200, '{"application_order": []}'::jsonb)`,
        [
          H1,
          GARDEN,
          JSON.stringify({
            application_order: [`ladder:${RULE}`],
            base_source: "calendar",
            active_ladder_effects: [{ rule_id: RULE, delta: "+10%" }],
            rule_snapshots: snapshots,
          }),
        ],
      );
    });

    const call = (before: string) =>
      q(`select * from public.audit_rows_before($1::uuid, $2::timestamptz, $3::date[], $4::uuid[])`, [H1, before, ["2026-10-10"], [GARDEN]]);

    it("gives the newest row before the instant with its rule changes and the rules as it kept them", async () => {
      const [row] = await call("2026-09-28T00:00:00Z");
      expect(row).toMatchObject({
        application_order: [`ladder:${RULE}`],
        base_source: "calendar",
        manual_override: null,
        ladder_effects: [{ rule_id: RULE, delta: "+10%" }],
        rule_snapshots: snapshots,
      });
      expect(Number(row.final_price)).toBe(220);
    });

    it("gives null for both on a row that kept neither", async () => {
      const [row] = await call("2026-09-21T00:00:00Z");
      expect(row).toMatchObject({ application_order: [], ladder_effects: null, rule_snapshots: null });
    });

    it("answers a member of the hotel and refuses anyone else", async () => {
      const mine = await asMember(GM, () => call("2026-09-28T00:00:00Z"));
      expect(mine).toHaveLength(1);
      await expect(
        asMember(GM, () => q(`select * from public.audit_rows_before($1::uuid, now(), $2::date[], $3::uuid[])`, [H2, ["2026-10-10"], [GARDEN]])),
      ).rejects.toThrow(/Not authorized to read the audit trail/);
    });

    it("leaves one function by that name after running again", async () => {
      await db.exec(fileSql(MIGRATION));
      const fns = await q(`select pg_get_function_identity_arguments(oid) as args from pg_proc where proname = 'audit_rows_before'`);
      expect(fns).toEqual([{ args: "p_hotel_id uuid, p_before timestamp with time zone, p_stay_dates date[], p_room_type_ids uuid[]" }]);
    });
  });
});
