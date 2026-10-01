/**
 * 99_supabase_migration_rule_fire_log_v1.sql run for real in PGlite, twice,
 * on top of every migration before it: what counts as a fire (activations
 * and pickup events in the last 90 days, never the same-run bug's rows), the
 * count and the paged log covering exactly the same fires, a page never
 * splitting or repeating the fires of one run, what the log reads beside each
 * fire (prices either side of its run, the numbers it fired on, what ended
 * it), and who may read it.
 * Only runs with MAYA_PGLITE_DIR set (see engine/pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../..");
const MIGRATION = "99_supabase_migration_rule_fire_log_v1.sql";
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

const HOTEL = "11111111-1111-4111-8111-111111111101";
const ELSEWHERE = "11111111-1111-4111-8111-111111111102";
const QUEEN = "55555555-5555-4555-8555-555555555501";
const KING = "55555555-5555-4555-8555-555555555502";
const FAR_ROOM = "55555555-5555-4555-8555-555555555503";
const BUSY = "66666666-6666-4666-8666-666666666601"; // a standard (ladder) rule
const RUSH = "66666666-6666-4666-8666-666666666602"; // a pickup rule
const QUIET = "66666666-6666-4666-8666-666666666603"; // never fired in the window
const FAR_RULE = "66666666-6666-4666-8666-666666666604"; // another property's
const GM = "33333333-3333-4333-8333-333333333301";
const STRANGER = "33333333-3333-4333-8333-333333333302";

const DAY = 86_400_000;
const NOW = Date.now();
/** An instant n days before now, in UTC. */
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
/** A night n days after today's UTC date. */
const night = (days: number) => new Date(NOW + days * DAY).toISOString().slice(0, 10);

/** The run that switched BUSY on across 30 nights at one instant. */
const BIG_RUN = ago(5);
const N1 = night(20);

describe("the migration file", () => {
  const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8");
  const code = sql.replace(/--.*$/gm, "");

  it("is the newest file on the list the SQL tests build production's schema from", () => {
    expect(MIGRATION_ORDER).toContain(MIGRATION);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBeGreaterThan(MIGRATION_ORDER.indexOf("99_supabase_migration_simulation_history_v1.sql"));
  });

  it("is one transaction, keeps row level security on and never grants anon anything", () => {
    expect(code.match(/\bbegin;/g)).toHaveLength(1);
    expect(code.match(/\bcommit;/g)).toHaveLength(1);
    expect(code).not.toMatch(/disable row level security/i);
    expect(code).not.toMatch(/grant[^;]*\banon\b/i);
  });

  it("revokes execute from public and anon on every function it defines", () => {
    const defined = [...code.matchAll(/create or replace function (public\.[a-z_]+)\(/g)].map((m) => m[1]);
    expect(defined.sort()).toEqual(["public.rule_fire_counts", "public.rule_fire_log", "public.rule_fires"]);
    for (const fn of defined) {
      expect(code).toMatch(new RegExp(`revoke all on function ${fn.replace(".", "\\.")}\\([^)]*\\) from public, anon;`));
    }
    const definers = [...code.matchAll(/create or replace function (public\.[a-z_]+)\([\s\S]*?\$\$;/g)]
      .filter((m) => /security definer/.test(m[0]))
      .map((m) => m[1]);
    expect(definers.sort()).toEqual(["public.rule_fire_counts", "public.rule_fire_log"]);
  });
});

type FireRow = {
  kind: string;
  event_id: string;
  sort_key: string;
  fired_at: string;
  stay_date: string;
  room_type_id: string;
  rule_version: number;
  action_kind: string;
  action_direction: string;
  action_value: string;
  fire_seq: number | null;
  metrics: Record<string, unknown> | null;
  own_numbers: Record<string, unknown> | null;
  price_before: string | null;
  price_after: string | null;
  clamped_by: string | null;
  newer_row_at: string | null;
  ended_at: string | null;
  ended_reason: string | null;
  suppressed_at: string | null;
  stopped_at: string | null;
};

describe.skipIf(!PGLITE_DIR)("the rule fire log migration in PGlite", () => {
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

  const counts = async (hotel = HOTEL) =>
    Object.fromEntries(
      (await q(`select rule_id::text as rule_id, fires::int as fires from public.rule_fire_counts($1)`, [hotel])).map((r) => [r.rule_id, r.fires]),
    ) as Record<string, number>;

  const page = async (rule: string, before: { at: string; key: string } | null, limit: number) =>
    (await q(
      `select kind, event_id::text as event_id, sort_key, to_char(fired_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as fired_at,
              stay_date::text as stay_date, room_type_id::text as room_type_id, rule_version, action_kind, action_direction,
              action_value::text as action_value, fire_seq, metrics, own_numbers, price_before::text as price_before,
              price_after::text as price_after, clamped_by, newer_row_at::text as newer_row_at, ended_at::text as ended_at,
              ended_reason, suppressed_at::text as suppressed_at, stopped_at::text as stopped_at
         from public.rule_fire_log($1, $2, $3::timestamptz, $4, $5)`,
      [HOTEL, rule, before?.at ?? null, before?.key ?? null, limit],
    )) as unknown as FireRow[];

  /** Every fire of a rule, page by page as the app reads them. */
  const everything = async (rule: string, limit: number) => {
    const all: FireRow[] = [];
    let before: { at: string; key: string } | null = null;
    for (let i = 0; i < 100; i++) {
      const rows = await page(rule, before, limit);
      all.push(...rows);
      if (rows.length < limit) break;
      const last = rows[rows.length - 1];
      before = { at: last.fired_at, key: last.sort_key };
    }
    return all;
  };

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

    const ladder = (rule: string, at: string, stay: string, room: string, transition = "activate", metrics = "{}") =>
      `('${HOTEL}', '${rule}', 1, '${stay}', '${room}', '${transition}', '${at}', '${metrics}'::jsonb, 'percent', 'increase', 10)`;
    const bigRun = Array.from({ length: 30 }, (_, i) => ladder(BUSY, BIG_RUN, night(30 + i), i % 2 ? KING : QUEEN));

    await db.exec(`
      select set_config('request.jwt.claim.role', 'service_role', false);
      insert into auth.users (id, email) values ('${GM}', 'gm@example.com'), ('${STRANGER}', 'stranger@example.com');
      insert into public.hotels (id, name, timezone) values ('${HOTEL}', 'Juniper', 'America/New_York'), ('${ELSEWHERE}', 'Harbour Inn', 'UTC');
      insert into public.hotel_memberships (hotel_id, user_id, role) values
        ('${HOTEL}', '${GM}', 'general_manager'), ('${ELSEWHERE}', '${STRANGER}', 'general_manager');
      insert into public.room_types (id, hotel_id, external_room_type_id, name, total_rooms) values
        ('${QUEEN}', '${HOTEL}', 'Q', 'Queen', 10), ('${KING}', '${HOTEL}', 'K', 'King', 5), ('${FAR_ROOM}', '${ELSEWHERE}', 'D', 'Double', 8);
      insert into public.pricing_rules (id, hotel_id, name, action_type, action_direction, action_value, is_pickup_rule) values
        ('${BUSY}', '${HOTEL}', 'Busy nights', 'percent', 'increase', 10, false),
        ('${RUSH}', '${HOTEL}', 'Rush', 'fixed', 'increase', 15, true),
        ('${QUIET}', '${HOTEL}', 'Quiet', 'percent', 'decrease', 5, false),
        ('${FAR_RULE}', '${ELSEWHERE}', 'Elsewhere', 'percent', 'increase', 10, false);

      insert into public.ladder_transition_event
        (hotel_id, rule_id, rule_version, stay_date, room_type_id, transition, transitioned_at, metrics_snapshot,
         action_kind, action_direction, action_value)
      values
        -- On N1: on, off again, on again.
        ${ladder(BUSY, ago(3), N1, QUEEN, "activate", '{"occupancy": 0.82, "dta": 20}')},
        ${ladder(BUSY, ago(2), N1, QUEEN, "deactivate")},
        ${ladder(BUSY, ago(1), N1, QUEEN, "activate", '{"occupancy": 0.85, "dta": 18}')},
        -- One run switching the rule on across 30 nights at one instant.
        ${bigRun.join(",\n        ")},
        -- Too old to count, or to list.
        ${ladder(BUSY, ago(91), night(40), QUEEN)},
        ${ladder(QUIET, ago(120), night(41), QUEEN)};
      insert into public.ladder_transition_event
        (hotel_id, rule_id, rule_version, stay_date, room_type_id, transition, transitioned_at, metrics_snapshot,
         action_kind, action_direction, action_value)
      values ('${ELSEWHERE}', '${FAR_RULE}', 1, '${N1}', '${FAR_ROOM}', 'activate', '${ago(1)}', '{}'::jsonb, 'percent', 'increase', 10);

      -- The night's state row, as the last activation left it, with a typed price over it.
      insert into public.ladder_rule_state
        (rule_id, rule_version, stay_date, room_type_id, is_active, activated_at, last_evaluated_at,
         action_kind, action_direction, action_value, suppressed_at)
      values ('${BUSY}', 1, '${N1}', '${QUEEN}', true, '${ago(1)}', '${ago(0.1)}', 'percent', 'increase', 10, '${ago(0.5)}');

      insert into public.pickup_event
        (hotel_id, rule_id, rule_version, stay_date, affected_room_type_id, baseline_start_ts, baseline_end_ts,
         signal_booked_units_start, signal_booked_units_end, signal_booked_revenue_start, signal_booked_revenue_end,
         applied_at, retired_at, retired_reason, action_kind, action_direction, action_value, fire_seq, signal_set_key)
      values
        ('${HOTEL}', '${RUSH}', 1, '${N1}', '${KING}', '${ago(7)}', '${ago(4)}', 3, 9, 300, 900,
         '${ago(4)}', '${ago(0.2)}', 'bookings_cancelled', 'fixed', 'increase', 15, 1, 'k'),
        ('${HOTEL}', '${RUSH}', 1, '${N1}', '${KING}', '${ago(3)}', '${ago(2)}', 9, 12, 900, 1200,
         '${ago(2)}', null, null, 'fixed', 'increase', 15, 2, 'k'),
        -- The same-run bug's row: never a fire.
        ('${HOTEL}', '${RUSH}', 1, '${N1}', '${KING}', '${ago(3)}', '${ago(1.5)}', 9, 12, 900, 1200,
         '${ago(1.5)}', '${ago(1.5)}', 'self_cancelled', 'fixed', 'increase', 15, 3, 'k'),
        -- Too old.
        ('${HOTEL}', '${RUSH}', 1, '${night(42)}', '${KING}', '${ago(99)}', '${ago(95)}', 1, 5, 100, 500,
         '${ago(95)}', null, null, 'fixed', 'increase', 15, 1, 'k');

      -- The run audit rows for N1 Queen: before the first activation, at it, and the next run.
      insert into public.evaluation_audit
        (evaluation_run_id, hotel_id, stay_date, room_type_id, evaluated_at, base_price, floor_price, ceiling_price,
         ladder_subtotal_delta, pickup_subtotal_delta, pre_clamp_price, final_price, details)
      values
        (gen_random_uuid(), '${HOTEL}', '${N1}', '${QUEEN}', '${ago(10)}', 150, 80, 400, 0, 0, 150, 150, '{"application_order": []}'),
        (gen_random_uuid(), '${HOTEL}', '${N1}', '${QUEEN}', '${ago(3)}', 150, 80, 400, 15, 0, 165, 165,
         '{"application_order": ["ladder:${BUSY}"], "clamped_by": "none"}'),
        (gen_random_uuid(), '${HOTEL}', '${N1}', '${QUEEN}', '${ago(2)}', 150, 80, 400, 0, 0, 150, 150, '{"application_order": []}'),
        (gen_random_uuid(), '${HOTEL}', '${N1}', '${QUEEN}', '${ago(1)}', 150, 80, 160, 15, 0, 165, 160,
         '{"application_order": ["ladder:${BUSY}"], "clamped_by": "ceiling"}'),
        (gen_random_uuid(), '${HOTEL}', '${N1}', '${KING}', '${ago(4)}', 200, 80, 400, 0, 15, 215, 215,
         '{"application_order": ["pickup:x"], "pickup_candidates": [
            {"rule_id": "${QUIET}", "outcome": "lost_competition", "metrics": {"occupancy": 0.1}},
            {"rule_id": "${RUSH}", "outcome": "won", "metrics": {"occupancy": 0.6, "dta": 21, "net_pickup_units": 6}}
          ]}');

      -- The owner told the pickup rule to stop on N1, after its first fire.
      insert into public.rule_repeat_alerts (id, hotel_id, rule_id, rule_version, action_direction, opened_at)
      values ('77777777-7777-4777-8777-777777777701', '${HOTEL}', '${RUSH}', 1, 'increase', '${ago(3)}');
      insert into public.rule_repeat_alert_nights
        (alert_id, hotel_id, rule_id, rule_version, stay_date, fire_count, reached_at, last_fire_at, choice, chosen_at, chosen_by)
      values ('77777777-7777-4777-8777-777777777701', '${HOTEL}', '${RUSH}', 1, '${N1}', 3, '${ago(3)}', '${ago(2.5)}',
              'stop', '${ago(2.5)}', '${GM}');
      select set_config('request.jwt.claim.role', '', false);
    `);

    // The file under test, twice: it is safe to run again.
    await db.exec(fileSql(MIGRATION));
    await db.exec(fileSql(MIGRATION));
    // Outside `as`, the reads are the service role's, as the app's server makes them.
    await db.exec(`select set_config('request.jwt.claim.role', 'service_role', false);`);
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  it("counts activations and pickup events of the last 90 days, never the bug's rows", async () => {
    // BUSY: 2 activations on N1 and 30 in the big run; the 91-day-old one is out.
    // RUSH: 2 fires; the self-cancelled row and the 95-day-old one are out.
    expect(await counts()).toEqual({ [BUSY]: 32, [RUSH]: 2 });
    expect(await counts(ELSEWHERE)).toEqual({ [FAR_RULE]: 1 });
  });

  it("lists exactly the fires it counts, page by page, whatever the page size", async () => {
    const want = await counts();
    for (const limit of [1, 7, 25, 101]) {
      const busy = await everything(BUSY, limit);
      expect(busy).toHaveLength(want[BUSY]);
      expect(new Set(busy.map((f) => f.event_id)).size).toBe(busy.length);
      const rush = await everything(RUSH, limit);
      expect(rush).toHaveLength(want[RUSH]);
    }
    expect(await everything(QUIET, 25)).toEqual([]);
  });

  it("orders newest first, and a run's fires by night and room type, never split or repeated across pages", async () => {
    const busy = await everything(BUSY, 7);
    const order = busy.map((f) => `${f.fired_at}|${f.sort_key}`);
    const sorted = [...order].sort((a, b) => {
      const [ta, ...ka] = a.split("|");
      const [tb, ...kb] = b.split("|");
      return ta === tb ? (ka.join("|") < kb.join("|") ? -1 : 1) : ta < tb ? 1 : -1;
    });
    expect(order).toEqual(sorted);
    const run = busy.filter((f) => Date.parse(f.fired_at) === Date.parse(BIG_RUN));
    expect(run).toHaveLength(30);
    expect(run.map((f) => f.stay_date)).toEqual([...run.map((f) => f.stay_date)].sort());
  });

  it("reads a ladder fire's prices either side of its run, its numbers, and what ended it", async () => {
    const [newest, older] = (await page(BUSY, null, 2)) as FireRow[];
    expect(Date.parse(newest.fired_at)).toBe(Date.parse(ago(1)));
    expect(newest).toMatchObject({
      kind: "ladder",
      stay_date: N1,
      room_type_id: QUEEN,
      rule_version: 1,
      action_kind: "percent",
      action_direction: "increase",
      price_before: "150.00",
      price_after: "160.00",
      clamped_by: "ceiling",
      newer_row_at: null,
      ended_at: null,
      ended_reason: null,
      metrics: { occupancy: 0.85, dta: 18 },
      own_numbers: null,
    });
    // A typed price took over the night's current activation.
    expect(newest.suppressed_at).not.toBeNull();

    expect(Date.parse(older.fired_at)).toBe(Date.parse(ago(3)));
    expect(older).toMatchObject({ price_before: "150.00", price_after: "165.00", ended_reason: "came_off", suppressed_at: null });
    expect(Date.parse(String(older.ended_at))).toBe(Date.parse(ago(2)));
    // A later run wrote the night again, so this run's price is not the night's latest.
    expect(Date.parse(String(older.newer_row_at))).toBe(Date.parse(ago(2)));
  });

  it("reads a pickup fire's numbers off its run's audit row, with its own as a fallback", async () => {
    const [second, first] = await page(RUSH, null, 25);
    expect(first).toMatchObject({
      kind: "pickup",
      fire_seq: 1,
      action_kind: "fixed",
      price_before: null,
      price_after: "215.00",
      metrics: { occupancy: 0.6, dta: 21, net_pickup_units: 6 },
      own_numbers: { units_start: 3, units_end: 9, window_bookings: null, window_expected: null },
      ended_reason: "bookings_cancelled",
    });
    // The owner's stop came after the first fire, and before the second.
    expect(first.stopped_at).not.toBeNull();
    // No audit row for the second fire's run: no prices, no metrics, its own numbers only.
    expect(second).toMatchObject({ fire_seq: 2, metrics: null, price_after: null, ended_at: null, stopped_at: null });
    expect(second.own_numbers).toMatchObject({ units_start: 9, units_end: 12 });
  });

  it("lets the property's own people read it, and nobody else", async () => {
    await as(GM, async () => {
      expect((await page(BUSY, null, 3)).length).toBe(3);
      expect(await counts()).toEqual({ [BUSY]: 32, [RUSH]: 2 });
      await expect(q(`select * from public.rule_fire_counts($1)`, [ELSEWHERE])).rejects.toThrow(/Not authorized/);
    });
    await as(STRANGER, async () => {
      await expect(page(BUSY, null, 3)).rejects.toThrow(/Not authorized/);
      await expect(q(`select * from public.rule_fire_counts($1)`, [HOTEL])).rejects.toThrow(/Not authorized/);
      // Called directly, the shared definition answers only what RLS lets them read.
      expect(await q(`select * from public.rule_fires($1)`, [HOTEL])).toEqual([]);
    });
    await as(null, async () => {
      await expect(q(`select * from public.rule_fire_log($1, $2)`, [HOTEL, BUSY])).rejects.toThrow(/permission denied/);
      await expect(q(`select * from public.rule_fire_counts($1)`, [HOTEL])).rejects.toThrow(/permission denied/);
      await expect(q(`select * from public.rule_fires($1)`, [HOTEL])).rejects.toThrow(/permission denied/);
    });
  });

  it("runs a third time without changing an answer", async () => {
    const before = { counts: await counts(), page: await page(BUSY, null, 5) };
    await db.exec(fileSql(MIGRATION));
    expect(await counts()).toEqual(before.counts);
    expect(await page(BUSY, null, 5)).toEqual(before.page);
  });
});
