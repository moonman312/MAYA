/**
 * 99_supabase_migration_pricing_watchdog_v1.sql run for real in PGlite,
 * twice, on top of every migration before it: the failed-run counter, and
 * the watchdog pg_cron runs every 10 minutes: which hotels it watches, when
 * one is behind or its daily pass is late, the line it posts through pg_net
 * to the webhook in Vault, the once-per-6-hours dedupe, the recovery line,
 * and its silence while the sync's own alert for the hotel is out. pg_net
 * and Vault are stand-ins here (a table each); the clock is the function's
 * p_now. Only runs with MAYA_PGLITE_DIR set (see pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_pricing_watchdog_v1.sql";

const CADENCE_TEST = readFileSync(resolve(__dirname, "../engine/pricing-cadence-sql.test.ts"), "utf8");

const MIGRATION_ORDER: string[] = (() => {
  const list = CADENCE_TEST.slice(CADENCE_TEST.indexOf("MIGRATION_ORDER = ["), CADENCE_TEST.indexOf("];", CADENCE_TEST.indexOf("MIGRATION_ORDER = [")));
  return [...list.matchAll(/"(99_supabase_migration_[^"]+\.sql)"/g)].map((m) => m[1]);
})();

/** What Supabase provides and the files assume, read off the cadence test so there is one copy. */
const PLATFORM: string = (() => {
  const start = CADENCE_TEST.indexOf("export const PLATFORM = `") + "export const PLATFORM = `".length;
  return CADENCE_TEST.slice(start, CADENCE_TEST.indexOf("`;", start));
})();

/**
 * Stand-ins for pg_net and Vault: net.http_post records what it was asked to
 * send (and refuses when told to), vault.decrypted_secrets is a table.
 */
const STAND_INS = `
create schema if not exists net;
create table net.zz_calls (
  id bigserial primary key,
  url text,
  body jsonb,
  headers jsonb,
  timeout_milliseconds integer,
  called_at timestamptz not null default now()
);
create table net.zz_refuse (reason text);
create or replace function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint language plpgsql as $$
declare v_id bigint; v_reason text;
begin
  select reason into v_reason from net.zz_refuse limit 1;
  if v_reason is not null then raise exception '%', v_reason; end if;
  insert into net.zz_calls (url, body, headers, timeout_milliseconds)
  values (url, body, headers, timeout_milliseconds) returning id into v_id;
  return v_id;
end $$;
create table vault.decrypted_secrets (name text, decrypted_secret text, created_at timestamptz default now());
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

const LIVE = "00000000-0000-4000-8000-00000000a001";
const SIM = "00000000-0000-4000-8000-00000000a002";
const TEST = "00000000-0000-4000-8000-00000000a003";
const LAPSED = "00000000-0000-4000-8000-00000000a004";
const PENDING = "00000000-0000-4000-8000-00000000a005";
const NOSUB = "00000000-0000-4000-8000-00000000a006";
const ODDTZ = "00000000-0000-4000-8000-00000000a007";

/** 03:00 UTC on a Wednesday: three hours into a UTC hotel's day, 22:00 the evening before in Chicago. */
const NOW = "2026-09-30T03:00:00Z";
const MIN = 60_000;
const at = (minutesFromNow: number, base = NOW) => new Date(Date.parse(base) + minutesFromNow * MIN).toISOString();
const WEBHOOK = "https://hooks.example.test/services/T0/B0/x";

describe("the migration file", () => {
  it("is on the list the SQL tests build production's schema from, after the cadence file whose function it restates", () => {
    expect(MIGRATION_ORDER).toContain(MIGRATION);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBeGreaterThan(MIGRATION_ORDER.indexOf("99_supabase_migration_pricing_cadence_v1.sql"));
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBeGreaterThan(MIGRATION_ORDER.indexOf("99_supabase_migration_definer_lockdown_v1.sql"));
  });

  it("is one transaction, keeps pricing_run_done's signature, and changes no policy", () => {
    const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8").replace(/--.*$/gm, "");
    expect(sql.match(/\bbegin;/g)).toHaveLength(1);
    expect(sql.match(/\bcommit;/g)).toHaveLength(1);
    expect(sql).not.toMatch(/create policy|drop policy|create table/i);
    expect(sql).toMatch(/create or replace function public\.pricing_run_done\(p_hotel_id uuid, p_run jsonb\)/);
    expect(sql).toMatch(/grant execute on function public\.pricing_run_done\(uuid, jsonb\) to service_role/);
  });

  it("restates pricing_run_done as the cadence file wrote it, apart from the failed_runs line", () => {
    const strip = (s: string) => s.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();
    const fnOf = (sql: string) => {
      const start = sql.indexOf("create or replace function public.pricing_run_done(");
      const end = sql.indexOf("grant execute on function public.pricing_run_done", start);
      return strip(sql.slice(start, end));
    };
    const before = fnOf(readFileSync(resolve(ROOT, "99_supabase_migration_pricing_cadence_v1.sql"), "utf8"));
    const after = fnOf(readFileSync(resolve(ROOT, MIGRATION), "utf8"));
    const added = "failed_runs = case when coalesce((p_run->>'idle')::boolean, false) then s.failed_runs else 0 end,";
    expect(after).toContain(added);
    expect(after.replace(` ${added}`, "")).toBe(before);
  });
});

describe.skipIf(!PGLITE_DIR)("the pricing watchdog in PGlite", () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const asRole = (role: string | null) => db.query(`select set_config('request.jwt.claim.role', $1, false)`, [role ?? ""]);

  type Row = {
    hotel_id: string;
    name: string;
    mode: string;
    severity: string;
    behind: boolean;
    pass_late: boolean;
    last_run_at: Date | string | null;
    minutes_since_run: number | null;
    pass_date: string | null;
    pass_finished: boolean;
    hours_into_day: string | number;
    failed_runs: number;
    reads_failing: number;
    last_read_at: Date | string | null;
    alert_key: string;
    action: string;
    detail: string | null;
  };
  const watchdog = async (opts: { post?: boolean; min?: string; now?: string } = {}) =>
    ((await q(`select * from public.pricing_watchdog($1, $2, $3::timestamptz)`, [opts.post ?? true, opts.min ?? "critical", opts.now ?? NOW])) as unknown as Row[]).map((r) => ({
      ...r,
      // PGlite hands a date column back as a Date.
      pass_date: r.pass_date == null ? null : new Date(r.pass_date).toISOString().slice(0, 10),
    }));
  const rowOf = (rows: Row[], hotel: string) => rows.find((r) => r.hotel_id === hotel)!;
  /** What was posted, for one hotel or all (the clock moves in these tests, so other hotels go stale too and post their own lines). */
  const calls = async (hotel?: string) =>
    (await q(`select url, body, timeout_milliseconds from net.zz_calls where $1::text is null or body->>'hotelId' = $1 order by id`, [hotel ?? null])) as {
      url: string;
      body: Record<string, unknown>;
      timeout_milliseconds: number;
    }[];
  const events = async (type: string, key?: string) =>
    q(`select entity_id, hotel_id, detail, created_at from public.platform_audit_events where event_type = $1 and ($2::text is null or entity_id = $2) order by created_at, id`, [type, key ?? null]);
  const setWebhook = async (url: string | null) => {
    await db.exec(`delete from vault.decrypted_secrets`);
    if (url != null) await db.query(`insert into vault.decrypted_secrets (name, decrypted_secret) values ('maya_alert_webhook', $1)`, [url]);
  };
  const setState = (hotel: string, s: Partial<{ last_ok_run_at: string | null; pass_date: string | null; pass_started_at: string | null; pass_completed_at: string | null; failed_runs: number; last_error: string | null }>) =>
    db.query(
      `insert into public.hotel_pricing_state (hotel_id, last_ok_run_at, pass_date, pass_started_at, pass_completed_at, failed_runs, last_error)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (hotel_id) do update set last_ok_run_at = excluded.last_ok_run_at, pass_date = excluded.pass_date,
         pass_started_at = excluded.pass_started_at, pass_completed_at = excluded.pass_completed_at,
         failed_runs = excluded.failed_runs, last_error = excluded.last_error`,
      [hotel, s.last_ok_run_at ?? null, s.pass_date ?? null, s.pass_started_at ?? null, s.pass_completed_at ?? null, s.failed_runs ?? 0, s.last_error ?? null],
    );
  /** A hotel that is fine: a run five minutes ago, today's pass finished an hour ago. */
  const fine = (hotel: string) => setState(hotel, { last_ok_run_at: at(-5), pass_date: "2026-09-30", pass_started_at: at(-170), pass_completed_at: at(-60) });
  const runLog = (hotel: string, evaluatedAt: string, kind: string | null = "nights") =>
    db.query(`insert into public.evaluation_run_log (hotel_id, evaluation_run_id, evaluated_at, run_kind) values ($1, gen_random_uuid(), $2, $3)`, [hotel, evaluatedAt, kind]);
  const reset = async () => {
    await db.exec(`
      delete from net.zz_calls; delete from net.zz_refuse;
      delete from public.platform_audit_events;
      delete from public.evaluation_run_log;
      update public.pms_connections set sync_failures = 0, last_sync_at = '${at(-10)}';
    `);
    for (const h of [LIVE, SIM, TEST, LAPSED, PENDING, NOSUB, ODDTZ]) await fine(h);
    await setWebhook(WEBHOOK);
  };

  beforeAll(async () => {
    const dist = `${PGLITE_DIR}/node_modules/@electric-sql/pglite/dist`;
    const mod = await import(/* @vite-ignore */ pathToFileURL(`${dist}/index.js`).href);
    const { pgcrypto } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/pgcrypto.js`).href);
    const { citext } = await import(/* @vite-ignore */ pathToFileURL(`${dist}/contrib/citext.js`).href);
    db = new mod.PGlite({ extensions: { pgcrypto, citext } }) as Db;
    await db.exec(PLATFORM);
    // The cadence file last before this one: the table and the function this file builds on.
    const before = [...MIGRATION_ORDER.slice(0, MIGRATION_ORDER.indexOf(MIGRATION)), "99_supabase_migration_pricing_cadence_v1.sql"];
    for (const name of ["01_supabase_base_schema.sql", "02_supabase_schema.sql", ...before]) {
      try {
        await db.exec(fileSql(name));
      } catch (e) {
        throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await db.exec(fileSql(MIGRATION));
    await db.exec(fileSql(MIGRATION));
    await db.exec(STAND_INS);
    await asRole("service_role");
    await db.exec(`
      insert into public.hotels (id, name, timezone, created_at) values
        ('${LIVE}', 'Live Inn', 'UTC', '${at(-3 * 24 * 60)}'),
        ('${SIM}', 'Sim Inn', 'UTC', '${at(-3 * 24 * 60)}'),
        ('${TEST}', 'MAYA Sandbox', 'UTC', '${at(-3 * 24 * 60)}'),
        ('${LAPSED}', 'Lapsed Inn', 'UTC', '${at(-3 * 24 * 60)}'),
        ('${PENDING}', 'Pending Inn', 'UTC', '${at(-3 * 24 * 60)}'),
        ('${NOSUB}', 'Handmade Inn', 'America/Chicago', '${at(-3 * 24 * 60)}'),
        ('${ODDTZ}', 'Odd Zone Inn', 'Mars/Olympus', '${at(-3 * 24 * 60)}');
      update public.hotels set is_test = true where id = '${TEST}';
      insert into public.hotel_settings (hotel_id, simulation_mode) values
        ('${LIVE}', false), ('${SIM}', true), ('${TEST}', false), ('${LAPSED}', false), ('${PENDING}', false), ('${NOSUB}', false), ('${ODDTZ}', false);
      update public.hotel_settings set live_since = '${at(-3 * 24 * 60)}';
      insert into public.hotel_subscriptions (hotel_id, stripe_customer_id, stripe_subscription_id, status, billing_interval, billed_rooms) values
        ('${LIVE}', 'cus_live', 'sub_live', 'active', 'month', 20),
        ('${SIM}', 'cus_sim', 'sub_sim', 'trialing', 'month', 20),
        ('${TEST}', 'cus_test', 'sub_test', 'active', 'month', 20),
        ('${LAPSED}', 'cus_lapsed', 'sub_lapsed', 'canceled', 'month', 20),
        ('${PENDING}', 'cus_pending', 'sub_pending', 'active', 'month', 20),
        ('${ODDTZ}', 'cus_odd', 'sub_odd', 'past_due', 'month', 20);
      insert into public.pms_connections (hotel_id, pms_type, status) values
        ('${LIVE}', 'cloudbeds', 'connected'),
        ('${SIM}', 'cloudbeds', 'connected'),
        ('${TEST}', 'cloudbeds', 'connected'),
        ('${LAPSED}', 'cloudbeds', 'connected'),
        ('${PENDING}', 'cloudbeds', 'pending'),
        ('${NOSUB}', 'cloudbeds', 'degraded'),
        ('${ODDTZ}', 'think', 'error');
    `);
    await reset();
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await asRole("service_role");
    await reset();
  });

  describe("failed runs in a row", () => {
    it("pricing_run_failed counts them and says how many; a run that priced nights ends the streak, an idle tick does not", async () => {
      const failed = async (err = "boom") => Number((await q(`select public.pricing_run_failed($1, $2) as n`, [LIVE, err]))[0].n);
      expect(await failed()).toBe(1);
      expect(await failed("Failed to load typed prices: timeout")).toBe(2);
      expect(await failed()).toBe(3);
      const [s] = await q(`select failed_runs, last_error, last_failed_at from public.hotel_pricing_state where hotel_id = $1`, [LIVE]);
      expect(s).toMatchObject({ failed_runs: 3, last_error: "boom" });
      expect(s.last_failed_at).not.toBeNull();

      const done = (idle: boolean) =>
        db.query(`select public.pricing_run_done($1, $2::jsonb)`, [
          LIVE,
          JSON.stringify({ at: at(1), first: "2026-09-30", last: "2026-10-29", nights: idle ? [] : ["2026-10-01"], dirty: [], failed: [], again: [], pass: null, momentum: [], idle, run_id: "00000000-0000-4000-8000-0000000000aa" }),
        ]);
      await done(true);
      expect((await q(`select failed_runs from public.hotel_pricing_state where hotel_id = $1`, [LIVE]))[0].failed_runs).toBe(3);
      await done(false);
      expect((await q(`select failed_runs from public.hotel_pricing_state where hotel_id = $1`, [LIVE]))[0].failed_runs).toBe(0);
    });

    it("keeps a long error to 300 characters and makes the state row when there is none", async () => {
      await db.query(`delete from public.hotel_pricing_state where hotel_id = $1`, [SIM]);
      expect(Number((await q(`select public.pricing_run_failed($1, $2) as n`, [SIM, "x".repeat(1000)]))[0].n)).toBe(1);
      const [s] = await q(`select length(last_error) as len, failed_runs from public.hotel_pricing_state where hotel_id = $1`, [SIM]);
      expect(s).toEqual({ len: 300, failed_runs: 1 });
      expect(Number((await q(`select public.pricing_run_failed($1, $2) as n`, ["00000000-0000-4000-8000-0000000000ff", "no such hotel"]))[0].n)).toBe(0);
    });

    it("is the scheduled sync's alone", async () => {
      await asRole("authenticated");
      await expect(q(`select public.pricing_run_failed($1, $2)`, [LIVE, "x"])).rejects.toThrow(/Only the scheduled sync/);
      const [g] = await q(`
        select has_function_privilege('anon', 'public.pricing_run_failed(uuid, text)', 'execute') as anon,
               has_function_privilege('authenticated', 'public.pricing_run_failed(uuid, text)', 'execute') as authenticated,
               has_function_privilege('service_role', 'public.pricing_run_failed(uuid, text)', 'execute') as service_role`);
      expect(g).toEqual({ anon: false, authenticated: false, service_role: true });
    });
  });

  describe("which hotels are watched", () => {
    it("live and simulating, entitled or with no subscription row, not test, not lapsed, not a pending connection", async () => {
      const rows = await watchdog({ post: false });
      expect(rows.map((r) => [r.name, r.mode, r.severity])).toEqual([
        ["Handmade Inn", "live", "critical"],
        ["Live Inn", "live", "critical"],
        ["Odd Zone Inn", "live", "critical"],
        ["Sim Inn", "simulation", "warn"],
      ]);
      expect(rows.every((r) => r.action === "ok" && !r.behind && !r.pass_late)).toBe(true);
      expect(rows.every((r) => r.alert_key === `pricing-watchdog:${r.hotel_id}`)).toBe(true);
    });

    it("counts hours into the hotel's own day, and an unknown time zone as UTC", async () => {
      const rows = await watchdog({ post: false });
      expect(Number(rowOf(rows, LIVE).hours_into_day)).toBe(3);
      expect(Number(rowOf(rows, NOSUB).hours_into_day)).toBe(22);
      expect(Number(rowOf(rows, ODDTZ).hours_into_day)).toBe(3);
    });
  });

  describe("behind", () => {
    it("is no run finished for 30 minutes, by the newer of the state row and the run log", async () => {
      await setState(LIVE, { last_ok_run_at: at(-29), pass_date: "2026-09-30", pass_completed_at: at(-20) });
      expect(rowOf(await watchdog({ post: false }), LIVE)).toMatchObject({ behind: false, minutes_since_run: 29 });
      await setState(LIVE, { last_ok_run_at: at(-31), pass_date: "2026-09-30", pass_completed_at: at(-31) });
      expect(rowOf(await watchdog({ post: false }), LIVE)).toMatchObject({ behind: true, minutes_since_run: 31, action: "dry_run" });
      expect(rowOf(await watchdog({ post: false }), LIVE).detail).toContain("No pricing run has finished for 31 minutes (the last at 2026-09-30 02:29Z).");
      // A run the log has that the state row does not (the record failed).
      await runLog(LIVE, at(-4));
      expect(rowOf(await watchdog({ post: false }), LIVE)).toMatchObject({ behind: false, minutes_since_run: 4 });
    });

    it("a hotel that never ran counts from when it went live, or was created", async () => {
      await db.query(`delete from public.hotel_pricing_state where hotel_id = any($1::uuid[])`, [[LIVE, SIM]]);
      await db.query(`update public.hotel_settings set live_since = $1 where hotel_id = $2`, [at(-10), LIVE]);
      let rows = await watchdog({ post: false });
      expect(rowOf(rows, LIVE)).toMatchObject({ behind: false, pass_late: false, last_run_at: null, minutes_since_run: null });
      // Simulating: from the hotel's creation, three days ago.
      expect(rowOf(rows, SIM)).toMatchObject({ behind: true, pass_late: true });
      expect(rowOf(rows, SIM).detail).toContain("No pricing run has ever finished for this hotel.");
      expect(rowOf(rows, SIM).detail).toContain("no pass has ever run");
      await db.query(`update public.hotel_settings set live_since = $1 where hotel_id = $2`, [at(-31), LIVE]);
      rows = await watchdog({ post: false });
      expect(rowOf(rows, LIVE)).toMatchObject({ behind: true, pass_late: false });
    });
  });

  describe("the daily pass", () => {
    it("is late when it has not finished 2 hours into the hotel day: not started today, or running for 2 hours", async () => {
      // 03:00: yesterday's pass, finished, is the one on record.
      await setState(LIVE, { last_ok_run_at: at(-5), pass_date: "2026-09-29", pass_started_at: at(-27 * 60), pass_completed_at: at(-26 * 60) });
      let r = rowOf(await watchdog({ post: false }), LIVE);
      expect(r).toMatchObject({ behind: false, pass_late: true, pass_finished: false, action: "dry_run" });
      expect(r.detail).toBe("Today's pass (2026-09-30) has not finished, 3.00 hours into the hotel day; the last pass on record is for 2026-09-29.");
      // 01:00: the same state is not late yet.
      r = rowOf(await watchdog({ post: false, now: "2026-09-30T01:00:00Z" }), LIVE);
      expect(r).toMatchObject({ pass_late: false, action: "ok", detail: null });
      // Today's pass running since 00:10: late at 03:00, not at 02:00.
      await setState(LIVE, { last_ok_run_at: at(-5), pass_date: "2026-09-30", pass_started_at: "2026-09-30T00:10:00Z", pass_completed_at: null });
      r = rowOf(await watchdog({ post: false }), LIVE);
      expect(r).toMatchObject({ pass_late: true });
      expect(r.detail).toBe("Today's pass (2026-09-30) has not finished, 3.00 hours into the hotel day; it started at 2026-09-30 00:10Z.");
      expect(rowOf(await watchdog({ post: false, now: "2026-09-30T02:00:00Z" }), LIVE)).toMatchObject({ pass_late: false });
      // An owner's edit started a new pass at 02:45: not late at 03:00.
      await setState(LIVE, { last_ok_run_at: at(-5), pass_date: "2026-09-30", pass_started_at: at(-15), pass_completed_at: null });
      expect(rowOf(await watchdog({ post: false }), LIVE)).toMatchObject({ pass_late: false });
      // Finished today.
      await setState(LIVE, { last_ok_run_at: at(-5), pass_date: "2026-09-30", pass_started_at: at(-170), pass_completed_at: at(-100) });
      expect(rowOf(await watchdog({ post: false }), LIVE)).toMatchObject({ pass_late: false, pass_finished: true });
    });

    it("goes by the hotel's day: 22:00 in Chicago with today's pass done is fine, with yesterday's pass on record is late", async () => {
      await setState(NOSUB, { last_ok_run_at: at(-5), pass_date: "2026-09-29", pass_started_at: at(-22 * 60), pass_completed_at: at(-21 * 60) });
      expect(rowOf(await watchdog({ post: false }), NOSUB)).toMatchObject({ pass_late: false, pass_finished: true, pass_date: "2026-09-29" });
      await setState(NOSUB, { last_ok_run_at: at(-5), pass_date: "2026-09-28", pass_started_at: at(-46 * 60), pass_completed_at: at(-45 * 60) });
      expect(rowOf(await watchdog({ post: false }), NOSUB)).toMatchObject({ pass_late: true });
    });
  });

  describe("the line to the channel", () => {
    it("posts once per hotel per 6 hours, through pg_net to the webhook in Vault, and records the alert the way the functions do", async () => {
      await setState(LIVE, { last_ok_run_at: at(-45), pass_date: "2026-09-29", pass_completed_at: at(-20 * 60), failed_runs: 3, last_error: "Failed to load typed prices: timeout" });
      await db.query(`update public.pms_connections set sync_failures = 4, last_sync_at = $1 where hotel_id = $2`, [at(-50), LIVE]);
      const first = await watchdog();
      expect(rowOf(first, LIVE)).toMatchObject({ behind: true, pass_late: true, failed_runs: 3, reads_failing: 4, action: "alerted" });
      expect(first.filter((r) => r.hotel_id !== LIVE).every((r) => r.action === "ok")).toBe(true);

      const sent = await calls(LIVE);
      expect(sent).toHaveLength(1);
      expect(await calls()).toHaveLength(1);
      expect(sent[0].url).toBe(WEBHOOK);
      expect(sent[0].timeout_milliseconds).toBe(8000);
      expect(sent[0].body).toMatchObject({ severity: "critical", key: `pricing-watchdog:${LIVE}`, hotelId: LIVE });
      const text = String(sent[0].body.text);
      expect(text).toContain("🔴 *MAYA critical* — Pricing is behind and today's pass is late for Live Inn");
      expect(text).toContain("> No pricing run has finished for 45 minutes (the last at 2026-09-30 02:15Z). Today's pass (2026-09-30) has not finished, 3.00 hours into the hotel day; the last pass on record is for 2026-09-29. The last 3 runs failed in a row: Failed to load typed prices: timeout. Reads from cloudbeds have failed 4 times in a row; the last good read was 50 minutes ago.");
      expect(text).toContain(`> hotel \`${LIVE}\``);

      const raised = await events("alert.raised");
      expect(raised).toHaveLength(1);
      expect(raised[0]).toMatchObject({ entity_id: `pricing-watchdog:${LIVE}`, hotel_id: LIVE, detail: { severity: "critical", source: "pricing_watchdog" } });
      expect(new Date(String(raised[0].created_at)).toISOString()).toBe(NOW.replace("Z", ".000Z"));

      // Ten minutes on, still stuck: nothing more. Six hours on: told again.
      expect(rowOf(await watchdog({ now: at(10) }), LIVE)).toMatchObject({ action: "deduped" });
      expect(rowOf(await watchdog({ now: at(5 * 60 + 59) }), LIVE)).toMatchObject({ action: "deduped" });
      expect(await calls(LIVE)).toHaveLength(1);
      expect(rowOf(await watchdog({ now: at(6 * 60 + 1) }), LIVE)).toMatchObject({ action: "alerted" });
      expect(await calls(LIVE)).toHaveLength(2);
      expect(await events("alert.raised", `pricing-watchdog:${LIVE}`)).toHaveLength(2);
    });

    it("says one recovery line when the hotel is fine again, and nothing after that", async () => {
      await setState(LIVE, { last_ok_run_at: at(-45), pass_date: "2026-09-30", pass_completed_at: at(-45) });
      expect(rowOf(await watchdog(), LIVE)).toMatchObject({ action: "alerted" });
      await setState(LIVE, { last_ok_run_at: at(20), pass_date: "2026-09-30", pass_completed_at: at(20) });
      const rows = await watchdog({ now: at(25) });
      expect(rowOf(rows, LIVE)).toMatchObject({ behind: false, action: "recovered" });
      const sent = await calls(LIVE);
      expect(sent).toHaveLength(2);
      expect(sent[1].body).toMatchObject({ severity: "recovered", key: `pricing-watchdog:${LIVE}`, hotelId: LIVE });
      expect(String(sent[1].body.text)).toContain("🟢 *MAYA recovered* — Pricing is running again for Live Inn");
      expect(String(sent[1].body.text)).toContain("> A pricing run finished at 2026-09-30 03:20Z. Today's pass has finished.");
      const recovered = await events("alert.recovered");
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({ entity_id: `pricing-watchdog:${LIVE}`, hotel_id: LIVE });
      expect(rowOf(await watchdog({ now: at(35) }), LIVE)).toMatchObject({ action: "ok" });
      expect(await calls(LIVE)).toHaveLength(2);
      // Stuck again later: a new line, since the last one was recovered.
      await setState(LIVE, { last_ok_run_at: at(20), pass_date: "2026-09-30", pass_completed_at: at(20) });
      expect(rowOf(await watchdog({ now: at(60) }), LIVE)).toMatchObject({ behind: true, action: "alerted" });
      expect(await calls(LIVE)).toHaveLength(3);
    });

    it("a hotel that was never told about says nothing when it is fine", async () => {
      await setState(LIVE, { last_ok_run_at: at(-45), pass_date: "2026-09-30", pass_completed_at: at(-45) });
      expect(rowOf(await watchdog({ post: false }), LIVE)).toMatchObject({ action: "dry_run" });
      await fine(LIVE);
      expect(rowOf(await watchdog(), LIVE)).toMatchObject({ action: "ok" });
      expect(await calls()).toEqual([]);
    });

    it("stays quiet while the sync's own alert for the hotel is out, and speaks once that is recovered", async () => {
      await setState(LIVE, { last_ok_run_at: at(-45), pass_date: "2026-09-30", pass_completed_at: at(-45) });
      await db.query(
        `insert into public.platform_audit_events (event_type, entity_type, entity_id, hotel_id, detail, created_at) values ('alert.raised', 'alert', $1, $2, '{"severity":"critical"}', $3)`,
        [`pms_reads_failing:cloudbeds:${LIVE}`, LIVE, at(-20)],
      );
      expect(rowOf(await watchdog(), LIVE)).toMatchObject({ action: "covered" });
      expect(await calls()).toEqual([]);
      await db.query(
        `insert into public.platform_audit_events (event_type, entity_type, entity_id, hotel_id, detail, created_at) values ('alert.recovered', 'alert', $1, $2, '{}', $3)`,
        [`pms_reads_failing:cloudbeds:${LIVE}`, LIVE, at(-5)],
      );
      expect(rowOf(await watchdog(), LIVE)).toMatchObject({ action: "alerted" });
      // The tick's own alert covers too, and one older than the window does not.
      await reset();
      await setState(LIVE, { last_ok_run_at: at(-45), pass_date: "2026-09-30", pass_completed_at: at(-45) });
      await db.query(
        `insert into public.platform_audit_events (event_type, entity_type, entity_id, hotel_id, detail, created_at) values ('alert.raised', 'alert', $1, $2, '{"severity":"critical"}', $3)`,
        [`pricing-failing:${LIVE}`, LIVE, at(-10)],
      );
      expect(rowOf(await watchdog(), LIVE)).toMatchObject({ action: "covered" });
      expect(rowOf(await watchdog({ now: at(6 * 60) }), LIVE)).toMatchObject({ action: "alerted" });
    });

    it("a simulating hotel is a warning: sent only when the floor is warn", async () => {
      await setState(SIM, { last_ok_run_at: at(-45), pass_date: "2026-09-30", pass_completed_at: at(-45) });
      expect(rowOf(await watchdog(), SIM)).toMatchObject({ severity: "warn", behind: true, action: "below_min_severity" });
      expect(await calls()).toEqual([]);
      expect(rowOf(await watchdog({ min: "warn" }), SIM)).toMatchObject({ action: "alerted" });
      const [sent] = await calls();
      expect(sent.body).toMatchObject({ severity: "warn" });
      expect(String(sent.body.text)).toContain("🟠 *MAYA warn* — Pricing is behind for Sim Inn");
      expect(String(sent.body.text)).toContain("The hotel is simulating: nothing is sent to its property system.");
    });

    it("with nothing in Vault, or not an https:// address, sends nothing, records no alert, and says so on the channel report", async () => {
      await setState(LIVE, { last_ok_run_at: at(-45), pass_date: "2026-09-30", pass_completed_at: at(-45) });
      await setWebhook(null);
      expect(rowOf(await watchdog(), LIVE)).toMatchObject({ action: "no_webhook" });
      expect(await calls()).toEqual([]);
      expect(await events("alert.raised")).toEqual([]);
      let channel = await events("alert.channel", "pricing-watchdog");
      expect(channel).toHaveLength(1);
      expect(channel[0].detail).toEqual({ state: "missing", min_severity: "critical", fn: "pricing-watchdog", source: "vault" });

      await setWebhook("http://hooks.example.test/plain");
      expect(rowOf(await watchdog({ now: at(10) }), LIVE)).toMatchObject({ action: "no_webhook" });
      channel = await events("alert.channel", "pricing-watchdog");
      expect(channel).toHaveLength(2);
      expect(channel[1].detail).toMatchObject({ state: "not_https" });

      // Ready again: said once, then not again for 6 hours while nothing changes.
      await setWebhook(WEBHOOK);
      expect(rowOf(await watchdog({ now: at(20) }), LIVE)).toMatchObject({ action: "alerted" });
      expect(rowOf(await watchdog({ now: at(30) }), LIVE)).toMatchObject({ action: "deduped" });
      channel = await events("alert.channel", "pricing-watchdog");
      expect(channel).toHaveLength(3);
      expect(channel[2].detail).toMatchObject({ state: "ready", min_severity: "critical" });
      await watchdog({ now: at(20 + 6 * 60 + 1) });
      expect(await events("alert.channel", "pricing-watchdog")).toHaveLength(4);
      // A different floor is a change worth a row.
      await watchdog({ now: at(20 + 6 * 60 + 2), min: "warn" });
      const last = (await events("alert.channel", "pricing-watchdog")).at(-1)!;
      expect(last.detail).toMatchObject({ state: "ready", min_severity: "warn" });
    });

    it("when pg_net refuses the request, records nothing and tries again next time", async () => {
      await setState(LIVE, { last_ok_run_at: at(-45), pass_date: "2026-09-30", pass_completed_at: at(-45) });
      await db.exec(`insert into net.zz_refuse values ('pg_net is not installed')`);
      const r = rowOf(await watchdog(), LIVE);
      expect(r.action).toBe("post_failed");
      expect(r.detail).toContain("pg_net is not installed");
      expect(await events("alert.raised")).toEqual([]);
      await db.exec(`delete from net.zz_refuse`);
      expect(rowOf(await watchdog({ now: at(10) }), LIVE)).toMatchObject({ action: "alerted" });
    });

    it("a dry run writes nothing and sends nothing, however stuck the fleet is", async () => {
      for (const h of [LIVE, SIM, NOSUB]) await setState(h, { last_ok_run_at: at(-90), pass_date: "2026-09-28" });
      const rows = await watchdog({ post: false });
      expect(rows.filter((r) => r.behind).map((r) => r.action)).toEqual(["dry_run", "dry_run", "dry_run"]);
      expect(await calls()).toEqual([]);
      expect(await q(`select count(*)::int as n from public.platform_audit_events`)).toEqual([{ n: 0 }]);
    });
  });

  describe("who may run it", () => {
    it("the service role and a session with no JWT (pg_cron); not a signed-in user, and not anon", async () => {
      await asRole(null);
      expect((await watchdog({ post: false })).length).toBe(4);
      await asRole("authenticated");
      await expect(watchdog({ post: false })).rejects.toThrow(/Only the scheduled watchdog/);
      await asRole("service_role");
      const [g] = await q(`
        select has_function_privilege('anon', 'public.pricing_watchdog(boolean, text, timestamptz)', 'execute') as anon,
               has_function_privilege('authenticated', 'public.pricing_watchdog(boolean, text, timestamptz)', 'execute') as authenticated,
               has_function_privilege('service_role', 'public.pricing_watchdog(boolean, text, timestamptz)', 'execute') as service_role,
               has_function_privilege('anon', 'public.pricing_watchdog_local_time(text, timestamptz)', 'execute') as local_anon`);
      expect(g).toEqual({ anon: false, authenticated: false, service_role: true, local_anon: false });
    });
  });
});
