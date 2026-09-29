/**
 * 99_supabase_migration_manual_price_retry_v1.sql run for real in PGlite,
 * twice: the column arrives nullable, an upsert that leaves it out (every
 * ledger write the push makes) keeps the stamp while pushed_at moves past it,
 * and the retry route's guarded update stamps only a row whose stamp is not
 * already newer than its last try. Only runs with MAYA_PGLITE_DIR set (see
 * src/lib/engine/large-property-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const MIGRATION = readFileSync(
  resolve(__dirname, "../../../../99_supabase_migration_manual_price_retry_v1.sql"),
  "utf8",
);

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

const HOTEL = "11111111-1111-4111-8111-111111111111";
const ROOM = "22222222-2222-4222-8222-222222222222";

describe.skipIf(!PGLITE_DIR)("manual price retry migration in PGlite", () => {
  let db: Db;

  const row = async () =>
    (
      await db.query(
        `select status, attempts, pushed_at, retry_requested_at
           from public.rate_updates where hotel_id = $1 and room_type_id = $2 and stay_date = '2026-10-05'`,
        [HOTEL, ROOM],
      )
    ).rows[0];

  beforeAll(async () => {
    const mod = await import(
      /* @vite-ignore */ pathToFileURL(`${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist/index.js`).href
    );
    db = new mod.PGlite() as Db;
    // The ledger as 99_supabase_migration_rate_push_v1.sql and the push
    // guardrails migration leave the columns this file and the push read.
    await db.exec(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
      end $$;
      create type public.pms_type as enum ('mews', 'cloudbeds', 'think');
      create table public.rate_updates (
        id uuid primary key default gen_random_uuid(),
        hotel_id uuid not null,
        pms_type public.pms_type not null,
        room_type_id uuid,
        stay_date date not null,
        price numeric(10,2) not null,
        status text not null check (status in ('sent', 'failed', 'skipped')),
        error text,
        attempts integer not null default 1,
        pushed_at timestamptz,
        sent_price numeric(10,2),
        unique (hotel_id, room_type_id, stay_date)
      );
      insert into public.rate_updates (hotel_id, pms_type, room_type_id, stay_date, price, status, error, attempts, pushed_at)
        values ('${HOTEL}', 'cloudbeds', '${ROOM}', '2026-10-05', 210, 'failed', 'Rate must be greater than 500', 1, '2026-09-29T10:00:00Z');
    `);
    await db.exec(MIGRATION);
    await db.exec(MIGRATION);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it("adds the column nullable, and a third run changes nothing", async () => {
    const col = (
      await db.query(`
        select data_type, is_nullable from information_schema.columns
         where table_schema = 'public' and table_name = 'rate_updates' and column_name = 'retry_requested_at'`)
    ).rows;
    expect(col).toEqual([{ data_type: "timestamp with time zone", is_nullable: "YES" }]);
    expect((await row()).retry_requested_at).toBeNull();
    await db.exec(MIGRATION);
    expect((await row()).retry_requested_at).toBeNull();
  });

  it("stamps a row whose press is not newer than its last try, and only that row", async () => {
    // The retry route's write, as PostgREST runs it.
    const stamp = () =>
      db.query(
        `update public.rate_updates set retry_requested_at = now()
          where hotel_id = $1 and room_type_id = $2 and stay_date = '2026-10-05' and status = 'failed'
            and (retry_requested_at is null or retry_requested_at <= pushed_at)
          returning retry_requested_at`,
        [HOTEL, ROOM],
      );
    const first = await stamp();
    expect(first.rows).toHaveLength(1);
    const pressed = (await row()).retry_requested_at;
    expect(pressed).not.toBeNull();
    // A second press while the first is still newer than the last try is nothing.
    const second = await stamp();
    expect(second.rows).toHaveLength(0);
    expect((await row()).retry_requested_at).toEqual(pressed);
  });

  it("keeps the stamp through the push's own upsert, which moves pushed_at past it", async () => {
    const before = await row();
    // attemptLedgerRow's write: every column of the row but the stamp.
    await db.query(
      `insert into public.rate_updates (hotel_id, pms_type, room_type_id, stay_date, price, status, error, attempts, pushed_at, sent_price)
         values ($1, 'cloudbeds', $2, '2026-10-05', 210, 'failed', 'Rate must be greater than 500', 2, now() + interval '1 minute', null)
       on conflict (hotel_id, room_type_id, stay_date) do update
         set price = excluded.price, status = excluded.status, error = excluded.error, attempts = excluded.attempts,
             pushed_at = excluded.pushed_at, sent_price = excluded.sent_price`,
      [HOTEL, ROOM],
    );
    const after = await row();
    expect(after).toMatchObject({ status: "failed", attempts: 2, retry_requested_at: before.retry_requested_at });
    expect(new Date(String(after.pushed_at)).getTime()).toBeGreaterThan(new Date(String(after.retry_requested_at)).getTime());
  });
});
