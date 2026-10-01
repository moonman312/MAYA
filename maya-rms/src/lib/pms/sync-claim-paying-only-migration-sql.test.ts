/**
 * 99_supabase_migration_sync_claim_paying_only_v1.sql run for real in PGlite,
 * twice, on top of every migration before it (audits A27 and A34): the
 * scheduler's claim leaves lapsed subscriptions and hotels that are not
 * active alone and keeps every filter it had; a restarted subscription or a
 * hotel switched back on is due at once; members read their connection rows
 * and can no longer write them. Only runs with MAYA_PGLITE_DIR set (see
 * engine/pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_sync_claim_paying_only_v1.sql";
const CADENCE_FILE = "99_supabase_migration_pricing_cadence_v1.sql";

const CADENCE_TEST = readFileSync(resolve(__dirname, "../engine/pricing-cadence-sql.test.ts"), "utf8");

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

const PAYING = "11111111-1111-4111-8111-111111111301";
const LAPSED = "11111111-1111-4111-8111-111111111302";
const NO_SUB = "11111111-1111-4111-8111-111111111303";
const PAST_DUE = "11111111-1111-4111-8111-111111111304";
const PLACEHOLDER = "11111111-1111-4111-8111-111111111305";
const PENDING = "11111111-1111-4111-8111-111111111306";
const PURGED = "11111111-1111-4111-8111-111111111307";
const GM = "33333333-3333-4333-8333-333333333301";
const GM_PLACEHOLDER = "33333333-3333-4333-8333-333333333302";

describe("the migration file", () => {
  const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8");
  const code = sql.replace(/--.*$/gm, "");

  it("is on the list the SQL tests build production's schema from, right after the third signups feed file", () => {
    expect(MIGRATION_ORDER).toContain(MIGRATION);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBe(MIGRATION_ORDER.indexOf("99_supabase_migration_signups_feed_v3.sql") + 1);
  });

  it("is one transaction, keeps row level security on and never grants anon or members anything", () => {
    expect(code.match(/\bbegin;/g)).toHaveLength(1);
    expect(code.match(/\bcommit;/g)).toHaveLength(1);
    expect(code).not.toMatch(/disable row level security/i);
    expect(code).not.toMatch(/grant[^;]*\b(anon|authenticated)\b/i);
    expect(code).not.toMatch(/create policy/i);
  });

  it("revokes execute from public, anon and authenticated on every function it defines", () => {
    const defined = [...code.matchAll(/create or replace function (public\.[a-z_]+)\(/g)].map((m) => m[1]);
    expect(defined.sort()).toEqual(["public.claim_pms_sync_batch", "public.pms_sync_due_on_restart"]);
    for (const fn of defined) {
      expect(code).toMatch(new RegExp(`revoke all on function ${fn.replace(".", "\\.")}\\([^)]*\\) from public, anon, authenticated;`));
    }
  });

  it("restates the claim from its newest definition, keeping the purge hold and the pending filter", () => {
    const fn = code.slice(code.indexOf("create or replace function public.claim_pms_sync_batch("));
    expect(fn).toContain("c.status not in ('disconnected', 'pending')");
    expect(fn).toContain("h.data_purged_at is not null");
    expect(fn).toContain("for update of c skip locked");
  });
});

describe.skipIf(!PGLITE_DIR)("the paying-only claim in PGlite", () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

  /** Runs `fn` as this signed-in person, then puts the session back. */
  const as = async <T>(userId: string, fn: () => Promise<T>): Promise<T> => {
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

  const claim = async (limit = 25) =>
    (await q(`select hotel_id::text as h from public.claim_pms_sync_batch('cloudbeds', $1, 300, 'w1')`, [limit])).map((r) => String(r.h)).sort();

  /** Seconds from now until each connection is due, by hotel. */
  const dueIn = async (hotel: string) =>
    Number(
      (await q(`select round(extract(epoch from (sync_due_at - now())))::int as s from public.pms_connections where hotel_id = $1`, [hotel]))[0]
        .s,
    );

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

    // The file under test, twice: it is safe to run again.
    await db.exec(fileSql(MIGRATION));
    await db.exec(fileSql(MIGRATION));

    await db.exec(`
      select set_config('request.jwt.claim.role', 'service_role', false);
      insert into auth.users (id, email) values ('${GM}', 'gm@example.com'), ('${GM_PLACEHOLDER}', 'new@example.com');
      insert into public.hotels (id, name, timezone, is_active, setup_pending_at) values
        ('${PAYING}', 'Juniper Lodge', 'UTC', true, null),
        ('${LAPSED}', 'Harbour Inn', 'UTC', true, null),
        ('${NO_SUB}', 'Cedar Court', 'UTC', true, null),
        ('${PAST_DUE}', 'Willow House', 'UTC', true, null),
        ('${PLACEHOLDER}', 'Pending setup 1', 'UTC', false, now()),
        ('${PENDING}', 'Birch Cabins', 'UTC', false, now()),
        ('${PURGED}', 'Aspen Rooms', 'UTC', true, null);
      update public.hotels set data_purged_at = now() - interval '1 day' where id = '${PURGED}';
      insert into public.hotel_memberships (hotel_id, user_id, role) values
        ('${PAYING}', '${GM}', 'general_manager'), ('${PLACEHOLDER}', '${GM_PLACEHOLDER}', 'hotel_admin');
      insert into public.hotel_subscriptions (hotel_id, status, plan_kind, billing_interval, billed_rooms) values
        ('${PAYING}', 'active', 'internal', 'month', 10),
        ('${LAPSED}', 'canceled', 'internal', 'month', 10),
        ('${PAST_DUE}', 'past_due', 'internal', 'month', 10);
    `);
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.exec(`
      delete from public.pms_connections;
      insert into public.pms_connections (hotel_id, pms_type, status, sync_due_at) values
        ('${PAYING}', 'cloudbeds', 'connected', now() - interval '5 minutes'),
        ('${LAPSED}', 'cloudbeds', 'connected', now() - interval '30 days'),
        ('${NO_SUB}', 'cloudbeds', 'connected', now() - interval '4 minutes'),
        ('${PAST_DUE}', 'cloudbeds', 'error', now() - interval '3 minutes'),
        ('${PLACEHOLDER}', 'cloudbeds', 'connected', now() - interval '20 days'),
        ('${PENDING}', 'cloudbeds', 'pending', now() - interval '20 days'),
        ('${PURGED}', 'cloudbeds', 'connected', now() - interval '20 days');
      update public.hotel_subscriptions set status = 'canceled' where hotel_id = '${LAPSED}';
      update public.hotels set is_active = false where id = '${PLACEHOLDER}';
    `);
  });

  describe("the claim (A27, A34)", () => {
    it("takes paying, past due and never-billed hotels, and leaves lapsed, inactive, parked and purged ones alone", async () => {
      expect(await claim()).toEqual([PAYING, NO_SUB, PAST_DUE].sort());
      // Nothing left to take: the three are leased now, the rest never were.
      expect(await claim()).toEqual([]);
      const leased = await q(`select hotel_id::text as h from public.pms_connections where sync_lease_owner is not null order by 1`);
      expect(leased.map((r) => r.h)).toEqual([PAYING, NO_SUB, PAST_DUE].sort());
    });

    it("no longer lets a pile of lapsed hotels crowd paying ones out of a small batch", async () => {
      // The lapsed and the placeholder are the most overdue by far.
      expect(await claim(2)).toEqual([PAYING, NO_SUB].sort());
    });

    it("stays service-role only", async () => {
      const rows = await q(
        `select has_function_privilege('anon', 'public.claim_pms_sync_batch(text, integer, integer, text)', 'execute') as anon,
                has_function_privilege('authenticated', 'public.claim_pms_sync_batch(text, integer, integer, text)', 'execute') as members,
                has_function_privilege('service_role', 'public.claim_pms_sync_batch(text, integer, integer, text)', 'execute') as service`,
      );
      expect(rows).toEqual([{ anon: false, members: false, service: true }]);
    });
  });

  describe("due at once when it can be worked on again", () => {
    it("makes a restarted subscription's connection due now, so the next tick takes it", async () => {
      await db.exec(`update public.pms_connections set sync_due_at = now() + interval '1 hour' where hotel_id = '${LAPSED}'`);
      await db.exec(`update public.hotel_subscriptions set status = 'active' where hotel_id = '${LAPSED}'`);
      expect(await dueIn(LAPSED)).toBeLessThanOrEqual(0);
      expect(await claim()).toContain(LAPSED);
    });

    it("does not move a hotel whose subscription changes between two statuses that are owed service", async () => {
      await db.exec(`update public.pms_connections set sync_due_at = now() + interval '10 minutes' where hotel_id = '${PAYING}'`);
      await db.exec(`update public.hotel_subscriptions set status = 'past_due' where hotel_id = '${PAYING}'`);
      expect(await dueIn(PAYING)).toBeGreaterThan(500);
      await db.exec(`update public.hotel_subscriptions set status = 'active' where hotel_id = '${PAYING}'`);
    });

    it("makes a new subscription's connection due now, and leaves a lapsed one waiting", async () => {
      await db.exec(`update public.pms_connections set sync_due_at = now() + interval '1 hour' where hotel_id in ('${NO_SUB}', '${PENDING}')`);
      await db.exec(`insert into public.hotel_subscriptions (hotel_id, status, plan_kind, billing_interval, billed_rooms) values ('${PENDING}', 'unpaid', 'internal', 'month', 10)`);
      expect(await dueIn(PENDING)).toBeGreaterThan(3000);
      await db.exec(`insert into public.hotel_subscriptions (hotel_id, status, plan_kind, billing_interval, billed_rooms) values ('${NO_SUB}', 'trialing', 'internal', 'month', 10)`);
      expect(await dueIn(NO_SUB)).toBeLessThanOrEqual(0);
      await db.exec(`delete from public.hotel_subscriptions where hotel_id in ('${NO_SUB}', '${PENDING}')`);
    });

    it("makes a hotel switched on due now", async () => {
      await db.exec(`update public.pms_connections set sync_due_at = now() + interval '1 hour' where hotel_id = '${PLACEHOLDER}'`);
      await db.exec(`update public.hotels set is_active = true where id = '${PLACEHOLDER}'`);
      expect(await dueIn(PLACEHOLDER)).toBeLessThanOrEqual(0);
      expect(await claim()).toContain(PLACEHOLDER);
    });

    it("leaves a connection under a live lease to the run that holds it", async () => {
      await db.exec(`
        update public.pms_connections set sync_due_at = now() + interval '1 hour', sync_lease_until = now() + interval '5 minutes', sync_lease_owner = 'w9'
         where hotel_id = '${LAPSED}';
        update public.hotel_subscriptions set status = 'active' where hotel_id = '${LAPSED}';`);
      expect(await dueIn(LAPSED)).toBeGreaterThan(3000);
    });

    it("never runs for anyone who calls it", async () => {
      const rows = await q(
        `select has_function_privilege('anon', 'public.pms_sync_due_on_restart()', 'execute') as anon,
                has_function_privilege('authenticated', 'public.pms_sync_due_on_restart()', 'execute') as members`,
      );
      expect(rows).toEqual([{ anon: false, members: false }]);
    });
  });

  describe("members and their connection rows (A34)", () => {
    it("lets a member read their own row, and nobody else's", async () => {
      const rows = await as(GM, () => q(`select hotel_id::text as h from public.pms_connections order by 1`));
      expect(rows.map((r) => r.h)).toEqual([PAYING]);
    });

    it("refuses a General Manager marking a parked connection Connected, or pointing it at another address", async () => {
      await as(GM_PLACEHOLDER, async () => {
        const marked = await q(
          `update public.pms_connections set status = 'connected' where hotel_id = '${PLACEHOLDER}' returning hotel_id`,
        );
        expect(marked).toEqual([]);
      });
      await as(GM, async () => {
        const moved = await q(
          `update public.pms_connections set base_url = 'https://example.test' where hotel_id = '${PAYING}' returning hotel_id`,
        );
        expect(moved).toEqual([]);
      });
      const rows = await q(`select hotel_id::text as h, base_url from public.pms_connections where hotel_id = $1`, [PAYING]);
      expect(rows).toEqual([{ h: PAYING, base_url: null }]);
    });

    it("refuses a member adding a connection row", async () => {
      await db.exec(`delete from public.pms_connections where hotel_id = '${PLACEHOLDER}'`);
      await expect(
        as(GM_PLACEHOLDER, () =>
          q(`insert into public.pms_connections (hotel_id, pms_type, status) values ('${PLACEHOLDER}', 'cloudbeds', 'connected')`),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("leaves only the read policy on the table, with row level security on", async () => {
      const policies = await q(`select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'pms_connections' order by 1`);
      expect(policies).toEqual([{ policyname: "pms_connections_read", cmd: "SELECT" }]);
      const [{ rls }] = await q(`select relrowsecurity as rls from pg_class where oid = 'public.pms_connections'::regclass`);
      expect(rls).toBe(true);
    });

    it("still lets the service role write, as every app path does", async () => {
      await db.exec(`update public.pms_connections set status = 'degraded' where hotel_id = '${PAYING}'`);
      const [{ status }] = await q(`select status::text as status from public.pms_connections where hotel_id = $1`, [PAYING]);
      expect(status).toBe("degraded");
    });
  });
});
