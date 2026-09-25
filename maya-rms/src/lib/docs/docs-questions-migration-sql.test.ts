/**
 * 99_supabase_migration_docs_questions_v1.sql, run for real in PGlite: it
 * applies twice, the service role inserts, the table refuses bad rows, and
 * only a platform admin reads. Only runs with MAYA_PGLITE_DIR set (see
 * src/lib/engine/large-property-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const MIGRATION = readFileSync(resolve(__dirname, "../../../../99_supabase_migration_docs_questions_v1.sql"), "utf8");

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

describe.skipIf(!PGLITE_DIR)("docs_questions migration in PGlite", () => {
  let db: Db;

  beforeAll(async () => {
    const mod = await import(
      /* @vite-ignore */ pathToFileURL(`${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist/index.js`).href
    );
    db = new mod.PGlite() as Db;
    // Supabase's roles, and is_platform_admin as a switch the test flips.
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create or replace function public.is_platform_admin(p_user_id uuid default null) returns boolean
        language sql stable as $$ select coalesce(current_setting('test.admin', true), 'false')::boolean $$;
      grant execute on function public.is_platform_admin(uuid) to authenticated, service_role;
      grant usage on schema public to anon, authenticated, service_role;
    `);
    await db.exec(MIGRATION);
    await db.exec(MIGRATION);
  });

  afterAll(async () => {
    await db?.close();
  });

  const as = async (role: string, sql: string, admin = false) => {
    await db.exec(`set test.admin = '${admin}'; set role ${role};`);
    try {
      return await db.query(sql);
    } finally {
      await db.exec("reset role;");
    }
  };

  it("lets the service role insert a row, and refuses a bad one", async () => {
    await as(
      "service_role",
      `insert into public.docs_questions (source, question, page, sections_shown, note, signed_in)
       values ('unanswered', 'Does it work with Mews?', '/docs/connect/mews', '/docs/connect/mews', '', true)`,
    );
    await expect(as("service_role", `insert into public.docs_questions (source) values ('spam')`)).rejects.toThrow();
    await expect(as("service_role", `insert into public.docs_questions (source, question) values ('unanswered', repeat('x', 501))`)).rejects.toThrow();
    await expect(as("service_role", `insert into public.docs_questions (source, page) values ('page-useful', 'https://evil.example')`)).rejects.toThrow();
  });

  it("shows the rows to a platform admin only, and lets no reader write", async () => {
    expect((await as("authenticated", "select question from public.docs_questions", true)).rows).toEqual([{ question: "Does it work with Mews?" }]);
    expect((await as("authenticated", "select question from public.docs_questions", false)).rows).toEqual([]);
    await expect(as("anon", "select question from public.docs_questions")).rejects.toThrow();
    await expect(as("authenticated", `insert into public.docs_questions (source, page) values ('page-useful', '/docs')`, true)).rejects.toThrow();
  });
});
