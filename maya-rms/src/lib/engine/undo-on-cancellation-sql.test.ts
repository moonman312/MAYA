/**
 * 99_supabase_migration_undo_on_cancellation_v1.sql run for real in PGlite,
 * after the two migrations it follows
 * (99_supabase_migration_booking_speed_counts_bookings_v1.sql and
 * 99_supabase_migration_pickup_wait_v1.sql), twice, and replayed with them
 * in either order: the box on every rule, what pickup_event takes, the open
 * changes it converts, engine_booked_before against the model the engine's
 * tests run on (undo-rpc-model.test.ts), and the three-changes alert
 * counting changes still on the price. Also its deploy list.
 *
 * The PGlite part only runs with MAYA_PGLITE_DIR set (see
 * large-property-sql.test.ts).
 *
 *   MAYA_PGLITE_DIR=/path/to/dir npx vitest run src/lib/engine/undo-on-cancellation-sql.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeRow } from "./fake-supabase.test";
import { COUNTS_BOOKINGS_MIGRATION, insertReservations, openPglite, uuidFor, type Db } from "./large-property-sql.test";
import { engineBookedBefore } from "./undo-rpc-model.test";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = resolve(ROOT, "99_supabase_migration_undo_on_cancellation_v1.sql");
const PICKUP_WAIT = resolve(ROOT, "99_supabase_migration_pickup_wait_v1.sql");
const FUNCTIONS = resolve(__dirname, "../../../supabase/functions");

const H1 = uuidFor("h1");
const H2 = uuidFor("h2");
const RT1 = uuidFor("rt1");
const R1 = uuidFor("rule-1");
const R2 = uuidFor("rule-2");
const USER = "00000000-0000-4000-8000-00000000aaaa";

/**
 * What the migrations before this one leave, as far as it reads or changes
 * it, on top of openPglite's stubs (large property and counts-bookings
 * already run): the rule tables, the stacking columns on pickup_event, the
 * alert tables with the reasons they took, hotels, and auth.uid() and
 * can_manage_hotel() from settings.
 */
const BEFORE = `
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create or replace function public.can_manage_hotel(target_hotel_id uuid) returns boolean
language sql stable as $$
  select coalesce(current_setting('test.accessible_hotel', true), '') = target_hotel_id::text
$$;
create table public.hotels (id uuid primary key, timezone text);
insert into public.hotels (id, timezone) values ('${H1}', 'UTC'), ('${H2}', 'America/New_York');
create table public.pricing_rules (
  id uuid primary key,
  hotel_id uuid not null references public.hotels(id),
  name text not null,
  version integer not null default 1,
  action_direction text not null default 'increase'
);
create table public.rule_condition (
  rule_id uuid primary key references public.pricing_rules(id) on delete cascade,
  pickup_operator text check (pickup_operator in ('gt','lt')),
  pickup_threshold numeric(10,2),
  pickup_window_days integer check (pickup_window_days in (1,3,7)),
  pickup_metric text check (pickup_metric in ('room_nights','revenue'))
);
insert into public.pricing_rules (id, hotel_id, name) values ('${R1}', '${H1}', 'Quick pickup'), ('${R2}', '${H1}', 'Busy night');
insert into public.rule_condition values ('${R1}', 'gt', 5, 7, 'room_nights');
alter table public.pickup_event
  add column rule_version integer not null default 1,
  add column stay_date date,
  add column affected_room_type_id uuid,
  add column fire_seq integer not null default 1,
  add column signal_set_key text not null default '';
create table public.rule_repeat_alerts (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  rule_id uuid not null,
  rule_version integer not null,
  action_direction text not null,
  opened_at timestamptz not null,
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text
);
create table public.rule_repeat_alert_nights (
  alert_id uuid not null references public.rule_repeat_alerts(id) on delete cascade,
  hotel_id uuid not null,
  rule_id uuid not null,
  rule_version integer not null,
  stay_date date not null,
  fire_count integer not null,
  reached_at timestamptz not null,
  last_fire_at timestamptz not null,
  choice text,
  chosen_at timestamptz,
  chosen_by uuid,
  resumed_at timestamptz,
  resumed_by uuid,
  closed_at timestamptz,
  closed_reason text,
  updated_at timestamptz not null default now(),
  primary key (alert_id, stay_date),
  constraint rule_repeat_alert_nights_closed_reason_chk
    check (closed_reason is null or closed_reason in ('night_passed', 'rule_edited', 'price_set', 'resumed'))
);
`;

/** Open and retired changes as the engines before this file wrote them. */
function seedFires(): string {
  const row = (
    n: number,
    o: {
      check: string;
      dir?: "increase" | "decrease";
      window?: boolean;
      retired?: string;
      rule?: string;
      night?: string;
      rt?: string;
      at?: string;
    },
  ) =>
    `('${String(n).padStart(8, "0")}-0000-4000-8000-000000000000', '${H1}', '${o.rule ?? R1}', 1, '${o.night ?? "2026-10-20"}', ` +
    `'${o.rt ?? RT1}', ${n}, '${o.at ?? "2026-09-20T10:00:00Z"}', ` +
    `${o.retired ? `'2026-09-21T10:00:00Z', '${o.retired}'` : "null, null"}, '${o.dir ?? "increase"}', '${o.check}', ` +
    `${o.window ? "'2026-09-14', '2026-09-20', 6, 2" : "null, null, null, null"}, '${RT1}')`;
  return `insert into public.pickup_event
    (id, hotel_id, rule_id, rule_version, stay_date, affected_room_type_id, fire_seq, applied_at,
     retired_at, retired_reason, action_direction, cancel_check,
     window_from, window_to, window_bookings_at_fire, window_expected_at_fire, signal_set_key) values
    ${row(1, { check: "window_bookings", window: true })},
    ${row(2, { check: "either", window: true })},
    ${row(3, { check: "net_units" })},
    ${row(4, { check: "none" })},
    ${row(5, { check: "none", dir: "decrease" })},
    ${row(6, { check: "none", window: true })},
    ${row(7, { check: "net_units", window: true })},
    ${row(8, { check: "none", dir: "decrease", window: true })},
    ${row(9, { check: "window_bookings", window: true, retired: "bookings_cancelled" })},
    ${row(10, { check: "none", retired: "manual_price" })};`;
}

const checks = async (db: Db) =>
  (
    await db.query(`select left(id::text, 8) as id, cancel_check, retired_reason, window_bookings_at_fire
                      from public.pickup_event order by id`)
  ).rows.map((r) => [r.id, r.cancel_check, r.retired_reason ?? null, r.window_bookings_at_fire ?? null]);

describe.skipIf(!PGLITE_DIR)("the undo on cancellation migration in PGlite, after counts-bookings and the pickup wait", () => {
  let db: Db;
  beforeAll(async () => {
    db = await openPglite();
    await db.exec(BEFORE);
    await db.exec(readFileSync(PICKUP_WAIT, "utf8"));
    await db.exec(seedFires());
    await db.exec(readFileSync(MIGRATION, "utf8"));
  }, 120_000);
  afterAll(async () => {
    await db?.close();
  });

  it("ticks every rule, and a new rule starts ticked", async () => {
    expect((await db.query(`select name, undo_on_cancellation from public.pricing_rules order by name`)).rows).toEqual([
      { name: "Busy night", undo_on_cancellation: true },
      { name: "Quick pickup", undo_on_cancellation: true },
    ]);
    await db.exec(`insert into public.pricing_rules (id, hotel_id, name) values ('${uuidFor("rule-3")}', '${H1}', 'Fresh')`);
    expect((await db.query(`select undo_on_cancellation from public.pricing_rules where name = 'Fresh'`)).rows).toEqual([
      { undo_on_cancellation: true },
    ]);
    await expect(db.exec(`update public.pricing_rules set undo_on_cancellation = null where name = 'Fresh'`)).rejects.toThrow();
  });

  it("converts the open changes whose numbers can all be recounted, and leaves the rest and every retired row alone", async () => {
    expect(await checks(db)).toEqual([
      // Trusted by the old window test: counted in bookings.
      ["00000001", "recount", null, 6],
      ["00000002", "recount", null, 6],
      // No booking speed window at all: nothing depends on the unit.
      ["00000003", "recount", null, null],
      ["00000004", "recount", null, null],
      ["00000005", "recount", null, null],
      // A window that may be in rooms: its pace part is kept as it was.
      ["00000006", "none", null, 6],
      ["00000007", "net_units", null, 6],
      ["00000008", "none", null, 6],
      // Retired rows are history.
      ["00000009", "window_bookings", "bookings_cancelled", 6],
      ["00000010", "none", "manual_price", null],
    ]);
  });

  it("takes 'recount' on a raise or a cut and arrivals of 0 or more, and refuses anything else", async () => {
    const insert = (id: string, check: string, dir: string, units: string, revenue: string) =>
      db.exec(`insert into public.pickup_event
        (id, hotel_id, rule_id, stay_date, affected_room_type_id, fire_seq, applied_at, action_direction, cancel_check,
         pickup_units_arrived_at_fire, pickup_revenue_arrived_at_fire)
        values ('${id}', '${H1}', '${R1}', '2026-10-21', '${RT1}', 1, now(), '${dir}', '${check}', ${units}, ${revenue})`);
    await insert(uuidFor("ok-raise"), "recount", "increase", "4", "400.50");
    await insert(uuidFor("ok-cut"), "recount", "decrease", "null", "null");
    await insert(uuidFor("ok-zero"), "recount", "increase", "0", "0");
    await expect(insert(uuidFor("bad-units"), "recount", "increase", "-1", "null")).rejects.toThrow(/pickup_event_arrivals_chk/);
    await expect(insert(uuidFor("bad-rev"), "recount", "increase", "null", "-0.01")).rejects.toThrow(/pickup_event_arrivals_chk/);
    await expect(insert(uuidFor("bad-check"), "sometimes", "increase", "null", "null")).rejects.toThrow(/pickup_event_cancel_check_chk/);
    await expect(insert(uuidFor("bad-cut"), "net_units", "decrease", "null", "null")).rejects.toThrow(/pickup_event_cancel_increase_chk/);
    await db.exec(`delete from public.pickup_event where stay_date = '2026-10-21'`);
  });

  it("files an alert night closed for cancellations", async () => {
    const alert = uuidFor("alert-closed");
    await db.exec(`insert into public.rule_repeat_alerts (id, hotel_id, rule_id, rule_version, action_direction, opened_at)
      values ('${alert}', '${H1}', '${R1}', 1, 'increase', now())`);
    await db.exec(`insert into public.rule_repeat_alert_nights
      (alert_id, hotel_id, rule_id, rule_version, stay_date, fire_count, reached_at, last_fire_at, closed_at, closed_reason)
      values ('${alert}', '${H1}', '${R1}', 1, '2026-10-22', 3, now(), now(), now(), 'bookings_cancelled')`);
    await expect(
      db.exec(`update public.rule_repeat_alert_nights set closed_reason = 'bored' where alert_id = '${alert}'`),
    ).rejects.toThrow(/rule_repeat_alert_nights_closed_reason_chk/);
  });

  it("replays cleanly, twice, and in either order with the files before it, keeping an owner's unticked box", async () => {
    await db.exec(`update public.pricing_rules set undo_on_cancellation = false where name = 'Busy night'`);
    await db.exec(readFileSync(MIGRATION, "utf8"));
    await db.exec(readFileSync(MIGRATION, "utf8"));
    await db.exec(readFileSync(COUNTS_BOOKINGS_MIGRATION, "utf8"));
    await db.exec(readFileSync(PICKUP_WAIT, "utf8"));
    await db.exec(readFileSync(MIGRATION, "utf8"));
    expect((await db.query(`select name, undo_on_cancellation from public.pricing_rules order by name`)).rows).toEqual([
      { name: "Busy night", undo_on_cancellation: false },
      { name: "Fresh", undo_on_cancellation: true },
      { name: "Quick pickup", undo_on_cancellation: true },
    ]);
    expect((await checks(db)).map((c) => c[1])).toEqual([
      "recount", "recount", "recount", "recount", "recount", "none", "net_units", "none", "window_bookings", "none",
    ]);
    const named = await db.query(`select conname from pg_constraint
      where conrelid = 'public.pickup_event'::regclass
        and conname in ('pickup_event_arrivals_chk', 'pickup_event_cancel_check_chk', 'pickup_event_cancel_increase_chk')
      order by conname`);
    expect(named.rows).toEqual([
      { conname: "pickup_event_arrivals_chk" },
      { conname: "pickup_event_cancel_check_chk" },
      { conname: "pickup_event_cancel_increase_chk" },
    ]);
    const fns = await db.query(`select p.proname, pg_get_function_identity_arguments(p.oid) as args
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('engine_booked_before', 'pickup_fire_heads', 'rule_repeat_alert_resume_many', 'booking_speed_windows', 'audit_rows_before')
       order by 1`);
    expect(fns.rows).toEqual([
      { proname: "audit_rows_before", args: "p_hotel_id uuid, p_before timestamp with time zone, p_stay_dates date[], p_room_type_ids uuid[]" },
      {
        proname: "booking_speed_windows",
        args: "p_hotel_id uuid, p_dates date[], p_exclude uuid[], p_include uuid[], p_since timestamp with time zone[]",
      },
      { proname: "engine_booked_before", args: "p_hotel_id uuid, p_stay_dates date[], p_at timestamp with time zone[]" },
      { proname: "pickup_fire_heads", args: "p_hotel_id uuid, p_rule_ids uuid[], p_from date, p_to date" },
      { proname: "rule_repeat_alert_resume_many", args: "p_alert_ids uuid[], p_stay_dates date[]" },
    ]);
    // The pickup wait file's column is still there, still empty.
    expect((await db.query(`select pickup_cooldown_days from public.rule_condition`)).rows).toEqual([{ pickup_cooldown_days: null }]);
  });
});

describe.skipIf(!PGLITE_DIR)("engine_booked_before in PGlite", () => {
  let db: Db;
  const rows: FakeRow[] = [];
  beforeAll(async () => {
    db = await openPglite();
    await db.exec(BEFORE);
    await db.exec(readFileSync(PICKUP_WAIT, "utf8"));
    await db.exec(readFileSync(MIGRATION, "utf8"));
    // 12 nights, two room types and a row with none, two hotels, rows first
    // seen over a month at odd minutes, some rates missing.
    let seed = 11;
    const r = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 900; i++) {
      const night = `2026-10-${String(1 + Math.floor(r() * 12)).padStart(2, "0")}`;
      const seen = new Date(Date.parse("2026-09-01T00:00:00Z") + Math.floor(r() * 30 * 1440) * 60_000).toISOString();
      const u = r();
      rows.push({
        id: `res-${i}`,
        hotel_id: r() < 0.1 ? "h2" : "h1",
        room_type_id: u < 0.05 ? null : u < 0.55 ? "rt1" : "rt2",
        stay_date: night,
        booking_date: seen.slice(0, 10),
        booking_window_days: 20,
        current_rate: r() < 0.1 ? null : Math.round(80 + r() * 9000) / 100,
        base_rate: 100,
        created_at: seen,
        external_reservation_id: `${1000 + i}-1`,
      });
    }
    await insertReservations(db, rows);
  }, 120_000);
  afterAll(async () => {
    await db?.close();
  });

  const asTables = (): FakeRow[] =>
    rows.map((x) => ({
      ...x,
      hotel_id: uuidFor(String(x.hotel_id)),
      room_type_id: x.room_type_id == null ? null : uuidFor(String(x.room_type_id)),
    }));
  const call = (hotel: string, dates: string[], ats: string[]) =>
    db.query(`select * from public.engine_booked_before($1::uuid, $2::date[], $3::timestamptz[])`, [hotel, dates, ats]);
  const plain = (list: Record<string, unknown>[]) =>
    list.map((x) => ({
      stay_date: String(x.stay_date).slice(0, 10),
      as_of: new Date(Date.parse(String(x.as_of))).toISOString(),
      room_type_id: String(x.room_type_id),
      units: Number(x.units),
      revenue: Number(x.revenue),
    }));

  it("gives each (night, instant) pair its rows first seen by then, per room type, as the model does", async () => {
    await db.exec("select set_config('request.jwt.claim.role', 'service_role', false);");
    const dates: string[] = [];
    const ats: string[] = [];
    for (let d = 1; d <= 13; d++) {
      for (const at of ["2026-08-31T00:00:00Z", "2026-09-10T08:30:00Z", "2026-09-20T23:59:00Z", "2026-10-05T00:00:00Z"]) {
        dates.push(`2026-10-${String(d).padStart(2, "0")}`);
        ats.push(at);
      }
    }
    // Asked twice, and spelt two ways: one answer per pair.
    dates.push("2026-10-01");
    ats.push("2026-09-10T08:30:00.000+00:00");
    const sql = await call(H1, dates, ats);
    const model = engineBookedBefore(asTables(), { p_hotel_id: H1, p_stay_dates: dates, p_at: ats });
    expect(plain(sql.rows)).toEqual(plain(model));
    expect(sql.rows.length).toBeGreaterThan(40);
    // Nothing is first seen before the month: those pairs have no rows.
    expect(sql.rows.some((x) => String(x.as_of).startsWith("2026-08-31"))).toBe(false);
    // At an instant after every row, a night's units are its booked rooms.
    const all = sql.rows.filter((x) => String(x.stay_date).startsWith("2026-10-03") && String(x.as_of).startsWith("2026-10-05"));
    const booked = asTables().filter((x) => x.hotel_id === H1 && x.stay_date === "2026-10-03" && x.room_type_id != null).length;
    expect(all.reduce((s, x) => s + Number(x.units), 0)).toBe(booked);
  });

  it("refuses a caller who is neither the service role nor a member of the hotel, and arrays that don't pair up", async () => {
    await db.exec("select set_config('request.jwt.claim.role', 'authenticated', false);");
    await db.exec("select set_config('test.accessible_hotel', '', false);");
    await expect(call(H1, ["2026-10-01"], ["2026-09-20T00:00:00Z"])).rejects.toMatchObject({ code: "42501" });
    await db.exec(`select set_config('test.accessible_hotel', '${H1}', false);`);
    expect((await call(H1, ["2026-10-01"], ["2026-09-20T00:00:00Z"])).rows.length).toBeGreaterThan(0);
    await expect(call(H1, ["2026-10-01", "2026-10-02"], ["2026-09-20T00:00:00Z"])).rejects.toMatchObject({ code: "22023" });
    await db.exec("select set_config('test.accessible_hotel', '', false);");
    await db.exec("select set_config('request.jwt.claim.role', 'service_role', false);");
  });

  it("reads one night at a time through the hotel and night index", async () => {
    await db.exec("set enable_seqscan = off;");
    const plan = await db.query(`explain
      select r.room_type_id, count(*) from public.reservations r
       where r.hotel_id = '${H1}' and r.stay_date = '2026-10-01' and r.created_at <= now() and r.room_type_id is not null
       group by r.room_type_id`);
    await db.exec("set enable_seqscan = on;");
    expect(plan.rows.map((x) => String(Object.values(x)[0])).join("\n")).toMatch(/idx_reservations_hotel_stay_date/);
  });
});

describe.skipIf(!PGLITE_DIR)("the three-changes alert counts changes still on the price, in PGlite", () => {
  let db: Db;
  const ALERT = uuidFor("alert-resume");
  beforeAll(async () => {
    db = await openPglite();
    await db.exec(BEFORE);
    await db.exec(readFileSync(PICKUP_WAIT, "utf8"));
    await db.exec(readFileSync(MIGRATION, "utf8"));
    await db.exec("select set_config('request.jwt.claim.role', 'service_role', false);");
    // Four changes by the rule on one night and room type: two still on the
    // price, one taken off for cancellations, one by a passed night.
    const fire = (n: number, at: string, retired: string | null) =>
      `('${uuidFor(`f${n}`)}', '${H1}', '${R1}', 1, '2026-10-20', '${RT1}', ${n}, '${at}', ` +
      `${retired ? `'2026-09-25T00:00:00Z', '${retired}'` : "null, null"}, 'increase', 'recount', '${RT1}')`;
    await db.exec(`insert into public.pickup_event
      (id, hotel_id, rule_id, rule_version, stay_date, affected_room_type_id, fire_seq, applied_at,
       retired_at, retired_reason, action_direction, cancel_check, signal_set_key) values
      ${fire(1, "2026-09-20T10:00:00Z", null)},
      ${fire(2, "2026-09-21T10:00:00Z", null)},
      ${fire(3, "2026-09-22T10:00:00Z", "bookings_cancelled")},
      ${fire(4, "2026-09-19T10:00:00Z", "night_passed")};`);
    await db.exec(`insert into public.rule_repeat_alerts (id, hotel_id, rule_id, rule_version, action_direction, opened_at, resolved_at, resolution)
      values ('${ALERT}', '${H1}', '${R1}', 1, 'increase', now(), now(), 'chosen')`);
    await db.exec(`insert into public.rule_repeat_alert_nights
      (alert_id, hotel_id, rule_id, rule_version, stay_date, fire_count, reached_at, last_fire_at, choice, chosen_at)
      values ('${ALERT}', '${H1}', '${R1}', 1, '2026-10-20', 3, now(), now(), 'stop', now())`);
  }, 120_000);
  afterAll(async () => {
    await db?.close();
  });

  it("pickup_fire_heads counts the open changes, while the wait still runs from the one that came off", async () => {
    const heads = await db.query(`select * from public.pickup_fire_heads($1::uuid, $2::uuid[], $3::date, $4::date)`, [
      H1,
      [R1],
      "2026-10-01",
      "2026-10-31",
    ]);
    expect(
      heads.rows.map((h) => ({
        max: h.max_fire_seq,
        anchor: new Date(Date.parse(String(h.anchor_at))).toISOString(),
        counted: h.counted_fires,
        last: new Date(Date.parse(String(h.last_counted_at))).toISOString(),
      })),
    ).toEqual([{ max: 4, anchor: "2026-09-22T10:00:00.000Z", counted: 2, last: "2026-09-21T10:00:00.000Z" }]);
  });

  it("a resumed night's fire_count is the changes still on the price", async () => {
    await db.exec(`select set_config('request.jwt.claim.sub', '${USER}', false);`);
    const out = await db.query(`select * from public.rule_repeat_alert_resume_many($1::uuid[], null)`, [[ALERT]]);
    expect(out.rows.map((n) => [n.fire_count, n.closed_reason, n.choice])).toEqual([[2, "resumed", null]]);
  });
});

/** Every file an edge function's bundle pulls in, following relative imports. */
function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [normalize(entry)];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    seen.add(file);
    for (const m of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      stack.push(normalize(join(dirname(file), m[1])));
    }
  }
  return seen;
}

describe("the undo on cancellation migration's deploy list", () => {
  it("names every function whose bundle carries the engine or starter rule code this build changed", () => {
    const source = readFileSync(MIGRATION, "utf8");
    const header = source.slice(0, source.indexOf("\nbegin;"));
    const changed = [
      "_shared/engine/pickup.ts",
      "_shared/engine/evaluate.ts",
      "_shared/engine/conditions.ts",
      "_shared/engine/ladder.ts",
      "_shared/engine/snapshots.ts",
      "_shared/engine/repeat-alerts.ts",
      "_shared/engine/booking-speed-provider.ts",
      "_shared/onboarding/generate-rules.ts",
    ];
    const carries = readdirSync(FUNCTIONS, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "_shared")
      .map((d) => d.name)
      .filter((name) => {
        const closure = [...importClosure(join(FUNCTIONS, name, "index.ts"))];
        return changed.some((c) => closure.some((f) => f.endsWith(c)));
      });
    expect(carries.sort()).toEqual([
      "cloudbeds-scheduled-sync",
      "mews-scheduled-sync",
      "onboarding-import-worker",
      "think-scheduled-sync",
    ]);
    for (const name of carries) expect(header).toContain(name);
  });
});
