/**
 * 99_supabase_migration_simulation_history_v1.sql run for real in PGlite,
 * twice, on top of every migration before it: the history it rebuilds for
 * properties that were there before it (never live, live from a recorded
 * go-live, back to simulation, live when tracking began, a send on record
 * with no switch), the rows the trigger writes on every switch from then on,
 * hotel_simulated_at, and who may read the history.
 * Only runs with MAYA_PGLITE_DIR set (see engine/pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../..");
const MIGRATION = "99_supabase_migration_simulation_history_v1.sql";
const CADENCE_FILE = "99_supabase_migration_pricing_cadence_v1.sql";

const CADENCE_TEST = readFileSync(resolve(__dirname, "engine/pricing-cadence-sql.test.ts"), "utf8");

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

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

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
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
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

// One property per story the backfill has to tell.
const NEVER = "11111111-1111-4111-8111-111111111101"; // simulating, nothing on record
const WENT_LIVE = "11111111-1111-4111-8111-111111111102"; // a recorded go-live, live now
const BACK = "11111111-1111-4111-8111-111111111103"; // live, then back to simulation
const TRACKED_LIVE = "11111111-1111-4111-8111-111111111104"; // live when product events began
const SENT_NO_SWITCH = "11111111-1111-4111-8111-111111111105"; // simulating, but a send is on record
const ADMIN_SWITCHED = "11111111-1111-4111-8111-111111111106"; // switched in the Command Center only
const NO_SETTINGS = "11111111-1111-4111-8111-111111111107"; // no settings row at all
const ROOM = "55555555-5555-4555-8555-555555555501";
const GM = "33333333-3333-4333-8333-333333333301";
const OTHER = "33333333-3333-4333-8333-333333333302";

const DAY = 86_400_000;
/** An instant n days before now, in UTC. */
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

describe("the migration file", () => {
  const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8");
  const code = sql.replace(/--.*$/gm, "");

  it("is the newest file on the list the SQL tests build production's schema from", () => {
    expect(MIGRATION_ORDER).toContain(MIGRATION);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBeGreaterThan(MIGRATION_ORDER.indexOf("99_supabase_migration_staff_roles_v1.sql"));
  });

  it("is one transaction, keeps row level security on and never grants anon anything", () => {
    expect(code.match(/\bbegin;/g)).toHaveLength(1);
    expect(code.match(/\bcommit;/g)).toHaveLength(1);
    expect(code).not.toMatch(/disable row level security/i);
    expect(code).not.toMatch(/grant[^;]*\banon\b/i);
    expect(code).toMatch(/enable row level security/);
    expect(code).toMatch(/revoke all on function public\.hotel_simulated_at\(uuid, timestamptz\) from public, anon;/);
    expect(code).toMatch(/revoke all on function public\.hotel_mode_history_record\(\) from public, anon, authenticated;/);
  });

  it("adds no security definer function except the trigger's", () => {
    const definers = [...code.matchAll(/create or replace function (public\.[a-z_]+)\([^)]*\)\s*returns (\w+)[\s\S]*?\$\$;/g)].filter((m) =>
      /security definer/.test(m[0]),
    );
    expect(definers.map((m) => [m[1], m[2]])).toEqual([["public.hotel_mode_history_record", "trigger"]]);
  });
});

describe.skipIf(!PGLITE_DIR)("the simulation history migration in PGlite", () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const at = async (hotel: string, iso: string) =>
    (await q(`select public.hotel_simulated_at($1, $2::timestamptz) as s`, [hotel, iso]))[0].s as boolean | null;
  const rows = async (hotel: string) =>
    (await q(`select simulated, source, basis from public.hotel_mode_history where hotel_id = $1 order by since, recorded_at`, [hotel])) as {
      simulated: boolean | null;
      source: string;
      basis: string | null;
    }[];

  /** Runs `fn` as this signed-in person, then puts the session back. */
  const as = async <T>(userId: string | null, fn: () => Promise<T>): Promise<T> => {
    const role = userId ? "authenticated" : "anon";
    await db.exec(`
      select set_config('request.jwt.claim.sub', '${userId ?? ""}', false);
      select set_config('request.jwt.claim.role', '${role}', false);
      set role ${role};`);
    try {
      return await fn();
    } finally {
      await db.exec(`
        reset role;
        select set_config('request.jwt.claim.sub', '', false);
        select set_config('request.jwt.claim.role', '', false);`);
    }
  };

  const wentLiveAt = ago(10);
  const backAt = ago(4);
  const trackingBegan = ago(14);
  const adminLiveAt = ago(8);
  const adminBackAt = ago(6);

  beforeAll(async () => {
    const dist = `${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist`;
    const mod = await import(/* @vite-ignore */ pathToFileURL(`${dist}/index.js`).href);
    const { pgcrypto } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/pgcrypto.js`).href);
    const { citext } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/citext.js`).href);
    db = new mod.PGlite({ extensions: { pgcrypto, citext } }) as Db;
    await db.exec(PLATFORM);
    for (const name of ["01_supabase_base_schema.sql", "02_supabase_schema.sql", ...BEFORE]) {
      try {
        await db.exec(fileSql(name));
      } catch (e) {
        throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated;`);

    // The properties as they stood before the file, with their records.
    await db.exec(`
      select set_config('request.jwt.claim.role', 'service_role', false);
      insert into auth.users (id, email) values ('${GM}', 'gm@example.com'), ('${OTHER}', 'other@example.com');
      insert into public.hotels (id, name, timezone) values
        ('${NEVER}', 'Juniper', 'UTC'), ('${WENT_LIVE}', 'Harbour Inn', 'UTC'), ('${BACK}', 'Cliff House', 'UTC'),
        ('${TRACKED_LIVE}', 'Dune Lodge', 'UTC'), ('${SENT_NO_SWITCH}', 'Pier Hotel', 'UTC'),
        ('${ADMIN_SWITCHED}', 'Fernhill', 'UTC'), ('${NO_SETTINGS}', 'Bare Hotel', 'UTC');
      insert into public.hotel_memberships (hotel_id, user_id, role) values
        ('${NEVER}', '${GM}', 'general_manager'), ('${WENT_LIVE}', '${OTHER}', 'general_manager');
      insert into public.hotel_settings (hotel_id, simulation_mode) values
        ('${NEVER}', true), ('${WENT_LIVE}', false), ('${BACK}', true),
        ('${TRACKED_LIVE}', false), ('${SENT_NO_SWITCH}', true), ('${ADMIN_SWITCHED}', true)
        on conflict (hotel_id) do update set simulation_mode = excluded.simulation_mode;
      -- live_since as the go-live set it (an insert stamps now(); the record says when).
      update public.hotel_settings set live_since = '${wentLiveAt}' where hotel_id = '${WENT_LIVE}';
      update public.hotel_settings set live_since = '${wentLiveAt}' where hotel_id = '${BACK}';
      update public.hotel_settings set live_since = null where hotel_id = '${TRACKED_LIVE}';
      insert into public.product_events (occurred_at, recorded_at, event, hotel_id, source) values
        ('${wentLiveAt}', '${wentLiveAt}', 'property.went_live', '${WENT_LIVE}', 'trigger'),
        ('${wentLiveAt}', '${wentLiveAt}', 'property.went_live', '${BACK}', 'trigger'),
        ('${backAt}', '${backAt}', 'property.back_to_simulation', '${BACK}', 'trigger'),
        ('${ago(40)}', '${trackingBegan}', 'property.went_live', '${TRACKED_LIVE}', 'backfill');
      insert into public.platform_audit_events (event_type, entity_type, entity_id, hotel_id, detail, created_at) values
        ('hotel.simulation_mode_changed', 'hotel', '${ADMIN_SWITCHED}', '${ADMIN_SWITCHED}', '{"simulation_mode": false}', '${adminLiveAt}'),
        ('hotel.simulation_mode_changed', 'hotel', '${ADMIN_SWITCHED}', '${ADMIN_SWITCHED}', '{"simulation_mode": true}', '${adminBackAt}');
      insert into public.room_types (id, hotel_id, external_room_type_id, name, total_rooms) values
        ('${ROOM}', '${SENT_NO_SWITCH}', 'Q', 'Queen', 10);
      insert into public.rate_updates (hotel_id, pms_type, room_type_id, stay_date, price, status, created_at, pushed_at) values
        ('${SENT_NO_SWITCH}', 'cloudbeds', '${ROOM}', current_date, 150, 'sent', '${ago(30)}', '${ago(30)}');
      select set_config('request.jwt.claim.role', '', false);
    `);

    // The file under test, twice: it is safe to run again.
    await db.exec(fileSql(MIGRATION));
    await db.exec(fileSql(MIGRATION));
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  it("calls a property that never went live simulated all the way back", async () => {
    expect(await rows(NEVER)).toEqual([
      { simulated: true, source: "backfill", basis: "never_live" },
      { simulated: true, source: "backfill", basis: "state_at_backfill" },
    ]);
    expect(await at(NEVER, ago(85))).toBe(true);
    expect(await at(NEVER, ago(0.01))).toBe(true);
  });

  it("calls the time before a recorded go-live simulated and the time after it live", async () => {
    expect(await at(WENT_LIVE, ago(11))).toBe(true);
    expect(await at(WENT_LIVE, ago(9))).toBe(false);
    expect(await at(WENT_LIVE, ago(0.01))).toBe(false);
    const bases = (await rows(WENT_LIVE)).map((r) => r.basis);
    expect(bases[0]).toBe("before_first_go_live");
    expect(bases.slice(1, 3).sort()).toEqual(["live_since", "product_event"]);
    expect(bases[3]).toBe("state_at_backfill");
  });

  it("follows a property back into simulation", async () => {
    expect(await at(BACK, ago(11))).toBe(true);
    expect(await at(BACK, ago(5))).toBe(false);
    expect(await at(BACK, ago(3))).toBe(true);
  });

  it("knows a property live when tracking began only from then on", async () => {
    expect(await at(TRACKED_LIVE, ago(20))).toBeNull();
    expect(await at(TRACKED_LIVE, ago(13))).toBe(false);
    expect((await rows(TRACKED_LIVE))[0]).toEqual({ simulated: null, source: "backfill", basis: "not_known_before" });
  });

  it("will not call a property that has sent prices simulated before its records begin", async () => {
    expect(await at(SENT_NO_SWITCH, ago(30))).toBeNull();
    expect(await at(SENT_NO_SWITCH, ago(0.01))).toBeNull();
    // From the backfill on, it is certain.
    expect(await at(SENT_NO_SWITCH, new Date(Date.now() + 60_000).toISOString())).toBe(true);
  });

  it("reads the Command Center's switches off the audit log", async () => {
    expect(await at(ADMIN_SWITCHED, ago(9))).toBe(true);
    expect(await at(ADMIN_SWITCHED, ago(7))).toBe(false);
    expect(await at(ADMIN_SWITCHED, ago(5))).toBe(true);
  });

  it("calls a property with no settings row simulating, as the push does", async () => {
    expect((await rows(NO_SETTINGS)).map((r) => r.basis)).toEqual(["never_live", "state_at_backfill"]);
    expect(await at(NO_SETTINGS, ago(2))).toBe(true);
  });

  it("adds nothing on the second run", async () => {
    const counts = await q(`select hotel_id, count(*)::int as n from public.hotel_mode_history group by hotel_id order by hotel_id`);
    expect(counts).toHaveLength(7);
    await db.exec(fileSql(MIGRATION));
    expect(await q(`select hotel_id, count(*)::int as n from public.hotel_mode_history group by hotel_id order by hotel_id`)).toEqual(counts);
  });

  it("writes a row on every switch from now on, with who made it, and none when the mode stays", async () => {
    const before = (await rows(NEVER)).length;
    // A General Manager's go-live, under their own session.
    await as(GM, async () => {
      await q(`update public.hotel_settings set simulation_mode = false where hotel_id = $1`, [NEVER]);
    });
    const after = await q(
      `select simulated, source, basis, changed_by::text as by from public.hotel_mode_history where hotel_id = $1 order by since desc, recorded_at desc limit 1`,
      [NEVER],
    );
    expect(after).toEqual([{ simulated: false, source: "switch", basis: null, by: GM }]);
    expect(await at(NEVER, new Date(Date.now() + 60_000).toISOString())).toBe(false);
    // Still simulated before the switch: the label follows the time.
    expect(await at(NEVER, ago(1))).toBe(true);

    // A write that leaves the mode as it is records nothing.
    await q(`update public.hotel_settings set simulation_mode = false where hotel_id = $1`, [NEVER]);
    expect((await rows(NEVER)).length).toBe(before + 1);

    // A new property's settings row is its first switch.
    const NEW = "11111111-1111-4111-8111-111111111199";
    await q(`insert into public.hotels (id, name) values ($1, 'New Inn')`, [NEW]);
    await q(`insert into public.hotel_settings (hotel_id, simulation_mode) values ($1, true)`, [NEW]);
    expect(await rows(NEW)).toEqual([{ simulated: true, source: "switch", basis: null }]);
  });

  it("lets a property's own people read its history, and nobody else write it", async () => {
    await as(GM, async () => {
      const seen = await q(`select distinct hotel_id::text as h from public.hotel_mode_history`);
      expect(seen).toEqual([{ h: NEVER }]);
      expect(await at(WENT_LIVE, ago(5))).toBeNull();
      await expect(
        q(`insert into public.hotel_mode_history (hotel_id, since, simulated, source) values ($1, now(), false, 'switch')`, [NEVER]),
      ).rejects.toThrow(/permission denied|row-level security/);
      await expect(q(`delete from public.hotel_mode_history where hotel_id = $1`, [NEVER])).rejects.toThrow(/permission denied/);
    });
    await as(null, async () => {
      await expect(q(`select public.hotel_simulated_at($1, now())`, [NEVER])).rejects.toThrow(/permission denied/);
      await expect(q(`select * from public.hotel_mode_history`)).rejects.toThrow(/permission denied/);
    });
    const rls = await q(
      `select relrowsecurity as on from pg_class where relname = 'hotel_mode_history' and relnamespace = 'public'::regnamespace`,
    );
    expect(rls).toEqual([{ on: true }]);
  });

  it("takes only the shapes it knows", async () => {
    await expect(
      q(`insert into public.hotel_mode_history (hotel_id, since, simulated, source, basis) values ($1, now(), true, 'backfill', 'a guess')`, [NEVER]),
    ).rejects.toThrow(/source_check/);
    await expect(
      q(`insert into public.hotel_mode_history (hotel_id, since, simulated, source) values ($1, now(), null, 'switch')`, [NEVER]),
    ).rejects.toThrow(/source_check/);
  });
});
