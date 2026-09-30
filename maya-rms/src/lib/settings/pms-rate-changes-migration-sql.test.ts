/**
 * 99_supabase_migration_pms_rate_changes_v1.sql run for real in PGlite,
 * twice, on top of every migration before it: every property starts on
 * "Keep the change", only the two choices are taken, a rate removed in the
 * property system marks its night for the pricing cadence, the change log's
 * items are readable by the property's own people only, and the Settings
 * save (set_pms_rate_changes) asks before it replaces rates changed in the
 * property system, then clears only those, never a price typed in MAYA.
 * Only runs with MAYA_PGLITE_DIR set (see pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PMS_RATE_REMOVED_REASON } from "../../../supabase/functions/_shared/pms/push-guardrails";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_pms_rate_changes_v1.sql";
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

/** What Supabase provides and the files assume; auth.jwt() reads the whole claims object for God Mode. */
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
const OTHER = "44444444-4444-4444-8444-444444444445";
const KING = "55555555-5555-4555-8555-555555555551";
const SUITE = "55555555-5555-4555-8555-555555555552";
const RULE = "66666666-6666-4666-8666-666666666666";

/** A night n days from today (UTC; the property is on UTC). */
const night = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe("the migration file", () => {
  const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8");
  const code = sql.replace(/--.*$/gm, "");

  it("is on the list the SQL tests build production's schema from, after the display settings", () => {
    expect(MIGRATION_ORDER).toContain(MIGRATION);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBeGreaterThan(MIGRATION_ORDER.indexOf("99_supabase_migration_display_settings_v1.sql"));
  });

  it("is one transaction, keeps row level security on and never grants anon anything", () => {
    expect(code.match(/\bbegin;/g)).toHaveLength(1);
    expect(code.match(/\bcommit;/g)).toHaveLength(1);
    expect(code).not.toMatch(/disable row level security/i);
    expect(code).not.toMatch(/grant[^;]*\banon\b/i);
    expect(code).toMatch(/revoke all on function public\.set_pms_rate_changes\(uuid, text, boolean\) from public, anon;/);
  });

  it("writes the same reason on a ledger row as the refresh does for a rate removed in the PMS", () => {
    expect(code).toContain(`error = '${PMS_RATE_REMOVED_REASON}'`);
  });
});

describe.skipIf(!PGLITE_DIR)("the PMS rate changes migration in PGlite", () => {
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

  const mode = async (hotel = H) => (await q(`select pms_rate_changes as m from public.hotel_settings where hotel_id = $1`, [hotel]))[0]?.m;
  const save = async (m: string, replace = false, hotel = H) =>
    (await q(`select public.set_pms_rate_changes($1, $2, $3) as r`, [hotel, m, replace]))[0].r as Record<string, unknown>;

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
        ('${ADMIN}', 'jake@example.com'), ('${RM}', 'priya@example.com'), ('${VIEWER}', 'sam@example.com'), ('${OTHER}', 'lee@example.com');
      insert into public.profiles (id, full_name) values ('${RM}', 'Priya'), ('${VIEWER}', 'Sam'), ('${OTHER}', 'Lee')
        on conflict (id) do nothing;
      insert into public.app_roles (user_id, role) values ('${ADMIN}', 'platform_admin');
      insert into public.hotels (id, name, timezone) values ('${H}', 'Harbour Inn', 'UTC'), ('${H2}', 'Cliff House', 'UTC');
      insert into public.hotel_memberships (hotel_id, user_id, role) values
        ('${H}', '${RM}', 'revenue_manager'), ('${H}', '${VIEWER}', 'viewer'), ('${H2}', '${OTHER}', 'revenue_manager');
      insert into public.hotel_settings (hotel_id, simulation_mode) values ('${H}', false), ('${H2}', false)
        on conflict (hotel_id) do update set simulation_mode = false;
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

  it("starts every property on Keep the change, before and after the file", async () => {
    expect(await mode()).toBe("keep");
    const H3 = "11111111-1111-4111-8111-111111111113";
    await q(`insert into public.hotels (id, name) values ($1, 'Dune Lodge')`, [H3]);
    await q(`insert into public.hotel_settings (hotel_id, simulation_mode) values ($1, true)`, [H3]);
    expect(await mode(H3)).toBe("keep");
  });

  it("takes the two choices and nothing else", async () => {
    await expect(q(`update public.hotel_settings set pms_rate_changes = 'overwrite' where hotel_id = $1`, [H])).rejects.toThrow(/pms_rate_changes_check/);
    await expect(q(`update public.hotel_settings set pms_rate_changes = null where hotel_id = $1`, [H])).rejects.toThrow(/null/);
    await q(`update public.hotel_settings set pms_rate_changes = 'maya_wins' where hotel_id = $1`, [H]);
    await q(`update public.hotel_settings set pms_rate_changes = 'keep' where hotel_id = $1`, [H]);
    expect(await mode()).toBe("keep");
  });

  it("marks a night for pricing when its rate is removed in the PMS, or comes back", async () => {
    await q(`insert into public.base_rate_calendar (hotel_id, stay_date, room_type_id, price, source) values ($1, $2, $3, 150, 'pms')`, [H, night(9), KING]);
    await q(`delete from public.pricing_dirty_nights where hotel_id = $1`, [H]);
    await q(`update public.base_rate_calendar set pms_removed_at = now() where hotel_id = $1 and stay_date = $2`, [H, night(9)]);
    expect((await q(`select stay_date::text as d, reasons from public.pricing_dirty_nights where hotel_id = $1`, [H])).map((r) => r.d)).toEqual([night(9)]);
    await q(`delete from public.pricing_dirty_nights where hotel_id = $1`, [H]);
    // A write that moves nothing marks nothing, as before.
    await q(`update public.base_rate_calendar set captured_at = now() where hotel_id = $1 and stay_date = $2`, [H, night(9)]);
    expect(await q(`select 1 from public.pricing_dirty_nights where hotel_id = $1`, [H])).toEqual([]);
    await q(`update public.base_rate_calendar set pms_removed_at = null where hotel_id = $1 and stay_date = $2`, [H, night(9)]);
    expect((await q(`select stay_date::text as d from public.pricing_dirty_nights where hotel_id = $1`, [H])).map((r) => r.d)).toEqual([night(9)]);
    await q(`delete from public.base_rate_calendar where hotel_id = $1`, [H]);
  });

  it("keeps each kind of change log item to its own shape", async () => {
    await expect(
      q(`insert into public.pms_change_notices (hotel_id, pms_type, kind, rates) values ($1, 'cloudbeds', 'overwrite', 3)`, [H]),
    ).rejects.toThrow(/shape_check/);
    await expect(
      q(`insert into public.pms_change_notices (hotel_id, pms_type, kind, rates) values ($1, 'cloudbeds', 'other_tool', 0)`, [H]),
    ).rejects.toThrow(/shape_check/);
    await expect(
      q(`insert into public.pms_change_notices (hotel_id, pms_type, kind, rates) values ($1, 'cloudbeds', 'another_tool', 3)`, [H]),
    ).rejects.toThrow(/kind_check/);
    await q(
      `insert into public.pms_change_notices (hotel_id, pms_type, kind, stay_date, room_type_id, pms_rate, maya_price) values
         ($1, 'cloudbeds', 'overwrite', $2, $3, 175, 165),
         ($1, 'cloudbeds', 'overwrite', $2, $4, null, 240)`,
      [H, night(4), KING, SUITE],
    );
    await q(`insert into public.pms_change_notices (hotel_id, pms_type, kind, rates) values ($1, 'think', 'other_tool', 34), ($2, 'cloudbeds', 'other_tool', 21)`, [H, H2]);
  });

  it("lets a property's own people read its change log items, and nobody write them or read the watch", async () => {
    await as(VIEWER, "aal1", async () => {
      expect(await q(`select kind from public.pms_change_notices order by kind`)).toEqual([{ kind: "other_tool" }, { kind: "overwrite" }, { kind: "overwrite" }]);
      await expect(q(`insert into public.pms_change_notices (hotel_id, pms_type, kind, rates) values ($1, 'cloudbeds', 'other_tool', 1)`, [H])).rejects.toThrow(
        /permission denied|row-level security/,
      );
      await expect(q(`select * from public.pms_change_watch`)).rejects.toThrow(/permission denied/);
    });
    await as(RM, "aal1", async () => {
      await expect(q(`update public.pms_change_notices set emailed_at = now()`)).rejects.toThrow(/permission denied/);
    });
    await as(OTHER, "aal1", async () => {
      expect(await q(`select rates from public.pms_change_notices`)).toEqual([{ rates: 21 }]);
    });
    const rows = await q(
      `select c.relname as t, c.relrowsecurity as rls from pg_class c
        where c.relname in ('pms_change_notices', 'pms_change_watch') and c.relnamespace = 'public'::regnamespace order by 1`,
    );
    expect(rows).toEqual([
      { t: "pms_change_notices", rls: true },
      { t: "pms_change_watch", rls: true },
    ]);
  });

  describe("set_pms_rate_changes", () => {
    const typedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();

    beforeAll(async () => {
      await db.exec(`
        select set_config('request.jwt.claim.role', 'service_role', false);
        insert into public.pricing_rules (id, hotel_id, name, action_type, action_direction, action_value, is_active)
          values ('${RULE}', '${H}', 'Busy', 'percent', 'increase', 10, true);
        -- Two future nights and one past night changed in Cloudbeds; one night typed in MAYA.
        insert into public.manual_price (hotel_id, stay_date, room_type_id, price, set_by, set_at, source, pms_type) values
          ('${H}', '${night(2)}', '${KING}', 175, null, '${typedAt}', 'pms', 'cloudbeds'),
          ('${H}', '${night(2)}', '${SUITE}', 310, null, '${typedAt}', 'pms', 'cloudbeds'),
          ('${H}', '${night(3)}', '${KING}', 180, null, '${typedAt}', 'pms', 'cloudbeds'),
          ('${H}', '${night(-3)}', '${KING}', 160, null, '${typedAt}', 'pms', 'cloudbeds'),
          ('${H}', '${night(5)}', '${KING}', 199, '${RM}', '${typedAt}', 'maya', null);
        -- One night whose rate was removed in Cloudbeds after MAYA sent 150 to it.
        insert into public.base_rate_calendar (hotel_id, stay_date, room_type_id, price, source, pms_removed_at) values
          ('${H}', '${night(7)}', '${KING}', 140, 'pms', now()),
          ('${H}', '${night(8)}', '${KING}', 140, 'pms', null);
        insert into public.rate_updates (hotel_id, pms_type, room_type_id, stay_date, price, sent_price, status, attempts, pushed_at) values
          ('${H}', 'cloudbeds', '${KING}', '${night(7)}', 150, 150, 'sent', 1, now() - interval '3 hours'),
          ('${H}', 'cloudbeds', '${KING}', '${night(8)}', 150, 150, 'sent', 1, now() - interval '3 hours');
        -- The busy rule had fired on each, and each price paused it.
        insert into public.ladder_rule_state (rule_id, rule_version, stay_date, room_type_id, is_active, activated_at, last_evaluated_at, action_kind, action_direction, action_value, suppressed_at) values
          ('${RULE}', 1, '${night(2)}', '${KING}', true, now(), now(), 'percent', 'increase', 10, '${typedAt}'),
          ('${RULE}', 1, '${night(3)}', '${KING}', true, now(), now(), 'percent', 'increase', 10, '${typedAt}'),
          ('${RULE}', 1, '${night(5)}', '${KING}', true, now(), now(), 'percent', 'increase', 10, '${typedAt}');
        select set_config('request.jwt.claim.role', '', false);
      `);
    });

    const open = async () =>
      (
        await q(
          `select stay_date::text as d, room_type_id::text as rt, source, cleared_at is not null as cleared, cleared_by::text as by
             from public.manual_price where hotel_id = $1 order by stay_date, room_type_id`,
          [H],
        )
      ).map((r) => ({ ...r }));
    const suppressed = async () =>
      (await q(`select stay_date::text as d, suppressed_at is not null as s from public.ladder_rule_state where rule_id = $1 order by stay_date`, [RULE])).map(
        (r) => [r.d, r.s],
      );

    it("refuses anyone who can't manage the property, and anything but the two choices", async () => {
      await as(VIEWER, "aal1", async () => {
        await expect(save("maya_wins")).rejects.toThrow(/not allowed/);
      });
      await as(OTHER, "aal1", async () => {
        await expect(save("maya_wins", true)).rejects.toThrow(/not allowed/);
      });
      await as(ADMIN, "aal2", async () => {
        await expect(save("maya_wins", true)).rejects.toThrow(/not allowed/);
      });
      await as(RM, "aal1", async () => {
        await expect(save("always")).rejects.toThrow(/keep or maya_wins/);
      });
      expect(await mode()).toBe("keep");
    });

    it("can't be called without signing in", async () => {
      await db.exec(`set role anon;`);
      try {
        await expect(q(`select public.set_pms_rate_changes($1, 'maya_wins', true)`, [H])).rejects.toThrow(/permission denied/);
      } finally {
        await db.exec(`reset role;`);
      }
    });

    it("says how many nights keep a rate changed in the PMS, and changes nothing until it is told to replace them", async () => {
      const before = await open();
      const answer = await as(RM, "aal1", () => save("maya_wins"));
      // Nights 2 (two room types), 3 and 7: three nights. The past night and the typed one don't count.
      expect(answer).toMatchObject({ saved: false, reason: "confirm", mode: "keep", nights: 3 });
      expect(await mode()).toBe("keep");
      expect(await open()).toEqual(before);
    });

    it("on replace: clears the future rates changed in the PMS, lets their rules go, hands removed nights back, and leaves typed prices alone", async () => {
      const answer = await as(RM, "aal1", () => save("maya_wins", true));
      expect(answer).toMatchObject({ saved: true, mode: "maya_wins", nights: 3, cleared_prices: 3, handed_back: 1 });
      expect(await mode()).toBe("maya_wins");
      expect(await open()).toEqual([
        { d: night(-3), rt: KING, source: "pms", cleared: false, by: null },
        { d: night(2), rt: KING, source: "pms", cleared: true, by: RM },
        { d: night(2), rt: SUITE, source: "pms", cleared: true, by: RM },
        { d: night(3), rt: KING, source: "pms", cleared: true, by: RM },
        { d: night(5), rt: KING, source: "maya", cleared: false, by: null },
      ]);
      // The rules those prices paused apply again; the typed price keeps its own pause.
      expect(await suppressed()).toEqual([
        [night(2), false],
        [night(3), false],
        [night(5), true],
      ]);
      // The removed night is priced by MAYA again, and its ledger says MAYA's price isn't there.
      expect(await q(`select stay_date::text as d, pms_removed_at from public.base_rate_calendar where hotel_id = $1 order by 1`, [H])).toEqual([
        { d: night(7), pms_removed_at: null },
        { d: night(8), pms_removed_at: null },
      ]);
      expect(await q(`select stay_date::text as d, status, error, sent_price from public.rate_updates where hotel_id = $1 order by 1`, [H])).toEqual([
        { d: night(7), status: "skipped", error: PMS_RATE_REMOVED_REASON, sent_price: null },
        { d: night(8), status: "sent", error: null, sent_price: "150.00" },
      ]);
    });

    it("turns off with nothing else changed, and on again with nothing to ask when nothing is left", async () => {
      const before = await open();
      expect(await as(RM, "aal1", () => save("keep"))).toMatchObject({ saved: true, mode: "keep" });
      expect(await mode()).toBe("keep");
      expect(await open()).toEqual(before);
      expect(await as(RM, "aal1", () => save("maya_wins"))).toMatchObject({ saved: true, mode: "maya_wins", nights: 0 });
      expect(await mode()).toBe("maya_wins");
    });

    it("lets a platform admin save only in God Mode, and puts that save on the change log", async () => {
      await as(ADMIN, "aal2", async () => {
        await q(`select public.god_mode_start()`);
        expect(await save("keep")).toMatchObject({ saved: true, mode: "keep" });
        await q(`select public.god_mode_end()`);
      });
      expect(await mode()).toBe("keep");
      const recorded = await q(`select user_id::text as u, hotel_id::text as h, table_name as t, summary from public.support_changes order by id desc limit 1`);
      expect(recorded[0]).toMatchObject({ u: ADMIN, h: H, t: "hotel_settings" });
      expect(String(recorded[0].summary)).toContain("pms_rate_changes from maya_wins to keep");
    });

    it("runs again on a database that already has it without changing a saved choice", async () => {
      await as(RM, "aal1", () => save("maya_wins"));
      await db.exec(fileSql(MIGRATION));
      expect(await mode()).toBe("maya_wins");
      expect(await q(`select count(*)::int as n from public.pms_change_notices`)).toEqual([{ n: 4 }]);
    });
  });
});
