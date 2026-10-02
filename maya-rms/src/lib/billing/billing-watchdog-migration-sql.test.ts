/**
 * 99_supabase_migration_billing_watchdog_v1.sql run for real in PGlite, twice,
 * on top of every migration before it (audit A40): billing_watchdog() posts
 * each billing problem the app wrote, once per key per 6 hours, and says when
 * a billing job has stopped reporting runs, with one recovery line when it is
 * back. pg_net and Vault are stand-ins (a table each); the clock is p_now.
 * Only runs with MAYA_PGLITE_DIR set (see engine/pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_billing_watchdog_v1.sql";
const CADENCE_FILE = "99_supabase_migration_pricing_cadence_v1.sql";

const CADENCE_TEST = readFileSync(resolve(__dirname, "../engine/pricing-cadence-sql.test.ts"), "utf8");

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

const PLATFORM: string = (() => {
  const start = CADENCE_TEST.indexOf("export const PLATFORM = `") + "export const PLATFORM = `".length;
  return CADENCE_TEST.slice(start, CADENCE_TEST.indexOf("`;", start));
})();

const SUPABASE_DEFAULT_PRIVILEGES = `
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

/** pg_net records what it was asked to send (and refuses when told to); Vault is a table. */
const STAND_INS = `
create schema if not exists net;
create table net.zz_calls (id bigserial primary key, url text, body jsonb, headers jsonb, timeout_milliseconds integer);
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

function outsideBodies(sql: string): string {
  return sql.replace(/--.*$/gm, "").replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
}

const HOTEL = "11111111-1111-4111-8111-111111111701";
const NOW = "2026-10-01T12:00:00Z";
const MIN = 60_000;
const at = (minutesFromNow: number, base = NOW) => new Date(Date.parse(base) + minutesFromNow * MIN).toISOString();
const WEBHOOK = "https://hooks.example.test/services/T0/B0/billing";

describe("the migration file", () => {
  const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8");
  const code = outsideBodies(sql);

  it("is on the list the SQL tests build production's schema from, right after the pricing records file", () => {
    expect(MIGRATION_ORDER).toContain(MIGRATION);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBe(MIGRATION_ORDER.indexOf("99_supabase_migration_pricing_records_v1.sql") + 1);
  });

  it("is one transaction, makes no table, changes no policy and never grants anon anything", () => {
    expect(code.match(/\bbegin;/g)).toHaveLength(1);
    expect(code.match(/\bcommit;/g)).toHaveLength(1);
    expect(code).not.toMatch(/create table|create policy|drop policy|disable row level security/i);
    expect(code).not.toMatch(/grant[^;]*\banon\b/i);
    expect(code).toMatch(/revoke all on function public\.billing_watchdog\(boolean, text, timestamptz\) from public, anon, authenticated;/);
  });

  it("watches the jobs the app reports under, with the event names the app writes", () => {
    const problems = readFileSync(resolve(__dirname, "./problems.ts"), "utf8");
    for (const job of ["card-reverify", "room-truing", "stripe-reconcile"]) {
      expect(sql).toContain(`'${job}'`);
      expect(problems).toContain(`"${job}"`);
    }
    expect(problems).toContain(`BILLING_PROBLEM_EVENT = "billing.problem"`);
    expect(problems).toContain(`BILLING_SWEEP_EVENT = "billing.sweep"`);
  });
});

describe.skipIf(!PGLITE_DIR)("the billing watchdog in PGlite", () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const asRole = (role: string | null) => db.query(`select set_config('request.jwt.claim.role', $1, false)`, [role ?? ""]);

  type Row = { kind: string; alert_key: string; severity: string; title: string; last_at: Date | string | null; action: string; detail: string | null };
  const watchdog = async (opts: { post?: boolean; min?: string; now?: string } = {}) =>
    (await q(`select * from public.billing_watchdog($1, $2, $3::timestamptz)`, [opts.post ?? true, opts.min ?? "critical", opts.now ?? NOW])) as unknown as Row[];
  const job = (rows: Row[], name: string) => rows.find((r) => r.alert_key === `billing-watchdog:${name}`)!;
  const calls = async () => (await q(`select url, body from net.zz_calls order by id`)) as { url: string; body: Record<string, unknown> }[];
  const events = async (type: string, key?: string) =>
    q(`select entity_id, hotel_id, detail, created_at from public.platform_audit_events where event_type = $1 and ($2::text is null or entity_id = $2) order by created_at, id`, [type, key ?? null]);
  const sweep = (name: string, when: string) =>
    db.query(`insert into public.platform_audit_events (event_type, entity_type, entity_id, detail, created_at) values ('billing.sweep', 'billing_job', $1, '{}'::jsonb, $2)`, [name, when]);
  const problem = (key: string, when: string, detail: Record<string, unknown>, hotel: string | null = null) =>
    db.query(`insert into public.platform_audit_events (event_type, entity_type, entity_id, hotel_id, detail, created_at) values ('billing.problem', 'billing', $1, $2, $3::jsonb, $4)`, [key, hotel, JSON.stringify(detail), when]);
  const allJobsRan = async (when = at(-10)) => {
    for (const name of ["card-reverify", "room-truing", "stripe-reconcile"]) await sweep(name, when);
  };
  const setWebhook = async (url: string | null) => {
    await db.exec(`delete from vault.decrypted_secrets`);
    if (url != null) await db.query(`insert into vault.decrypted_secrets (name, decrypted_secret) values ('maya_alert_webhook', $1)`, [url]);
  };

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
    // The file under test, twice: it is safe to run again.
    await db.exec(fileSql(MIGRATION));
    await db.exec(fileSql(MIGRATION));
    await db.exec(STAND_INS);
    await asRole("service_role");
    await db.exec(`
      insert into public.hotels (id, name, timezone) values ('${HOTEL}', 'Juniper Lodge', 'UTC');
      insert into public.hotel_subscriptions (hotel_id, stripe_customer_id, stripe_subscription_id, status, billing_interval, billed_rooms)
        values ('${HOTEL}', 'cus_1', 'sub_1', 'active', 'month', 20);
    `);
  }, 240_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await asRole("service_role");
    await db.exec(`delete from net.zz_calls; delete from net.zz_refuse; delete from public.platform_audit_events;`);
    await db.exec(`update public.hotel_subscriptions set plan_kind = 'stripe'`);
    await setWebhook(WEBHOOK);
  });

  describe("billing jobs", () => {
    it("is quiet while every job has reported in time", async () => {
      await allJobsRan();
      const rows = await watchdog();
      expect(rows.filter((r) => r.kind === "job").map((r) => [r.alert_key, r.action])).toEqual([
        ["billing-watchdog:card-reverify", "ok"],
        ["billing-watchdog:room-truing", "ok"],
        ["billing-watchdog:stripe-reconcile", "ok"],
      ]);
      expect(await calls()).toEqual([]);
    });

    it("says when the card check has not run for 2 hours, and the daily jobs for 26", async () => {
      await sweep("card-reverify", at(-121));
      await sweep("room-truing", at(-25 * 60));
      await sweep("stripe-reconcile", at(-27 * 60));
      const rows = await watchdog();
      expect(job(rows, "card-reverify")).toMatchObject({ action: "alerted", severity: "critical", title: "The card check has stopped running" });
      expect(job(rows, "card-reverify").detail).toContain("last ran at 2026-10-01 09:59Z (it runs every 15 minutes)");
      expect(job(rows, "card-reverify").detail).toContain("BILLING_CRON_SECRET");
      expect(job(rows, "room-truing").action).toBe("ok");
      expect(job(rows, "stripe-reconcile")).toMatchObject({ action: "alerted", title: "The nightly Stripe check has stopped running" });
      const sent = await calls();
      expect(sent).toHaveLength(2);
      expect(sent[0].url).toBe(WEBHOOK);
      expect(sent[0].body).toMatchObject({ severity: "critical", key: "billing-watchdog:card-reverify", hotelId: null });
      expect(String(sent[0].body.text)).toContain("*MAYA critical*: The card check has stopped running");
      expect(String(sent[0].body.text)).not.toContain("\u2014");
      expect((await events("alert.raised")).map((e) => e.entity_id).sort()).toEqual(["billing-watchdog:card-reverify", "billing-watchdog:stripe-reconcile"]);
    });

    it("counts a job that never ran as stopped, once Stripe billing is in use, and not before", async () => {
      expect(job(await watchdog({ post: false }), "room-truing")).toMatchObject({ action: "dry_run" });
      expect(job(await watchdog({ post: false }), "room-truing").detail).toContain("has never reported a run (it runs daily)");
      await db.exec(`update public.hotel_subscriptions set plan_kind = 'internal'`);
      const rows = await watchdog();
      expect(rows.filter((r) => r.kind === "job").every((r) => r.action === "ok")).toBe(true);
      expect(job(rows, "room-truing").detail).toContain("No Stripe subscription yet");
      expect(await calls()).toEqual([]);
    });

    it("does not repeat inside 6 hours, repeats after, and sends one recovery line when the job is back", async () => {
      await sweep("room-truing", at(-10));
      await sweep("stripe-reconcile", at(-10));
      expect(job(await watchdog(), "card-reverify").action).toBe("alerted");
      expect(job(await watchdog({ now: at(60) }), "card-reverify").action).toBe("deduped");
      expect(job(await watchdog({ now: at(6 * 60 + 1) }), "card-reverify").action).toBe("alerted");
      expect((await calls()).filter((c) => c.body.key === "billing-watchdog:card-reverify")).toHaveLength(2);

      await sweep("card-reverify", at(6 * 60 + 5));
      const back = job(await watchdog({ now: at(6 * 60 + 10) }), "card-reverify");
      expect(back).toMatchObject({ action: "recovered", title: "The card check is running again" });
      expect((await calls()).at(-1)?.body).toMatchObject({ severity: "recovered", key: "billing-watchdog:card-reverify" });
      expect(job(await watchdog({ now: at(6 * 60 + 25) }), "card-reverify").action).toBe("ok");
      expect(await events("alert.recovered", "billing-watchdog:card-reverify")).toHaveLength(1);
    });

    it("says no_webhook without the Vault secret, and post_failed when pg_net refuses, without recording an alert", async () => {
      await setWebhook(null);
      expect(job(await watchdog(), "card-reverify").action).toBe("no_webhook");
      await setWebhook("http://insecure.example.test/hook");
      expect(job(await watchdog(), "card-reverify").action).toBe("no_webhook");
      await setWebhook(WEBHOOK);
      await db.exec(`insert into net.zz_refuse values ('queue full')`);
      const refused = job(await watchdog(), "card-reverify");
      expect(refused).toMatchObject({ action: "post_failed", detail: "queue full" });
      expect(await events("alert.raised")).toEqual([]);
    });

    it("reports its own channel for Pilot health, under billing-watchdog with source vault", async () => {
      await allJobsRan();
      await setWebhook(null);
      await watchdog();
      await watchdog();
      const reports = await events("alert.channel", "billing-watchdog");
      expect(reports).toHaveLength(1);
      expect(reports[0].detail).toMatchObject({ state: "missing", source: "vault", fn: "billing-watchdog", min_severity: "critical" });
      await setWebhook(WEBHOOK);
      await watchdog({ now: at(1) });
      expect((await events("alert.channel", "billing-watchdog")).at(-1)?.detail).toMatchObject({ state: "ready" });
    });
  });

  describe("billing problems", () => {
    it("posts a problem with its title, detail and property, once", async () => {
      await allJobsRan();
      await problem("billing-duplicate-subscription:" + HOTEL, at(-3), {
        severity: "critical",
        title: "Two live subscriptions on one property",
        detail: "Stripe has sub_2 and sub_1 live for this property.",
      }, HOTEL);
      const rows = (await watchdog()).filter((r) => r.kind === "problem");
      expect(rows).toEqual([
        expect.objectContaining({ alert_key: `billing-duplicate-subscription:${HOTEL}`, action: "alerted", severity: "critical", title: "Two live subscriptions on one property" }),
      ]);
      const [sent] = await calls();
      expect(sent.body).toMatchObject({ severity: "critical", key: `billing-duplicate-subscription:${HOTEL}`, hotelId: HOTEL });
      expect(String(sent.body.text)).toBe(
        `🔴 *MAYA critical*: Two live subscriptions on one property\n> Stripe has sub_2 and sub_1 live for this property.\n> hotel \`${HOTEL}\``,
      );
      const [raised] = await events("alert.raised");
      expect(raised).toMatchObject({ entity_id: `billing-duplicate-subscription:${HOTEL}`, hotel_id: HOTEL });

      // Nothing new: nothing posted, nothing listed.
      expect((await watchdog({ now: at(15) })).filter((r) => r.kind === "problem")).toEqual([]);
      expect(await calls()).toHaveLength(1);
    });

    it("holds a repeat of the same key for 6 hours, then posts it", async () => {
      await allJobsRan();
      await problem("billing-code-over-cap:c1:h1", at(-3), { title: "A signup code was used past its limit", detail: "x" });
      await watchdog();
      await problem("billing-code-over-cap:c1:h1", at(30), { title: "A signup code was used past its limit", detail: "again" });
      expect((await watchdog({ now: at(45) })).find((r) => r.kind === "problem")).toMatchObject({ action: "deduped" });
      await sweep("card-reverify", at(6 * 60));
      const later = (await watchdog({ now: at(6 * 60 + 5) })).find((r) => r.kind === "problem");
      expect(later).toMatchObject({ action: "alerted", detail: "again" });
      expect((await calls()).filter((c) => c.body.key === "billing-code-over-cap:c1:h1")).toHaveLength(2);
    });

    it("sends warnings only when told to, forgets problems older than 7 days, and puts a stray hotel id from the detail on the line", async () => {
      await allJobsRan();
      await problem("billing-minor", at(-5), { severity: "warn", title: "Minor", detail: "d" });
      await problem("billing-old", at(-8 * 24 * 60), { title: "Old", detail: "d" });
      await problem("billing-gone-hotel", at(-5), { title: "Gone", detail: "d", hotel_id: "99999999-9999-4999-8999-999999999999" });
      let rows = (await watchdog()).filter((r) => r.kind === "problem");
      expect(rows.map((r) => [r.alert_key, r.action]).sort()).toEqual([
        ["billing-gone-hotel", "alerted"],
        ["billing-minor", "below_min_severity"],
      ]);
      expect((await calls()).find((c) => c.body.key === "billing-gone-hotel")?.body.hotelId).toBe("99999999-9999-4999-8999-999999999999");
      rows = (await watchdog({ min: "warn", now: at(1) })).filter((r) => r.kind === "problem");
      expect(rows).toEqual([expect.objectContaining({ alert_key: "billing-minor", action: "alerted", severity: "warn" })]);
      expect(String((await calls()).at(-1)?.body.text)).toContain("🟠 *MAYA warn*: Minor");
    });

    it("changes nothing on a dry run", async () => {
      await problem("billing-x", at(-5), { title: "X", detail: "d" });
      const rows = await watchdog({ post: false });
      expect(rows.find((r) => r.kind === "problem")).toMatchObject({ action: "dry_run" });
      expect(await calls()).toEqual([]);
      expect(await events("alert.raised")).toEqual([]);
      expect(await events("alert.channel")).toEqual([]);
    });
  });

  describe("who may run it", () => {
    it("is the service role's and pg_cron's alone", async () => {
      await asRole("authenticated");
      await expect(watchdog()).rejects.toThrow(/Only the scheduled watchdog/);
      await asRole(null);
      await expect(watchdog({ post: false })).resolves.toBeDefined();
      const [g] = await q(`
        select has_function_privilege('anon', 'public.billing_watchdog(boolean, text, timestamptz)', 'execute') as anon,
               has_function_privilege('authenticated', 'public.billing_watchdog(boolean, text, timestamptz)', 'execute') as authenticated,
               has_function_privilege('service_role', 'public.billing_watchdog(boolean, text, timestamptz)', 'execute') as service_role`);
      expect(g).toEqual({ anon: false, authenticated: false, service_role: true });
    });
  });
});
