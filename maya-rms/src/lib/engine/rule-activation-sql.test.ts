/**
 * 99_supabase_migration_rule_activation_v1.sql run for real in PGlite, twice,
 * on a production-shaped base (every migration before it, the pricing
 * cadence included): the Skip columns, rule_skip_hold, and save_rule, which
 * writes a rule, whether it is on, the owner's Apply or Skip and the Skip's
 * holds (marks on a standard rule's rows, rule_skip_hold rows for a booking
 * speed or pickup rule) in one transaction, checked against the version the
 * popup was worked out on and against who is asking, and marks the nights to
 * price first.
 *
 * Only runs with MAYA_PGLITE_DIR set (see large-property-sql.test.ts):
 *
 *   MAYA_PGLITE_DIR=/path/to/dir npx vitest run src/lib/engine/rule-activation-sql.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_ORDER, PLATFORM, fileSql } from "./pricing-cadence-sql.test";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_rule_activation_v1.sql";
const CADENCE = "99_supabase_migration_pricing_cadence_v1.sql";

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

const H = "11111111-1111-4111-8111-111111111111";
const H2 = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const VIEWER = "33333333-3333-4333-8333-333333333334";
const RT1 = "44444444-4444-4444-8444-444444444441";
const RT2 = "44444444-4444-4444-8444-444444444442";
const FOREIGN_RT = "44444444-4444-4444-8444-444444444449";
const RULE = "55555555-5555-4555-8555-555555555555";
const NEW_RULE = "55555555-5555-4555-8555-555555555556";
const SPEED_RULE = "55555555-5555-4555-8555-555555555557";

const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe("the migration file", () => {
  it("is listed last in the order the SQL tests build production's base in", () => {
    expect(MIGRATION_ORDER[MIGRATION_ORDER.length - 1]).toBe(MIGRATION);
  });

  it("keeps the Skip columns, save_rule and its checks together", () => {
    const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8");
    for (const bit of [
      "add column if not exists skip_at timestamptz",
      "add column if not exists version_ranks jsonb",
      "add column if not exists skip_state text",
      "skip_state in ('held', 'kept', 'carried')",
      "create table if not exists public.rule_skip_hold",
      "create or replace function public.save_rule(",
      "public.can_manage_hotel(p_hotel_id)",
      "rule_changed",
      "pricing_mark_many",
    ]) {
      expect(sql).toContain(bit);
    }
    // No dashes that read as em dashes in what an owner might see.
    expect(sql).not.toMatch(/—/);
  });
});

describe.skipIf(!PGLITE_DIR)("the rule activation migration in PGlite", () => {
  let db: Db;
  const today = new Date().toISOString().slice(0, 10);
  const night = (n: number) => addDays(today, n);
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  /** Run as a signed-in user, the service role (null), or signed out ("anon"). */
  const as = async <T>(user: string | null, fn: () => Promise<T>): Promise<T> => {
    const [sub, role] = user === null ? ["", "service_role"] : user === "anon" ? ["", "anon"] : [user, "authenticated"];
    await db.exec(`select set_config('request.jwt.claim.sub', '${sub}', false), set_config('request.jwt.claim.role', '${role}', false)`);
    try {
      return await fn();
    } finally {
      await db.exec(`select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false)`);
    }
  };
  const save = (args: {
    rule?: string;
    isNew?: boolean;
    expected?: number | null;
    fields?: Record<string, unknown> | null;
    activation: string;
    at?: string;
    touched?: string[];
    marks?: { d: string; rt: string; w: string }[];
    holdNights?: string[];
  }) =>
    q(`select public.save_rule($1, $2, $3, $4, $5::jsonb, $6, $7::timestamptz, $8::date[], $9::jsonb, $10::date[]) as r`, [
      H,
      args.rule ?? RULE,
      args.isNew ?? false,
      args.expected ?? null,
      args.fields === undefined || args.fields === null ? null : JSON.stringify(args.fields),
      args.activation,
      args.at ?? "2026-10-01T14:10:00Z",
      args.touched ?? [],
      JSON.stringify(args.marks ?? []),
      args.holdNights ?? [],
    ]).then((rows) => rows[0].r as Record<string, unknown>);
  /** A rule's holds in rule_skip_hold, read as the engine reads them. */
  const holds = (id: string) =>
    as(null, () =>
      q(
        `select stay_date::text as d, room_type_id as rt, skip_at, was_true from public.rule_skip_hold where rule_id = $1 order by stay_date, room_type_id`,
        [id],
      ),
    );
  const rule = async (id = RULE) => (await q(`select * from public.pricing_rules where id = $1`, [id]))[0];
  /** The rule's product events since the test seeded it. */
  const seeded = new Map<string, number>();
  const events = async (id: string) =>
    (await q(`select event from public.product_events where properties->>'rule_id' = $1 order by id`, [id]))
      .map((r) => r.event)
      .slice(seeded.get(id) ?? 0);
  const newRuleFields = {
    name: "Busy nights",
    priority: 100,
    start_date: null,
    end_date: null,
    is_annual: false,
    dow_mask: 127,
    action_type: "percent",
    action_direction: "increase",
    action_value: 10,
    is_pickup_rule: false,
    undo_on_cancellation: true,
    version: 1,
    condition: { occupancy_operator: "gt", occupancy_threshold: 0.8 },
    signal: [RT1, RT2, FOREIGN_RT],
    affected: [RT1],
    legacy_conditions: [{ metric: "occupancy_percentage", operator: "gt", numeric_value: 80 }],
  };

  beforeAll(async () => {
    const dist = `${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist`;
    const mod = await import(/* @vite-ignore */ pathToFileURL(`${dist}/index.js`).href);
    const { pgcrypto } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/pgcrypto.js`).href);
    const { citext } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/citext.js`).href);
    db = new mod.PGlite({ extensions: { pgcrypto, citext } }) as Db;
    await db.exec(PLATFORM);
    // Production's order: everything before this file, the cadence migration, then this file twice.
    const before = MIGRATION_ORDER.filter((m) => m !== MIGRATION);
    for (const name of ["01_supabase_base_schema.sql", "02_supabase_schema.sql", ...before, CADENCE, MIGRATION, MIGRATION]) {
      try {
        await db.exec(fileSql(name));
      } catch (e) {
        throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await db.exec(`
      select set_config('request.jwt.claim.role', 'service_role', false);
      insert into auth.users (id, email) values ('${OWNER}', 'owner@example.com'), ('${VIEWER}', 'viewer@example.com');
      insert into public.hotels (id, name, timezone) values ('${H}', 'Skip Inn', 'America/New_York'), ('${H2}', 'Other Inn', 'UTC');
      insert into public.hotel_memberships (hotel_id, user_id, role) values ('${H}', '${OWNER}', 'general_manager'), ('${H}', '${VIEWER}', 'viewer');
      insert into public.room_types (id, hotel_id, external_room_type_id, name, total_rooms) values
        ('${RT1}', '${H}', 'K', 'King', 10), ('${RT2}', '${H}', 'Q', 'Queen', 8), ('${FOREIGN_RT}', '${H2}', 'X', 'Elsewhere', 4);
      insert into public.pricing_rules (id, hotel_id, name, action_type, action_direction, action_value, is_active)
        values ('${RULE}', '${H}', 'Busy', 'percent', 'increase', 15, false);
      insert into public.rule_condition (rule_id, occupancy_operator, occupancy_threshold) values ('${RULE}', 'gt', 0.6);
      insert into public.rule_signal_room_type (rule_id, room_type_id) values ('${RULE}', '${RT1}'), ('${RULE}', '${RT2}');
      insert into public.rule_affected_room_type (rule_id, room_type_id) values ('${RULE}', '${RT1}'), ('${RULE}', '${RT2}');
      insert into public.ladder_rule_state (rule_id, rule_version, stay_date, room_type_id, is_active, activated_at, last_evaluated_at, action_kind, action_direction, action_value) values
        ('${RULE}', 1, '${night(3)}', '${RT1}', true, now(), now(), 'percent', 'increase', 15),
        ('${RULE}', 1, '${night(4)}', '${RT1}', true, now(), now(), 'percent', 'increase', 15),
        ('${RULE}', 1, '${night(5)}', '${RT1}', true, now(), now(), 'percent', 'increase', 15),
        ('${RULE}', 1, '${night(6)}', '${RT1}', true, now(), now(), 'percent', 'increase', 15);
      select set_config('request.jwt.claim.role', '', false);
    `);
    seeded.set(RULE, (await events(RULE)).length);
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  it("adds the Skip columns and rule_skip_hold, and a ladder row takes only held, kept or carried", async () => {
    const cols = await q(
      `select table_name as t, column_name as c from information_schema.columns
        where (table_name = 'pricing_rules' and column_name in ('skip_at', 'version_ranks'))
           or (table_name = 'ladder_rule_state' and column_name in ('skip_state', 'skip_at')) order by 1, 2`,
    );
    expect(cols).toEqual([
      { t: "ladder_rule_state", c: "skip_at" },
      { t: "ladder_rule_state", c: "skip_state" },
      { t: "pricing_rules", c: "skip_at" },
      { t: "pricing_rules", c: "version_ranks" },
    ]);
    await expect(db.exec(`update public.ladder_rule_state set skip_state = 'maybe'`)).rejects.toThrow(/skip_state_chk/);
    const holdCols = await q(
      `select column_name as c from information_schema.columns where table_name = 'rule_skip_hold' order by ordinal_position`,
    );
    expect(holdCols.map((x) => x.c)).toEqual(["rule_id", "stay_date", "room_type_id", "skip_at", "was_true"]);
    // Only the engine and save_rule touch it: not a signed-in session, nor anyone signed out.
    for (const role of ["authenticated", "anon"]) {
      await db.exec(`set role ${role}`);
      try {
        await expect(db.query(`select * from public.rule_skip_hold`)).rejects.toThrow(/permission denied/);
      } finally {
        await db.exec(`reset role`);
      }
    }
  });

  it("refuses a viewer, and anyone signed out, before writing anything", async () => {
    await expect(as(VIEWER, () => save({ activation: "apply" }))).rejects.toThrow(/Only a Revenue Manager or above can change this/);
    await expect(as("anon", () => save({ activation: "apply" }))).rejects.toThrow(/Only a Revenue Manager/);
    expect((await rule()).is_active).toBe(false);
  });

  it("switches a rule on with Skip: skip_at, the marks, the nights to price first, one enabled event", async () => {
    const at = "2026-10-01T14:10:00Z";
    const result = await as(OWNER, () =>
      save({
        expected: 1,
        activation: "skip",
        at,
        touched: [night(3), night(8)],
        marks: [
          { d: night(3), rt: RT1, w: "carried" },
          { d: night(4), rt: RT1, w: "kept" },
          { d: night(8), rt: RT2, w: "held" },
        ],
        holdNights: [night(3), night(4), night(8)],
      }),
    );
    expect(result).toMatchObject({ id: RULE, version: 1, is_active: true });
    const r = await rule();
    expect(r.is_active).toBe(true);
    expect(new Date(String(r.skip_at)).toISOString()).toBe(new Date(at).toISOString());
    const rows = await q(
      `select stay_date::text as d, room_type_id as rt, is_active, rule_version as v, action_value::float as a, skip_state, skip_at is not null as stamped
         from public.ladder_rule_state where rule_id = $1 order by stay_date, room_type_id`,
      [RULE],
    );
    expect(rows).toEqual([
      { d: night(3), rt: RT1, is_active: true, v: 1, a: 15, skip_state: "carried", stamped: true },
      { d: night(4), rt: RT1, is_active: true, v: 1, a: 15, skip_state: "kept", stamped: true },
      { d: night(5), rt: RT1, is_active: true, v: 1, a: 15, skip_state: null, stamped: false },
      { d: night(6), rt: RT1, is_active: true, v: 1, a: 15, skip_state: null, stamped: false },
      { d: night(8), rt: RT2, is_active: true, v: 1, a: 15, skip_state: "held", stamped: true },
    ]);
    // A standard rule's holds are its marks: no rule_skip_hold rows (it has no booking speed or pickup changes on).
    expect(await holds(RULE)).toEqual([]);
    const dirty = await as(null, () =>
      q(`select stay_date::text as d, reasons from public.pricing_dirty_nights where hotel_id = $1 order by stay_date`, [H]),
    );
    expect(dirty.filter((x) => (x.reasons as string[]).includes("rule")).map((x) => x.d)).toEqual([night(3), night(8)]);
    expect(await events(RULE)).toEqual(["rule.enabled"]);
  });

  it("an edit saved with Apply: the settings, the next version and no Skip, in one go, and one edited event", async () => {
    const result = await as(OWNER, () =>
      save({
        expected: 1,
        activation: "apply",
        fields: {
          name: "Busy nights",
          action_type: "fixed",
          action_direction: "increase",
          action_value: 12,
          is_pickup_rule: false,
          undo_on_cancellation: false,
          version: 2,
          condition: { occupancy_operator: "gt", occupancy_threshold: 0.7 },
          signal: [RT1],
          affected: [RT1],
        },
      }),
    );
    expect(result).toMatchObject({ version: 2, is_active: true, skip_at: null });
    expect(await rule()).toMatchObject({ name: "Busy nights", action_type: "fixed", version: 2, undo_on_cancellation: false, skip_at: null });
    expect((await q(`select occupancy_threshold::float as t from public.rule_condition where rule_id = $1`, [RULE]))[0].t).toBe(0.7);
    expect((await q(`select room_type_id from public.rule_affected_room_type where rule_id = $1`, [RULE])).map((x) => x.room_type_id)).toEqual([RT1]);
    // Switched on already: an edit is one "edited", not an off-and-on pair
    // (and the undo box, unticked here, says so as it always has).
    expect(await events(RULE)).toEqual(["rule.enabled", "rule.edited", "rule.undo_unticked"]);
  });

  it("refuses a form filled from an older version, and writes nothing", async () => {
    await expect(
      as(OWNER, () => save({ expected: 1, activation: "apply", fields: { name: "Stale", version: 2 } })),
    ).rejects.toThrow(/rule_changed/);
    expect((await rule()).name).toBe("Busy nights");
  });

  it("an empty room type list is refused and the whole save undone", async () => {
    await expect(
      as(OWNER, () =>
        save({ expected: 2, activation: "apply", fields: { name: "Half saved", version: 3, signal: [FOREIGN_RT], affected: [RT1] } }),
      ),
    ).rejects.toThrow(/Pick at least one room type to measure/);
    expect(await rule()).toMatchObject({ name: "Busy nights", version: 2 });
    expect((await q(`select count(*)::int as n from public.rule_signal_room_type where rule_id = $1`, [RULE]))[0].n).toBe(1);
  });

  it("a new rule: saved under the id it was previewed with, only this hotel's room types, the older tables too", async () => {
    const result = await as(OWNER, () => save({ rule: NEW_RULE, isNew: true, activation: "apply", fields: newRuleFields }));
    expect(result).toMatchObject({ id: NEW_RULE, version: 1, is_active: true, skip_at: null });
    expect(await rule(NEW_RULE)).toMatchObject({ name: "Busy nights", is_active: true, created_by: OWNER });
    expect((await q(`select room_type_id from public.rule_signal_room_type where rule_id = $1 order by 1`, [NEW_RULE])).map((x) => x.room_type_id)).toEqual([
      RT1,
      RT2,
    ]);
    expect(await q(`select metric, operator, numeric_value::float as v from public.pricing_rule_conditions where rule_id = $1`, [NEW_RULE])).toEqual([
      { metric: "occupancy_percentage", operator: "gt", v: 80 },
    ]);
    expect((await q(`select count(*)::int as n from public.pricing_rule_room_types where rule_id = $1`, [NEW_RULE]))[0].n).toBe(1);
    expect(await events(NEW_RULE)).toEqual(["rule.created"]);
    // The same id again is a clash, not a second rule.
    await expect(as(OWNER, () => save({ rule: NEW_RULE, isNew: true, activation: "apply", fields: newRuleFields }))).rejects.toThrow(/rule_exists/);
  });

  it("an edit to a rule that is off keeps it off and its Skip as it was", async () => {
    await as(null, () => q(`update public.pricing_rules set is_active = false where id = $1`, [NEW_RULE]));
    const result = await as(OWNER, () =>
      save({ rule: NEW_RULE, expected: 1, activation: "keep", fields: { name: "Busy nights 2", version: 2, action_value: 11 } }),
    );
    expect(result).toMatchObject({ is_active: false, version: 2 });
    expect(await rule(NEW_RULE)).toMatchObject({ is_active: false, name: "Busy nights 2" });
  });

  it("an edit keeps how each earlier version with changes still on the price ranked, and drops the rest; a Skip holds its days", async () => {
    // Surging, on, with two raises of version 1 on the price.
    await as(null, async () => {
      await db.exec(`
        insert into public.pricing_rules (id, hotel_id, name, priority, action_type, action_direction, action_value, is_active, is_pickup_rule)
          values ('${SPEED_RULE}', '${H}', 'Surging', 130, 'percent', 'increase', 25, false, true);
        insert into public.rule_condition (rule_id, booking_speed_operator, booking_speed_level, booking_speed_window_days, booking_speed_cooldown_days)
          values ('${SPEED_RULE}', 'at_least', 'surging', 1, 1);
        insert into public.rule_signal_room_type (rule_id, room_type_id) values ('${SPEED_RULE}', '${RT1}'), ('${SPEED_RULE}', '${RT2}');
        insert into public.rule_affected_room_type (rule_id, room_type_id) values ('${SPEED_RULE}', '${RT2}');
        insert into public.pickup_event (hotel_id, rule_id, rule_version, stay_date, affected_room_type_id, baseline_start_ts, baseline_end_ts,
            signal_booked_units_start, signal_booked_units_end, signal_booked_revenue_start, signal_booked_revenue_end, applied_at,
            action_kind, action_direction, action_value, fire_seq, signal_set_key)
          values
            ('${H}', '${SPEED_RULE}', 1, '${night(2)}', '${RT1}', now(), now(), 0, 3, 0, 300, now(), 'percent', 'increase', 25, 1, '${RT1}'),
            ('${H}', '${SPEED_RULE}', 1, '${night(3)}', '${RT1}', now(), now(), 0, 3, 0, 300, now(), 'percent', 'increase', 25, 1, '${RT1}');
      `);
    });
    const ranks = async () => (await rule(SPEED_RULE)).version_ranks;
    const surging = { booking_speed_operator: "at_least", booking_speed_level: "surging", pickup_operator: null, pickup_threshold: null, pickup_metric: null, occupancy_operator: null, dta_operator: null };
    // Lowered to +10% at least Faster, with Skip: version 1's raises stay, ranked as they were made.
    const at = "2026-10-01T14:10:00Z";
    await as(OWNER, () =>
      save({
        rule: SPEED_RULE,
        expected: 1,
        activation: "skip",
        at,
        holdNights: [night(2), night(9)],
        fields: {
          name: "Surging",
          action_type: "percent",
          action_direction: "increase",
          action_value: 10,
          is_pickup_rule: true,
          undo_on_cancellation: true,
          version: 2,
          condition: { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 1, booking_speed_cooldown_days: 1 },
        },
      }),
    );
    expect(await ranks()).toEqual({ "1": { priority: 130, action_type: "percent", action_direction: "increase", action_value: 25, condition: surging } });
    // Held on each day shown, on every room type it changes and the one its raise is on, not judged yet.
    const stamp = new Date(at).toISOString();
    const held = (list: Record<string, unknown>[]) => list.map((h) => [h.d, h.rt, new Date(String(h.skip_at)).toISOString() === stamp, h.was_true]);
    expect(held(await holds(SPEED_RULE))).toEqual([
      [night(2), RT1, true, null],
      [night(2), RT2, true, null],
      [night(9), RT2, true, null],
    ]);
    // A new name moves no version and keeps them.
    await as(OWNER, () => save({ rule: SPEED_RULE, expected: 2, activation: "keep", fields: { name: "Surging nights" } }));
    expect(await ranks()).toEqual({ "1": { priority: 130, action_type: "percent", action_direction: "increase", action_value: 25, condition: surging } });
    expect(await holds(SPEED_RULE)).toHaveLength(3);
    // Another edit: version 2 has nothing on the price, so only version 1 is kept. Its Skip replaces the holds.
    await as(OWNER, () =>
      save({ rule: SPEED_RULE, expected: 2, activation: "skip", holdNights: [night(3)], fields: { name: "Surging nights", action_value: 12, version: 3 } }),
    );
    expect(await ranks()).toEqual({ "1": { priority: 130, action_type: "percent", action_direction: "increase", action_value: 25, condition: surging } });
    expect((await holds(SPEED_RULE)).map((h) => [h.d, h.rt])).toEqual([
      [night(3), RT1],
      [night(3), RT2],
    ]);
    // Once version 1's raises are off the price, the next edit drops it. Apply ends the holds.
    await as(null, () => q(`update public.pickup_event set retired_at = now(), retired_reason = 'night_passed' where rule_id = $1`, [SPEED_RULE]));
    await as(OWNER, () => save({ rule: SPEED_RULE, expected: 3, activation: "apply", fields: { name: "Surging nights", action_value: 14, version: 4 } }));
    expect(await ranks()).toBeNull();
    expect(await holds(SPEED_RULE)).toEqual([]);
    // A standard rule's edit never writes one.
    expect((await rule()).version_ranks).toBeNull();
    // Off again, so the cap below counts as before.
    await as(null, () => q(`update public.pricing_rules set is_active = false where id = $1`, [SPEED_RULE]));
  });

  it("the 40-rule cap still holds", async () => {
    await as(null, async () => {
      // With the first rule on, 39 more make 40.
      const values = Array.from({ length: 39 }, (_, i) => `('${H}', 'Filler ${i}', 'percent', 'increase', 1, true)`).join(", ");
      await db.exec(`insert into public.pricing_rules (hotel_id, name, action_type, action_direction, action_value, is_active) values ${values}`);
    });
    await expect(as(OWNER, () => save({ rule: NEW_RULE, expected: 2, activation: "apply" }))).rejects.toThrow(/40 active rules/);
    expect((await rule(NEW_RULE)).is_active).toBe(false);
  });
});
