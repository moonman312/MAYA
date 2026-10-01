/**
 * 99_supabase_migration_pms_property_changes_v1.sql run for real in PGlite,
 * twice, on top of every migration before it: switching off a room type the
 * property system no longer lists (never on a read that may not be whole, and
 * never every type at once), switching it back on when it is listed again,
 * the time zone and currency refresh (never a missing value, never a live
 * property's currency), the change log lines each writes, the Cloudbeds
 * display name fix, and who may call or read any of it.
 * Only runs with MAYA_PGLITE_DIR set (see engine/pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_pms_property_changes_v1.sql";
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

const HOTEL = "11111111-1111-4111-8111-111111111201";
const ELSEWHERE = "11111111-1111-4111-8111-111111111202";
const LIVE = "11111111-1111-4111-8111-111111111203";
const KING = "55555555-5555-4555-8555-555555555201";
const QUEEN = "55555555-5555-4555-8555-555555555202";
const SUITE = "55555555-5555-4555-8555-555555555203";
const HIDDEN = "55555555-5555-4555-8555-555555555204";
const OTHER_KING = "55555555-5555-4555-8555-555555555205";
const GM = "33333333-3333-4333-8333-333333333201";
const STRANGER = "33333333-3333-4333-8333-333333333202";

describe("the migration file", () => {
  const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8");
  const code = sql.replace(/--.*$/gm, "");

  it("is on the list the SQL tests build production's schema from, right after the rule fire log file", () => {
    expect(MIGRATION_ORDER).toContain(MIGRATION);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBe(MIGRATION_ORDER.indexOf("99_supabase_migration_rule_fire_log_v1.sql") + 1);
  });

  it("is one transaction, keeps row level security on and never grants anon anything", () => {
    expect(code.match(/\bbegin;/g)).toHaveLength(1);
    expect(code.match(/\bcommit;/g)).toHaveLength(1);
    expect(code).not.toMatch(/disable row level security/i);
    expect(code).not.toMatch(/grant[^;]*\banon\b/i);
  });

  it("revokes execute from public, anon and authenticated on every function it defines, and none runs as its owner", () => {
    const defined = [...code.matchAll(/create or replace function (public\.[a-z_]+)\(/g)].map((m) => m[1]);
    expect(defined.sort()).toEqual(["public.pms_property_details_refresh", "public.pms_room_types_reconcile"]);
    for (const fn of defined) {
      expect(code).toMatch(new RegExp(`revoke all on function ${fn.replace(".", "\\.")}\\([^)]*\\) from public, anon, authenticated;`));
    }
    expect(code).not.toMatch(/security definer/);
  });
});

describe.skipIf(!PGLITE_DIR)("the property changes migration in PGlite", () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

  /** Runs `fn` as this signed-in person (null: anon), then puts the session back. */
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
        select set_config('request.jwt.claim.role', 'service_role', false);`);
    }
  };

  const reconcile = async (hotel: string, listed: string[], remove: boolean) =>
    (await q(
      `select change, room_type_id::text as room_type_id, room_type_name
         from public.pms_room_types_reconcile($1, 'cloudbeds', $2::text[], $3) order by change, room_type_name`,
      [hotel, listed, remove],
    )) as { change: string; room_type_id: string; room_type_name: string }[];

  const refresh = async (hotel: string, tz: string | null, currency: string | null) =>
    (await q(`select change, before_value, after_value from public.pms_property_details_refresh($1, 'cloudbeds', $2, $3) order by change`, [
      hotel,
      tz,
      currency,
    ])) as { change: string; before_value: string | null; after_value: string | null }[];

  const types = async (hotel = HOTEL) =>
    (await q(
      `select external_room_type_id as ext, is_active, pms_removed_at is not null as removed
         from public.room_types where hotel_id = $1 order by external_room_type_id`,
      [hotel],
    )) as { ext: string; is_active: boolean; removed: boolean }[];

  const notes = async (hotel = HOTEL) =>
    (await q(
      `select kind, room_type_name, before_value, after_value from public.pms_property_changes where hotel_id = $1 order by found_at, kind, room_type_name`,
      [hotel],
    )) as { kind: string; room_type_name: string | null; before_value: string | null; after_value: string | null }[];

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

    // What production holds before the file runs: two Cloudbeds properties
    // whose room types carry Cloudbeds' short code as display_name, two of
    // them the same code, and a Think property, whose names are left alone.
    await db.exec(`
      select set_config('request.jwt.claim.role', 'service_role', false);
      insert into auth.users (id, email) values ('${GM}', 'gm@example.com'), ('${STRANGER}', 'stranger@example.com');
      insert into public.hotels (id, name, timezone, currency) values
        ('${HOTEL}', 'Juniper Lodge', 'UTC', 'USD'),
        ('${ELSEWHERE}', 'Harbour Inn', 'UTC', 'USD'),
        ('${LIVE}', 'Cedar Court', 'America/Denver', 'USD');
      insert into public.hotel_memberships (hotel_id, user_id, role) values
        ('${HOTEL}', '${GM}', 'general_manager'), ('${ELSEWHERE}', '${STRANGER}', 'general_manager');
      insert into public.hotel_settings (hotel_id, simulation_mode) values ('${HOTEL}', true), ('${LIVE}', false);
      insert into public.pms_connections (hotel_id, pms_type, status) values
        ('${HOTEL}', 'cloudbeds', 'connected'), ('${ELSEWHERE}', 'think', 'connected'), ('${LIVE}', 'cloudbeds', 'connected');
      insert into public.room_types (id, hotel_id, external_room_type_id, name, display_name, total_rooms, is_active) values
        ('${KING}', '${HOTEL}', 'RT-K', 'Harbour Double', 'DBL', 10, true),
        ('${QUEEN}', '${HOTEL}', 'RT-Q', 'Harbour Double Deluxe', 'DBL', 6, true),
        ('${SUITE}', '${HOTEL}', 'RT-S', 'Juniper Suite', 'Juniper Suite', 2, true),
        ('${HIDDEN}', '${HOTEL}', 'RT-H', 'Old Twin Room', 'TWN', 4, false),
        ('${OTHER_KING}', '${ELSEWHERE}', 'T-1', 'Harbour King', 'HK', 8, true);
    `);

    // The file under test, twice: it is safe to run again.
    await db.exec(fileSql(MIGRATION));
    await db.exec(fileSql(MIGRATION));
    await db.exec(`grant select on all tables in schema public to authenticated;`);
  });

  afterAll(async () => {
    await db?.close();
  });

  describe("the Cloudbeds display name fix", () => {
    it("puts the full name in display_name on Cloudbeds properties, and leaves other systems' rows alone", async () => {
      const rows = await q(`select id::text as id, name, display_name from public.room_types order by id`);
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.display_name]));
      expect(byId[KING]).toBe("Harbour Double");
      expect(byId[QUEEN]).toBe("Harbour Double Deluxe");
      expect(byId[HIDDEN]).toBe("Old Twin Room");
      expect(byId[OTHER_KING]).toBe("HK");
    });
  });

  describe("room types the property system stops listing", () => {
    beforeEach(async () => {
      await db.exec(`
        delete from public.pms_property_changes;
        update public.room_types set is_active = (id <> '${HIDDEN}'), pms_removed_at = null where hotel_id = '${HOTEL}';`);
    });

    it("switches off every active type a complete full read left out, with one change log line each", async () => {
      expect(await reconcile(HOTEL, ["RT-K", "RT-NEW-1", "RT-NEW-2"], true)).toEqual([
        { change: "removed", room_type_id: QUEEN, room_type_name: "Harbour Double Deluxe" },
        { change: "removed", room_type_id: SUITE, room_type_name: "Juniper Suite" },
      ]);
      expect(await types()).toEqual([
        // The type someone switched off stays off, untouched and with no line.
        { ext: "RT-H", is_active: false, removed: false },
        { ext: "RT-K", is_active: true, removed: false },
        { ext: "RT-Q", is_active: false, removed: true },
        { ext: "RT-S", is_active: false, removed: true },
      ]);
      expect(await notes()).toEqual([
        { kind: "room_type_removed", room_type_name: "Harbour Double Deluxe", before_value: null, after_value: null },
        { kind: "room_type_removed", room_type_name: "Juniper Suite", before_value: null, after_value: null },
      ]);
      // Nothing is deleted.
      expect((await q(`select count(*)::int as n from public.room_types where hotel_id = $1`, [HOTEL]))[0].n).toBe(4);
    });

    it("switches nothing off on a read that may not be whole", async () => {
      expect(await reconcile(HOTEL, ["RT-K"], false)).toEqual([]);
      expect(await reconcile(HOTEL, [], true)).toEqual([]);
      expect((await types()).filter((t) => t.is_active).map((t) => t.ext)).toEqual(["RT-K", "RT-Q", "RT-S"]);
      expect(await notes()).toEqual([]);
    });

    it("keeps every type when none of the property's types is in the list, and says which", async () => {
      expect(await reconcile(HOTEL, ["X-1", "X-2"], true)).toEqual([
        { change: "kept", room_type_id: KING, room_type_name: "Harbour Double" },
        { change: "kept", room_type_id: QUEEN, room_type_name: "Harbour Double Deluxe" },
        { change: "kept", room_type_id: SUITE, room_type_name: "Juniper Suite" },
      ]);
      expect((await types()).filter((t) => t.is_active).map((t) => t.ext)).toEqual(["RT-K", "RT-Q", "RT-S"]);
      expect(await notes()).toEqual([]);
    });

    it("switches a type back on when any read lists it again, and only one it switched off", async () => {
      await reconcile(HOTEL, ["RT-K"], true);
      // A partial read that lists the suite (and the hand-hidden twin room) again.
      expect(await reconcile(HOTEL, ["RT-S", "RT-H"], false)).toEqual([
        { change: "back", room_type_id: SUITE, room_type_name: "Juniper Suite" },
      ]);
      expect(await types()).toEqual([
        { ext: "RT-H", is_active: false, removed: false },
        { ext: "RT-K", is_active: true, removed: false },
        { ext: "RT-Q", is_active: false, removed: true },
        { ext: "RT-S", is_active: true, removed: false },
      ]);
      // Lines written within one clock tick can share found_at, so they are compared as a set.
      expect((await notes()).map((n) => `${n.kind}: ${n.room_type_name}`).sort()).toEqual([
        "room_type_back: Juniper Suite",
        "room_type_removed: Harbour Double Deluxe",
        "room_type_removed: Juniper Suite",
      ]);
    });

    it("writes nothing twice when the same read is reconciled again", async () => {
      await reconcile(HOTEL, ["RT-K"], true);
      expect(await reconcile(HOTEL, ["RT-K"], true)).toEqual([]);
      expect(await notes()).toHaveLength(2);
    });

    it("never touches another property's types", async () => {
      await reconcile(HOTEL, ["RT-K"], true);
      expect(await types(ELSEWHERE)).toEqual([{ ext: "T-1", is_active: true, removed: false }]);
    });

    it("marks the property for pricing again when a type goes", async () => {
      await db.exec(`delete from public.hotel_pricing_state where hotel_id = '${HOTEL}';`).catch(() => undefined);
      await reconcile(HOTEL, ["RT-K", "RT-S"], true);
      const marked = await q(`select 1 from public.hotel_pricing_state where hotel_id = $1`, [HOTEL]);
      expect(marked.length).toBeGreaterThan(0);
    });
  });

  describe("the daily time zone and currency refresh", () => {
    beforeEach(async () => {
      await db.exec(`
        delete from public.pms_property_changes;
        update public.hotels set timezone = 'UTC', currency = 'USD' where id = '${HOTEL}';
        update public.hotels set timezone = 'America/Denver', currency = 'USD' where id = '${LIVE}';`);
    });

    it("saves a changed time zone with a line saying what it was and became", async () => {
      expect(await refresh(HOTEL, "America/Chicago", "USD")).toEqual([
        { change: "timezone", before_value: "UTC", after_value: "America/Chicago" },
      ]);
      expect((await q(`select timezone from public.hotels where id = $1`, [HOTEL]))[0].timezone).toBe("America/Chicago");
      expect(await notes()).toEqual([{ kind: "timezone", room_type_name: null, before_value: "UTC", after_value: "America/Chicago" }]);
      // The same answer tomorrow changes nothing and says nothing.
      expect(await refresh(HOTEL, "America/Chicago", "usd")).toEqual([]);
      expect(await notes()).toHaveLength(1);
    });

    it("never stores a missing value or a time zone Postgres does not know", async () => {
      expect(await refresh(HOTEL, null, null)).toEqual([]);
      expect(await refresh(HOTEL, "  ", " ")).toEqual([]);
      expect(await refresh(HOTEL, "Mars/Olympus_Mons", null)).toEqual([]);
      expect((await q(`select timezone, currency from public.hotels where id = $1`, [HOTEL]))[0]).toEqual({ timezone: "UTC", currency: "USD" });
      expect(await notes()).toEqual([]);
    });

    it("changes a simulating property's currency, with a line", async () => {
      expect(await refresh(HOTEL, null, "cad")).toEqual([{ change: "currency", before_value: "USD", after_value: "CAD" }]);
      expect((await q(`select currency from public.hotels where id = $1`, [HOTEL]))[0].currency).toBe("CAD");
      expect(await notes()).toEqual([{ kind: "currency", room_type_name: null, before_value: "USD", after_value: "CAD" }]);
    });

    it("never changes a live property's currency: it says so instead, and the time zone still follows", async () => {
      expect(await refresh(LIVE, "America/Chicago", "EUR")).toEqual([
        { change: "currency_kept", before_value: "USD", after_value: "EUR" },
        { change: "timezone", before_value: "America/Denver", after_value: "America/Chicago" },
      ]);
      expect((await q(`select timezone, currency from public.hotels where id = $1`, [LIVE]))[0]).toEqual({
        timezone: "America/Chicago",
        currency: "USD",
      });
      expect((await notes(LIVE)).map((n) => n.kind)).toEqual(["timezone"]);
    });

    it("marks the property for pricing again when its time zone moves", async () => {
      await db.exec(`delete from public.hotel_pricing_state where hotel_id = '${HOTEL}';`).catch(() => undefined);
      await refresh(HOTEL, "America/Chicago", null);
      expect((await q(`select 1 from public.hotel_pricing_state where hotel_id = $1`, [HOTEL])).length).toBeGreaterThan(0);
    });
  });

  describe("who may", () => {
    it("lets only the service role call either function", async () => {
      const privileges = await q(`
        select p.proname as name,
               has_function_privilege('anon', p.oid, 'execute') as anon,
               has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
               has_function_privilege('service_role', p.oid, 'execute') as service_role
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ('pms_room_types_reconcile', 'pms_property_details_refresh')
         order by p.proname`);
      expect(privileges).toEqual([
        { name: "pms_property_details_refresh", anon: false, authenticated: false, service_role: true },
        { name: "pms_room_types_reconcile", anon: false, authenticated: false, service_role: true },
      ]);
    });

    it("lets a member read their own property's lines and nobody else's, and nobody write", async () => {
      await db.exec(`
        delete from public.pms_property_changes;
        update public.room_types set is_active = (id <> '${HIDDEN}'), pms_removed_at = null where hotel_id = '${HOTEL}';`);
      await reconcile(HOTEL, ["RT-K", "RT-S"], true);
      await db.exec(`update public.room_types set is_active = true, pms_removed_at = null where id = '${QUEEN}';`);
      expect(await as(GM, () => q(`select room_type_name from public.pms_property_changes`))).toEqual([{ room_type_name: "Harbour Double Deluxe" }]);
      expect(await as(STRANGER, () => q(`select room_type_name from public.pms_property_changes`))).toEqual([]);
      await expect(as(null, () => q(`select * from public.pms_property_changes`))).rejects.toThrow(/permission denied/);
      await expect(
        as(GM, () => q(`insert into public.pms_property_changes (hotel_id, pms_type, kind, after_value) values ($1, 'cloudbeds', 'timezone', 'UTC')`, [HOTEL])),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
