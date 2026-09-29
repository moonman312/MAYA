/**
 * 99_supabase_migration_connection_outage_notice_v1.sql run for real in
 * PGlite, twice: when an outage starts and ends, what a deliberate disconnect
 * keeps, the Mews refusal count and what clears it, and the backfill of
 * connections already down. Only runs with MAYA_PGLITE_DIR set (see
 * large-property-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const MIGRATION = readFileSync(
  resolve(__dirname, "../../../../99_supabase_migration_connection_outage_notice_v1.sql"),
  "utf8",
);

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

const H = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const ALREADY_DOWN = H(1);
const CONNECTED = H(2);
const MEWS = H(3);
const PENDING = H(4);
const ERRORED = H(5);
const INSERTED = H(6);

describe.skipIf(!PGLITE_DIR)("connection outage migration in PGlite", () => {
  let db: Db;

  const row = async (hotel: string) =>
    (
      await db.query(
        `select status::text, down_since is not null as down, outage_notice_at is not null as noticed,
                auth_failures, down_since, outage_notice_at
           from public.pms_connections where hotel_id = $1`,
        [hotel],
      )
    ).rows[0];

  const note = async (hotel: string, pms = "mews", threshold = 3) =>
    (await db.query(`select * from public.pms_note_auth_failure($1, $2, $3)`, [hotel, pms, threshold])).rows;

  beforeAll(async () => {
    const mod = await import(
      /* @vite-ignore */ pathToFileURL(`${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist/index.js`).href
    );
    db = new mod.PGlite() as Db;
    // The table as 02_supabase_schema.sql and the later migrations leave the
    // columns this file reads.
    await db.exec(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
      end $$;
      create type public.connection_status as enum ('pending', 'connected', 'degraded', 'disconnected', 'error');
      create type public.pms_type as enum ('mews', 'cloudbeds', 'think');
      create table public.pms_connections (
        id uuid primary key default gen_random_uuid(),
        hotel_id uuid not null,
        pms_type public.pms_type not null,
        status public.connection_status not null default 'pending',
        last_sync_at timestamptz,
        sync_lease_until timestamptz,
        updated_at timestamptz not null default now(),
        unique (hotel_id, pms_type)
      );
      insert into public.pms_connections (hotel_id, pms_type, status, updated_at) values
        ('${ALREADY_DOWN}', 'cloudbeds', 'disconnected', '2026-09-01T10:00:00Z'),
        ('${CONNECTED}', 'cloudbeds', 'connected', '2026-09-20T10:00:00Z'),
        ('${MEWS}', 'mews', 'connected', '2026-09-20T10:00:00Z'),
        ('${PENDING}', 'mews', 'pending', '2026-09-20T10:00:00Z'),
        ('${ERRORED}', 'think', 'error', '2026-09-25T08:30:00Z');
    `);
    await db.exec(MIGRATION);
    await db.exec(MIGRATION);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it("backfills connections already down as noticed, from when they last changed, and leaves the rest alone", async () => {
    const down = await row(ALREADY_DOWN);
    expect(down).toMatchObject({ status: "disconnected", down: true, noticed: true, auth_failures: 0 });
    expect(new Date(String(down.down_since)).toISOString()).toBe("2026-09-01T10:00:00.000Z");
    const errored = await row(ERRORED);
    expect(new Date(String(errored.down_since)).toISOString()).toBe("2026-09-25T08:30:00.000Z");
    expect(errored.noticed).toBe(true);
    expect(await row(CONNECTED)).toMatchObject({ down: false, noticed: false, auth_failures: 0 });

    // A third run finds nothing new to stamp.
    const before = await row(ALREADY_DOWN);
    await db.exec(MIGRATION);
    expect(await row(ALREADY_DOWN)).toEqual(before);
  });

  it("starts an outage when a connection goes down and ends it when it comes back", async () => {
    await db.query(`update public.pms_connections set status = 'disconnected' where hotel_id = $1`, [CONNECTED]);
    const down = await row(CONNECTED);
    expect(down).toMatchObject({ status: "disconnected", down: true, noticed: false });

    // The notifier marks it; moving to Error and back is still the same outage.
    await db.query(`update public.pms_connections set outage_notice_at = now() where hotel_id = $1`, [CONNECTED]);
    await db.query(`update public.pms_connections set status = 'error' where hotel_id = $1`, [CONNECTED]);
    await db.query(`update public.pms_connections set status = 'disconnected' where hotel_id = $1`, [CONNECTED]);
    const still = await row(CONNECTED);
    expect(still).toMatchObject({ down: true, noticed: true });
    expect(still.down_since).toEqual(down.down_since);

    // Degraded is not down: back up, and the next outage is a new one.
    await db.query(`update public.pms_connections set status = 'degraded' where hotel_id = $1`, [CONNECTED]);
    expect(await row(CONNECTED)).toMatchObject({ status: "degraded", down: false, noticed: false });
    await db.query(`update public.pms_connections set status = 'error' where hotel_id = $1`, [CONNECTED]);
    expect(await row(CONNECTED)).toMatchObject({ status: "error", down: true, noticed: false });
    await db.query(`update public.pms_connections set status = 'connected' where hotel_id = $1`, [CONNECTED]);
    expect(await row(CONNECTED)).toMatchObject({ status: "connected", down: false, noticed: false });
  });

  it("keeps a notice the writer sets on a deliberate disconnect, and an insert that arrives down starts an outage", async () => {
    await db.query(
      `update public.pms_connections set status = 'disconnected', outage_notice_at = now() where hotel_id = $1`,
      [CONNECTED],
    );
    expect(await row(CONNECTED)).toMatchObject({ status: "disconnected", down: true, noticed: true });
    await db.query(`update public.pms_connections set status = 'connected' where hotel_id = $1`, [CONNECTED]);

    await db.query(
      `insert into public.pms_connections (hotel_id, pms_type, status) values ($1, 'mews', 'disconnected')`,
      [INSERTED],
    );
    const inserted = (
      await db.query(
        `select down_since is not null as down, outage_notice_at from public.pms_connections
          where hotel_id = $1`,
        [INSERTED],
      )
    ).rows[0];
    expect(inserted).toEqual({ down: true, outage_notice_at: null });
  });

  it("leaves the outage columns alone on writes that touch neither status nor last_sync_at", async () => {
    await db.query(`update public.pms_connections set status = 'error' where hotel_id = $1`, [CONNECTED]);
    const before = await row(CONNECTED);
    await db.query(`update public.pms_connections set sync_lease_until = now() where hotel_id = $1`, [CONNECTED]);
    expect(await row(CONNECTED)).toEqual(before);
    await db.query(`update public.pms_connections set status = 'connected' where hotel_id = $1`, [CONNECTED]);
  });

  it("marks Mews Error on the third refusal in a row, and a good read clears the count and the outage", async () => {
    expect(await note(MEWS)).toEqual([{ failures: 1, new_status: "connected" }]);
    expect(await note(MEWS)).toEqual([{ failures: 2, new_status: "connected" }]);

    // A good read in between starts the count again.
    await db.query(`update public.pms_connections set status = 'connected', last_sync_at = now() where hotel_id = $1`, [MEWS]);
    expect((await row(MEWS)).auth_failures).toBe(0);

    expect(await note(MEWS)).toEqual([{ failures: 1, new_status: "connected" }]);
    expect(await note(MEWS)).toEqual([{ failures: 2, new_status: "connected" }]);
    expect(await note(MEWS)).toEqual([{ failures: 3, new_status: "error" }]);
    expect(await row(MEWS)).toMatchObject({ status: "error", down: true, noticed: false, auth_failures: 3 });

    // Still refused: still Error, still counting, the same outage.
    const down = await row(MEWS);
    expect(await note(MEWS)).toEqual([{ failures: 4, new_status: "error" }]);
    expect((await row(MEWS)).down_since).toEqual(down.down_since);

    // The Mews sync's stamp after a good read.
    await db.query(
      `update public.pms_connections set status = 'connected', last_sync_at = now() + interval '1 minute'
        where hotel_id = $1 and status in ('connected', 'degraded', 'error')`,
      [MEWS],
    );
    expect(await row(MEWS)).toMatchObject({ status: "connected", down: false, noticed: false, auth_failures: 0 });
  });

  it("does not count refusals on a connection that is not in service", async () => {
    expect(await note(PENDING)).toEqual([]);
    expect(await note(ALREADY_DOWN, "cloudbeds")).toEqual([]);
    expect(await row(PENDING)).toMatchObject({ status: "pending", auth_failures: 0 });
    expect(await row(ALREADY_DOWN)).toMatchObject({ status: "disconnected", auth_failures: 0 });
  });

  it("lets only the service role count refusals", async () => {
    const grants = await db.query(`
      select grantee from information_schema.routine_privileges
       where routine_name = 'pms_note_auth_failure' and privilege_type = 'EXECUTE'
       order by grantee`);
    const who = grants.rows.map((r) => r.grantee);
    expect(who).toContain("service_role");
    expect(who).not.toContain("authenticated");
    expect(who).not.toContain("anon");
    expect(who).not.toContain("PUBLIC");
  });
});
