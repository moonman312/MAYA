/**
 * 99_supabase_migration_display_settings_v1.sql run for real in PGlite,
 * twice, on top of every migration before it: a property that never opens
 * Settings keeps the calendar it had (occupancy, rooms booked, room revenue,
 * standard colours), every choice outside the list is refused, a Revenue
 * Manager saves and a Viewer cannot, a platform admin saves only in God Mode
 * and that save is on the change log, a room type that goes away leaves the
 * price line with nothing to show, and each person's text size is theirs
 * alone. Only runs with MAYA_PGLITE_DIR set (see pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_display_settings_v1.sql";
const CADENCE_FILE = "99_supabase_migration_pricing_cadence_v1.sql";

const CADENCE_TEST = readFileSync(resolve(__dirname, "../engine/pricing-cadence-sql.test.ts"), "utf8");

/** The order production ran the migrations in, read off the cadence test's list. */
const MIGRATION_ORDER: string[] = (() => {
  const list = CADENCE_TEST.slice(CADENCE_TEST.indexOf("MIGRATION_ORDER = ["), CADENCE_TEST.indexOf("];", CADENCE_TEST.indexOf("MIGRATION_ORDER = [")));
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

/**
 * What Supabase provides and the files assume. auth.jwt() reads the whole
 * claims object, so a platform admin can act with an aal2 token in God Mode.
 */
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

const H = "11111111-1111-4111-8111-111111111111";
const H2 = "11111111-1111-4111-8111-111111111112";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RM = "33333333-3333-4333-8333-333333333333";
const VIEWER = "44444444-4444-4444-8444-444444444444";
const KING = "55555555-5555-4555-8555-555555555551";
const SUITE = "55555555-5555-4555-8555-555555555552";

describe("the migration file", () => {
  it("is last on the list the SQL tests build production's schema from", () => {
    expect(MIGRATION_ORDER[MIGRATION_ORDER.length - 1]).toBe(MIGRATION);
  });

  it("is one transaction, and makes no table, function, policy or grant", () => {
    const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8").replace(/--.*$/gm, "");
    expect(sql.match(/\bbegin;/g)).toHaveLength(1);
    expect(sql.match(/\bcommit;/g)).toHaveLength(1);
    expect(sql).not.toMatch(/create table|create (or replace )?function|security definer|create policy|drop policy|\bgrant\b|\brevoke\b|disable row level security/i);
  });
});

describe.skipIf(!PGLITE_DIR)("the display settings migration in PGlite", () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

  /** Runs `fn` as this signed-in person, then puts the session back. */
  const as = async <T>(userId: string, aal: "aal1" | "aal2", fn: () => Promise<T>): Promise<T> => {
    const now = Math.floor(Date.now() / 1000);
    const amr = aal === "aal2" ? [{ method: "totp", timestamp: now }, { method: "password", timestamp: now - 60 }] : [{ method: "password", timestamp: now }];
    const claims = JSON.stringify({ sub: userId, role: "authenticated", aal, amr, session_id: "sess-laptop" });
    await db.exec(`
      select set_config('request.jwt.claim.sub', '${userId}', false);
      select set_config('request.jwt.claim.role', 'authenticated', false);
      select set_config('request.jwt.claims', '${claims}', false);
      set role authenticated;`);
    try {
      return await fn();
    } finally {
      await db.exec(`
        reset role;
        select set_config('request.jwt.claim.sub', '', false);
        select set_config('request.jwt.claim.role', '', false);
        select set_config('request.jwt.claims', '', false);`);
    }
  };

  const settings = async (hotel = H) =>
    (
      await q(
        `select calendar_big_metric as big, calendar_small_metric_1 as s1, calendar_small_metric_2 as s2,
                calendar_price_room_type_id::text as rt, calendar_colors as colors
           from public.hotel_settings where hotel_id = $1`,
        [hotel],
      )
    )[0];
  /** How many rows an update reaches: 0 when row level security refuses it. */
  const saveColors = async (colors: string, hotel = H) =>
    (await q(`with u as (update public.hotel_settings set calendar_colors = $1 where hotel_id = $2 returning 1) select count(*)::int as n from u`, [colors, hotel]))[0].n;
  const textSize = async (id: string) => (await q(`select text_size from public.profiles where id = $1`, [id]))[0]?.text_size;

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
    // Supabase's default privileges: signed-in people reach the tables and RLS decides the rows.
    await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated;`);
    // A property that was running before the file: its settings row is already there.
    await db.exec(`
      select set_config('request.jwt.claim.role', 'service_role', false);
      insert into auth.users (id, email) values
        ('${ADMIN}', 'jake@example.com'), ('${RM}', 'priya@example.com'), ('${VIEWER}', 'sam@example.com');
      insert into public.profiles (id, full_name) values ('${RM}', 'Priya'), ('${VIEWER}', 'Sam')
        on conflict (id) do nothing;
      insert into public.app_roles (user_id, role) values ('${ADMIN}', 'platform_admin');
      insert into public.hotels (id, name) values ('${H}', 'Harbour Inn'), ('${H2}', 'Cliff House');
      insert into public.hotel_memberships (hotel_id, user_id, role) values
        ('${H}', '${RM}', 'revenue_manager'), ('${H}', '${VIEWER}', 'viewer');
      insert into public.hotel_settings (hotel_id, simulation_mode) values ('${H}', true), ('${H2}', true)
        on conflict (hotel_id) do update set simulation_mode = true;
      insert into public.room_types (id, hotel_id, external_room_type_id, name, total_rooms) values
        ('${KING}', '${H}', 'K', 'King', 10), ('${SUITE}', '${H}', 'S', 'Suite', 2);
      select set_config('request.jwt.claim.role', '', false);
    `);
    // The file under test, twice: it is safe to run again.
    await db.exec(fileSql(MIGRATION));
    await db.exec(fileSql(MIGRATION));
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  it("gives a property that was already running the calendar it had", async () => {
    expect(await settings()).toEqual({ big: "occupancy", s1: "rooms_booked", s2: "room_revenue", rt: null, colors: "standard" });
    expect(await textSize(RM)).toBe("standard");
  });

  it("gives a property set up after it the same", async () => {
    const H3 = "11111111-1111-4111-8111-111111111113";
    await q(`insert into public.hotels (id, name) values ($1, 'Dune Lodge')`, [H3]);
    await q(`insert into public.hotel_settings (hotel_id, simulation_mode) values ($1, true)`, [H3]);
    expect(await settings(H3)).toEqual({ big: "occupancy", s1: "rooms_booked", s2: "room_revenue", rt: null, colors: "standard" });
  });

  it("keeps row level security on both tables, with the policies they had", async () => {
    const rows = await q(
      `select c.relname as t, c.relrowsecurity as rls,
              (select string_agg(p.policyname || ':' || p.cmd, ',' order by p.policyname) from pg_policies p where p.tablename = c.relname) as policies
         from pg_class c where c.relname in ('hotel_settings', 'profiles') and c.relnamespace = 'public'::regnamespace order by 1`,
    );
    expect(rows).toEqual([
      { t: "hotel_settings", rls: true, policies: "hotel_settings_insert:INSERT,hotel_settings_read:SELECT,hotel_settings_update:UPDATE" },
      { t: "profiles", rls: true, policies: "profiles_insert:INSERT,profiles_select:SELECT,profiles_update:UPDATE" },
    ]);
  });

  it("takes every metric and both colour modes, and refuses anything else", async () => {
    for (const m of ["rooms_booked", "room_revenue", "adr", "revpar", "price", "occupancy"]) {
      await q(
        `update public.hotel_settings set calendar_big_metric = $1, calendar_small_metric_1 = null, calendar_small_metric_2 = null where hotel_id = $2`,
        [m, H],
      );
    }
    await expect(q(`update public.hotel_settings set calendar_big_metric = 'profit' where hotel_id = $1`, [H])).rejects.toThrow(/big_metric_check/);
    await expect(q(`update public.hotel_settings set calendar_big_metric = null where hotel_id = $1`, [H])).rejects.toThrow(/null/);
    await expect(q(`update public.hotel_settings set calendar_small_metric_1 = 'Occupancy' where hotel_id = $1`, [H])).rejects.toThrow(/small_metric_1_check/);
    await expect(
      q(`update public.hotel_settings set calendar_small_metric_1 = 'adr', calendar_small_metric_2 = 'goppar' where hotel_id = $1`, [H]),
    ).rejects.toThrow(/small_metric_2_check/);
    await expect(q(`update public.hotel_settings set calendar_colors = 'inverted' where hotel_id = $1`, [H])).rejects.toThrow(/colors_check/);
    await expect(q(`update public.hotel_settings set calendar_colors = null where hotel_id = $1`, [H])).rejects.toThrow(/null/);
    expect(await saveColors("reversed")).toBe(1);
    expect(await saveColors("standard")).toBe(1);
  });

  it("shows each number once, and a second small line only under a first", async () => {
    await q(`update public.hotel_settings set calendar_big_metric = 'occupancy', calendar_small_metric_1 = null, calendar_small_metric_2 = null where hotel_id = $1`, [H]);
    await expect(q(`update public.hotel_settings set calendar_small_metric_1 = 'occupancy' where hotel_id = $1`, [H])).rejects.toThrow(/metrics_check/);
    await expect(q(`update public.hotel_settings set calendar_small_metric_2 = 'adr' where hotel_id = $1`, [H])).rejects.toThrow(/metrics_check/);
    await expect(
      q(`update public.hotel_settings set calendar_small_metric_1 = 'adr', calendar_small_metric_2 = 'adr' where hotel_id = $1`, [H]),
    ).rejects.toThrow(/metrics_check/);
    await q(`update public.hotel_settings set calendar_small_metric_1 = 'adr', calendar_small_metric_2 = 'revpar' where hotel_id = $1`, [H]);
    await q(`update public.hotel_settings set calendar_small_metric_1 = 'rooms_booked', calendar_small_metric_2 = 'room_revenue' where hotel_id = $1`, [H]);
    expect(await settings()).toMatchObject({ big: "occupancy", s1: "rooms_booked", s2: "room_revenue" });
  });

  it("points the price line at a room type that exists, and at nothing once that room type goes", async () => {
    await expect(
      q(`update public.hotel_settings set calendar_price_room_type_id = '99999999-9999-4999-8999-999999999999' where hotel_id = $1`, [H]),
    ).rejects.toThrow(/foreign key/);
    await q(`update public.hotel_settings set calendar_big_metric = 'price', calendar_price_room_type_id = $1 where hotel_id = $2`, [SUITE, H]);
    expect((await settings()).rt).toBe(SUITE);
    await q(`delete from public.room_types where id = $1`, [SUITE]);
    expect(await settings()).toMatchObject({ big: "price", rt: null });
    await q(`update public.hotel_settings set calendar_big_metric = 'occupancy' where hotel_id = $1`, [H]);
  });

  it("lets a Revenue Manager save the property's calendar, and not a Viewer or another property's", async () => {
    await as(RM, "aal1", async () => {
      expect(await saveColors("reversed")).toBe(1);
      expect(await saveColors("reversed", H2)).toBe(0);
    });
    expect((await settings()).colors).toBe("reversed");
    await as(VIEWER, "aal1", async () => {
      // A Viewer reads the choice, and cannot change it.
      expect((await settings()).colors).toBe("reversed");
      expect(await saveColors("standard")).toBe(0);
    });
    expect((await settings()).colors).toBe("reversed");
  });

  it("lets a platform admin save only in God Mode, and puts that save on the change log", async () => {
    await as(ADMIN, "aal2", async () => {
      expect(await saveColors("standard")).toBe(0);
    });
    expect((await settings()).colors).toBe("reversed");
    await as(ADMIN, "aal2", async () => {
      await q(`select public.god_mode_start()`);
      expect(await saveColors("standard")).toBe(1);
      await q(`select public.god_mode_end()`);
    });
    expect((await settings()).colors).toBe("standard");
    const recorded = await q(`select user_id, hotel_id, table_name, op, summary from public.support_changes order by id desc limit 1`);
    expect(recorded[0]).toMatchObject({ user_id: ADMIN, hotel_id: H, table_name: "hotel_settings", op: "update" });
    expect(String(recorded[0].summary)).toContain("calendar_colors from reversed to standard");
  });

  it("keeps each person's text size their own", async () => {
    await expect(q(`update public.profiles set text_size = 'huge' where id = $1`, [RM])).rejects.toThrow(/text_size_check/);
    await expect(q(`update public.profiles set text_size = null where id = $1`, [RM])).rejects.toThrow(/null/);
    await as(RM, "aal1", async () => {
      const own = await q(`with u as (update public.profiles set text_size = 'larger' where id = $1 returning 1) select count(*)::int as n from u`, [RM]);
      expect(own[0].n).toBe(1);
      const other = await q(`with u as (update public.profiles set text_size = 'large' where id = $1 returning 1) select count(*)::int as n from u`, [VIEWER]);
      expect(other[0].n).toBe(0);
    });
    expect(await textSize(RM)).toBe("larger");
    expect(await textSize(VIEWER)).toBe("standard");
  });

  it("runs again on a database that already has it without changing a saved choice", async () => {
    await q(`update public.hotel_settings set calendar_big_metric = 'adr', calendar_small_metric_1 = 'occupancy', calendar_small_metric_2 = null, calendar_colors = 'reversed' where hotel_id = $1`, [H]);
    await db.exec(fileSql(MIGRATION));
    expect(await settings()).toMatchObject({ big: "adr", s1: "occupancy", s2: null, colors: "reversed" });
    expect(await textSize(RM)).toBe("larger");
  });
});
