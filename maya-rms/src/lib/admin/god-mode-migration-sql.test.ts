/**
 * 99_supabase_migration_god_mode_v1.sql run for real in PGlite, twice, on top
 * of every migration before it: a platform admin's write on a customer's
 * table is refused at aal1, refused at aal2 without a window, refused with an
 * expired window, and lands inside an open one with a support_changes row to
 * show for it; a Revenue Manager's write works in every case; the admin keeps
 * reading; entering, leaving and expiring are all on the audit trail. Only
 * runs with MAYA_PGLITE_DIR set (see pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_god_mode_v1.sql";

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

/**
 * What Supabase provides and the files assume. auth.jwt() reads the whole
 * claims object here, so a test can act with an aal1 or an aal2 token.
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
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RM = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const RT1 = "55555555-5555-4555-8555-555555555551";
const RULE = "66666666-6666-4666-8666-666666666666";
const SPEED_RULE = "66666666-6666-4666-8666-666666666667";

describe.skipIf(!PGLITE_DIR)("the God Mode migration in PGlite", () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

  /**
   * Runs `fn` as this signed-in person, with the token's aal, then puts the
   * session back. An aal2 token carries a code entered `codeAgeSeconds` ago
   * (just now by default), and every token names its sign-in session.
   */
  const as = async <T>(
    userId: string,
    aal: "aal1" | "aal2",
    fn: () => Promise<T>,
    opts: { session?: string; codeAgeSeconds?: number } = {},
  ): Promise<T> => {
    const now = Math.floor(Date.now() / 1000);
    const amr =
      aal === "aal2"
        ? [{ method: "totp", timestamp: now - (opts.codeAgeSeconds ?? 0) }, { method: "password", timestamp: now - 86_400 }]
        : [{ method: "password", timestamp: now }];
    const claims = JSON.stringify({ sub: userId, role: "authenticated", aal, amr, session_id: opts.session ?? "sess-laptop" });
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
  const asService = async <T>(fn: () => Promise<T>): Promise<T> => {
    await db.exec(`select set_config('request.jwt.claim.role', 'service_role', false)`);
    try {
      return await fn();
    } finally {
      await db.exec(`select set_config('request.jwt.claim.role', '', false)`);
    }
  };

  /** How many rows an UPDATE on the customer's rule reaches (0 under RLS when refused). */
  const renameRule = async (name: string) =>
    (await q(`with u as (update public.pricing_rules set name = $1 where id = $2 returning 1) select count(*)::int as n from u`, [name, RULE]))[0].n;
  const setFloor = async (floor: number) =>
    (await q(`with u as (update public.hotel_settings set strategy_floor = $1 where hotel_id = $2 returning 1) select count(*)::int as n from u`, [floor, H]))[0].n;
  const godModeActive = async () => (await q(`select public.god_mode_active() as on`))[0].on;
  const status = async () => (await q(`select public.god_mode_status() as s`))[0].s as Record<string, unknown>;
  const audit = async (type: string) =>
    q(`select actor_user_id, entity_type, entity_id, hotel_id, detail from public.platform_audit_events where event_type = $1 order by created_at`, [type]);
  const changes = async () =>
    q(`select session_id, user_id, hotel_id, table_name, row_id, op, before, after, summary from public.support_changes order by id`);

  beforeAll(async () => {
    const dist = `${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist`;
    const mod = await import(/* @vite-ignore */ pathToFileURL(`${dist}/index.js`).href);
    const { pgcrypto } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/pgcrypto.js`).href);
    const { citext } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/citext.js`).href);
    db = new mod.PGlite({ extensions: { pgcrypto, citext } }) as Db;
    await db.exec(PLATFORM);
    for (const name of ["01_supabase_base_schema.sql", "02_supabase_schema.sql", ...MIGRATION_ORDER.filter((m) => m !== MIGRATION)]) {
      try {
        await db.exec(fileSql(name));
      } catch (e) {
        throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Supabase's default privileges: signed-in people reach the tables and
    // RLS decides the rows. Granted before the file under test, so its own
    // grants on the tables it creates are the ones that count.
    await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated;`);
    // The file under test, twice: it is safe to run again.
    await db.exec(fileSql(MIGRATION));
    await db.exec(fileSql(MIGRATION));
    await db.exec(`
      select set_config('request.jwt.claim.role', 'service_role', false);
      insert into auth.users (id, email) values
        ('${ADMIN}', 'jake@example.com'), ('${RM}', 'priya@example.com'), ('${OTHER}', 'sam@example.com');
      insert into public.app_roles (user_id, role) values ('${ADMIN}', 'platform_admin');
      insert into public.hotels (id, name, timezone) values ('${H}', 'Harbour Inn', 'America/New_York');
      insert into public.hotel_memberships (hotel_id, user_id, role) values ('${H}', '${RM}', 'revenue_manager');
      insert into public.hotel_settings (hotel_id, simulation_mode) values ('${H}', true)
        on conflict (hotel_id) do update set simulation_mode = true;
      insert into public.room_types (id, hotel_id, external_room_type_id, name, total_rooms) values ('${RT1}', '${H}', 'K', 'King', 10);
      insert into public.pricing_rules (id, hotel_id, name, action_type, action_direction, action_value)
        values ('${RULE}', '${H}', 'Busy', 'percent', 'increase', 10);
      insert into public.rate_updates (hotel_id, pms_type, room_type_id, stay_date, price, status)
        values ('${H}', 'cloudbeds', '${RT1}', '2026-12-01', 180, 'sent');
      select set_config('request.jwt.claim.role', '', false);
    `);
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  it("keeps both new tables behind row level security, readable by signed-in people and written only by the service role", async () => {
    const rows = await q(
      `select c.relname as t, c.relrowsecurity as rls,
              (select string_agg(p.policyname || ':' || p.cmd, ',' order by p.policyname) from pg_policies p where p.tablename = c.relname) as policies
         from pg_class c where c.relname in ('support_sessions', 'support_changes') order by 1`,
    );
    expect(rows).toEqual([
      { t: "support_changes", rls: true, policies: "support_changes_read:SELECT" },
      { t: "support_sessions", rls: true, policies: "support_sessions_own_read:SELECT" },
    ]);
    const grants = await q(
      `select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privs
         from information_schema.role_table_grants
        where table_name in ('support_sessions', 'support_changes') and grantee in ('anon', 'authenticated', 'service_role')
        group by 1, 2 order by 1, 2`,
    );
    expect(grants).toEqual([
      { table_name: "support_changes", grantee: "authenticated", privs: "SELECT" },
      { table_name: "support_changes", grantee: "service_role", privs: "DELETE,INSERT,SELECT,UPDATE" },
      { table_name: "support_sessions", grantee: "authenticated", privs: "SELECT" },
      { table_name: "support_sessions", grantee: "service_role", privs: "DELETE,INSERT,SELECT,UPDATE" },
    ]);
    expect(await q(`select public.god_mode_minutes() as m`)).toEqual([{ m: 30 }]);
  });

  it("refuses an admin's write at aal1, and will not open a window without a code", async () => {
    await as(ADMIN, "aal1", async () => {
      expect(await godModeActive()).toBe(false);
      expect(await renameRule("Busy (admin aal1)")).toBe(0);
      expect(await setFloor(90)).toBe(0);
      await expect(q(`select public.god_mode_start()`)).rejects.toThrow(/authenticator app/);
      expect(await status()).toMatchObject({ admin: true, aal: "aal1", active: false, session_id: null });
    });
    expect(await q(`select name from public.pricing_rules where id = $1`, [RULE])).toEqual([{ name: "Busy" }]);
  });

  it("refuses an admin's write at aal2 with no window open", async () => {
    await as(ADMIN, "aal2", async () => {
      expect(await godModeActive()).toBe(false);
      expect(await renameRule("Busy (admin no window)")).toBe(0);
      expect(await setFloor(90)).toBe(0);
      expect(await status()).toMatchObject({ admin: true, aal: "aal2", active: false, session_id: null });
    });
    expect(await changes()).toEqual([]);
  });

  it("refuses an admin's write on an expired window, and records that it ran out the first time anyone looks", async () => {
    const [{ id }] = await asService(() =>
      q(`insert into public.support_sessions (user_id, started_at, expires_at) values ($1, now() - interval '31 minutes', now() - interval '1 minute') returning id`, [ADMIN]),
    );
    await as(ADMIN, "aal2", async () => {
      expect(await godModeActive()).toBe(false);
      expect(await renameRule("Busy (admin expired)")).toBe(0);
      expect(await status()).toMatchObject({ admin: true, active: false, session_id: null });
      // Looking twice logs it once.
      await status();
    });
    expect(await q(`select end_reason, ended_at = expires_at as at_expiry, expiry_logged_at is not null as logged from public.support_sessions where id = $1`, [id])).toEqual([
      { end_reason: "expired", at_expiry: true, logged: true },
    ]);
    expect(await audit("god_mode.expired")).toEqual([
      { actor_user_id: ADMIN, entity_type: "support_session", entity_id: id, hotel_id: null, detail: expect.objectContaining({ expires_at: expect.any(String) }) },
    ]);
    expect(await changes()).toEqual([]);
  });

  it("lets the admin write inside an open window, records every change, and closes on End", async () => {
    let sessionId = "";
    await as(ADMIN, "aal2", async () => {
      const [{ s }] = await q(`select to_jsonb(public.god_mode_start()) as s`);
      const started = s as Record<string, unknown>;
      sessionId = String(started.id);
      expect(started).toMatchObject({ user_id: ADMIN, ended_at: null, end_reason: null });
      const minutes = (Date.parse(String(started.expires_at)) - Date.parse(String(started.started_at))) / 60_000;
      expect(Math.round(minutes)).toBe(30);
      expect(await godModeActive()).toBe(true);
      expect(await status()).toMatchObject({ admin: true, aal: "aal2", active: true, session_id: sessionId });

      expect(await renameRule("Busy (support)")).toBe(1);
      expect(await setFloor(95)).toBe(1);
      // The team RPCs let the admin through too.
      await q(`select public.platform_set_membership_role($1, $2, 'general_manager')`, [H, RM]);
      // A window can be read back by its owner, and only its owner.
      expect(await q(`select count(*)::int as n from public.support_sessions`)).toEqual([{ n: 2 }]);
      expect(await q(`select count(*)::int as n from public.support_changes`)).toEqual([{ n: 3 }]);

      await q(`select public.god_mode_end()`);
      expect(await godModeActive()).toBe(false);
      expect(await renameRule("Busy (after end)")).toBe(0);
    });
    await asService(() => q(`select public.platform_set_membership_role($1, $2, 'revenue_manager')`, [H, RM]));

    expect(await q(`select end_reason from public.support_sessions where id = $1`, [sessionId])).toEqual([{ end_reason: "ended" }]);
    expect(await audit("god_mode.started")).toEqual([
      { actor_user_id: ADMIN, entity_type: "support_session", entity_id: sessionId, hotel_id: null, detail: expect.objectContaining({ expires_at: expect.any(String) }) },
    ]);
    expect(await audit("god_mode.ended")).toEqual([
      { actor_user_id: ADMIN, entity_type: "support_session", entity_id: sessionId, hotel_id: null, detail: expect.objectContaining({ expires_at: expect.any(String) }) },
    ]);
    const rows = await changes();
    expect(rows.map((r) => [r.session_id, r.user_id, r.hotel_id, r.table_name, r.row_id, r.op, r.summary])).toEqual([
      [sessionId, ADMIN, H, "pricing_rules", RULE, "update", 'Changed the pricing rule "Busy (support)": name from Busy to Busy (support).'],
      [sessionId, ADMIN, H, "hotel_settings", H, "update", "Changed the property settings: strategy_floor from nothing to 95.00."],
      [sessionId, ADMIN, H, "hotel_memberships", expect.any(String), "update", "Changed a team member: role from revenue_manager to general_manager."],
    ]);
    expect((rows[0].before as Record<string, unknown>).name).toBe("Busy");
    expect((rows[0].after as Record<string, unknown>).name).toBe("Busy (support)");
    // The service role's own write, the one that put the role back, was not a God Mode change.
    expect(rows).toHaveLength(3);
  });

  it("logs nothing for a service-role write and nothing for a member's", async () => {
    const before = (await changes()).length;
    await asService(() => q(`update public.pricing_rules set name = 'Busy' where id = $1`, [RULE]));
    await as(RM, "aal1", async () => {
      expect(await renameRule("Busy (member)")).toBe(1);
      expect(await renameRule("Busy")).toBe(1);
    });
    expect((await changes()).length).toBe(before);
  });

  it("leaves a Revenue Manager's writes alone, with or without a code", async () => {
    for (const aal of ["aal1", "aal2"] as const) {
      await as(RM, aal, async () => {
        expect(await godModeActive()).toBe(false);
        expect(await renameRule(`Busy (${aal})`)).toBe(1);
        expect(await setFloor(88)).toBe(1);
        expect(await status()).toMatchObject({ admin: false, active: false });
        expect(await q(`select count(*)::int as n from public.support_sessions`)).toEqual([{ n: 0 }]);
        await expect(q(`select public.god_mode_start()`)).rejects.toThrow(/Only MAYA staff/);
      });
    }
    await as(OTHER, "aal2", async () => {
      expect(await renameRule("Busy (stranger)")).toBe(0);
    });
    await asService(() => q(`update public.pricing_rules set name = 'Busy' where id = $1`, [RULE]));
  });

  it("still lets the admin read: rate updates, the hotel, and the property's support changes", async () => {
    await as(ADMIN, "aal1", async () => {
      expect(await q(`select count(*)::int as n from public.rate_updates where hotel_id = $1`, [H])).toEqual([{ n: 1 }]);
      expect(await q(`select name from public.hotels where id = $1`, [H])).toEqual([{ name: "Harbour Inn" }]);
      expect(await q(`select count(*)::int as n from public.support_changes where hotel_id = $1`, [H])).toEqual([{ n: 3 }]);
    });
    await as(RM, "aal1", async () => {
      expect(await q(`select count(*)::int as n from public.support_changes where hotel_id = $1`, [H])).toEqual([{ n: 3 }]);
    });
    await as(OTHER, "aal1", async () => {
      expect(await q(`select count(*)::int as n from public.support_changes`)).toEqual([{ n: 0 }]);
    });
    expect(await q(`select qual from pg_policies where tablename = 'rate_updates' and policyname = 'rate_updates_read'`)).toEqual([
      { qual: "is_hotel_accessible(hotel_id)" },
    ]);
  });

  it("gates the rest of the admin's doors on God Mode: deleting a hotel, the rank triggers and base rate deletes", async () => {
    expect(await q(`select qual from pg_policies where tablename = 'hotels' and policyname = 'hotels_delete'`)).toEqual([
      { qual: "(is_platform_admin() AND god_mode_active())" },
    ]);
    expect(
      await q(`select policyname, cmd from pg_policies where tablename = 'base_rate_calendar' order by policyname`),
    ).toEqual([
      { policyname: "base_rate_calendar_delete", cmd: "DELETE" },
      { policyname: "base_rate_calendar_insert", cmd: "INSERT" },
      { policyname: "base_rate_calendar_read", cmd: "SELECT" },
      { policyname: "base_rate_calendar_update", cmd: "UPDATE" },
    ]);
    for (const fn of ["enforce_membership_rank", "enforce_membership_delete_rank", "enforce_simulation_mode_rank", "can_manage_hotel", "can_manage_finances", "platform_invite_user", "platform_set_membership_role", "platform_remove_membership"]) {
      const [{ src }] = await q(`select prosrc as src from pg_proc where proname = $1`, [fn]);
      expect(String(src)).toContain("public.is_platform_admin() and public.god_mode_active()");
    }
    // An admin outside God Mode cannot delete the property or a base rate.
    await asService(() => q(`insert into public.base_rate_calendar (hotel_id, stay_date, room_type_id, price) values ($1, '2026-12-01', $2, 150)`, [H, RT1]));
    await as(ADMIN, "aal2", async () => {
      expect((await q(`with d as (delete from public.base_rate_calendar where hotel_id = $1 returning 1) select count(*)::int as n from d`, [H]))[0].n).toBe(0);
      expect((await q(`with d as (delete from public.hotels where id = $1 returning 1) select count(*)::int as n from d`, [H]))[0].n).toBe(0);
      await expect(q(`select public.platform_set_membership_role($1, $2, 'viewer')`, [H, RM])).rejects.toThrow(/Not authorized/);
    });
    expect(await q(`select count(*)::int as n from public.hotels where id = $1`, [H])).toEqual([{ n: 1 }]);
  });

  it("holds save_rule to God Mode too: switching a rule on with Skip is refused outside it, recorded inside it, and a member's save is theirs", async () => {
    // A pickup rule that is off, so a Skip writes rule_skip_hold days.
    await asService(() =>
      db.exec(`
        insert into public.pricing_rules (id, hotel_id, name, action_type, action_direction, action_value, is_active, is_pickup_rule)
          values ('${SPEED_RULE}', '${H}', 'Rush', 'percent', 'increase', 8, false, true);
        insert into public.rule_affected_room_type (rule_id, room_type_id) values ('${SPEED_RULE}', '${RT1}');
      `),
    );
    const before = (await changes()).length;
    const skipOn = () =>
      q(
        `select public.save_rule($1, $2, false, null, null, 'skip', now(), '{}'::date[], '[]'::jsonb, array['2026-12-01', '2026-12-02']::date[]) as r`,
        [H, SPEED_RULE],
      );
    const switchOff = () =>
      q(`select public.save_rule($1, $2, false, null, null, 'off', now(), '{}'::date[], '[]'::jsonb, '{}'::date[]) as r`, [H, SPEED_RULE]);
    const rule = async () => (await q(`select is_active, skip_at is not null as skipped from public.pricing_rules where id = $1`, [SPEED_RULE]))[0];
    const holds = async () => (await q(`select count(*)::int as n from public.rule_skip_hold where rule_id = $1`, [SPEED_RULE]))[0].n;

    for (const aal of ["aal1", "aal2"] as const) {
      await as(ADMIN, aal, async () => {
        await expect(skipOn()).rejects.toThrow(/Revenue Manager or above/);
      });
    }
    expect(await rule()).toEqual({ is_active: false, skipped: false });
    expect(await holds()).toBe(0);

    let sessionId = "";
    await as(ADMIN, "aal2", async () => {
      sessionId = String((await q(`select (public.god_mode_start()).id as id`))[0].id);
      await skipOn();
      await q(`select public.god_mode_end()`);
      await expect(switchOff()).rejects.toThrow(/Revenue Manager or above/);
    });
    expect(await rule()).toEqual({ is_active: true, skipped: true });
    expect(await holds()).toBe(2);
    const recorded = (await changes()).slice(before);
    expect(recorded.map((r) => [r.session_id, r.user_id, r.hotel_id, r.table_name, r.op])).toEqual([
      [sessionId, ADMIN, H, "pricing_rules", "update"],
      [sessionId, ADMIN, H, "rule_skip_hold", "insert"],
      [sessionId, ADMIN, H, "rule_skip_hold", "insert"],
    ]);
    expect(recorded[0].summary).toMatch(/^Changed the pricing rule "Rush": is_active from false to true, skip_at from nothing to /);
    expect(recorded[1].summary).toBe("Added a held day of a rule.");

    // The property's own Revenue Manager saves as always, and it is not support's change.
    await as(RM, "aal1", async () => {
      expect((await switchOff())[0].r).toMatchObject({ is_active: false });
    });
    expect((await changes()).length).toBe(before + 3);
  });

  it("makes a new platform admin only in God Mode: refused at aal1 and at aal2 with no window", async () => {
    const isAdmin = async (id: string) =>
      (await q(`select count(*)::int as n from public.app_roles where user_id = $1 and role = 'platform_admin'`, [id]))[0].n;
    await q(`select public.god_mode_end()`).catch(() => undefined);
    await as(ADMIN, "aal1", async () => {
      await expect(q(`select public.platform_grant_role($1, 'platform_admin')`, [OTHER])).rejects.toThrow(/Not authorized/);
    });
    await as(ADMIN, "aal2", async () => {
      await q(`select public.god_mode_end()`);
      await expect(q(`select public.platform_grant_role($1, 'platform_admin')`, [OTHER])).rejects.toThrow(/Not authorized/);
      await expect(q(`select public.platform_revoke_role($1, 'platform_admin')`, [ADMIN])).rejects.toThrow(/Not authorized/);
    });
    expect(await isAdmin(OTHER)).toBe(0);

    await as(ADMIN, "aal2", async () => {
      await q(`select public.god_mode_start()`);
      await q(`select public.platform_grant_role($1, 'platform_admin')`, [OTHER]);
      await q(`select public.platform_revoke_role($1, 'platform_admin')`, [OTHER]);
      await q(`select public.god_mode_end()`);
    });
    expect(await isAdmin(OTHER)).toBe(0);
    expect((await audit("app_role.granted")).map((r) => r.actor_user_id)).toEqual([ADMIN]);
    expect((await audit("app_role.revoked")).map((r) => r.actor_user_id)).toEqual([ADMIN]);
  });

  it("opens a window only for a code entered in the last few minutes, not an aal2 session from days ago", async () => {
    await as(
      ADMIN,
      "aal2",
      async () => {
        await expect(q(`select public.god_mode_start()`)).rejects.toThrow(/new code from your authenticator app/);
        expect(await godModeActive()).toBe(false);
      },
      { codeAgeSeconds: 30 * 86_400 },
    );
    await as(
      ADMIN,
      "aal2",
      async () => {
        await expect(q(`select public.god_mode_start()`)).rejects.toThrow(/new code from your authenticator app/);
      },
      { codeAgeSeconds: 6 * 60 },
    );
    await as(
      ADMIN,
      "aal2",
      async () => {
        await q(`select public.god_mode_start()`);
        expect(await godModeActive()).toBe(true);
        await q(`select public.god_mode_end()`);
      },
      { codeAgeSeconds: 60 },
    );
  });

  it("ties a window to the sign-in session that opened it: another device of the same login cannot write", async () => {
    await as(ADMIN, "aal2", async () => {
      await q(`select public.god_mode_start()`);
      expect(await godModeActive()).toBe(true);
    }, { session: "sess-A" });
    await as(
      ADMIN,
      "aal2",
      async () => {
        expect(await godModeActive()).toBe(false);
        expect(await status()).toMatchObject({ admin: true, aal: "aal2", active: false, session_id: null });
        expect(await renameRule("Busy (other device)")).toBe(0);
      },
      { session: "sess-B-other-device", codeAgeSeconds: 7 * 86_400 },
    );
    await as(ADMIN, "aal2", async () => {
      expect(await renameRule("Busy (laptop A)")).toBe(1);
      expect(await renameRule("Busy")).toBe(1);
      await q(`select public.god_mode_end()`);
    }, { session: "sess-A" });
    expect(await q(`select name from public.pricing_rules where id = $1`, [RULE])).toEqual([{ name: "Busy" }]);
  });

  it("records every table an admin can write in God Mode: the policy tables, the RPC-only rule tables, and nothing holding a secret", async () => {
    const triggered = (
      await q(`select c.relname as t from pg_trigger g join pg_class c on c.oid = g.tgrelid where g.tgname = 'trg_god_mode_record_change' order by 1`)
    ).map((r) => String(r.t));
    const writable = (
      await q(`
        select distinct p.tablename::text as t from pg_policies p
         where p.schemaname = 'public' and p.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
           and concat_ws(' ', p.qual, p.with_check) ~ '(can_manage_hotel|can_manage_finances|god_mode_active)'
         order by 1`)
    ).map((r) => String(r.t));
    expect(writable.length).toBeGreaterThan(19);
    for (const t of ["published_price", "rate_updates", "market_events", "reservations", "pricing_decisions", "rule_applications"]) {
      expect(writable).toContain(t);
    }
    expect(triggered).toEqual([...new Set([...writable, "rule_skip_hold", "rule_repeat_alerts", "rule_repeat_alert_nights"])].sort());
    expect(triggered).not.toContain("pms_connection_secrets");

    const before = (await changes()).length;
    await as(ADMIN, "aal2", async () => {
      await q(`select public.god_mode_start()`);
      await q(`insert into public.published_price (hotel_id, room_type_id, stay_date, price, computed_at) values ($1, $2, '2026-12-03', 9, now())`, [H, RT1]);
      await q(`insert into public.market_events (hotel_id, name, start_date, end_date) values ($1, 'Fake festival', '2026-12-01', '2026-12-03')`, [H]);
      await q(`select public.god_mode_end()`);
    });
    const recorded = (await changes()).slice(before);
    expect(recorded.map((r) => [r.user_id, r.hotel_id, r.table_name, r.op, r.summary])).toEqual([
      [ADMIN, H, "published_price", "insert", "Added a published price."],
      [ADMIN, H, "market_events", "insert", 'Added a market event "Fake festival".'],
    ]);
  });

  it("files a deleted rule's conditions and room types under the property", async () => {
    const DOOMED = "66666666-6666-4666-8666-666666666668";
    await asService(() =>
      db.exec(`
        insert into public.pricing_rules (id, hotel_id, name, action_type, action_direction, action_value)
          values ('${DOOMED}', '${H}', 'Doomed', 'percent', 'increase', 5);
        insert into public.rule_affected_room_type (rule_id, room_type_id) values ('${DOOMED}', '${RT1}');
        insert into public.rule_condition (rule_id, occupancy_operator, occupancy_threshold) values ('${DOOMED}', 'gt', 0.8);
      `),
    );
    const before = (await changes()).length;
    await as(ADMIN, "aal2", async () => {
      await q(`select public.god_mode_start()`);
      expect((await q(`with d as (delete from public.pricing_rules where id = $1 returning 1) select count(*)::int as n from d`, [DOOMED]))[0].n).toBe(1);
      await q(`select public.god_mode_end()`);
    });
    const recorded = (await changes()).slice(before);
    expect(recorded.map((r) => r.table_name).sort()).toEqual(["pricing_rules", "rule_affected_room_type", "rule_condition"]);
    expect(recorded.map((r) => r.hotel_id)).toEqual([H, H, H]);
  });

  it("leaves MAYA staff's own clicks and edits out of a never-paid property's last activity", async () => {
    const last = async () => (await q(`select public.never_paid_last_activity($1) as t`, [H]))[0].t as Date;
    await asService(() => q(`update public.hotels set created_at = now() - interval '200 days' where id = $1`, [H]));
    const start = await last();
    await asService(() =>
      q(`insert into public.product_events (hotel_id, user_id, event, source, occurred_at) values ($1, $2, 'dashboard.tab_opened', 'app', now())`, [H, ADMIN]),
    );
    await asService(() =>
      q(`insert into public.platform_audit_events (actor_user_id, event_type, entity_type, entity_id, hotel_id) values ($1, 'membership.role_changed', 'hotel_membership', 'x', $2)`, [ADMIN, H]),
    );
    expect(await last()).toEqual(start);
    // The property's own Revenue Manager still counts.
    await asService(() =>
      q(`insert into public.product_events (hotel_id, user_id, event, source, occurred_at) values ($1, $2, 'dashboard.tab_opened', 'app', now())`, [H, RM]),
    );
    expect((await last()).getTime()).toBeGreaterThan(start.getTime());
  });

  it("names every migration before it, so the base this test builds is production's", () => {
    expect(MIGRATION_ORDER[MIGRATION_ORDER.length - 1]).toBe(MIGRATION);
  });
});
