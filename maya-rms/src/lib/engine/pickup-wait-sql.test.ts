/**
 * 99_supabase_migration_pickup_wait_v1.sql run for real in PGlite, twice,
 * over rule_condition as it stands before it, and 02_supabase_schema.sql's
 * rule_condition for a fresh install: the same column and the same two
 * named checks either way. Also the deploy list in the migration's header.
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
