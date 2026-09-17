/**
 * Section 6 of 99_supabase_migration_push_guardrails_v1.sql, the reset of
 * legacy "no rate target" skips, run for real in PGlite with its count query.
 * Only runs with MAYA_PGLITE_DIR set (see large-property-sql.test.ts).
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

const H1 = "00000000-0000-4000-8000-000000000001";
const H2 = "00000000-0000-4000-8000-000000000002";
const rt = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
const NEVER = rt(1);
const SENT_ON_A_PAST_NIGHT = rt(2);
const FAILED_ONCE = rt(3);
const SKIP_WITH_REFERENCE = rt(4);

describe.skipIf(!PGLITE_DIR)("push guardrails migration section 6 in PGlite", () => {
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
        attempts integer not null default 0,
        pms_job_reference text,
        external_rate_id text,
        unique (hotel_id, room_type_id, stay_date)
      );
    `);
    const skip = (hotel: string, room: string, night: string, extra = "null, null") =>
      `('${hotel}', '${room}', '${night}', 'skipped', 'no rate target for room type', 1, ${extra})`;
    await db.exec(`
      insert into public.rate_updates (hotel_id, room_type_id, stay_date, status, error, attempts, pms_job_reference, external_rate_id) values
        ${skip(H1, NEVER, "2026-09-20")},
        ${skip(H1, NEVER, "2026-09-21")},
        -- A bulk upsert nulled this skip's reference; the send it overwrote shows on an older night.
        ('${H1}', '${SENT_ON_A_PAST_NIGHT}', '2026-08-01', 'sent', null, 1, 'job-1', 'rate-1'),
        ${skip(H1, SENT_ON_A_PAST_NIGHT, "2026-09-20")},
        ('${H1}', '${FAILED_ONCE}', '2026-09-19', 'failed', 'Service Unavailable', 2, null, 'rate-3'),
        ${skip(H1, FAILED_ONCE, "2026-09-20")},
        ${skip(H1, SKIP_WITH_REFERENCE, "2026-09-20", "'job-9', 'rate-9'")},
        -- Another hotel's sends say nothing about this one's room types.
        ('${H2}', '${rt(9)}', '2026-09-20', 'sent', null, 1, 'job-2', 'rate-2');
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
});
