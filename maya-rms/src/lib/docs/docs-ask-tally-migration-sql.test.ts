/**
 * 99_supabase_migration_docs_ask_tally_v1.sql, run for real in PGlite: it
 * applies twice, the service role inserts, the table refuses bad rows, only
 * a platform admin reads the rows or the counts, and every row the route can
 * write fits. Only runs with MAYA_PGLITE_DIR set (see
 * src/lib/engine/large-property-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_AREAS, handleTally, OUTCOMES, PLACES, createTallyLimiter, type DocsAskTallyRow } from "./ask-tally";
import { weeklyFrom, totalsFrom, weeksEndingAt, type WeeklyRow } from "../admin/docs-tally";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const MIGRATION = readFileSync(resolve(__dirname, "../../../../99_supabase_migration_docs_ask_tally_v1.sql"), "utf8");

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

describe.skipIf(!PGLITE_DIR)("docs_ask_tally migration in PGlite", () => {
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

  const as = async (role: string, sql: string, admin = false, params?: unknown[]) => {
    await db.exec(`set test.admin = '${admin}'; set role ${role};`);
    try {
      return await db.query(sql, params);
    } finally {
      await db.exec("reset role;");
    }
  };

  it("lets the service role insert a row, fills in the day, and refuses a bad one", async () => {
    await as(
      "service_role",
      `insert into public.docs_ask_tally (asked_on, outcome, signed_in, section, app_area) values
         ('2026-09-21', 'answered', true, 'rules', 'calendar'),
         ('2026-09-22', 'none', false, 'home', ''),
         ('2026-09-24', 'none', false, 'support', ''),
         ('2026-09-15', 'canned', false, 'rules', 'rules.builder')`,
    );
    await db.exec("begin; set role service_role;");
    try {
      const today = await db.query(`insert into public.docs_ask_tally (outcome, section) values ('unsure', 'billing') returning asked_on::text as day`);
      expect(today.rows[0].day).toBe(new Date().toISOString().slice(0, 10));
    } finally {
      await db.exec("rollback; reset role;");
    }
    await expect(as("service_role", `delete from public.docs_ask_tally`)).rejects.toThrow();
    await expect(as("service_role", `insert into public.docs_ask_tally (outcome) values ('great')`)).rejects.toThrow();
    await expect(as("service_role", `insert into public.docs_ask_tally (outcome, section) values ('none', '/docs/rules')`)).rejects.toThrow();
    await expect(as("service_role", `insert into public.docs_ask_tally (outcome, app_area) values ('none', 'Calendar <b>')`)).rejects.toThrow();
    await expect(as("service_role", `insert into public.docs_ask_tally (outcome, section) values ('none', repeat('a', 41))`)).rejects.toThrow();
  });

  it("accepts every row the route can write", async () => {
    const rows: DocsAskTallyRow[] = [];
    const deps = { limiter: createTallyLimiter(), write: async (row: DocsAskTallyRow) => void rows.push(row), signedIn: async () => true };
    for (const outcome of OUTCOMES) {
      for (const section of PLACES) {
        const res = await handleTally(
          new Request("http://localhost/api/docs-ask/tally", {
            method: "POST",
            body: JSON.stringify({ outcome, section, appArea: APP_AREAS[(section.length + outcome.length) % APP_AREAS.length] }),
            headers: { "x-forwarded-for": `198.51.100.${rows.length % 250}` },
          }),
          deps,
        );
        expect(res.status).toBe(204);
      }
    }
    for (const app of APP_AREAS) rows.push({ asked_on: "2026-09-25", outcome: "none", signed_in: false, section: "home", app_area: app });
    await db.exec("begin; set role service_role;");
    try {
      for (const r of rows) {
        await db.query(
          `insert into public.docs_ask_tally (asked_on, outcome, signed_in, section, app_area) values ($1, $2, $3, $4, $5)`,
          [r.asked_on, r.outcome, r.signed_in, r.section, r.app_area],
        );
      }
    } finally {
      // rolled back so the next test sees only the four rows above
      await db.exec("rollback; reset role;");
    }
  });

  it("shows the rows and the counts to a platform admin only, and lets no reader write", async () => {
    expect((await as("authenticated", "select count(*)::int as n from public.docs_ask_tally", true)).rows).toEqual([{ n: 4 }]);
    expect((await as("authenticated", "select count(*)::int as n from public.docs_ask_tally", false)).rows).toEqual([{ n: 0 }]);
    await expect(as("anon", "select * from public.docs_ask_tally")).rejects.toThrow();
    await expect(as("authenticated", `insert into public.docs_ask_tally (outcome, section) values ('none', 'home')`, true)).rejects.toThrow();
    await expect(as("anon", `insert into public.docs_ask_tally (outcome, section) values ('none', 'home')`)).rejects.toThrow();

    const counts = await as("authenticated", "select outcome, n from public.docs_ask_tally_counts('2026-09-20')", true);
    const t = totalsFrom(counts.rows as { outcome: string; n: number }[]);
    expect(t.asked).toBe(3);
    expect(t.byOutcome.none).toBe(2);
    expect((await as("authenticated", "select * from public.docs_ask_tally_counts('2026-01-01')", false)).rows).toEqual([]);
    await expect(as("anon", "select * from public.docs_ask_tally_counts('2026-01-01')")).rejects.toThrow();
    await expect(as("anon", "select * from public.docs_ask_tally_weekly('2026-01-01')")).rejects.toThrow();
  });

  it("adds up the weeks by reply, signed in or not, section and MAYA screen", async () => {
    const weeks = weeksEndingAt("2026-09-25", 2);
    const res = await as(
      "authenticated",
      `select week::text as week, outcome, signed_in, section, app_area, n from public.docs_ask_tally_weekly('${weeks[0]}')`,
      true,
    );
    const w = weeklyFrom(res.rows as unknown as WeeklyRow[], weeks);
    expect(w.lines.map((l) => [l.week, l.asked, l.signedIn, l.signedOut, l.byOutcome.none])).toEqual([
      ["2026-09-14", 1, 0, 1, 0],
      ["2026-09-21", 3, 1, 2, 2],
    ]);
    expect(w.places.map((p) => [p.key, p.perWeek])).toEqual([
      ["rules", [1, 1]],
      ["home", [0, 1]],
      ["support", [0, 1]],
    ]);
    expect(w.areas.map((a) => [a.key, a.perWeek])).toEqual([
      ["calendar", [0, 1]],
      ["rules.builder", [1, 0]],
    ]);
    expect((await as("authenticated", `select * from public.docs_ask_tally_weekly('${weeks[0]}')`, false)).rows).toEqual([]);
  });
});
