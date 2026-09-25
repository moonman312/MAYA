/**
 * 99_supabase_migration_room_count_zero_v1.sql run for real in PGlite: a room
 * type may hold 0 rooms afterwards, never fewer, and a second run changes
 * nothing. Only runs with MAYA_PGLITE_DIR set (see large-property-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const MIGRATION = readFileSync(resolve(__dirname, "../../../../99_supabase_migration_room_count_zero_v1.sql"), "utf8");

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

describe.skipIf(!PGLITE_DIR)("room count zero migration in PGlite", () => {
  let db: Db;

  beforeAll(async () => {
    const mod = await import(
      /* @vite-ignore */ pathToFileURL(`${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist/index.js`).href
    );
    db = new mod.PGlite() as Db;
    // The column as 02_supabase_schema.sql first created it.
    await db.exec(`
      create table public.room_types (
        id serial primary key,
        external_room_type_id text not null,
        total_rooms integer not null default 100 check (total_rooms > 0)
      );
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("refuses 0 before and takes it after, twice over", async () => {
    await expect(
      db.query("insert into public.room_types (external_room_type_id, total_rooms) values ('a', 0)"),
    ).rejects.toThrow(/check constraint/);

    await db.exec(MIGRATION);
    await db.exec(MIGRATION);

    await db.query("insert into public.room_types (external_room_type_id, total_rooms) values ('a', 0)");
    await expect(
      db.query("insert into public.room_types (external_room_type_id, total_rooms) values ('b', -1)"),
    ).rejects.toThrow(/check constraint/);

    const { rows } = await db.query(`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'public.room_types'::regclass and contype = 'c'
    `);
    expect(rows.map((r) => r.def)).toEqual(["CHECK ((total_rooms >= 0))"]);
  });
});
