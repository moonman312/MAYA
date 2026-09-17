/**
 * 99_supabase_migration_pickup_event_stacking_v1.sql run for real in PGlite:
 * the backfill of existing fires, the index swap, the checks, the trigger it
 * removes, and the functions and alert tables it adds.
 *
 * Only runs with MAYA_PGLITE_DIR set (see large-property-sql.test.ts).
 *
 *   MAYA_PGLITE_DIR=/path/to/dir npx vitest run src/lib/engine/pickup-stacking-sql.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pickupFireHeads } from "./pickup-stacking-rpc-model.test";
import type { FakeRow } from "./fake-supabase.test";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const MIGRATION = resolve(__dirname, "../../../../99_supabase_migration_pickup_event_stacking_v1.sql");
const GUARDRAILS = resolve(__dirname, "../../../../99_supabase_migration_push_guardrails_v1.sql");

/** One `create or replace function ... $$;` block, lifted straight out of a migration file. */
function functionSql(file: string, name: string): string {
  const sql = readFileSync(file, "utf8");
  const start = sql.indexOf(`create or replace function public.${name}(`);
  const end = sql.indexOf("\n$$;", start);
  if (start < 0 || end < start) throw new Error(`${name} not found in ${file}`);
  return sql.slice(start, end + 4);
}

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

const H1 = "00000000-0000-4000-8000-000000000001";
const H2 = "00000000-0000-4000-8000-000000000002";
const USER = "00000000-0000-4000-8000-0000000000u1".replace("u", "a");
const rt = (n: number) => `00000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`;
const rid = (n: number) => `00000000-0000-4000-8000-0000000003${String(n).padStart(2, "0")}`;
const STD = rt(1);
const SUITE = rt(2);
/** A rule per shape: a pickup raise, a cut, a booking speed rule the trigger demoted, another hotel's. */
const [R_RAISE, R_CUT, R_BS, R_OTHER] = [rid(1), rid(2), rid(3), rid(4)];

/** The schema as it stands before this migration: only what the migration touches. */
const BEFORE = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.user_id', true), '')::uuid
$$;
create table if not exists auth.users (id uuid primary key);
create or replace function public.is_hotel_accessible(target_hotel_id uuid) returns boolean
language sql stable as $$
  select coalesce(current_setting('test.accessible_hotel', true), '') = target_hotel_id::text
$$;
create or replace function public.can_manage_hotel(target_hotel_id uuid) returns boolean
language sql stable as $$
  select coalesce(current_setting('test.manager_hotel', true), '') = target_hotel_id::text
$$;
do $$ begin
  if not exists (select 1 from pg_type where typname = 'pms_type') then
    create type public.pms_type as enum ('mews', 'cloudbeds', 'think');
  end if;
end $$;

create table public.hotels (id uuid primary key);
create table public.room_types (
  id uuid primary key,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  is_active boolean not null default true,
  counts_as_room boolean,
  floor_price numeric(10,2) not null default 1.00,
  ceiling_price numeric(10,2) not null default 99999.99
);
create table public.pricing_rules (
  id uuid primary key,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  is_active boolean not null default true,
  version integer not null default 1,
  is_pickup_rule boolean not null default false,
  action_direction text not null default 'decrease',
  updated_at timestamptz not null default now()
);
create table public.rule_condition (
  rule_id uuid primary key references public.pricing_rules(id) on delete cascade,
  pickup_operator text,
  pickup_threshold numeric(10,2),
  pickup_window_days integer,
  pickup_metric text,
  booking_speed_operator text,
  booking_speed_level text,
  booking_speed_window_days integer,
  booking_speed_cooldown_days integer check (booking_speed_cooldown_days is null or booking_speed_cooldown_days >= 0)
);
create table public.rule_signal_room_type (
  rule_id uuid not null references public.pricing_rules(id) on delete cascade,
  room_type_id uuid not null references public.room_types(id),
  primary key (rule_id, room_type_id)
);
create table public.ladder_rule_state (
  rule_id uuid not null references public.pricing_rules(id) on delete cascade,
  rule_version integer not null,
  stay_date date not null,
  room_type_id uuid not null,
  is_active boolean not null,
  activated_at timestamptz,
  deactivated_at timestamptz,
  last_evaluated_at timestamptz not null default now(),
  suppressed_at timestamptz,
  action_kind text not null,
  action_direction text not null,
  action_value numeric(10,4) not null,
  primary key (rule_id, stay_date, room_type_id)
);
create table public.ladder_transition_event (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  rule_id uuid not null,
  rule_version integer not null,
  stay_date date not null,
  room_type_id uuid not null,
  transition text not null check (transition in ('activate','deactivate')),
  transitioned_at timestamptz not null,
  metrics_snapshot jsonb not null,
  action_kind text not null,
  action_direction text not null,
  action_value numeric(10,4) not null
);
create table public.manual_price (
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  stay_date date not null,
  room_type_id uuid not null references public.room_types(id) on delete cascade,
  price numeric(10,2) not null,
  set_by uuid,
  set_at timestamptz not null default now(),
  cleared_at timestamptz,
  cleared_by uuid,
  note text,
  source text,
  pms_type public.pms_type,
  primary key (hotel_id, stay_date, room_type_id)
);
create table public.pickup_event (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  rule_id uuid not null references public.pricing_rules(id),
  rule_version integer not null,
  stay_date date not null,
  affected_room_type_id uuid not null,
  baseline_start_ts timestamptz not null,
  baseline_end_ts timestamptz not null,
  signal_booked_units_start integer not null,
  signal_booked_units_end integer not null,
  signal_booked_revenue_start numeric(12,2) not null,
  signal_booked_revenue_end numeric(12,2) not null,
  applied_at timestamptz not null,
  retired_at timestamptz,
  action_kind text not null,
  action_direction text not null,
  action_value numeric(10,4) not null
);
create unique index uq_pickup_event_active_per_rule_stay_room
  on public.pickup_event (rule_id, stay_date, affected_room_type_id)
  where retired_at is null;

-- The trigger this migration removes (99_supabase_migration_rules_engine_v1.sql).
create or replace function public.sync_rule_pickup_flag_from_condition()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update pricing_rules
  set is_pickup_rule = (new.pickup_operator is not null),
      updated_at = now()
  where id = new.rule_id;
  return new;
end;
$$;
create trigger trg_rule_condition_sync_pickup
  after insert or update of pickup_operator on public.rule_condition
  for each row execute function public.sync_rule_pickup_flag_from_condition();
`;

const NIGHT = "2026-10-01";
const NIGHT2 = "2026-10-02";

/** Fires as the old engine wrote them: no fire number, no reason, one open per cell. */
function seedSql(): string {
  const fire = (
    id: number,
    over: {
      rule?: string;
      night?: string;
      room?: string;
      applied: string;
      retired?: string | null;
      start?: number;
      end?: number;
      dir?: string;
      version?: number;
      hotel?: string;
    },
  ) =>
    `('${String(id).padStart(8, "0")}-0000-4000-8000-000000000000', '${over.hotel ?? H1}', '${over.rule ?? R_RAISE}', ${over.version ?? 1}, '${over.night ?? NIGHT}', '${over.room ?? STD}', ` +
    `'${over.applied}', '${over.applied}', ${over.start ?? 1}, ${over.end ?? 5}, 100, 500, '${over.applied}', ` +
    `${over.retired === undefined || over.retired === null ? "null" : `'${over.retired}'`}, 'percent', '${over.dir ?? "increase"}', 10)`;
  return `
insert into public.hotels (id) values ('${H1}'), ('${H2}');
insert into auth.users (id) values ('${USER}');
insert into public.room_types (id, hotel_id, is_active, counts_as_room) values
  ('${STD}', '${H1}', true, true),
  ('${SUITE}', '${H1}', false, true);
insert into public.pricing_rules (id, hotel_id, is_pickup_rule, action_direction) values
  ('${R_RAISE}', '${H1}', true, 'increase'),
  ('${R_CUT}', '${H1}', true, 'decrease'),
  ('${R_BS}', '${H1}', false, 'decrease'),
  ('${R_OTHER}', '${H2}', true, 'increase');
insert into public.rule_signal_room_type (rule_id, room_type_id) values
  ('${R_RAISE}', '${STD}'), ('${R_RAISE}', '${SUITE}'), ('${R_CUT}', '${STD}');
insert into public.ladder_rule_state (rule_id, rule_version, stay_date, room_type_id, is_active, activated_at, action_kind, action_direction, action_value) values
  ('${R_BS}', 1, '${NIGHT}', '${STD}', true, now(), 'percent', 'decrease', 7);
insert into public.manual_price (hotel_id, stay_date, room_type_id, price, set_at) values
  ('${H1}', '${NIGHT2}', '${STD}', 150, '2026-09-20T10:00:00Z');
insert into public.pickup_event (
  id, hotel_id, rule_id, rule_version, stay_date, affected_room_type_id,
  baseline_start_ts, baseline_end_ts, signal_booked_units_start, signal_booked_units_end,
  signal_booked_revenue_start, signal_booked_revenue_end, applied_at, retired_at,
  action_kind, action_direction, action_value) values
  -- Three fires of the raise on one cell, oldest first: one open, one the
  -- cancellation check took off, one the same-run bug wrote and took off.
  ${fire(1, { applied: "2026-09-01T10:00:00Z", retired: "2026-09-05T10:00:00Z" })},
  ${fire(2, { applied: "2026-09-10T10:00:00Z", retired: "2026-09-10T10:00:00Z" })},
  ${fire(3, { applied: "2026-09-15T10:00:00Z" })},
  -- A cut with no growth behind it, on the night a price was later set for.
  ${fire(4, { rule: R_CUT, night: NIGHT2, applied: "2026-09-18T10:00:00Z", dir: "decrease", start: 4, end: 4 })},
  -- Retired at exactly the price's set_at: the manual price save did it.
  ${fire(5, { rule: R_RAISE, night: NIGHT2, applied: "2026-09-18T10:00:00Z", retired: "2026-09-20T10:00:00Z" })},
  -- An older version's fire, and another hotel's.
  ${fire(6, { version: 0, night: NIGHT2, applied: "2026-08-01T10:00:00Z", retired: "2026-08-09T10:00:00Z" })},
  ${fire(7, { hotel: H2, rule: R_OTHER, applied: "2026-09-01T10:00:00Z" })};
insert into public.rule_condition (rule_id, pickup_operator, pickup_threshold, pickup_window_days, pickup_metric, booking_speed_cooldown_days) values
  ('${R_RAISE}', 'gt', 1, 3, 'room_nights', null),
  ('${R_CUT}', 'lt', 1, 3, 'room_nights', null);
insert into public.rule_condition (rule_id, booking_speed_operator, booking_speed_level, booking_speed_window_days, booking_speed_cooldown_days) values
  ('${R_BS}', 'at_most', 'slower', 30, 0);
`;
}

describe.skipIf(!PGLITE_DIR)("the pickup event stacking migration in PGlite", () => {
  let db: Db;

  beforeAll(async () => {
    const mod = await import(
      /* @vite-ignore */ pathToFileURL(`${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist/index.js`).href
    );
    db = new mod.PGlite({ parsers: { 1082: (v: string) => v, 1184: (v: string) => v } }) as Db;
    await db.exec("set timezone = 'UTC';");
    await db.exec(BEFORE);
    await db.exec(seedSql());
    // The trigger really did demote the booking speed rule when its condition
    // was inserted, which is why the migration repairs the flags.
    const flags = await db.query(`select is_pickup_rule from public.pricing_rules where id = '${R_BS}'`);
    expect(flags.rows).toEqual([{ is_pickup_rule: false }]);
    await db.exec(readFileSync(MIGRATION, "utf8"));
  }, 120_000);
  afterAll(async () => {
    await db?.close();
  });

  it("numbers every fire per cell in the order they fired, and says why each retired one came off", async () => {
    const rows = await db.query(`
      select left(id::text, 8) as id, fire_seq, retired_reason, cancel_check, signal_set_key
        from public.pickup_event order by rule_id, stay_date, affected_room_type_id, fire_seq
    `);
    expect(rows.rows).toEqual([
      // The raise's three fires on one cell, numbered in the order they fired.
      { id: "00000001", fire_seq: 1, retired_reason: "legacy", cancel_check: "none", signal_set_key: STD },
      { id: "00000002", fire_seq: 2, retired_reason: "self_cancelled", cancel_check: "none", signal_set_key: STD },
      // Still open, and it grew: today's cancellation check still applies.
      { id: "00000003", fire_seq: 3, retired_reason: null, cancel_check: "net_units", signal_set_key: STD },
      { id: "00000006", fire_seq: 1, retired_reason: "legacy", cancel_check: "none", signal_set_key: STD },
      { id: "00000005", fire_seq: 2, retired_reason: "manual_price", cancel_check: "none", signal_set_key: STD },
      { id: "00000004", fire_seq: 1, retired_reason: null, cancel_check: "none", signal_set_key: STD },
      { id: "00000007", fire_seq: 1, retired_reason: null, cancel_check: "none", signal_set_key: "" },
    ]);
  });

  it("changes nothing when it runs again", async () => {
    const before = await db.query(
      `select id, fire_seq, retired_reason, cancel_check, signal_set_key from public.pickup_event order by id`,
    );
    await db.exec(readFileSync(MIGRATION, "utf8"));
    const after = await db.query(
      `select id, fire_seq, retired_reason, cancel_check, signal_set_key from public.pickup_event order by id`,
    );
    expect(after.rows).toEqual(before.rows);
  }, 60_000);

  it("admits several open fires per cell, and only one of each fire number", async () => {
    const indexes = await db.query(
      `select indexname from pg_indexes where tablename = 'pickup_event' order by indexname`,
    );
    expect(indexes.rows.map((r) => r.indexname)).toContain("uq_pickup_event_fire");
    expect(indexes.rows.map((r) => r.indexname)).not.toContain("uq_pickup_event_active_per_rule_stay_room");

    const insert = (seq: number) => `
      insert into public.pickup_event (
        hotel_id, rule_id, rule_version, stay_date, affected_room_type_id,
        baseline_start_ts, baseline_end_ts, signal_booked_units_start, signal_booked_units_end,
        signal_booked_revenue_start, signal_booked_revenue_end, applied_at, action_kind,
        action_direction, action_value, fire_seq, signal_set_key)
      values ('${H1}', '${R_RAISE}', 1, '${NIGHT}', '${STD}', now(), now(), 1, 2, 1, 2, now(), 'percent', 'increase', 10, ${seq}, '${STD}');`;
    // A second open fire on the cell the old index would have refused.
    await db.exec(insert(4));
    expect(
      (await db.query(`select count(*)::int as open from public.pickup_event where rule_id = '${R_RAISE}' and stay_date = '${NIGHT}' and retired_at is null`)).rows,
    ).toEqual([{ open: 2 }]);
    // The same fire number twice is what two overlapping runs would write.
    await expect(db.exec(insert(4))).rejects.toThrow(/uq_pickup_event_fire/);
    await db.exec(`delete from public.pickup_event where fire_seq = 4`);
  });

  it("refuses a retirement with no reason, a cancellation test on a cut, and a window test with no window", async () => {
    await expect(
      db.exec(`update public.pickup_event set retired_at = now() where left(id::text, 8) = '00000003'`),
    ).rejects.toThrow(/pickup_event_retired_reason_set_chk/);
    await expect(
      db.exec(`update public.pickup_event set cancel_check = 'net_units' where left(id::text, 8) = '00000004'`),
    ).rejects.toThrow(/pickup_event_cancel_increase_chk/);
    await expect(
      db.exec(`update public.pickup_event set cancel_check = 'window_bookings' where left(id::text, 8) = '00000003'`),
    ).rejects.toThrow(/pickup_event_window_chk/);
    await expect(
      db.exec(`update public.pickup_event set retired_reason = 'because' , retired_at = now() where left(id::text, 8) = '00000003'`),
    ).rejects.toThrow(/pickup_event_retired_reason_chk/);
  });

  it("makes every booking speed rule wait at least a day", async () => {
    expect(
      (await db.query(`select booking_speed_cooldown_days as days from public.rule_condition where rule_id = '${R_BS}'`)).rows,
    ).toEqual([{ days: 1 }]);
    await expect(
      db.exec(`update public.rule_condition set booking_speed_cooldown_days = 0 where rule_id = '${R_BS}'`),
    ).rejects.toThrow(/rule_condition_bs_cooldown_chk/);
  });

  it("removes the trigger, puts every event rule back, and switches off the ladder rows it held", async () => {
    expect((await db.query(`select tgname from pg_trigger where tgname = 'trg_rule_condition_sync_pickup'`)).rows).toEqual([]);
    expect(
      (await db.query(`select proname from pg_proc where proname = 'sync_rule_pickup_flag_from_condition'`)).rows,
    ).toEqual([]);
    expect(
      (await db.query(`select is_pickup_rule from public.pricing_rules where id = '${R_BS}'`)).rows,
    ).toEqual([{ is_pickup_rule: true }]);
    expect(
      (await db.query(`select is_active, deactivated_at is not null as stamped from public.ladder_rule_state where rule_id = '${R_BS}'`)).rows,
    ).toEqual([{ is_active: false, stamped: true }]);
    expect(
      (await db.query(`select transition, rule_id from public.ladder_transition_event where rule_id = '${R_BS}'`)).rows,
    ).toEqual([{ transition: "deactivate", rule_id: R_BS }]);

    // And a condition written after this can no longer demote a rule.
    await db.exec(`
      insert into public.pricing_rules (id, hotel_id, is_pickup_rule) values ('${rid(9)}', '${H1}', true);
      insert into public.rule_condition (rule_id, booking_speed_operator, booking_speed_level, booking_speed_window_days)
        values ('${rid(9)}', 'at_most', 'slower', 30);
    `);
    expect((await db.query(`select is_pickup_rule from public.pricing_rules where id = '${rid(9)}'`)).rows).toEqual([
      { is_pickup_rule: true },
    ]);
  });

  it("pickup_fire_heads answers what the engine's model does, for members of the hotel only", async () => {
    await db.exec(`set request.jwt.claim.role = 'authenticated'; set test.accessible_hotel = '${H2}';`);
    await expect(
      db.query(`select * from public.pickup_fire_heads('${H1}', array['${R_RAISE}']::uuid[], '2026-09-01', '2026-12-31')`),
    ).rejects.toThrow(/Not authorized/);

    await db.exec(`set test.accessible_hotel = '${H1}';`);
    const sql = await db.query(
      `select * from public.pickup_fire_heads('${H1}', array['${R_RAISE}','${R_CUT}']::uuid[], '2026-09-01', '2026-12-31')
       order by rule_id, stay_date, affected_room_type_id, rule_version`,
    );
    const events = await db.query(`
      select id::text, hotel_id::text as hotel_id, rule_id::text as rule_id, rule_version, stay_date::text as stay_date,
             affected_room_type_id::text as affected_room_type_id, applied_at, fire_seq, retired_at, retired_reason
        from public.pickup_event
    `);
    const model = pickupFireHeads(events.rows as FakeRow[], {
      p_hotel_id: H1,
      p_rule_ids: [R_RAISE, R_CUT],
      p_from: "2026-09-01",
      p_to: "2026-12-31",
    });
    const shape = (r: Record<string, unknown>) => ({
      rule_id: String(r.rule_id),
      stay_date: String(r.stay_date),
      room: String(r.affected_room_type_id),
      version: Number(r.rule_version),
      max: Number(r.max_fire_seq),
      anchor: r.anchor_at == null ? null : new Date(String(r.anchor_at)).toISOString(),
      counted: Number(r.counted_fires),
      last: r.last_counted_at == null ? null : new Date(String(r.last_counted_at)).toISOString(),
    });
    expect(sql.rows.map(shape)).toEqual(model.map(shape));
    // And it really says what the engine needs. On the cell with three fires:
    // the next one is number 4; the wait runs from the open one; and only
    // that one counts toward the owner alert (the bug's row never counts, and
    // the one retired before reasons were kept starts a wait but is not a
    // fire anyone should be told about).
    expect(sql.rows.map(shape)).toContainEqual({
      rule_id: R_RAISE,
      stay_date: NIGHT,
      room: STD,
      version: 1,
      max: 3,
      anchor: "2026-09-15T10:00:00.000Z",
      counted: 1,
      last: "2026-09-15T10:00:00.000Z",
    });
  });

  it("leaves the bug's rows out of a rule's fire count", async () => {
    await db.exec(`set test.accessible_hotel = '${H1}';`);
    const rows = await db.query(`select rule_id::text as rule_id, fires::int as fires from public.rule_fire_counts('${H1}') order by 1`);
    const byRule = Object.fromEntries(rows.rows.map((r) => [r.rule_id, r.fires]));
    // Five fires of the raise, one of them the bug's, and the deactivate the
    // migration wrote for the flipped rule doesn't count (only activations do).
    expect(byRule[R_RAISE]).toBe(4);
    expect(byRule[R_BS]).toBeUndefined();
    expect(byRule[R_CUT]).toBe(1);
  });

  it("a rate changed in the PMS retires the fires on its cells with a reason", async () => {
    await db.exec(`set request.jwt.claim.role = 'service_role';`);
    const out = await db.query(
      `select * from public.set_manual_prices_from_pms('${H1}', 'cloudbeds', '2026-09-25T09:00:00Z',
        '[{"room_type_id": "${STD}", "stay_date": "${NIGHT}", "price": 123.45}]'::jsonb)`,
    );
    expect(out.rows).toEqual([{ cells: 1, suppressed_rules: 0, retired_pickups: 1 }]);
    expect(
      (await db.query(`select retired_reason from public.pickup_event where left(id::text, 8) = '00000003'`)).rows,
    ).toEqual([{ retired_reason: "manual_price" }]);
  });

  it("names the reason on a retirement a price save made without one, and still refuses every other", async () => {
    // What /api/manual-price does between this migration and the app deploy,
    // and what set_manual_prices_from_pms does if a replay of
    // 99_supabase_migration_push_guardrails_v1.sql puts its old body back: the
    // price is written first, then the cell's fires are retired at the same
    // instant with no reason.
    const priceSetAt = "2026-09-20T10:00:00Z";
    await db.exec(`update public.pickup_event set retired_at = '${priceSetAt}' where left(id::text, 8) = '00000004'`);
    expect(
      (await db.query(`select retired_reason from public.pickup_event where left(id::text, 8) = '00000004'`)).rows,
    ).toEqual([{ retired_reason: "manual_price" }]);
    await db.exec(`update public.pickup_event set retired_at = null, retired_reason = null where left(id::text, 8) = '00000004'`);

    // A retirement at any other moment is the old engine's cancellation check,
    // which would wipe fires it can't judge: it still fails.
    await expect(
      db.exec(`update public.pickup_event set retired_at = '2026-09-21T10:00:00Z' where left(id::text, 8) = '00000004'`),
    ).rejects.toThrow(/pickup_event_retired_reason_set_chk/);
    // And so does one on a cell whose price has been cleared.
    await db.exec(`update public.manual_price set cleared_at = now() where stay_date = '${NIGHT2}'`);
    await expect(
      db.exec(`update public.pickup_event set retired_at = '${priceSetAt}' where left(id::text, 8) = '00000004'`),
    ).rejects.toThrow(/pickup_event_retired_reason_set_chk/);
    await db.exec(`update public.manual_price set cleared_at = null where stay_date = '${NIGHT2}'`);
  });

  it("only a rule manager answers an alert, and answering it resolves it", async () => {
    const alert = "00000009-0000-4000-8000-000000000000";
    await db.exec(`
      insert into public.rule_repeat_alerts (id, hotel_id, rule_id, rule_version, action_direction, opened_at)
        values ('${alert}', '${H1}', '${R_CUT}', 1, 'decrease', now());
      insert into public.rule_repeat_alert_nights
        (alert_id, hotel_id, rule_id, rule_version, stay_date, fire_count, reached_at, last_fire_at)
      values
        ('${alert}', '${H1}', '${R_CUT}', 1, '${NIGHT}', 3, now(), now()),
        ('${alert}', '${H1}', '${R_CUT}', 1, '${NIGHT2}', 4, now(), now());
    `);
    // One open alert per rule, and one row per rule, night and version.
    await expect(
      db.exec(`insert into public.rule_repeat_alerts (hotel_id, rule_id, rule_version, action_direction, opened_at)
               values ('${H1}', '${R_CUT}', 1, 'decrease', now())`),
    ).rejects.toThrow(/uq_rule_repeat_alerts_open/);
    await expect(
      db.exec(`insert into public.rule_repeat_alert_nights (alert_id, hotel_id, rule_id, rule_version, stay_date, fire_count, reached_at, last_fire_at)
               values ('${alert}', '${H1}', '${R_CUT}', 1, '${NIGHT}', 3, now(), now())`),
    ).rejects.toThrow(/duplicate key/);

    await db.exec(`set request.jwt.claim.role = 'authenticated'; set test.manager_hotel = '${H2}'; set test.user_id = '${USER}';`);
    await expect(db.query(`select * from public.rule_repeat_alert_choose('${alert}', 'stop')`)).rejects.toThrow(/Not authorized/);
    await expect(db.query(`select * from public.rule_repeat_alert_choose('${alert}', 'whatever')`)).rejects.toThrow(/Unknown choice/);

    await db.exec(`set test.manager_hotel = '${H1}';`);
    // One night at a time, then the rest.
    const first = await db.query(`select stay_date::text as stay_date, choice from public.rule_repeat_alert_choose('${alert}', 'stop', array['${NIGHT}']::date[])`);
    expect(first.rows).toEqual([{ stay_date: NIGHT, choice: "stop" }]);
    expect((await db.query(`select resolved_at from public.rule_repeat_alerts where id = '${alert}'`)).rows).toEqual([
      { resolved_at: null },
    ]);

    const rest = await db.query(`select stay_date::text as stay_date, choice from public.rule_repeat_alert_choose('${alert}', 'keep_adjusting')`);
    expect(rest.rows).toEqual([{ stay_date: NIGHT2, choice: "keep_adjusting" }]);
    expect(
      (await db.query(`select resolution, chosen_by::text as chosen_by from public.rule_repeat_alerts a
                       join public.rule_repeat_alert_nights n on n.alert_id = a.id and n.stay_date = '${NIGHT2}'
                       where a.id = '${alert}'`)).rows,
    ).toEqual([{ resolution: "chosen", chosen_by: USER }]);

    // A night already answered can be answered again by name, and an alert
    // that is resolved stays resolved.
    const again = await db.query(`select choice from public.rule_repeat_alert_choose('${alert}', 'keep_adjusting', array['${NIGHT}']::date[])`);
    expect(again.rows).toEqual([{ choice: "keep_adjusting" }]);
  });

  it("survives a replay of push_guardrails, whose price function now names the reason on its own", async () => {
    // 99_supabase_migration_push_guardrails_v1.sql sorts after this migration,
    // so replaying the 99_ files in filename order restores its
    // set_manual_prices_from_pms last. That body used to retire fires without
    // a reason: with the trigger dropped it raises 23514, no PMS edit is ever
    // adopted, and MAYA goes on sending its own price over the hotel's change.
    // It names the reason itself now, so the replayed body stands alone --
    // the trigger stays for a checkout that still has the old file, and for
    // /api/manual-price in the deploy gap (the test above).
    await db.exec(functionSql(GUARDRAILS, "set_manual_prices_from_pms"));
    await db.exec(`drop trigger trg_pickup_event_manual_price_reason on public.pickup_event;`);
    await db.exec(`set request.jwt.claim.role = 'service_role';`);
    const out = await db.query(
      `select * from public.set_manual_prices_from_pms('${H1}', 'cloudbeds', '2026-09-28T09:00:00Z',
        '[{"room_type_id": "${STD}", "stay_date": "${NIGHT2}", "price": 99.00}]'::jsonb)`,
    );
    expect(out.rows).toEqual([{ cells: 1, suppressed_rules: 0, retired_pickups: 1 }]);
    expect(
      (await db.query(`select retired_reason from public.pickup_event where left(id::text, 8) = '00000004'`)).rows,
    ).toEqual([{ retired_reason: "manual_price" }]);
    await db.exec(`
      create trigger trg_pickup_event_manual_price_reason
        before update on public.pickup_event
        for each row execute function public.pickup_event_manual_price_reason();
    `);
  });

  it("lets a hotel's members read the alerts and nobody signed in write them", async () => {
    const policies = await db.query(
      `select tablename, policyname, cmd from pg_policies where tablename like 'rule_repeat_alert%' order by tablename`,
    );
    expect(policies.rows).toEqual([
      { tablename: "rule_repeat_alert_nights", policyname: "rule_repeat_alert_nights_read", cmd: "SELECT" },
      { tablename: "rule_repeat_alerts", policyname: "rule_repeat_alerts_read", cmd: "SELECT" },
    ]);
    const grants = await db.query(`
      select grantee, table_name, string_agg(privilege_type, ',' order by privilege_type) as privileges
        from information_schema.role_table_grants
       where table_name like 'rule_repeat_alert%' and grantee in ('authenticated', 'service_role', 'anon')
       group by grantee, table_name order by table_name, grantee
    `);
    expect(grants.rows).toEqual([
      { grantee: "authenticated", table_name: "rule_repeat_alert_nights", privileges: "SELECT" },
      { grantee: "service_role", table_name: "rule_repeat_alert_nights", privileges: "DELETE,INSERT,SELECT,UPDATE" },
      { grantee: "authenticated", table_name: "rule_repeat_alerts", privileges: "SELECT" },
      { grantee: "service_role", table_name: "rule_repeat_alerts", privileges: "DELETE,INSERT,SELECT,UPDATE" },
    ]);
  });
});
