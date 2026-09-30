/**
 * 99_supabase_migration_pilot_health_v2.sql run for real in PGlite, twice, on
 * top of every migration before it: what platform_pilot_health() counts as a
 * published price waiting to be sent, what it leaves out, the nights held for
 * a rate read, and that everything the function said before it still says.
 * Only runs with MAYA_PGLITE_DIR set (see pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_pilot_health_v2.sql";

/**
 * The order production ran the migrations in, read off the cadence test's
 * MIGRATION_ORDER (importing that file would run its suite here too).
 */
const MIGRATION_ORDER: string[] = (() => {
  const src = readFileSync(resolve(__dirname, "../engine/pricing-cadence-sql.test.ts"), "utf8");
  const list = src.slice(src.indexOf("MIGRATION_ORDER = ["), src.indexOf("];", src.indexOf("MIGRATION_ORDER = [")));
  return [...list.matchAll(/"(99_supabase_migration_[^"]+\.sql)"/g)].map((m) => m[1]);
})();

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

/** What Supabase provides and the files assume: the roles, auth's functions and users table, vault. */
const PLATFORM = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role supabase_admin nologin;
grant usage on schema public to anon, authenticated, service_role;
create schema auth;
create table auth.users (
  id uuid primary key, email text, raw_user_meta_data jsonb, raw_app_meta_data jsonb,
  created_at timestamptz default now(), last_sign_in_at timestamptz, email_confirmed_at timestamptz,
  confirmed_at timestamptz, phone text, updated_at timestamptz, banned_until timestamptz, deleted_at timestamptz
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
create schema vault;
`;

function fileSql(name: string): string {
  let sql = readFileSync(resolve(ROOT, name), "utf8");
  sql = sql.replace(/create extension if not exists supabase_vault[^;]*;/gi, "");
  if (name === "99_supabase_migration_rate_push_v1.sql") sql = `drop table if exists public.rate_updates cascade;\n${sql}`;
  return sql;
}

const H = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const LIVE = H(1);
const SIMULATING = H(2);
const LIVE_MEWS = H(3);
const LIVE_THINK = H(4);
const JUST_LIVE = H(5);
const HEALTHY = H(6);
const RT = (hotel: number, n: number) => `10000000-0000-4000-8000-0000000000${hotel}${n}`;
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const today = new Date().toISOString().slice(0, 10);
const night = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const NEW_COLUMNS = `
  select name, mode, pms_type::text as pms_type, sent_24h, open_incidents, open_incident_causes,
         unsent_count, unsent_since, rate_read_waiting, rate_read_waiting_since
    from public.platform_pilot_health($1)`;

describe("the migration file", () => {
  it("is on the list the SQL tests build production's schema from, after the file it replaces", () => {
    expect(MIGRATION_ORDER).toContain(MIGRATION);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBeGreaterThan(MIGRATION_ORDER.indexOf("99_supabase_migration_pilot_health_v1.sql"));
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBeGreaterThan(MIGRATION_ORDER.indexOf("99_supabase_migration_push_guardrails_v1.sql"));
  });

  it("is one transaction, and creates no table", () => {
    const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8").replace(/--.*$/gm, "");
    expect(sql.match(/\bbegin;/g)).toHaveLength(1);
    expect(sql.match(/\bcommit;/g)).toHaveLength(1);
    expect(sql).not.toMatch(/create table|alter table|create policy|drop policy/i);
  });
});

describe.skipIf(!PGLITE_DIR)("pilot health v2 in PGlite", () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const asService = async <T>(fn: () => Promise<T>): Promise<T> => {
    await db.exec(`select set_config('request.jwt.claim.role', 'service_role', false)`);
    try {
      return await fn();
    } finally {
      await db.exec(`select set_config('request.jwt.claim.role', '', false)`);
    }
  };
  const rowFor = async (name: string) => (await asService(() => q(NEW_COLUMNS, [false]))).find((r) => r.name === name);
  const ageMinutes = (v: unknown) => Math.round((Date.now() - new Date(String(v)).getTime()) / 60_000);

  beforeAll(async () => {
    const dist = `${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist`;
    const mod = await import(/* @vite-ignore */ pathToFileURL(`${dist}/index.js`).href);
    const { pgcrypto } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/pgcrypto.js`).href);
    const { citext } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/citext.js`).href);
    db = new mod.PGlite({ extensions: { pgcrypto, citext } }) as Db;
    await db.exec(PLATFORM);
    for (const name of [
      "01_supabase_base_schema.sql",
      "02_supabase_schema.sql",
      ...MIGRATION_ORDER.slice(0, MIGRATION_ORDER.indexOf(MIGRATION)),
      // The cadence test's own file, which its list leaves out: hotel_pricing_state is made there.
      "99_supabase_migration_pricing_cadence_v1.sql",
    ]) {
      try {
        await db.exec(fileSql(name));
      } catch (e) {
        throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // The file under test, twice: it is safe to run again.
    await db.exec(fileSql(MIGRATION));
    await db.exec(fileSql(MIGRATION));

    const price = (hotel: string, roomType: string, stay: string, amount: number, publishedAgo: string) =>
      `('${hotel}', '${stay}', '${roomType}', ${amount}, ${amount}, now() - interval '${publishedAgo}')`;
    const ledger = (hotel: string, pms: string, roomType: string, stay: string, amount: number, status: string, attempts = 1) =>
      `('${hotel}', '${pms}', '${roomType}', '${stay}', ${amount}, '${status}', ${attempts}, now() - interval '3 hours')`;

    await db.exec(`
      select set_config('request.jwt.claim.role', 'service_role', false);
      insert into auth.users (id, email) values ('${ADMIN}', 'jake@example.com');
      insert into public.app_roles (user_id, role) values ('${ADMIN}', 'platform_admin');
      insert into public.hotels (id, name, timezone) values
        ('${LIVE}', 'Live Inn', 'America/Denver'),
        ('${SIMULATING}', 'Simulating Inn', 'UTC'),
        ('${LIVE_MEWS}', 'Mews Inn', 'UTC'),
        ('${LIVE_THINK}', 'Think Inn', 'UTC'),
        ('${JUST_LIVE}', 'Just Live Inn', 'UTC'),
        ('${HEALTHY}', 'Healthy Inn', 'UTC');
      insert into public.hotel_settings (hotel_id, simulation_mode) values
        ('${LIVE}', false), ('${SIMULATING}', true), ('${LIVE_MEWS}', false),
        ('${LIVE_THINK}', false), ('${JUST_LIVE}', false), ('${HEALTHY}', false)
        on conflict (hotel_id) do update set simulation_mode = excluded.simulation_mode;
      -- Live for a week, except the one that went live ten minutes ago.
      update public.hotel_settings set live_since = now() - interval '7 days' where simulation_mode = false;
      update public.hotel_settings set live_since = now() - interval '10 minutes' where hotel_id = '${JUST_LIVE}';
      insert into public.pms_connections (hotel_id, pms_type, status, last_sync_at) values
        ('${LIVE}', 'cloudbeds', 'connected', now() - interval '3 minutes'),
        ('${SIMULATING}', 'cloudbeds', 'connected', now() - interval '3 minutes'),
        ('${LIVE_MEWS}', 'mews', 'connected', now() - interval '3 minutes'),
        ('${LIVE_THINK}', 'think', 'connected', now() - interval '3 minutes'),
        ('${JUST_LIVE}', 'cloudbeds', 'connected', now() - interval '3 minutes'),
        ('${HEALTHY}', 'cloudbeds', 'connected', now() - interval '3 minutes');
      insert into public.room_types (id, hotel_id, external_room_type_id, name, total_rooms, is_active) values
        ('${RT(1, 1)}', '${LIVE}', 'K', 'King', 8, true),
        ('${RT(1, 2)}', '${LIVE}', 'Q', 'Queen', 4, true),
        ('${RT(1, 3)}', '${LIVE}', 'OLD', 'Closed wing', 4, false),
        ('${RT(2, 1)}', '${SIMULATING}', 'K', 'King', 8, true),
        ('${RT(3, 1)}', '${LIVE_MEWS}', 'K', 'King', 8, true),
        ('${RT(4, 1)}', '${LIVE_THINK}', 'K', 'King', 8, true),
        ('${RT(5, 1)}', '${JUST_LIVE}', 'K', 'King', 8, true),
        ('${RT(6, 1)}', '${HEALTHY}', 'K', 'King', 8, true);

      insert into public.published_price (hotel_id, stay_date, room_type_id, price, base_price, computed_at) values
        -- Live Inn, King. Nobody has tried night 3; night 4 failed; night 5 is held by MAYA;
        -- night 6 was sent at an older price; night 7 is sent at this price.
        ${price(LIVE, RT(1, 1), night(3), 210, "5 hours")},
        ${price(LIVE, RT(1, 1), night(4), 210, "4 hours")},
        ${price(LIVE, RT(1, 1), night(5), 210, "3 hours")},
        ${price(LIVE, RT(1, 1), night(6), 230, "2 hours")},
        ${price(LIVE, RT(1, 1), night(7), 210, "6 hours")},
        -- Published twenty minutes ago: not waiting long enough to say anything.
        ${price(LIVE, RT(1, 1), night(8), 215, "20 minutes")},
        -- Tonight, and a night already over: the first is left to the hotel's own date, the second is history.
        ${price(LIVE, RT(1, 1), night(0), 210, "5 hours")},
        ${price(LIVE, RT(1, 1), night(-2), 210, "3 days")},
        -- Past the window the pass prices.
        ${price(LIVE, RT(1, 1), night(500), 210, "5 hours")},
        -- A comp night, which MAYA does not send, and a room type that is switched off.
        ${price(LIVE, RT(1, 2), night(3), 0, "5 hours")},
        ${price(LIVE, RT(1, 3), night(3), 150, "5 hours")},
        -- The others: one unsent night each, five hours old.
        ${price(SIMULATING, RT(2, 1), night(3), 210, "5 hours")},
        ${price(LIVE_MEWS, RT(3, 1), night(3), 210, "5 hours")},
        ${price(LIVE_THINK, RT(4, 1), night(3), 210, "5 hours")},
        ${price(JUST_LIVE, RT(5, 1), night(3), 210, "5 hours")},
        ${price(HEALTHY, RT(6, 1), night(3), 210, "5 hours")},
        ${price(HEALTHY, RT(6, 1), night(4), 220, "5 hours")};

      insert into public.rate_updates (hotel_id, pms_type, room_type_id, stay_date, price, status, attempts, pushed_at) values
        ${ledger(LIVE, "cloudbeds", RT(1, 1), night(4), 210, "failed")},
        ${ledger(LIVE, "cloudbeds", RT(1, 1), night(5), 210, "skipped", 0)},
        ${ledger(LIVE, "cloudbeds", RT(1, 1), night(6), 200, "sent")},
        ${ledger(LIVE, "cloudbeds", RT(1, 1), night(7), 210, "sent")},
        ${ledger(HEALTHY, "cloudbeds", RT(6, 1), night(3), 210, "sent")},
        ${ledger(HEALTHY, "cloudbeds", RT(6, 1), night(4), 220, "sent")};

      -- Nights held until the hotel's rates are read: two open, one that landed, and an older problem that closed.
      insert into public.rate_push_incidents (id, hotel_id, pms_type, cause, known, severity, admin_only, opened_at, resolved_at, resolution) values
        ('20000000-0000-4000-8000-000000000001', '${LIVE}', 'cloudbeds', 'awaiting_rate_read', true, 'transient', false, now() - interval '95 minutes', null, null),
        ('20000000-0000-4000-8000-000000000002', '${LIVE}', 'cloudbeds', 'awaiting_rate_read', true, 'transient', false, now() - interval '3 days', now() - interval '2 days', 'landed'),
        ('20000000-0000-4000-8000-000000000003', '${LIVE}', 'cloudbeds', 'value_rejected', true, 'critical', false, now() - interval '30 minutes', null, null);
      insert into public.rate_push_incident_cells (incident_id, hotel_id, room_type_id, stay_date, price, state, attempts, first_attempt_at, last_attempt_at, closed_at) values
        ('20000000-0000-4000-8000-000000000001', '${LIVE}', '${RT(1, 1)}', '${night(3)}', 210, 'open', 1, now() - interval '95 minutes', now() - interval '95 minutes', null),
        ('20000000-0000-4000-8000-000000000001', '${LIVE}', '${RT(1, 1)}', '${night(9)}', 210, 'open', 1, now() - interval '40 minutes', now() - interval '40 minutes', null),
        ('20000000-0000-4000-8000-000000000001', '${LIVE}', '${RT(1, 1)}', '${night(10)}', 210, 'landed', 1, now() - interval '95 minutes', now() - interval '95 minutes', now() - interval '50 minutes'),
        ('20000000-0000-4000-8000-000000000002', '${LIVE}', '${RT(1, 1)}', '${night(11)}', 210, 'landed', 1, now() - interval '3 days', now() - interval '3 days', now() - interval '2 days'),
        ('20000000-0000-4000-8000-000000000003', '${LIVE}', '${RT(1, 1)}', '${night(4)}', 210, 'open', 2, now() - interval '30 minutes', now() - interval '5 minutes', null);
      select set_config('request.jwt.claim.role', '', false);
    `);
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  it("counts a Live hotel's published prices that have waited over an hour with no sent record at that price", async () => {
    const live = await rowFor("Live Inn");
    // Nights 3 (never tried), 4 (failed), 5 (held by MAYA) and 6 (sent at an older price).
    expect(live).toMatchObject({ mode: "live", pms_type: "cloudbeds", unsent_count: 4 });
    // The oldest of them was published five hours ago.
    expect(ageMinutes(live?.unsent_since)).toBe(300);
  });

  it("counts none for a hotel whose prices are all sent", async () => {
    expect(await rowFor("Healthy Inn")).toMatchObject({ unsent_count: 0, unsent_since: null, rate_read_waiting: 0, rate_read_waiting_since: null });
  });

  it("counts none for a hotel that is simulating, or on a system MAYA does not send to", async () => {
    expect(await rowFor("Simulating Inn")).toMatchObject({ mode: "simulation", unsent_count: 0, unsent_since: null });
    expect(await rowFor("Mews Inn")).toMatchObject({ mode: "live", pms_type: "mews", unsent_count: 0, unsent_since: null });
  });

  it("counts a ThinkReservations hotel like a Cloudbeds one", async () => {
    expect(await rowFor("Think Inn")).toMatchObject({ pms_type: "think", unsent_count: 1 });
  });

  it("starts the wait at go-live for a price published while the hotel was simulating", async () => {
    // Published five hours ago, live for ten minutes: it has waited ten minutes.
    expect(await rowFor("Just Live Inn")).toMatchObject({ unsent_count: 0, unsent_since: null });
    await asService(() => db.exec(`update public.hotel_settings set live_since = now() - interval '90 minutes' where hotel_id = '${JUST_LIVE}'`));
    const later = await rowFor("Just Live Inn");
    expect(later).toMatchObject({ unsent_count: 1 });
    expect(ageMinutes(later?.unsent_since)).toBe(90);
  });

  it("counts a hotel with no go-live time on record from when each price was published", async () => {
    await asService(() => db.exec(`update public.hotel_settings set live_since = null where hotel_id = '${LIVE_THINK}'`));
    const think = await rowFor("Think Inn");
    expect(think).toMatchObject({ unsent_count: 1 });
    expect(ageMinutes(think?.unsent_since)).toBe(300);
  });

  it("follows the window the daily pass prices when it is shorter than the default", async () => {
    await asService(() =>
      db.exec(`
        insert into public.hotel_pricing_state (hotel_id, pass_horizon_days) values ('${LIVE}', 6)
          on conflict (hotel_id) do update set pass_horizon_days = 6`),
    );
    // Nights 3 and 4 are inside a six-night window read a day short; 5 and 6 are not.
    expect(await rowFor("Live Inn")).toMatchObject({ unsent_count: 2 });
    await asService(() => db.exec(`update public.hotel_pricing_state set pass_horizon_days = 396 where hotel_id = '${LIVE}'`));
    expect(await rowFor("Live Inn")).toMatchObject({ unsent_count: 4 });
  });

  it("counts the nights held for a rate read that are still open, and when the first was held", async () => {
    const live = await rowFor("Live Inn");
    expect(live).toMatchObject({ rate_read_waiting: 2 });
    expect(ageMinutes(live?.rate_read_waiting_since)).toBe(95);
    // The open problems are still listed as before, this one among them.
    expect(live).toMatchObject({ open_incidents: 2, open_incident_causes: ["awaiting_rate_read", "value_rejected"] });
  });

  it("stops counting a night once it is sent", async () => {
    await asService(() =>
      db.exec(`
        insert into public.rate_updates (hotel_id, pms_type, room_type_id, stay_date, price, status, attempts, pushed_at)
        values ('${LIVE_THINK}', 'think', '${RT(4, 1)}', '${night(3)}', 210, 'sent', 1, now())`),
    );
    expect(await rowFor("Think Inn")).toMatchObject({ unsent_count: 0, unsent_since: null, sent_24h: 1 });
  });

  it("still answers a platform admin and the service role, and nobody else", async () => {
    await expect(db.query(NEW_COLUMNS, [false])).rejects.toThrow(/Not authorized/);
    await db.exec(`select set_config('request.jwt.claim.sub', '${ADMIN}', false)`);
    try {
      expect((await db.query(NEW_COLUMNS, [false])).rows).toHaveLength(6);
    } finally {
      await db.exec(`select set_config('request.jwt.claim.sub', '', false)`);
    }
    const grants = await q(`
      select grantee from information_schema.routine_privileges
       where routine_name = 'platform_pilot_health' and privilege_type = 'EXECUTE'
       order by grantee`);
    const who = grants.map((r) => r.grantee);
    expect(who).toContain("service_role");
    expect(who).toContain("authenticated");
    expect(who).not.toContain("anon");
    expect(who).not.toContain("PUBLIC");
  });

  it("keeps every column the page read before, in the same order, with the new ones after them", async () => {
    const columns = await q(`
      select p.parameter_name as name
        from information_schema.routines r
        join information_schema.parameters p on p.specific_name = r.specific_name
       where r.routine_name = 'platform_pilot_health' and p.parameter_mode = 'OUT'
       order by p.ordinal_position`);
    expect(columns.map((c) => c.name)).toEqual([
      "hotel_id", "name", "timezone", "is_test", "mode", "subscription_status", "pms_type", "pms_status",
      "last_sync_at", "down_since", "sync_failures", "last_ok_run_at", "pass_date", "pass_cursor",
      "pass_started_at", "pass_completed_at", "pass_horizon_days", "dirty_count", "dirty_oldest_marked_at",
      "sent_24h", "open_incidents", "open_incidents_since", "open_incidents_admin_only", "open_incident_causes",
      "active_rules", "rule_changes_24h",
      "unsent_count", "unsent_since", "rate_read_waiting", "rate_read_waiting_since",
    ]);
  });

  it("gives a query in its closing comment that runs as written in the SQL editor, where nobody is signed in", async () => {
    const file = readFileSync(resolve(ROOT, MIGRATION), "utf8");
    const prompt = file
      .slice(file.indexOf("-- At a prompt"))
      .split("\n")
      .filter((line) => line.startsWith("--   "))
      .map((line) => line.slice(5))
      .join("\n");
    expect(prompt).toContain("from platform_pilot_health()");
    const results = (await db.exec(prompt)) as { rows: Record<string, unknown>[] }[];
    expect(results.some((r) => r.rows.some((row) => row.name === "Live Inn" && "unsent_count" in row))).toBe(true);
    expect(await q(`select coalesce(current_setting('request.jwt.claim.role', true), '') as role`)).toEqual([{ role: "" }]);
  });
});
