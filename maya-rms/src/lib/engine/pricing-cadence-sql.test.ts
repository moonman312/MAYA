/**
 * 99_supabase_migration_pricing_cadence_v1.sql run for real in PGlite
 * (Postgres compiled to WebAssembly), twice, on a production-shaped base:
 * 01_supabase_base_schema.sql, 02_supabase_schema.sql and every migration
 * before it, in the order they were run. Then the triggers that record the
 * touched nights and the owner edits, pricing_work, pricing_run_done and
 * engine_run_gaps, against the contract cadence-rpc-model.test.ts gives the
 * fake Supabase (which the engine, tick and equivalence tests run on).
 *
 * Only runs with MAYA_PGLITE_DIR set (see large-property-sql.test.ts):
 *
 *   MAYA_PGLITE_DIR=/path/to/dir npx vitest run src/lib/engine/pricing-cadence-sql.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RESERVATION_PRICING_COLUMNS } from "./cadence-rpc-model.test";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_pricing_cadence_v1.sql";

/**
 * Every migration before this one, in the order production ran them (the
 * order each file first reached main). A new migration goes on the end.
 */
export const MIGRATION_ORDER = [
  "99_supabase_migration_rules_engine_v1.sql",
  "99_supabase_migration_pms_secrets_v1.sql",
  "99_supabase_migration_command_center_v1.sql",
  "99_supabase_migration_command_center_v2.sql",
  "99_supabase_migration_pms_types_v1.sql",
  "99_supabase_migration_command_center_v3.sql",
  "99_supabase_migration_rate_push_v1.sql",
  "99_supabase_migration_pii_redaction_v1.sql",
  "99_supabase_migration_onboarding_v1.sql",
  "99_supabase_migration_onboarding_v2.sql",
  "99_supabase_migration_pms_request_log_v1.sql",
  "99_supabase_migration_realtime_v1.sql",
  "99_supabase_migration_calendar_revenue_v1.sql",
  "99_supabase_migration_booking_speed_v1.sql",
  "99_supabase_migration_assumption_challenges_v1.sql",
  "99_supabase_migration_rls_hardening_v1.sql",
  "99_supabase_migration_roles_v2.sql",
  "99_supabase_migration_roles_v2_part2.sql",
  "99_supabase_migration_base_price_v1.sql",
  "99_supabase_migration_audit_indexes_v1.sql",
  "99_supabase_migration_run_heartbeat_v1.sql",
  "99_supabase_migration_pickup_event_unique_v1.sql",
  "99_supabase_migration_booking_window_pernight_v1.sql",
  "99_supabase_migration_rls_helpers_lockdown_v1.sql",
  "99_supabase_migration_cloudbeds_room_grain_v1.sql",
  "99_supabase_migration_billing_v1.sql",
  "99_supabase_migration_card_reverify_v1.sql",
  "99_supabase_migration_billing_v2_pending_hotel.sql",
  "99_supabase_migration_card_reverify_v2_two_stage.sql",
  "99_supabase_migration_stalled_signups_v1.sql",
  "99_supabase_migration_card_reverify_v3_anchor.sql",
  "99_supabase_migration_hotels_rls_paywall_v1.sql",
  "99_supabase_migration_room_count_truth_v1.sql",
  "99_supabase_migration_room_shortfall_notice_v1.sql",
  "99_supabase_migration_signup_code_cap_v1.sql",
  "99_supabase_migration_internal_plan_v1.sql",
  "99_supabase_migration_limits_and_scale_v1.sql",
  "99_supabase_migration_incremental_sync_v1.sql",
  "99_supabase_migration_merge_staff_role_v1.sql",
  "99_supabase_migration_pms_signup_gates_v1.sql",
  "99_supabase_migration_pms_request_log_retention_v1.sql",
  "99_supabase_migration_command_center_v4.sql",
  "99_supabase_migration_hotels_hardening_v1.sql",
  "99_supabase_migration_manual_sync_lease_v1.sql",
  "99_supabase_migration_amount_off_codes_v1.sql",
  "99_supabase_migration_retire_fixed_price_codes_v1.sql",
  "99_supabase_migration_sync_checkpoint_v1.sql",
  "99_supabase_migration_engine_data_sweep_v1.sql",
  "99_supabase_migration_trial_with_discount_v1.sql",
  "99_supabase_migration_business_metrics_v1.sql",
  "99_supabase_migration_test_hotels_v1.sql",
  "99_supabase_migration_base_rate_calendar_v1.sql",
  "99_supabase_migration_marketplace_flow_a_v1.sql",
  "99_supabase_migration_marketplace_groups_v1.sql",
  "99_supabase_migration_e2e_hotel4_disconnect_v1.sql",
  "99_supabase_migration_sync_claim_enum_cast_v1.sql",
  "99_supabase_migration_sync_claim_skip_pending_v1.sql",
  "99_supabase_migration_manual_price_v1.sql",
  "99_supabase_migration_room_type_counts_as_room_v1.sql",
  "99_supabase_migration_room_type_out_of_service_v1.sql",
  "99_supabase_migration_setup_deferred_v1.sql",
  "99_supabase_migration_terms_acceptance_v1.sql",
  "99_supabase_migration_no_customer_deletes_v1.sql",
  "99_supabase_migration_marketplace_claim_sweep_v1.sql",
  "99_supabase_migration_product_analytics_v1.sql",
  "99_supabase_migration_product_events_v1.sql",
  "99_supabase_migration_import_early_analysis_v1.sql",
  "99_supabase_migration_import_at_claim_v1.sql",
  "99_supabase_migration_first_paid_at_v1.sql",
  "99_supabase_migration_never_paid_retention_v1.sql",
  "99_supabase_migration_terms_acceptance_events_v1.sql",
  "99_supabase_migration_large_property_scale_v1.sql",
  "99_supabase_migration_push_guardrails_v1.sql",
  "99_supabase_migration_pickup_event_stacking_v1.sql",
  "99_supabase_migration_booking_speed_counts_bookings_v1.sql",
  "99_supabase_migration_docs_questions_v1.sql",
  "99_supabase_migration_pickup_wait_v1.sql",
  "99_supabase_migration_room_count_zero_v1.sql",
  "99_supabase_migration_undo_on_cancellation_v1.sql",
  "99_supabase_migration_docs_ask_tally_v1.sql",
  "99_supabase_migration_account_ready_email_v1.sql",
  "99_supabase_migration_connection_outage_notice_v1.sql",
];

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
  // Supabase's vault extension isn't in PGlite; its functions are never called here.
  sql = sql.replace(/create extension if not exists supabase_vault[^;]*;/gi, "");
  // 02_supabase_schema.sql still creates the pre-push rate_updates table that
  // production dropped before 99_supabase_migration_rate_push_v1.sql made the
  // one every later migration reads.
  if (name === "99_supabase_migration_rate_push_v1.sql") sql = `drop table if exists public.rate_updates cascade;\n${sql}`;
  return sql;
}

const H = "11111111-1111-4111-8111-111111111111";
const H2 = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const RT1 = "44444444-4444-4444-8444-444444444441";
const RT2 = "44444444-4444-4444-8444-444444444442";
const RULE = "55555555-5555-4555-8555-555555555555";

const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe("the migration file", () => {
  it("lists every migration before it, so the base the SQL tests build is production's", () => {
    const files = readdirSync(ROOT).filter((f) => /^99_supabase_migration_.*\.sql$/.test(f) && f !== MIGRATION);
    expect([...MIGRATION_ORDER].sort()).toEqual(files.sort());
  });

  it("watches every reservation column the engine prices on", () => {
    const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8");
    const fn = sql.slice(sql.indexOf("function public.pricing_mark_reservations_upd"), sql.indexOf("function public.pricing_mark_reservations_del"));
    for (const col of RESERVATION_PRICING_COLUMNS) {
      expect(fn).toContain(`o.${col}`);
      expect(fn).toContain(`n.${col}`);
    }
  });
});

describe.skipIf(!PGLITE_DIR)("the pricing cadence migration in PGlite", () => {
  let db: Db;
  const today = new Date().toISOString().slice(0, 10);
  const night = (n: number) => addDays(today, n);
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const dirty = async (hotel = H) =>
    (await q(`select stay_date::text as d, reasons, mark_seq::int as seq from public.pricing_dirty_nights where hotel_id = $1 order by stay_date`, [hotel])).map(
      (r) => [r.d, r.reasons],
    );
  const repriceSeq = async (hotel = H) =>
    Number((await q(`select coalesce(full_reprice_seq, 0) as s from public.hotel_pricing_state where hotel_id = $1`, [hotel]))[0]?.s ?? 0);
  const clear = async () => {
    await db.exec(`delete from public.pricing_dirty_nights; delete from public.hotel_pricing_state;`);
  };
  const asService = async <T>(fn: () => Promise<T>): Promise<T> => {
    await db.exec(`select set_config('request.jwt.claim.role', 'service_role', false)`);
    try {
      return await fn();
    } finally {
      await db.exec(`select set_config('request.jwt.claim.role', '', false)`);
    }
  };

  beforeAll(async () => {
    const dist = `${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist`;
    const mod = await import(/* @vite-ignore */ pathToFileURL(`${dist}/index.js`).href);
    // The extensions 02_supabase_schema.sql creates.
    const { pgcrypto } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/pgcrypto.js`).href);
    const { citext } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/citext.js`).href);
    db = new mod.PGlite({ extensions: { pgcrypto, citext } }) as Db;
    await db.exec(PLATFORM);
    for (const name of ["01_supabase_base_schema.sql", "02_supabase_schema.sql", ...MIGRATION_ORDER]) {
      try {
        await db.exec(fileSql(name));
      } catch (e) {
        throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // The file under test, twice: it is safe to run again.
    await db.exec(fileSql(MIGRATION));
    await db.exec(fileSql(MIGRATION));
    // Seeded as the service role, as the app's admin paths write these.
    await db.exec(`
      select set_config('request.jwt.claim.role', 'service_role', false);
      insert into auth.users (id, email) values ('${USER}', 'owner@example.com');
      insert into public.hotels (id, name, timezone) values ('${H}', 'Cadence Inn', 'America/New_York'), ('${H2}', 'Other Inn', 'UTC');
      insert into public.hotel_memberships (hotel_id, user_id, role) values ('${H}', '${USER}', 'general_manager');
      insert into public.room_types (id, hotel_id, external_room_type_id, name, total_rooms) values
        ('${RT1}', '${H}', 'K', 'King', 10), ('${RT2}', '${H}', 'Q', 'Queen', 8);
      insert into public.pricing_rules (id, hotel_id, name, action_type, action_direction, action_value)
        values ('${RULE}', '${H}', 'Busy', 'percent', 'increase', 10);
      insert into public.rule_condition (rule_id, occupancy_operator, occupancy_threshold) values ('${RULE}', 'gt', 0.8);
      select set_config('request.jwt.claim.role', '', false);
    `);
    await clear();
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it("leaves the queue tables behind row level security with no policies, and only the service role may touch them", async () => {
    const rows = await q(
      `select c.relname as t, c.relrowsecurity as rls,
              (select count(*) from pg_policies p where p.tablename = c.relname)::int as policies
         from pg_class c where c.relname in ('pricing_dirty_nights', 'hotel_pricing_state') order by 1`,
    );
    expect(rows).toEqual([
      { t: "hotel_pricing_state", rls: true, policies: 0 },
      { t: "pricing_dirty_nights", rls: true, policies: 0 },
    ]);
    const grants = await q(
      `select grantee, privilege_type from information_schema.role_table_grants
        where table_name = 'pricing_dirty_nights' and grantee in ('anon', 'authenticated', 'service_role') order by 1, 2`,
    );
    expect(grants.every((g) => g.grantee === "service_role")).toBe(true);
    expect(grants.map((g) => g.privilege_type).sort()).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    // No wake-up table: waits and windows count whole hotel days.
    expect(await q(`select to_regclass('public.pricing_wakeups') as t`)).toEqual([{ t: null }]);
  });

  describe("bookings", () => {
    const res = (id: string, stay: string, over: Record<string, unknown> = {}) => ({
      id,
      stay,
      rt: RT1,
      rate: 100,
      ext: `ext-${id.slice(-4)}`,
      booked: today,
      ...over,
    });
    const insert = async (rows: ReturnType<typeof res>[]) => {
      const values = rows
        .map((r) => `('${r.id}', '${H}', '${r.ext}', '${r.stay}', '${r.rt}', ${r.rate}, ${r.rate}, '${r.booked}', 5)`)
        .join(", ");
      await db.exec(
        `insert into public.reservations (id, hotel_id, external_reservation_id, stay_date, room_type_id, current_rate, base_rate, booking_date, booking_window_days) values ${values}`,
      );
    };
    const id = (n: number) => `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`;

    it("a new booking marks its nights, not the ones already over", async () => {
      await clear();
      await insert([res(id(1), night(3)), res(id(2), night(4)), res(id(3), night(-5))]);
      expect(await dirty()).toEqual([
        [night(3), ["booking"]],
        [night(4), ["booking"]],
      ]);
    });

    it("a rewrite of the payload alone marks nothing; a new rate, room type or first-seen time marks the night", async () => {
      await clear();
      await db.exec(`update public.reservations set raw_payload = '{"note": "late check-in"}'::jsonb where id = '${id(1)}'`);
      expect(await dirty()).toEqual([]);
      // The same rows written again by the sync's upsert: nothing moved.
      await db.exec(`update public.reservations set current_rate = current_rate, updated_at = now() where hotel_id = '${H}'`);
      expect(await dirty()).toEqual([]);
      await db.exec(`update public.reservations set current_rate = 120 where id = '${id(1)}'`);
      await db.exec(`update public.reservations set room_type_id = '${RT2}' where id = '${id(2)}'`);
      expect(await dirty()).toEqual([
        [night(3), ["booking"]],
        [night(4), ["booking"]],
      ]);
    });

    it("a move marks the night it left and the night it went to; a cancellation (the rows deleted) marks its nights", async () => {
      await clear();
      await db.exec(`update public.reservations set stay_date = '${night(9)}' where id = '${id(1)}'`);
      expect(await dirty()).toEqual([
        [night(3), ["booking"]],
        [night(9), ["booking"]],
      ]);
      await clear();
      await db.exec(`delete from public.reservations where id = '${id(2)}'`);
      expect(await dirty()).toEqual([[night(4), ["booking"]]]);
    });

    it("one statement that inserts some rows and changes others (the sync's upsert) marks exactly those nights, once each", async () => {
      await clear();
      await db.exec(`
        insert into public.reservations (id, hotel_id, external_reservation_id, stay_date, room_type_id, current_rate, base_rate, booking_date, booking_window_days)
        values
          ('${id(1)}', '${H}', 'ext-0001', '${night(9)}', '${RT1}', 120, 120, '${today}', 5),
          ('${id(4)}', '${H}', 'ext-0004', '${night(12)}', '${RT1}', 90, 90, '${today}', 5),
          ('${id(5)}', '${H}', 'ext-0005', '${night(12)}', '${RT2}', 90, 90, '${today}', 5)
        on conflict (id) do update set current_rate = excluded.current_rate, stay_date = excluded.stay_date`);
      expect(await dirty()).toEqual([[night(12), ["booking"]]]);
    });

    it("a bulk write marks each night once, and a night marked again gets a higher number", async () => {
      await clear();
      const rows = Array.from({ length: 500 }, (_, i) => res(id(100 + i), night(1 + (i % 50))));
      await insert(rows);
      const marks = await q(`select count(*)::int as n, count(distinct stay_date)::int as d from public.pricing_dirty_nights where hotel_id = '${H}'`);
      expect(marks).toEqual([{ n: 50, d: 50 }]);
      const before = Number((await q(`select mark_seq from public.pricing_dirty_nights where hotel_id = '${H}' and stay_date = '${night(1)}'`))[0].mark_seq);
      await db.exec(`delete from public.reservations where id = '${id(100)}'`);
      const after = Number((await q(`select mark_seq from public.pricing_dirty_nights where hotel_id = '${H}' and stay_date = '${night(1)}'`))[0].mark_seq);
      expect(after).toBeGreaterThan(before);
    });
  });

  describe("owner edits", () => {
    it("typed prices mark their night when set, re-set, cleared and deleted", async () => {
      await clear();
      await db.exec(`insert into public.manual_price (hotel_id, stay_date, room_type_id, price, set_at) values ('${H}', '${night(6)}', '${RT1}', 150, now())`);
      expect(await dirty()).toEqual([[night(6), ["manual_price"]]]);
      await clear();
      await db.exec(`update public.manual_price set cleared_at = now() where hotel_id = '${H}'`);
      expect(await dirty()).toEqual([[night(6), ["manual_price"]]]);
      await clear();
      await db.exec(`delete from public.manual_price where hotel_id = '${H}'`);
      expect(await dirty()).toEqual([[night(6), ["manual_price"]]]);
    });

    it("base rates mark a night only when its rate moves", async () => {
      await clear();
      await db.exec(`insert into public.base_rate_calendar (hotel_id, stay_date, room_type_id, price) values ('${H}', '${night(2)}', '${RT1}', 100), ('${H}', '${night(2)}', '${RT2}', 90)`);
      expect(await dirty()).toEqual([[night(2), ["base_rate"]]]);
      await clear();
      await db.exec(`update public.base_rate_calendar set price = price where hotel_id = '${H}'`);
      expect(await dirty()).toEqual([]);
      await db.exec(`update public.base_rate_calendar set price = 105 where hotel_id = '${H}' and room_type_id = '${RT1}'`);
      expect(await dirty()).toEqual([[night(2), ["base_rate"]]]);
    });

    it("rooms out of service mark every night of the old range and the new", async () => {
      await clear();
      await db.exec(`insert into public.room_type_out_of_service (id, hotel_id, room_type_id, start_date, end_date, units) values ('77777777-7777-4777-8777-777777777777', '${H}', '${RT1}', '${night(1)}', '${night(3)}', 2)`);
      expect((await dirty()).map((d) => d[0])).toEqual([night(1), night(2), night(3)]);
      await clear();
      await db.exec(`update public.room_type_out_of_service set end_date = '${night(5)}', start_date = '${night(4)}' where hotel_id = '${H}'`);
      expect((await dirty()).map((d) => d[0])).toEqual([night(1), night(2), night(3), night(4), night(5)]);
      await clear();
      await db.exec(`update public.room_type_out_of_service set reason = 'paint' where hotel_id = '${H}'`);
      expect(await dirty()).toEqual([]);
      await db.exec(`update public.room_type_out_of_service set cleared_at = now() where hotel_id = '${H}'`);
      expect((await dirty()).map((d) => d[0])).toEqual([night(4), night(5)]);
    });

    it("an answer to the three-changes alert marks the night; the engine's own updates to the row do not", async () => {
      await clear();
      await db.exec(`
        insert into public.rule_repeat_alerts (id, hotel_id, rule_id, rule_version, action_direction, opened_at)
          values ('88888888-8888-4888-8888-888888888888', '${H}', '${RULE}', 1, 'increase', now());
        insert into public.rule_repeat_alert_nights (alert_id, hotel_id, rule_id, rule_version, stay_date, fire_count, reached_at, last_fire_at)
          values ('88888888-8888-4888-8888-888888888888', '${H}', '${RULE}', 1, '${night(8)}', 3, now(), now());`);
      expect(await dirty()).toEqual([]);
      await db.exec(`update public.rule_repeat_alert_nights set fire_count = 4, last_fire_at = now(), updated_at = now()`);
      expect(await dirty()).toEqual([]);
      await db.exec(`update public.rule_repeat_alert_nights set choice = 'stop', chosen_at = now()`);
      expect(await dirty()).toEqual([[night(8), ["alert_answer"]]]);
      await clear();
      await db.exec(`update public.rule_repeat_alert_nights set choice = null, chosen_at = null, closed_at = now(), closed_reason = 'resumed'`);
      expect(await dirty()).toEqual([[night(8), ["alert_answer"]]]);
    });

    it("edits that can move any night ask for a new pass: rules, their conditions and room types, room types, closed periods, flags, the time zone", async () => {
      await clear();
      const bumps: [string, string][] = [
        ["a rule edited", `update public.pricing_rules set version = version + 1 where id = '${RULE}'`],
        ["a rule paused", `update public.pricing_rules set is_active = false where id = '${RULE}'`],
        ["a condition changed", `update public.rule_condition set occupancy_threshold = 0.7 where rule_id = '${RULE}'`],
        ["a signal room type added", `insert into public.rule_signal_room_type (rule_id, room_type_id) values ('${RULE}', '${RT1}')`],
        ["an affected room type added", `insert into public.rule_affected_room_type (rule_id, room_type_id) values ('${RULE}', '${RT2}')`],
        ["a floor changed", `update public.room_types set floor_price = 80 where id = '${RT1}'`],
        ["a room type added", `insert into public.room_types (hotel_id, external_room_type_id, name) values ('${H}', 'S', 'Suite')`],
        ["a closed period", `insert into public.hotel_closed_periods (hotel_id, start_date, end_date) values ('${H}', '2025-12-20', '2025-12-31')`],
        ["a date flagged", `insert into public.assumption_challenges (hotel_id, challenged_date, reason_key) values ('${H}', '2025-07-04', 'holiday')`],
        ["the time zone", `update public.hotels set timezone = 'America/Chicago' where id = '${H}'`],
        ["a rule deleted", `delete from public.pricing_rules where id = '${RULE}'`],
      ];
      let last = await repriceSeq();
      for (const [what, sql] of bumps) {
        await db.exec(sql);
        const now = await repriceSeq();
        expect(now, what).toBeGreaterThan(last);
        last = now;
      }
      // What the syncs write every tick, unchanged, and a rename: no new pass.
      await db.exec(`update public.room_types set total_rooms = total_rooms, name = 'King room' where id = '${RT1}'`);
      await db.exec(`update public.hotels set name = 'Cadence Inn' where id = '${H}'`);
      expect(await repriceSeq()).toBe(last);
      expect(await dirty()).toEqual([]);
      // Put the rule back for the tests after.
      await db.exec(`
        insert into public.pricing_rules (id, hotel_id, name, action_type, action_direction, action_value) values ('${RULE}', '${H}', 'Busy', 'percent', 'increase', 10);
        insert into public.rule_condition (rule_id, occupancy_operator, occupancy_threshold) values ('${RULE}', 'gt', 0.8);`);
    });

    it("a signed-in manager's own write still marks, though the session can't read or write the queue", async () => {
      await clear();
      // What Supabase grants signed-in sessions on every public table; the policies decide the rest.
      await db.exec(`grant select, insert, update, delete on public.assumption_challenges to authenticated`);
      await db.exec(`
        select set_config('request.jwt.claim.sub', '${USER}', false);
        select set_config('request.jwt.claim.role', 'authenticated', false);
        set role authenticated;`);
      try {
        await db.exec(`insert into public.assumption_challenges (hotel_id, challenged_date, reason_key, raised_by) values ('${H}', '2025-11-26', 'holiday', '${USER}')`);
        await expect(db.query(`select * from public.pricing_dirty_nights`)).rejects.toThrow(/permission denied/);
        await expect(db.query(`select * from public.hotel_pricing_state`)).rejects.toThrow(/permission denied/);
        await expect(db.query(`select public.pricing_work('${H}', '${today}', '${night(30)}')`)).rejects.toThrow(/permission denied/);
      } finally {
        await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); select set_config('request.jwt.claim.role', '', false);`);
      }
      expect(await repriceSeq()).toBeGreaterThan(0);
      await db.exec(`set role anon`);
      try {
        await expect(db.query(`select * from public.pricing_dirty_nights`)).rejects.toThrow(/permission denied/);
      } finally {
        await db.exec(`reset role`);
      }
    });
  });

  describe("pricing_work and pricing_run_done", () => {
    type Work = { dirty: { stay_date: string; mark_seq: number; reasons: string[] }[]; state: Record<string, unknown> | null };
    const work = async (first = today, last = night(29)) =>
      asService(async () => (await q(`select public.pricing_work($1, $2, $3) as w`, [H, first, last]))[0].w as Work);
    const done = async (run: Record<string, unknown>) =>
      asService(async () => (await q(`select public.pricing_run_done($1, $2::jsonb) as r`, [H, JSON.stringify(run)]))[0].r as Record<string, unknown>);
    const mark = (nights: string[], reason = "booking") =>
      db.exec(`select public.pricing_mark_many(array[${nights.map(() => `'${H}'::uuid`).join(",")}], array[${nights.map((n) => `'${n}'::date`).join(",")}], '${reason}')`);

    it("refuses anyone but the service role", async () => {
      await expect(db.query(`select public.pricing_work('${H}', '${today}', '${night(29)}')`)).rejects.toThrow(/Only the scheduled sync/);
      await expect(db.query(`select public.pricing_run_done('${H}', '{}'::jsonb)`)).rejects.toThrow(/Only the scheduled sync/);
    });

    it("clears what the run priced unless it was marked again after the read, and tidies nights outside the window", async () => {
      await clear();
      await mark([night(2), night(5), night(40)]);
      await mark([addDays(today, -1)]);
      const w = await work();
      expect(w.dirty.map((d) => d.stay_date)).toEqual([night(2), night(5)]);
      expect(w.state).toBeNull();
      // Marked again while the run priced.
      await mark([night(5)], "manual_price");
      const r = await done({
        at: new Date().toISOString(),
        first: today,
        last: night(29),
        nights: [night(2), night(5)],
        dirty: w.dirty.map((d) => ({ stay_date: d.stay_date, mark_seq: d.mark_seq })),
        failed: [night(7)],
        again: [night(8)],
        pass: null,
        momentum: [night(2)],
        idle: false,
      });
      expect(r).toMatchObject({ cleared: 1, kept: 1, pass_moved: null });
      expect(await dirty()).toEqual([
        [night(5), ["booking", "manual_price"]],
        [night(7), ["retry"]],
        [night(8), ["follow_up"]],
      ]);
      const s = (await work()).state!;
      expect(s.momentum_nights).toEqual([night(2)]);
      expect(s.last_ok_run_at).not.toBeNull();
    });

    it("starts a pass, moves its cursor only from where it read it (a stale run changes nothing), and ends it", async () => {
      await clear();
      const at = new Date().toISOString();
      const base = { at, first: today, last: night(29), nights: [], dirty: [], failed: [], again: [], momentum: [], idle: false };
      let r = await done({ ...base, pass: { date: today, start: true, from: today, next: night(10), horizon: 30, reason: "first_run", reprice_seq: null } });
      expect(r.pass_moved).toBe(true);
      expect((await work()).state).toMatchObject({ pass_date: today, pass_cursor: night(10), pass_horizon_days: 30, pass_reason: "first_run" });
      // A run that read the cursor at the start, after another moved it.
      r = await done({ ...base, pass: { date: today, start: false, from: today, next: night(10), horizon: 30, reason: null, reprice_seq: null } });
      expect(r.pass_moved).toBe(false);
      r = await done({ ...base, pass: { date: today, start: false, from: night(10), next: night(20), horizon: 30, reason: null, reprice_seq: null } });
      expect(r.pass_moved).toBe(true);
      r = await done({ ...base, pass: { date: today, start: false, from: night(20), next: null, horizon: 30, reason: null, reprice_seq: null } });
      const s = (await work()).state!;
      expect(s.pass_cursor).toBeNull();
      expect(s.pass_completed_at).not.toBeNull();
    });

    it("an idle tick writes its heartbeat, and engine_run_gaps finds the stretches without a run", async () => {
      await db.exec(`delete from public.evaluation_run_log where hotel_id = '${H}'`);
      const runId = "99999999-9999-4999-8999-999999999999";
      await done({ at: "2026-10-01T02:00:00Z", first: today, last: night(29), nights: [], dirty: [], failed: [], again: [], pass: null, momentum: [], idle: true, run_id: runId });
      await db.exec(`insert into public.evaluation_run_log (hotel_id, evaluation_run_id, evaluated_at, cells_checked, cells_changed) values
        ('${H}', gen_random_uuid(), '2026-10-01T01:00:00Z', 5, 0), ('${H}', gen_random_uuid(), '2026-10-01T20:00:00Z', 5, 1)`);
      const heartbeat = await q(`select run_kind, nights_priced, cells_checked from public.evaluation_run_log where evaluation_run_id = '${runId}'`);
      expect(heartbeat).toEqual([{ run_kind: "idle", nights_priced: 0, cells_checked: 0 }]);
      const gaps = await asService(() =>
        q(`select gap_from, gap_to from public.engine_run_gaps($1, '2026-09-30T00:00:00Z', '2026-10-02T00:00:00Z', 43200)`, [H]),
      );
      expect(gaps.map((g) => [new Date(String(g.gap_from)).toISOString(), new Date(String(g.gap_to)).toISOString()])).toEqual([
        ["2026-09-30T00:00:00.000Z", "2026-10-01T01:00:00.000Z"],
        ["2026-10-01T02:00:00.000Z", "2026-10-01T20:00:00.000Z"],
      ]);
      // A member of the hotel may read them too (an evaluation under a signed-in session).
      await db.exec(`select set_config('request.jwt.claim.sub', '${USER}', false); select set_config('request.jwt.claim.role', 'authenticated', false)`);
      try {
        expect(await q(`select count(*)::int as n from public.engine_run_gaps($1, '2026-09-30T00:00:00Z', '2026-10-02T00:00:00Z', 43200)`, [H])).toEqual([{ n: 2 }]);
        await expect(db.query(`select * from public.engine_run_gaps($1, '2026-09-30T00:00:00Z', '2026-10-02T00:00:00Z', 43200)`, [H2])).rejects.toThrow(/Not authorized/);
      } finally {
        await db.exec(`select set_config('request.jwt.claim.sub', '', false); select set_config('request.jwt.claim.role', '', false)`);
      }
    });

    it("request_full_reprice: a manager or the service role asks for a new pass", async () => {
      await clear();
      await asService(() => q(`select public.request_full_reprice($1)`, [H]));
      expect(await repriceSeq()).toBeGreaterThan(0);
    });
  });
});
