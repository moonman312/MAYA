/**
 * Sections 6 and 7 of 99_supabase_migration_push_guardrails_v1.sql, the reset
 * of legacy "no rate target" skips (with its count query) and sent_price, run
 * for real in PGlite. Only runs with MAYA_PGLITE_DIR set (see
 * large-property-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const MIGRATION = readFileSync(resolve(__dirname, "../../../../99_supabase_migration_push_guardrails_v1.sql"), "utf8");

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

/** The count query from section 6's comment, and its update statement. */
function sectionSix(): { count: string; update: string } {
  const start = MIGRATION.indexOf("-- 6. Before running");
  const updateAt = MIGRATION.indexOf("update public.rate_updates u", start);
  const count = MIGRATION.slice(start, updateAt)
    .split("\n")
    .filter((l) => l.startsWith("--   "))
    .map((l) => l.slice(5))
    .join("\n");
  const update = MIGRATION.slice(updateAt, MIGRATION.indexOf(";", updateAt) + 1);
  return { count, update };
}

/** Section 7's statements, up to the commit that ends the block. */
function sectionSeven(): string {
  const start = MIGRATION.indexOf("-- 7.\nalter table");
  return MIGRATION.slice(start, MIGRATION.indexOf("commit;", start));
}

const H1 = "00000000-0000-4000-8000-000000000001";
const H2 = "00000000-0000-4000-8000-000000000002";
const rt = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
const NEVER = rt(1);
const SENT_ON_A_PAST_NIGHT = rt(2);
const FAILED_ONCE = rt(3);
const SKIP_WITH_REFERENCE = rt(4);

describe.skipIf(!PGLITE_DIR)("push guardrails migration sections 6 and 7 in PGlite", () => {
  let db: Db;

  beforeAll(async () => {
    const mod = await import(
      /* @vite-ignore */ pathToFileURL(`${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist/index.js`).href
    );
    db = new mod.PGlite() as Db;
    await db.exec(`
      create table public.rate_updates (
        hotel_id uuid not null,
        room_type_id uuid not null,
        stay_date date not null,
        status text not null,
        error text,
        price numeric(10,2) not null default 0,
        attempts integer not null default 0,
        pms_job_reference text,
        external_rate_id text,
        unique (hotel_id, room_type_id, stay_date)
      );
    `);
    const skip = (hotel: string, room: string, night: string, extra = "null, null") =>
      `('${hotel}', '${room}', '${night}', 'skipped', 'no rate target for room type', 1, ${extra}, 5)`;
    await db.exec(`
      insert into public.rate_updates (hotel_id, room_type_id, stay_date, status, error, attempts, pms_job_reference, external_rate_id, price) values
        ${skip(H1, NEVER, "2026-09-20")},
        ${skip(H1, NEVER, "2026-09-21")},
        -- A bulk upsert nulled this skip's reference; the send it overwrote shows on an older night.
        ('${H1}', '${SENT_ON_A_PAST_NIGHT}', '2026-08-01', 'sent', null, 1, 'job-1', 'rate-1', 1),
        ${skip(H1, SENT_ON_A_PAST_NIGHT, "2026-09-20")},
        ('${H1}', '${FAILED_ONCE}', '2026-09-19', 'failed', 'Service Unavailable', 2, null, 'rate-3', 2),
        ${skip(H1, FAILED_ONCE, "2026-09-20")},
        ${skip(H1, SKIP_WITH_REFERENCE, "2026-09-20", "'job-9', 'rate-9'")},
        -- Another hotel's sends say nothing about this one's room types.
        ('${H2}', '${rt(9)}', '2026-09-20', 'sent', null, 1, 'job-2', 'rate-2', 3);
    `);
  }, 120_000);
  afterAll(async () => {
    await db?.close();
  });

  it("counts what it would reset before running, then resets only room types never sent or failed to on any night", async () => {
    const { count, update } = sectionSix();

    const before = await db.query(`${count.replace(/;\s*$/, "")} order by 1`);
    expect(before.rows).toEqual([
      { room_type_was_sent_to: false, skips: 2, room_types: 1 },
      { room_type_was_sent_to: true, skips: 2, room_types: 2 },
    ]);

    await db.exec(update);
    const after = await db.query(
      `select room_type_id, stay_date::text as night, attempts from public.rate_updates where status = 'skipped' order by 1, 2`,
    );
    expect(after.rows).toEqual([
      { room_type_id: NEVER, night: "2026-09-20", attempts: 0 },
      { room_type_id: NEVER, night: "2026-09-21", attempts: 0 },
      { room_type_id: SENT_ON_A_PAST_NIGHT, night: "2026-09-20", attempts: 1 },
      { room_type_id: FAILED_ONCE, night: "2026-09-20", attempts: 1 },
      { room_type_id: SKIP_WITH_REFERENCE, night: "2026-09-20", attempts: 1 },
    ]);

    // Again, after the code is deployed: nothing more moves.
    await db.exec(update);
    expect((await db.query(`select sum(attempts)::int as total from public.rate_updates where status = 'skipped'`)).rows).toEqual([
      { total: 3 },
    ]);
  }, 60_000);

  it("adds sent_price with sent rows' prices filled in, and can run again", async () => {
    await db.exec(sectionSeven());
    await db.exec(sectionSeven());
    const rows = await db.query(
      `select status, price::text, sent_price::text from public.rate_updates where status <> 'skipped' order by hotel_id, room_type_id`,
    );
    expect(rows.rows).toEqual([
      { status: "sent", price: "1.00", sent_price: "1.00" },
      { status: "failed", price: "2.00", sent_price: null },
      { status: "sent", price: "3.00", sent_price: "3.00" },
    ]);
    expect((await db.query(`select count(*)::int as n from public.rate_updates where status = 'skipped' and sent_price is not null`)).rows).toEqual([
      { n: 0 },
    ]);
  }, 60_000);
});

/** Section 8's block, begin to commit. */
function sectionEight(): string {
  const start = MIGRATION.indexOf("-- 8. Rates changed in the PMS");
  const end = MIGRATION.indexOf("commit;", start) + "commit;".length;
  return MIGRATION.slice(start, end);
}

describe.skipIf(!PGLITE_DIR)("push guardrails migration section 8 in PGlite", () => {
  let db: Db;
  const ROOM = rt(1);

  beforeAll(async () => {
    const mod = await import(
      /* @vite-ignore */ pathToFileURL(`${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist/index.js`).href
    );
    db = new mod.PGlite() as Db;
    // manual_price as 99_supabase_migration_manual_price_v1.sql makes it, and
    // the product event plumbing section 8 builds on, reduced to what it calls.
    await db.exec(`
      create role anon;
      create role authenticated;
      create type public.pms_type as enum ('mews', 'cloudbeds', 'think', 'opera', 'other');
      create table public.rate_updates (
        hotel_id uuid not null,
        room_type_id uuid not null,
        stay_date date not null,
        status text not null,
        price numeric(10,2) not null,
        unique (hotel_id, room_type_id, stay_date)
      );
      create table public.manual_price (
        hotel_id uuid not null,
        stay_date date not null,
        room_type_id uuid not null,
        price numeric(10,2) not null check (price >= 0),
        set_by uuid,
        set_at timestamptz not null default now(),
        cleared_at timestamptz,
        cleared_by uuid,
        note text,
        primary key (hotel_id, stay_date, room_type_id)
      );
      create table public.product_events (
        event text not null,
        hotel_id uuid,
        user_id uuid,
        properties jsonb not null,
        dedupe_key text unique
      );
      create function public.product_event_emit(
        p_event text, p_hotel_id uuid default null, p_user_id uuid default null, p_properties jsonb default '{}'::jsonb,
        p_source text default 'trigger', p_occurred_at timestamptz default null, p_dedupe_key text default null,
        p_pms_type text default null, p_pms_property_id text default null, p_property_name text default null, p_is_test boolean default null
      ) returns bigint language plpgsql as $$
      begin
        insert into public.product_events (event, hotel_id, user_id, properties, dedupe_key)
        values (p_event, p_hotel_id, p_user_id, p_properties, p_dedupe_key)
        on conflict (dedupe_key) do nothing;
        return 1;
      end;
      $$;
    `);
  }, 120_000);
  afterAll(async () => {
    await db?.close();
  });

  it("adds the columns and the source rule, and can run again", async () => {
    await db.exec(sectionEight());
    await db.exec(sectionEight());

    const columns = await db.query(
      `select table_name, column_name, is_nullable, column_default from information_schema.columns
        where (table_name = 'rate_updates' and column_name in ('confirmed_at', 'pms_edited_at'))
           or (table_name = 'manual_price' and column_name in ('source', 'pms_type'))
        order by table_name, column_name`,
    );
    expect(columns.rows).toEqual([
      { table_name: "manual_price", column_name: "pms_type", is_nullable: "YES", column_default: null },
      { table_name: "manual_price", column_name: "source", is_nullable: "NO", column_default: "'maya'::text" },
      { table_name: "rate_updates", column_name: "confirmed_at", is_nullable: "YES", column_default: null },
      { table_name: "rate_updates", column_name: "pms_edited_at", is_nullable: "YES", column_default: null },
    ]);

    const refused = async (values: string) => {
      try {
        await db.query(`insert into public.manual_price (hotel_id, stay_date, room_type_id, price, source, pms_type) values ${values}`);
        return false;
      } catch {
        return true;
      }
    };
    expect(await refused(`('${H1}', '2026-12-01', '${ROOM}', 100, 'pms', null)`)).toBe(true);
    expect(await refused(`('${H1}', '2026-12-01', '${ROOM}', 100, 'maya', 'cloudbeds')`)).toBe(true);
    expect(await refused(`('${H1}', '2026-12-01', '${ROOM}', 100, 'someone', null)`)).toBe(true);
  }, 60_000);

  it("records a typed save as manual_price.set and a PMS change as its own event, once per room type and save", async () => {
    const user = "00000000-0000-4000-8000-00000000aaaa";
    await db.exec(`
      insert into public.manual_price (hotel_id, stay_date, room_type_id, price, set_by, set_at)
      values ('${H1}', '2026-10-01', '${ROOM}', 150, '${user}', '2026-09-20T10:00:00Z'),
             ('${H1}', '2026-10-02', '${ROOM}', 150, '${user}', '2026-09-20T10:00:00Z');
    `);
    // The refresh adopts two nights the hotel changed, one over the typed price.
    await db.exec(`
      insert into public.manual_price (hotel_id, stay_date, room_type_id, price, set_by, set_at, source, pms_type)
      values ('${H1}', '2026-10-02', '${ROOM}', 180, null, '2026-09-21T10:00:00Z', 'pms', 'cloudbeds'),
             ('${H1}', '2026-10-03', '${ROOM}', 0, null, '2026-09-21T10:00:00Z', 'pms', 'cloudbeds')
      on conflict (hotel_id, stay_date, room_type_id) do update
        set price = excluded.price, set_by = excluded.set_by, set_at = excluded.set_at,
            source = excluded.source, pms_type = excluded.pms_type, cleared_at = null;
    `);
    await db.exec(`update public.manual_price set cleared_at = '2026-09-22T10:00:00Z', cleared_by = '${user}' where stay_date = '2026-10-03'`);

    const events = await db.query(
      `select event, user_id, properties->>'nights' as nights, properties->>'first_night' as first_night
         from public.product_events order by dedupe_key`,
    );
    expect(events.rows).toEqual([
      { event: "manual_price.changed_in_pms", user_id: null, nights: "2", first_night: "2026-10-02" },
      { event: "manual_price.cleared", user_id: user, nights: "1", first_night: "2026-10-03" },
      { event: "manual_price.set", user_id: user, nights: "2", first_night: "2026-10-01" },
    ]);
  }, 60_000);
});
