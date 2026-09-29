/**
 * 99_supabase_migration_pilot_health_v1.sql run for real in PGlite, twice:
 * the numbers platform_pilot_health() gives a seeded property, which
 * connection row it reports when a hotel has more than one, who is left out
 * (not entitled, placeholders, purged, inactive, test unless asked), who may
 * call it, and the index for the 24-hour sent count. Only runs with
 * MAYA_PGLITE_DIR set (see src/lib/engine/large-property-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const MIGRATION = readFileSync(resolve(__dirname, "../../../../99_supabase_migration_pilot_health_v1.sql"), "utf8");

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

const H = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const HARBOUR = H(1);
const QUIET = H(2);
const CANCELED = H(3);
const PLACEHOLDER = H(4);
const PURGED = H(5);
const SANDBOX = H(6);
const INACTIVE = H(7);
const TWO_DOWN = H(8);

/** The columns the page reads, dates as text so the numbers compare as strings. */
const ROW = `
  select hotel_id, name, timezone, is_test, mode, subscription_status, pms_type::text, pms_status::text,
         last_sync_at, down_since, sync_failures, last_ok_run_at,
         pass_date::text as pass_date, pass_cursor::text as pass_cursor, pass_started_at, pass_completed_at,
         pass_horizon_days, dirty_count, dirty_oldest_marked_at, sent_24h,
         open_incidents, open_incidents_since, open_incidents_admin_only, open_incident_causes,
         active_rules, rule_changes_24h
    from public.platform_pilot_health($1)`;

describe.skipIf(!PGLITE_DIR)("pilot health migration in PGlite", () => {
  let db: Db;

  const asService = async <T>(fn: () => Promise<T>): Promise<T> => {
    await db.exec(`select set_config('request.jwt.claim.role', 'service_role', false)`);
    try {
      return await fn();
    } finally {
      await db.exec(`select set_config('request.jwt.claim.role', '', false)`);
    }
  };
  const rows = (includeTest = false) => asService(async () => (await db.query(ROW, [includeTest])).rows);
  const rowFor = async (hotel: string, includeTest = false) => (await rows(includeTest)).find((r) => r.hotel_id === hotel);

  beforeAll(async () => {
    const mod = await import(
      /* @vite-ignore */ pathToFileURL(`${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist/index.js`).href
    );
    db = new mod.PGlite() as Db;
    // The tables as 02_supabase_schema.sql and the later migrations leave the
    // columns the function reads, Supabase's roles and auth.role(), and
    // is_platform_admin() as a switch.
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
      create schema auth;
      create function auth.role() returns text language sql stable as $$
        select nullif(current_setting('request.jwt.claim.role', true), '')
      $$;
      create function public.is_platform_admin(p_user_id uuid default null) returns boolean
        language sql stable as $$ select coalesce(nullif(current_setting('maya.test_admin', true), '')::boolean, false) $$;
      create type public.pms_type as enum ('mews', 'cloudbeds', 'think', 'opera', 'other');
      create type public.connection_status as enum ('pending', 'connected', 'degraded', 'disconnected', 'error');
      create table public.hotels (
        id uuid primary key,
        name text not null,
        timezone text not null default 'UTC',
        is_active boolean not null default true,
        setup_pending_at timestamptz,
        data_purged_at timestamptz,
        is_test boolean not null default false
      );
      create table public.hotel_settings (hotel_id uuid primary key, simulation_mode boolean not null default false);
      create table public.hotel_subscriptions (
        hotel_id uuid primary key,
        status text not null,
        plan_kind text not null default 'stripe'
      );
      create table public.pms_connections (
        id uuid primary key default gen_random_uuid(),
        hotel_id uuid not null,
        pms_type public.pms_type not null,
        status public.connection_status not null default 'pending',
        last_sync_at timestamptz,
        down_since timestamptz,
        sync_failures integer not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (hotel_id, pms_type)
      );
      create table public.hotel_pricing_state (
        hotel_id uuid primary key,
        pass_date date,
        pass_cursor date,
        pass_started_at timestamptz,
        pass_completed_at timestamptz,
        pass_horizon_days integer,
        last_ok_run_at timestamptz
      );
      create table public.pricing_dirty_nights (
        hotel_id uuid not null,
        stay_date date not null,
        first_marked_at timestamptz not null default now(),
        primary key (hotel_id, stay_date)
      );
      create table public.rate_updates (
        id uuid primary key default gen_random_uuid(),
        hotel_id uuid not null,
        stay_date date not null,
        status text not null check (status in ('sent', 'failed', 'skipped')),
        pushed_at timestamptz
      );
      create table public.rate_push_incidents (
        id uuid primary key default gen_random_uuid(),
        hotel_id uuid not null,
        pms_type public.pms_type not null,
        cause text not null,
        admin_only boolean not null default false,
        opened_at timestamptz not null,
        resolved_at timestamptz
      );
      create table public.pricing_rules (
        id uuid primary key default gen_random_uuid(),
        hotel_id uuid not null,
        is_active boolean not null default true
      );
      create table public.product_events (
        id bigint generated always as identity primary key,
        occurred_at timestamptz not null default now(),
        event text not null,
        hotel_id uuid
      );

      insert into public.hotels (id, name, timezone, is_active, setup_pending_at, data_purged_at, is_test) values
        ('${HARBOUR}', 'Harbour Inn', 'Pacific/Auckland', true, null, null, false),
        ('${QUIET}', 'Quiet Inn', 'UTC', true, null, null, false),
        ('${CANCELED}', 'Canceled Inn', 'UTC', true, null, null, false),
        ('${PLACEHOLDER}', 'Placeholder Inn', 'UTC', true, now(), null, false),
        ('${PURGED}', 'Purged Inn', 'UTC', true, null, now(), false),
        ('${SANDBOX}', 'Sandbox Inn', 'UTC', true, null, null, true),
        ('${INACTIVE}', 'Inactive Inn', 'UTC', false, null, null, false),
        ('${TWO_DOWN}', 'Two Down Inn', 'UTC', true, null, null, false);
      insert into public.hotel_settings (hotel_id, simulation_mode) values ('${HARBOUR}', false), ('${TWO_DOWN}', true);
      insert into public.hotel_subscriptions (hotel_id, status, plan_kind) values
        ('${HARBOUR}', 'active', 'stripe'),
        ('${CANCELED}', 'canceled', 'stripe'),
        ('${SANDBOX}', 'trialing', 'stripe'),
        ('${TWO_DOWN}', 'past_due', 'internal');

      -- Harbour: one connected Mews row, read five minutes ago.
      insert into public.pms_connections (hotel_id, pms_type, status, last_sync_at, sync_failures) values
        ('${HARBOUR}', 'mews', 'connected', now() - interval '5 minutes', 2);
      -- Quiet: a newer disconnected Cloudbeds row and an older connected Mews row.
      insert into public.pms_connections (hotel_id, pms_type, status, last_sync_at, down_since, updated_at) values
        ('${QUIET}', 'cloudbeds', 'disconnected', null, now() - interval '2 days', now()),
        ('${QUIET}', 'mews', 'connected', now() - interval '3 hours', null, now() - interval '1 day');
      -- Two Down: nothing connected, the Cloudbeds row changed last.
      insert into public.pms_connections (hotel_id, pms_type, status, down_since, updated_at) values
        ('${TWO_DOWN}', 'think', 'pending', null, now() - interval '1 day'),
        ('${TWO_DOWN}', 'cloudbeds', 'error', now() - interval '1 hour', now());

      insert into public.hotel_pricing_state
        (hotel_id, pass_date, pass_cursor, pass_started_at, pass_completed_at, pass_horizon_days, last_ok_run_at) values
        ('${HARBOUR}', '2026-09-29', '2026-11-03', now() - interval '20 minutes', null, 396, now() - interval '2 minutes');
      insert into public.pricing_dirty_nights (hotel_id, stay_date, first_marked_at) values
        ('${HARBOUR}', '2026-10-01', now() - interval '45 minutes'),
        ('${HARBOUR}', '2026-10-02', now() - interval '3 minutes'),
        ('${HARBOUR}', '2026-10-03', now() - interval '1 minute'),
        ('${QUIET}', '2026-10-01', now() - interval '1 minute');
      insert into public.rate_updates (hotel_id, stay_date, status, pushed_at) values
        ('${HARBOUR}', '2026-10-01', 'sent', now() - interval '1 hour'),
        ('${HARBOUR}', '2026-10-02', 'sent', now() - interval '2 hours'),
        ('${HARBOUR}', '2026-10-03', 'sent', now() - interval '23 hours'),
        ('${HARBOUR}', '2026-10-04', 'sent', now() - interval '30 hours'),
        ('${HARBOUR}', '2026-10-05', 'failed', now() - interval '1 hour'),
        ('${HARBOUR}', '2026-10-06', 'skipped', now() - interval '1 hour'),
        ('${QUIET}', '2026-10-01', 'sent', now() - interval '1 hour');
      insert into public.rate_push_incidents (hotel_id, pms_type, cause, admin_only, opened_at, resolved_at) values
        ('${HARBOUR}', 'mews', 'rate_not_found', false, now() - interval '3 hours', null),
        ('${HARBOUR}', 'mews', 'vendor_busy', false, now() - interval '1 hour', null),
        ('${HARBOUR}', 'mews', 'price_out_of_range', true, now() - interval '30 minutes', null),
        ('${HARBOUR}', 'mews', 'vendor_down', false, now() - interval '2 days', now() - interval '1 day');
      insert into public.pricing_rules (hotel_id, is_active) values
        ('${HARBOUR}', true), ('${HARBOUR}', true), ('${HARBOUR}', false), ('${QUIET}', true);
      insert into public.product_events (hotel_id, event, occurred_at) values
        ('${HARBOUR}', 'rule.created', now() - interval '1 hour'),
        ('${HARBOUR}', 'rule.edited', now() - interval '2 hours'),
        ('${HARBOUR}', 'rule.deleted', now() - interval '3 days'),
        ('${HARBOUR}', 'manual_price.set', now() - interval '1 hour'),
        ('${QUIET}', 'rule.enabled', now() - interval '1 hour');
    `);
    await db.exec(MIGRATION);
    await db.exec(MIGRATION);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it("gives a seeded property the numbers the page shows", async () => {
    const harbour = await rowFor(HARBOUR);
    expect(harbour).toMatchObject({
      name: "Harbour Inn",
      timezone: "Pacific/Auckland",
      is_test: false,
      mode: "live",
      subscription_status: "active",
      pms_type: "mews",
      pms_status: "connected",
      down_since: null,
      sync_failures: 2,
      pass_date: "2026-09-29",
      pass_cursor: "2026-11-03",
      pass_completed_at: null,
      pass_horizon_days: 396,
      dirty_count: 3,
      sent_24h: 3,
      open_incidents: 2,
      open_incidents_admin_only: 1,
      open_incident_causes: ["rate_not_found", "vendor_busy"],
      active_rules: 2,
      rule_changes_24h: 2,
    });
    const ageMinutes = (v: unknown) => Math.round((Date.now() - new Date(String(v)).getTime()) / 60_000);
    expect(ageMinutes(harbour?.last_sync_at)).toBe(5);
    expect(ageMinutes(harbour?.last_ok_run_at)).toBe(2);
    expect(ageMinutes(harbour?.pass_started_at)).toBe(20);
    expect(ageMinutes(harbour?.dirty_oldest_marked_at)).toBe(45);
    expect(ageMinutes(harbour?.open_incidents_since)).toBe(180);
  });

  it("reads a property with nothing yet as zeros and nulls, and no settings row as simulation", async () => {
    const quiet = await rowFor(QUIET);
    expect(quiet).toMatchObject({
      mode: "simulation",
      subscription_status: null,
      last_ok_run_at: null,
      pass_date: null,
      pass_cursor: null,
      pass_completed_at: null,
      pass_horizon_days: null,
      dirty_count: 1,
      sent_24h: 1,
      open_incidents: 0,
      open_incidents_since: null,
      open_incidents_admin_only: 0,
      open_incident_causes: [],
      active_rules: 1,
      rule_changes_24h: 1,
    });
  });

  it("reports the connected row when a hotel has more than one, else the newest", async () => {
    const quiet = await rowFor(QUIET);
    expect(quiet).toMatchObject({ pms_type: "mews", pms_status: "connected", down_since: null });
    const twoDown = await rowFor(TWO_DOWN);
    expect(twoDown).toMatchObject({ mode: "simulation", subscription_status: "past_due", pms_type: "cloudbeds", pms_status: "error" });
    expect(twoDown?.down_since).not.toBeNull();
  });

  it("lists only active, entitled properties, and test ones only when asked", async () => {
    const names = (await rows()).map((r) => r.name);
    expect(names).toEqual(["Harbour Inn", "Quiet Inn", "Two Down Inn"]);
    const withTest = (await rows(true)).map((r) => r.name);
    expect(withTest).toEqual(["Harbour Inn", "Quiet Inn", "Sandbox Inn", "Two Down Inn"]);
    expect((await rowFor(SANDBOX, true))?.is_test).toBe(true);
  });

  it("answers a platform admin, and refuses anyone else", async () => {
    await expect(db.query(ROW, [false])).rejects.toThrow(/Not authorized/);
    await db.exec(`select set_config('maya.test_admin', 'true', false)`);
    try {
      expect((await db.query(ROW, [false])).rows).toHaveLength(3);
    } finally {
      await db.exec(`select set_config('maya.test_admin', '', false)`);
    }
  });

  it("adds the index for the 24-hour sent count, and grants the function to signed-in callers and the service role", async () => {
    const index = await db.query(
      `select indexdef from pg_indexes where tablename = 'rate_updates' and indexname = 'idx_rate_updates_hotel_sent_at'`,
    );
    expect(index.rows).toHaveLength(1);
    expect(String(index.rows[0].indexdef)).toMatch(/\(hotel_id, pushed_at DESC\) WHERE \(status = 'sent'::text\)/);

    const grants = await db.query(`
      select grantee from information_schema.routine_privileges
       where routine_name = 'platform_pilot_health' and privilege_type = 'EXECUTE'
       order by grantee`);
    const who = grants.rows.map((r) => r.grantee);
    expect(who).toContain("service_role");
    expect(who).toContain("authenticated");
    expect(who).not.toContain("anon");
    expect(who).not.toContain("PUBLIC");
  });
});
