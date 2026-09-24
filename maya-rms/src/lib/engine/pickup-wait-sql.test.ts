/**
 * 99_supabase_migration_pickup_wait_v1.sql run for real in PGlite, twice,
 * over rule_condition as it stands before it, and 02_supabase_schema.sql's
 * rule_condition for a fresh install: the same column and the same two
 * named checks either way. Its audit_rows_before against the model the
 * change log's route tests run on (scale-rpc-model.test.ts). Also the
 * deploy list in the migration's header.
 *
 * The PGlite part only runs with MAYA_PGLITE_DIR set (see
 * large-property-sql.test.ts).
 *
 *   MAYA_PGLITE_DIR=/path/to/dir npx vitest run src/lib/engine/pickup-wait-sql.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeRpcError, type FakeRow } from "./fake-supabase.test";
import { auditRowsBefore } from "./scale-rpc-model.test";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = resolve(ROOT, "99_supabase_migration_pickup_wait_v1.sql");
const SCHEMA = resolve(ROOT, "02_supabase_schema.sql");
const FUNCTIONS = resolve(__dirname, "../../../supabase/functions");

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

const RULE = (n: number) => `00000000-0000-4000-8000-0000000003${String(n).padStart(2, "0")}`;

/** rule_condition as the migrations before this one leave it. */
const BEFORE = `
create table public.pricing_rules (id uuid primary key);
create table public.rule_condition (
  rule_id               uuid primary key references public.pricing_rules(id) on delete cascade,
  occupancy_operator    text check (occupancy_operator in ('gt','lt')),
  occupancy_threshold   numeric(8,4) check (occupancy_threshold between 0 and 1),
  dta_operator          text check (dta_operator in ('gt','lt')),
  dta_threshold_days    integer check (dta_threshold_days >= 0),
  pickup_operator       text check (pickup_operator in ('gt','lt')),
  pickup_threshold      numeric(10,2),
  pickup_window_days    integer check (pickup_window_days in (1,3,7)),
  pickup_metric         text check (pickup_metric in ('room_nights','revenue')),
  booking_speed_operator      text,
  booking_speed_level         text,
  booking_speed_window_days   integer,
  booking_speed_cooldown_days integer constraint rule_condition_bs_cooldown_chk check (booking_speed_cooldown_days is null or booking_speed_cooldown_days >= 1),
  check (
    (pickup_operator is null and pickup_threshold is null and pickup_window_days is null and pickup_metric is null)
    or
    (pickup_operator is not null and pickup_threshold is not null and pickup_window_days is not null and pickup_metric is not null)
  ),
  check (occupancy_operator is not null or dta_operator is not null or pickup_operator is not null or booking_speed_operator is not null)
);
insert into public.pricing_rules (id) values ('${RULE(1)}'), ('${RULE(2)}'), ('${RULE(3)}'), ('${RULE(4)}'), ('${RULE(5)}');
insert into public.rule_condition (rule_id, pickup_operator, pickup_threshold, pickup_window_days, pickup_metric)
  values ('${RULE(1)}', 'gt', 5, 7, 'room_nights');
insert into public.rule_condition (rule_id, occupancy_operator, occupancy_threshold) values ('${RULE(2)}', 'gt', 0.8);
`;

/** Roles, auth.role() and is_hotel_accessible() stubbed from settings, and evaluation_audit as the function reads it. */
const AUDIT_STUBS = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
create or replace function public.is_hotel_accessible(target_hotel_id uuid) returns boolean
language sql stable as $$
  select coalesce(current_setting('test.accessible_hotel', true), '') = target_hotel_id::text
$$;
create table public.evaluation_audit (
  id uuid primary key default gen_random_uuid(),
  evaluation_run_id uuid,
  hotel_id uuid not null,
  stay_date date not null,
  room_type_id uuid not null,
  evaluated_at timestamptz not null,
  base_price numeric(10,2),
  final_price numeric(10,2) not null,
  details jsonb not null
);
create index idx_evaluation_audit_cell on public.evaluation_audit (hotel_id, stay_date, room_type_id, evaluated_at desc);
`;

/** 02_supabase_schema.sql's rule_condition, as a fresh install creates it. */
function schemaRuleCondition(): string {
  const sql = readFileSync(SCHEMA, "utf8");
  const start = sql.indexOf("create table if not exists rule_condition (");
  const end = sql.indexOf("\n);", start);
  if (start < 0 || end < start) throw new Error("rule_condition not found in 02_supabase_schema.sql");
  return sql.slice(start, end + 3);
}

async function open(): Promise<Db> {
  const mod = await import(
    /* @vite-ignore */ pathToFileURL(`${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist/index.js`).href
  );
  return new mod.PGlite() as Db;
}

/** Everything a pickup wait may and may not be, on whichever database it is given. */
function checksHold(db: () => Db) {
  it("takes a wait of a day or more on a pickup count rule, and a pickup rule with none", async () => {
    await db().exec(`insert into public.rule_condition (rule_id, pickup_operator, pickup_threshold, pickup_window_days, pickup_metric, pickup_cooldown_days)
      values ('${RULE(3)}', 'gt', 5, 7, 'room_nights', 2)`);
    await db().exec(`update public.rule_condition set pickup_cooldown_days = 14 where rule_id = '${RULE(3)}'`);
    await db().exec(`update public.rule_condition set pickup_cooldown_days = null where rule_id = '${RULE(3)}'`);
    expect((await db().query(`select pickup_cooldown_days from public.rule_condition where rule_id = '${RULE(3)}'`)).rows).toEqual([
      { pickup_cooldown_days: null },
    ]);
  });

  it("refuses a wait under a day", async () => {
    await expect(
      db().exec(`insert into public.rule_condition (rule_id, pickup_operator, pickup_threshold, pickup_window_days, pickup_metric, pickup_cooldown_days)
        values ('${RULE(4)}', 'gt', 5, 7, 'room_nights', 0)`),
    ).rejects.toThrow(/rule_condition_pickup_cooldown_chk/);
  });

  it("refuses a wait on a rule with no pickup condition, and taking the condition away from under one", async () => {
    await expect(
      db().exec(`insert into public.rule_condition (rule_id, occupancy_operator, occupancy_threshold, pickup_cooldown_days)
        values ('${RULE(5)}', 'gt', 0.8, 2)`),
    ).rejects.toThrow(/rule_condition_pickup_cooldown_family_chk/);
    await db().exec(`update public.rule_condition set pickup_cooldown_days = 3 where rule_id = '${RULE(3)}'`);
    await expect(
      db().exec(`update public.rule_condition
        set pickup_operator = null, pickup_threshold = null, pickup_window_days = null, pickup_metric = null,
            occupancy_operator = 'gt', occupancy_threshold = 0.5
        where rule_id = '${RULE(3)}'`),
    ).rejects.toThrow(/rule_condition_pickup_cooldown_family_chk/);
  });
}

describe.skipIf(!PGLITE_DIR)("the pickup wait migration in PGlite", () => {
  let db: Db;
  beforeAll(async () => {
    db = await open();
    await db.exec(AUDIT_STUBS);
    await db.exec(BEFORE);
    await db.exec(readFileSync(MIGRATION, "utf8"));
  }, 120_000);
  afterAll(async () => {
    await db?.close();
  });

  it("adds the column empty: every rule that exists keeps waiting its window", async () => {
    expect((await db.query(`select rule_id, pickup_cooldown_days from public.rule_condition order by rule_id`)).rows).toEqual([
      { rule_id: RULE(1), pickup_cooldown_days: null },
      { rule_id: RULE(2), pickup_cooldown_days: null },
    ]);
  });

  it("replays cleanly, leaving one of each check", async () => {
    await db.exec(readFileSync(MIGRATION, "utf8"));
    await db.exec(readFileSync(MIGRATION, "utf8"));
    const names = await db.query(`select conname from pg_constraint
      where conrelid = 'public.rule_condition'::regclass and conname like 'rule_condition_pickup_cooldown%' order by conname`);
    expect(names.rows).toEqual([
      { conname: "rule_condition_pickup_cooldown_chk" },
      { conname: "rule_condition_pickup_cooldown_family_chk" },
    ]);
  });

  checksHold(() => db);
});

describe.skipIf(!PGLITE_DIR)("02_supabase_schema.sql's rule_condition in PGlite", () => {
  let db: Db;
  beforeAll(async () => {
    db = await open();
    await db.exec(AUDIT_STUBS);
    await db.exec(`create table pricing_rules (id uuid primary key);
      insert into pricing_rules (id) values ('${RULE(3)}'), ('${RULE(4)}'), ('${RULE(5)}');`);
    await db.exec(schemaRuleCondition());
  }, 120_000);
  afterAll(async () => {
    await db?.close();
  });

  it("has the same two checks by name, so a later migration can find them", async () => {
    const names = await db.query(`select conname from pg_constraint
      where conrelid = 'public.rule_condition'::regclass and conname like 'rule_condition_pickup_cooldown%' order by conname`);
    expect(names.rows).toEqual([
      { conname: "rule_condition_pickup_cooldown_chk" },
      { conname: "rule_condition_pickup_cooldown_family_chk" },
    ]);
  });

  checksHold(() => db);

  it("then running the migration over it changes nothing", async () => {
    await db.exec(readFileSync(MIGRATION, "utf8"));
    const names = await db.query(`select conname from pg_constraint
      where conrelid = 'public.rule_condition'::regclass and conname like 'rule_condition_pickup_cooldown%' order by conname`);
    expect(names.rows).toHaveLength(2);
  });
});

describe.skipIf(!PGLITE_DIR)("audit_rows_before in PGlite", () => {
  const H1 = "00000000-0000-4000-8000-0000000000d1";
  const H2 = "00000000-0000-4000-8000-0000000000d2";
  const TYPES = ["00000000-0000-4000-8000-0000000000e1", "00000000-0000-4000-8000-0000000000e2", "00000000-0000-4000-8000-0000000000e3"];
  const rows: FakeRow[] = [];
  let db: Db;

  beforeAll(async () => {
    const mod = await import(
      /* @vite-ignore */ pathToFileURL(`${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist/index.js`).href
    );
    db = new mod.PGlite({ parsers: { 1082: (v: string) => v, 1184: (v: string) => v } }) as Db;
    await db.exec("set timezone = 'UTC';");
    await db.exec(AUDIT_STUBS);
    await db.exec(BEFORE);
    await db.exec(readFileSync(MIGRATION, "utf8"));
    // 30 runs five minutes apart over 12 nights and three room types, each
    // writing some cells, a few twice at one instant (ties go to the id).
    let seed = 7;
    const r = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    let n = 0;
    for (let run = 0; run < 30; run++) {
      const at = new Date(Date.parse("2026-09-01T00:00:00Z") + run * 300_000).toISOString();
      for (let d = 0; d < 12; d++) {
        for (const t of TYPES) {
          if (r() < 0.6) continue;
          const copies = r() < 0.1 ? 2 : 1;
          for (let c = 0; c < copies; c++) {
            const manual = r() < 0.2;
            rows.push({
              id: `e0000000-0000-4000-8000-${(0xfffffff - ++n * 7919).toString(16).padStart(12, "0")}`,
              hotel_id: r() < 0.1 ? H2 : H1,
              stay_date: `2026-10-${String(1 + d).padStart(2, "0")}`,
              room_type_id: t,
              evaluated_at: at,
              base_price: 100 + d,
              final_price: Math.round((90 + r() * 40) * 100) / 100,
              details: {
                application_order: r() < 0.5 ? [] : ["ladder:00000000-0000-4000-8000-0000000000f1"],
                base_source: manual ? "manual" : "reservation",
                ...(manual ? { manual_override: { set_by: null, set_at: "2026-08-31T10:00:00.000Z" } } : {}),
              },
            });
          }
        }
      }
    }
    await db.query(
      `insert into public.evaluation_audit (id, hotel_id, stay_date, room_type_id, evaluated_at, base_price, final_price, details)
       select id, hotel_id, stay_date, room_type_id, evaluated_at, base_price, final_price, details
       from json_populate_recordset(null::public.evaluation_audit, $1::json)`,
      [JSON.stringify(rows)],
    );
  }, 120_000);
  afterAll(async () => {
    await db?.close();
  });

  const call = (hotel: string, before: string, dates: string[], types: string[]) =>
    db.query(`select * from public.audit_rows_before($1::uuid, $2::timestamptz, $3::date[], $4::uuid[])`, [hotel, before, dates, types]);
  const plain = (list: Record<string, unknown>[]) =>
    list.map((x) => ({
      stay_date: String(x.stay_date),
      room_type_id: String(x.room_type_id),
      evaluated_at: Date.parse(String(x.evaluated_at)),
      base_price: x.base_price == null ? null : Number(x.base_price),
      final_price: Number(x.final_price),
      application_order: x.application_order ?? null,
      base_source: x.base_source ?? null,
      manual_override: x.manual_override ?? null,
    }));

  it("gives each night's newest row before the instant, as the change log's model does", async () => {
    await db.exec("select set_config('request.jwt.claim.role', 'service_role', false);");
    const cells = Array.from({ length: 12 }, (_, d) => `2026-10-${String(1 + d).padStart(2, "0")}`).flatMap((date) => TYPES.map((t) => [date, t]));
    for (const run of [1, 7, 15, 29, 40]) {
      const before = new Date(Date.parse("2026-09-01T00:00:00Z") + run * 300_000).toISOString();
      // Every cell, some twice, one on no row at all.
      const asked = [...cells, ...cells.slice(0, 5), ["2026-11-30", TYPES[0]]];
      const dates = asked.map((c) => c[0]);
      const types = asked.map((c) => c[1]);
      const sql = await call(H1, before, dates, types);
      const model = auditRowsBefore(rows, { p_hotel_id: H1, p_before: before, p_stay_dates: dates, p_room_type_ids: types });
      expect(model).not.toBeInstanceOf(FakeRpcError);
      expect(plain(sql.rows)).toEqual(plain(model as FakeRow[]));
      if (run > 1) expect(sql.rows.length).toBeGreaterThan(10);
    }
  });

  it("refuses a caller who is neither the service role nor a member of the hotel, and arrays that don't pair up", async () => {
    await db.exec("select set_config('request.jwt.claim.role', 'authenticated', false);");
    await db.exec("select set_config('test.accessible_hotel', '', false);");
    await expect(call(H1, "2026-09-02T00:00:00Z", ["2026-10-01"], [TYPES[0]])).rejects.toMatchObject({ code: "42501" });
    await db.exec(`select set_config('test.accessible_hotel', '${H1}', false);`);
    expect((await call(H1, "2026-09-02T00:00:00Z", ["2026-10-01"], [TYPES[0]])).rows.length).toBeLessThanOrEqual(1);
    await expect(call(H1, "2026-09-02T00:00:00Z", ["2026-10-01", "2026-10-02"], [TYPES[0]])).rejects.toMatchObject({ code: "22023" });
    expect(auditRowsBefore(rows, { p_hotel_id: H1, p_before: "2026-09-02T00:00:00Z", p_stay_dates: ["2026-10-01", "2026-10-02"], p_room_type_ids: [TYPES[0]] })).toBeInstanceOf(FakeRpcError);
  });

  it("replays cleanly, leaving one function by that name", async () => {
    await db.exec(readFileSync(MIGRATION, "utf8"));
    await db.exec(readFileSync(MIGRATION, "utf8"));
    const fns = await db.query(`select pg_get_function_identity_arguments(oid) as args from pg_proc where proname = 'audit_rows_before'`);
    expect(fns.rows).toEqual([{ args: "p_hotel_id uuid, p_before timestamp with time zone, p_stay_dates date[], p_room_type_ids uuid[]" }]);
  });
});

/** Every file an edge function's bundle pulls in, following relative imports. */
function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [normalize(entry)];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    seen.add(file);
    for (const m of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      stack.push(normalize(join(dirname(file), m[1])));
    }
  }
  return seen;
}

describe("the pickup wait migration's deploy list", () => {
  it("names every function whose bundle carries the engine code this build changed", () => {
    const source = readFileSync(MIGRATION, "utf8");
    const header = source.slice(0, source.indexOf("\nbegin;"));
    const changed = [
      "_shared/engine/pickup.ts",
      "_shared/engine/evaluate.ts",
      "_shared/engine/snapshots.ts",
      "_shared/engine/repeat-alerts.ts",
      "_shared/engine/types.ts",
      "_shared/engine/domain.ts",
    ];
    const carries = readdirSync(FUNCTIONS, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "_shared")
      .map((d) => d.name)
      .filter((name) => {
        const closure = [...importClosure(join(FUNCTIONS, name, "index.ts"))];
        return changed.some((c) => closure.some((f) => f.endsWith(c)));
      });
    expect(carries.sort()).toEqual(["cloudbeds-scheduled-sync", "mews-scheduled-sync", "think-scheduled-sync"]);
    for (const name of carries) expect(header).toContain(name);
  });
});
