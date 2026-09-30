/**
 * 99_supabase_migration_command_center_speed_v1.sql run for real in PGlite,
 * twice, on top of every migration before it. The proof that matters: on a
 * seeded database (real and test hotels, trials, codes, a cancellation and a
 * win-back, a census day, test logins, first engine runs in and out of the
 * window), analytics_now and analytics_range give the analytics page exactly
 * what the TypeScript that used to read the tables one request at a time gave
 * it. That TypeScript is kept below, as it was on main, and run against the
 * same database through a small stand-in for PostgREST. The one stage held to
 * a new rule instead is accounts: a login counts once its email address is
 * confirmed, on the day it was confirmed.
 *
 * Only runs with MAYA_PGLITE_DIR set (see pricing-cadence-sql.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isEntitledStatus } from "@/lib/billing/entitlement";
import type { SignupCode } from "@/lib/billing/codes";
import type { BillingInterval } from "@/lib/billing/tiers";
import {
  loadAnalyticsNow,
  loadAnalyticsRange,
  monthlyListCents,
  monthlyNetCents,
  type AnalyticsNow,
  type AnalyticsRange,
  type AnalyticsScope,
  type DayPoint,
  type HotelRef,
  type SubscriptionEvent,
} from "./analytics";

const PGLITE_DIR = process.env.MAYA_PGLITE_DIR;
const ROOT = resolve(__dirname, "../../../..");
const MIGRATION = "99_supabase_migration_command_center_speed_v1.sql";
const CADENCE_FILE = "99_supabase_migration_pricing_cadence_v1.sql";

const CADENCE_TEST = readFileSync(resolve(__dirname, "../engine/pricing-cadence-sql.test.ts"), "utf8");

/** The order production ran the migrations in, read off the cadence test's list. */
const MIGRATION_ORDER: string[] = (() => {
  const list = CADENCE_TEST.slice(CADENCE_TEST.indexOf("MIGRATION_ORDER = ["), CADENCE_TEST.indexOf("];", CADENCE_TEST.indexOf("MIGRATION_ORDER = [")));
  return [...list.matchAll(/"(99_supabase_migration_[^"]+\.sql)"/g)].map((m) => m[1]);
})();

/**
 * Every file before this one, with the cadence file where production ran it:
 * just before the first migration that needs its tables when the cadence test
 * names one, otherwise last (it is idempotent and nothing here reads it).
 */
const BEFORE: string[] = (() => {
  const before = MIGRATION_ORDER.slice(0, MIGRATION_ORDER.indexOf(MIGRATION));
  const m = CADENCE_TEST.match(/CADENCE_RUNS_BEFORE = "([^"]+)"/);
  const at = m ? before.indexOf(m[1]) : -1;
  return at < 0 ? [...before, CADENCE_FILE] : [...before.slice(0, at), CADENCE_FILE, ...before.slice(at)];
})();

/** What Supabase provides and the files assume, read off the cadence test so there is one copy. */
const PLATFORM: string = (() => {
  const start = CADENCE_TEST.indexOf("export const PLATFORM = `") + "export const PLATFORM = `".length;
  return CADENCE_TEST.slice(start, CADENCE_TEST.indexOf("`;", start));
})();

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

// ── A stand-in for PostgREST over PGlite ────────────────────────────────────
//
// Just the builder calls the old loaders made, answered the way PostgREST
// answers them: rows encoded by Postgres's own JSON (so a timestamp reads
// "2026-09-10T12:00:00+00:00", as the old string comparisons saw it), a 1000
// row cap, and functions called by named arguments.

type Result = { data: unknown; error: { message: string; code?: string } | null };

function postgrest(db: Db): SupabaseClient {
  const ident = (c: string) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(c)) throw new Error(`unexpected column ${c}`);
    return c;
  };
  const from = (table: string) => {
    let cols = "*";
    const where: string[] = [];
    const params: unknown[] = [];
    const order: string[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const run = async (a: number | null, z: number | null): Promise<Result> => {
      const limit = a == null || z == null ? 1000 : Math.min(1000, z - a + 1);
      const offset = a ?? 0;
      const sql = `select coalesce(json_agg(t), '[]'::json) as data from (
        select ${cols} from public.${ident(table)}
        ${where.length ? `where ${where.join(" and ")}` : ""}
        ${order.length ? `order by ${order.join(", ")}` : ""}
        limit ${limit} offset ${offset}) t`;
      try {
        const { rows } = await db.query(sql, params);
        return { data: rows[0].data, error: null };
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
      }
    };
    const b = {
      select(c = "*") {
        cols = c
          .split(",")
          .map((s) => s.trim())
          .map((s) => (s === "*" ? s : ident(s)))
          .join(", ");
        return b;
      },
      eq(c: string, v: unknown) {
        where.push(`${ident(c)} = ${p(v)}`);
        return b;
      },
      gte(c: string, v: unknown) {
        where.push(`${ident(c)} >= ${p(v)}`);
        return b;
      },
      lte(c: string, v: unknown) {
        where.push(`${ident(c)} <= ${p(v)}`);
        return b;
      },
      lt(c: string, v: unknown) {
        where.push(`${ident(c)} < ${p(v)}`);
        return b;
      },
      in(c: string, v: unknown[]) {
        where.push(`${ident(c)}::text = any(${p(v.map(String))}::text[])`);
        return b;
      },
      not(c: string, op: string, v: unknown) {
        if (op !== "is" || v !== null) throw new Error(`unexpected not(${c}, ${op})`);
        where.push(`${ident(c)} is not null`);
        return b;
      },
      or(expr: string) {
        const parts = expr.split(",").map((part) => {
          const m = part.match(/^([a-z_]+)\.not\.is\.null$/);
          if (!m) throw new Error(`unexpected or(${expr})`);
          return `${ident(m[1])} is not null`;
        });
        where.push(`(${parts.join(" or ")})`);
        return b;
      },
      order(c: string, opts: { ascending?: boolean } = {}) {
        order.push(`${ident(c)} ${opts.ascending === false ? "desc" : "asc"}`);
        return b;
      },
      range(a: number, z: number) {
        return run(a, z);
      },
      then<T>(res: (v: Result) => T, rej?: (e: unknown) => T) {
        return run(null, null).then(res, rej);
      },
    };
    return b;
  };
  const rpc = async (name: string, args: Record<string, unknown> = {}): Promise<Result> => {
    const keys = Object.keys(args);
    const sql = `select to_json(public.${ident(name)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(", ")})) as data`;
    try {
      const { rows } = await db.query(sql, keys.map((k) => args[k]));
      return { data: rows[0].data, error: null };
    } catch (e) {
      return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
    }
  };
  const auth = {
    admin: {
      // GoTrue's listUsers: newest first, timestamps as JSON strings.
      listUsers: async ({ page, perPage }: { page: number; perPage: number }) => {
        const { rows } = await db.query(
          `select coalesce(json_agg(t), '[]'::json) as users from (
             select id::text as id, email, email_confirmed_at from auth.users order by created_at desc, id limit $1 offset $2) t`,
          [perPage, (page - 1) * perPage],
        );
        return { data: { users: rows[0].users as { id: string; email: string | null; email_confirmed_at: string | null }[] }, error: null };
      },
    },
  };
  return { from, rpc, auth } as unknown as SupabaseClient;
}

// ── The TypeScript this replaces, as it was on main ─────────────────────────
//
// Copied, not imported: the point is to hold the new SQL to what the page used
// to compute. Only the names changed (legacy*), and the accounts count, which
// models the new rule (see there).

function legacyIsPayingRow(row: { entitled: boolean; status: string }): boolean {
  return row.entitled && row.status !== "trialing";
}

function legacyAggregateSeries(
  rows: { day: string; entitled: boolean; status: string; list_mrr_cents: number; net_mrr_cents: number }[],
): DayPoint[] {
  const byDay = new Map<string, DayPoint>();
  for (const r of rows) {
    const p = byDay.get(r.day) ?? { day: r.day, listMrrCents: 0, netMrrCents: 0, paying: 0, trialing: 0 };
    if (legacyIsPayingRow(r)) {
      p.paying += 1;
      p.listMrrCents += r.list_mrr_cents;
      p.netMrrCents += r.net_mrr_cents;
    } else if (r.status === "trialing") {
      p.trialing += 1;
    }
    byDay.set(r.day, p);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

function legacyDeriveEvents(
  rows: { day: string; hotel_id: string; entitled: boolean; status: string }[],
  fromDay: string,
  toDay: string,
) {
  const firstDay = rows.reduce<string | null>((min, r) => (min === null || r.day < min ? r.day : min), null);
  const byHotel = new Map<string, { day: string; paying: boolean }[]>();
  for (const r of rows) {
    if (!byHotel.has(r.hotel_id)) byHotel.set(r.hotel_id, []);
    byHotel.get(r.hotel_id)!.push({ day: r.day, paying: legacyIsPayingRow(r) });
  }
  const newPaying: { hotelId: string; day: string }[] = [];
  const churned: { hotelId: string; day: string }[] = [];
  const wonBack: { hotelId: string; day: string }[] = [];
  for (const [hotelId, days] of byHotel) {
    days.sort((a, b) => (a.day < b.day ? -1 : 1));
    let everPaying = false;
    let prevPaying = false;
    for (const d of days) {
      const inRange = d.day >= fromDay && d.day <= toDay;
      const census = d.day === firstDay;
      if (d.paying && !prevPaying) {
        if (inRange && !census) (everPaying ? wonBack : newPaying).push({ hotelId, day: d.day });
      } else if (!d.paying && prevPaying && inRange) {
        churned.push({ hotelId, day: d.day });
      }
      everPaying = everPaying || d.paying;
      prevPaying = d.paying;
    }
  }
  return { newPaying, churned, wonBack };
}

function legacyMedianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function legacyPageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

const LEGACY_BRACKETS = [
  { label: "1–20", max: 20 },
  { label: "21–40", max: 40 },
  { label: "41–60", max: 60 },
  { label: "61–80", max: 80 },
  { label: "81–500", max: 500 },
];

type LegacySubRow = {
  hotel_id: string;
  status: string;
  billing_interval: BillingInterval;
  billed_rooms: number;
  plan_kind: string;
  signup_code_id: string | null;
};

async function legacyLoadScopedHotels(admin: SupabaseClient, scope: AnalyticsScope) {
  const rows = await legacyPageAll<{ id: string; name: string }>((from, to) => {
    let q = admin.from("hotels").select("id, name, is_test");
    if (!scope.includeTest) q = q.eq("is_test", false);
    return q.range(from, to);
  }, "hotels");
  const nameById = new Map<string, string>();
  for (const h of rows) nameById.set(String(h.id), String(h.name));
  return nameById;
}

async function legacyLoadSubsWithCodes(admin: SupabaseClient, allowed: Map<string, string>) {
  const subs = await legacyPageAll<LegacySubRow>(
    (from, to) =>
      admin
        .from("hotel_subscriptions")
        .select("hotel_id, status, billing_interval, billed_rooms, plan_kind, signup_code_id")
        .range(from, to),
    "hotel_subscriptions",
  );
  const codeIds = [...new Set(subs.map((s) => s.signup_code_id).filter(Boolean))] as string[];
  const codeById = new Map<string, SignupCode>();
  if (codeIds.length) {
    const { data: codes, error: codeErr } = await admin.from("signup_codes").select("*").in("id", codeIds);
    if (codeErr) throw new Error(`signup_codes: ${codeErr.message}`);
    for (const c of codes ?? []) codeById.set(String(c.id), c as SignupCode);
  }
  const scoped = subs.filter((s) => allowed.has(String(s.hotel_id)));
  return { subs: scoped, codeById };
}

async function legacyLoadAnalyticsNow(admin: SupabaseClient, scope: AnalyticsScope): Promise<AnalyticsNow> {
  const nameById = await legacyLoadScopedHotels(admin, scope);
  const { subs, codeById } = await legacyLoadSubsWithCodes(admin, nameById);
  const now: AnalyticsNow = {
    listMrrCents: 0,
    netMrrCents: 0,
    payingCount: 0,
    trialingCount: 0,
    trialPotentialCents: 0,
    byBracket: LEGACY_BRACKETS.map((b) => ({ label: b.label, count: 0, netMrrCents: 0 })),
    liveCount: 0,
    simulationCount: 0,
    attention: { cardTrouble: [], roomShortfall: [], syncBroken: [], engineSilent: [] },
  };

  const stripeSubs = subs.filter((s) => s.plan_kind !== "internal");
  for (const s of stripeSubs) {
    const list = monthlyListCents(s.billed_rooms, s.billing_interval);
    const net = monthlyNetCents(list, s.signup_code_id ? codeById.get(s.signup_code_id) ?? null : null);
    if (s.status === "trialing") {
      now.trialingCount += 1;
      now.trialPotentialCents += net;
    } else if (isEntitledStatus(s.status)) {
      now.payingCount += 1;
      now.listMrrCents += list;
      now.netMrrCents += net;
      const bracket = now.byBracket[LEGACY_BRACKETS.findIndex((b) => s.billed_rooms <= b.max)] ?? now.byBracket[now.byBracket.length - 1];
      bracket.count += 1;
      bracket.netMrrCents += net;
    }
  }

  const entitledIds = stripeSubs.filter((s) => isEntitledStatus(s.status)).map((s) => s.hotel_id);
  const ref = (hotelId: string): HotelRef => ({ hotelId, name: nameById.get(hotelId) ?? hotelId });

  {
    const entitledSet = new Set(entitledIds);
    const settings = await legacyPageAll<{ hotel_id: string; simulation_mode: boolean }>(
      (f, t) => admin.from("hotel_settings").select("hotel_id, simulation_mode").range(f, t),
      "hotel_settings",
    );
    const simulating = new Set(settings.filter((r) => r.simulation_mode === true).map((r) => String(r.hotel_id)));
    for (const id of entitledSet) {
      if (simulating.has(id)) now.simulationCount += 1;
      else now.liveCount += 1;
    }
  }

  {
    const rows = await legacyPageAll<Record<string, unknown>>(
      (f, t) =>
        admin
          .from("hotel_subscriptions")
          .select("hotel_id, card_verify_failed_at, room_shortfall_since, status")
          .or("card_verify_failed_at.not.is.null,room_shortfall_since.not.is.null")
          .range(f, t),
      "hotel_subscriptions",
    );
    for (const r of rows) {
      if (!nameById.has(String(r.hotel_id))) continue;
      if (r.card_verify_failed_at && isEntitledStatus(String(r.status))) now.attention.cardTrouble.push(ref(String(r.hotel_id)));
      if (r.room_shortfall_since) now.attention.roomShortfall.push(ref(String(r.hotel_id)));
    }
  }
  {
    const conns = await legacyPageAll<Record<string, unknown>>(
      (f, t) => admin.from("pms_connections").select("hotel_id, pms_type, status").range(f, t),
      "pms_connections",
    );
    for (const c of conns) {
      if (!nameById.has(String(c.hotel_id))) continue;
      if (String(c.status) !== "connected") {
        now.attention.syncBroken.push({ ...ref(String(c.hotel_id)), pmsType: String(c.pms_type), status: String(c.status) });
      }
    }
  }
  {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const runs = await legacyPageAll<{ hotel_id: string }>(
      (f, t) => admin.from("evaluation_run_log").select("hotel_id, evaluated_at").gte("evaluated_at", cutoff).range(f, t),
      "evaluation_run_log",
    );
    const seen = new Set(runs.map((r) => String(r.hotel_id)));
    for (const id of entitledIds) {
      if (!seen.has(id)) now.attention.engineSilent.push(ref(id));
    }
  }
  return now;
}

async function legacyLoadAnalyticsRange(
  admin: SupabaseClient,
  fromDay: string,
  toDay: string,
  scope: AnalyticsScope,
): Promise<AnalyticsRange> {
  const nameById = await legacyLoadScopedHotels(admin, scope);
  const snapRows = await legacyPageAll<Record<string, unknown>>((from, to) => {
    let q = admin
      .from("hotel_metrics_daily")
      .select("day, hotel_id, entitled, status, list_mrr_cents, net_mrr_cents")
      .lte("day", toDay);
    if (!scope.includeTest) q = q.eq("is_test", false);
    return q.order("day", { ascending: true }).range(from, to);
  }, "hotel_metrics_daily");
  const all = snapRows.map((r) => ({
    day: String(r.day),
    hotel_id: String(r.hotel_id),
    entitled: r.entitled === true,
    status: String(r.status),
    list_mrr_cents: Number(r.list_mrr_cents),
    net_mrr_cents: Number(r.net_mrr_cents),
  }));

  const series = legacyAggregateSeries(all.filter((r) => r.day >= fromDay));
  const events = legacyDeriveEvents(all, fromDay, toDay);
  const named = (e: { hotelId: string; day: string }): SubscriptionEvent => ({
    ...e,
    name: nameById.get(e.hotelId) ?? e.hotelId,
  });

  const fromTs = `${fromDay}T00:00:00Z`;
  const toTs = `${toDay}T23:59:59Z`;
  const hotelIds = [...nameById.keys()];
  const countStage = async (col: string) => {
    if (hotelIds.length === 0) return 0;
    const rows = await legacyPageAll<{ hotel_id: string }>(
      (f, t) =>
        admin
          .from("onboarding_states")
          .select("hotel_id")
          .gte(col, fromTs)
          .lte(col, toTs)
          .range(f, t),
      "onboarding_states",
    );
    return rows.filter((r) => nameById.has(String(r.hotel_id))).length;
  };
  // Not main's count. Main counted profiles created in the window, confirmed
  // or not; an account now counts once its email address is confirmed, on the
  // UTC day it was confirmed, over whole days [from, to + 1), "+" addresses
  // left out unless test is included. Worked out from every login, profile
  // row or not.
  let accounts = 0;
  {
    const start = Date.parse(`${fromDay}T00:00:00Z`);
    const end = Date.parse(`${toDay}T00:00:00Z`) + 86_400_000;
    for (let page = 1; ; page += 1) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new Error(`auth.listUsers: ${error.message}`);
      const users = data?.users ?? [];
      for (const u of users) {
        if (!u.email_confirmed_at) continue;
        const confirmed = Date.parse(u.email_confirmed_at);
        if (confirmed < start || confirmed >= end) continue;
        if (!scope.includeTest && String(u.email ?? "").includes("+")) continue;
        accounts += 1;
      }
      if (users.length < 200) break;
    }
  }
  let paid = 0;
  {
    const rows = await legacyPageAll<{ hotel_id: string }>(
      (f, t) =>
        admin
          .from("hotel_subscriptions")
          .select("hotel_id, created_at")
          .gte("created_at", fromTs)
          .lte("created_at", toTs)
          .range(f, t),
      "hotel_subscriptions",
    );
    paid = rows.filter((r) => nameById.has(String(r.hotel_id))).length;
  }
  const funnel = [
    { stage: "Accounts created", count: accounts },
    { stage: "Paid (checkout done)", count: paid },
    { stage: "PMS connected", count: await countStage("connected_at") },
    { stage: "Onboarding finished", count: await countStage("questions_completed_at") },
  ];

  let medianHoursToLive: number | null = null;
  {
    const runs = await legacyPageAll<{ hotel_id: string; evaluated_at: string }>(
      (f, t) =>
        admin.from("evaluation_run_log").select("hotel_id, evaluated_at").order("evaluated_at", { ascending: true }).range(f, t),
      "evaluation_run_log",
    );
    const firstRun = new Map<string, string>();
    for (const r of runs) {
      const id = String(r.hotel_id);
      if (!firstRun.has(id)) firstRun.set(id, String(r.evaluated_at));
    }
    const states = await legacyPageAll<{ hotel_id: string; connected_at: string }>(
      (f, t) => admin.from("onboarding_states").select("hotel_id, connected_at").not("connected_at", "is", null).range(f, t),
      "onboarding_states",
    );
    const hours: number[] = [];
    for (const s of states) {
      if (!nameById.has(String(s.hotel_id))) continue;
      const first = firstRun.get(String(s.hotel_id));
      if (!first || first < fromTs || first > toTs) continue;
      const ms = new Date(first).getTime() - new Date(String(s.connected_at)).getTime();
      if (ms >= 0) hours.push(ms / 3_600_000);
    }
    medianHoursToLive = legacyMedianOf(hours);
  }

  return {
    series,
    newPaying: events.newPaying.map(named),
    churned: events.churned.map(named),
    wonBack: events.wonBack.map(named),
    funnel,
    medianHoursToLive,
  };
}

// ── Comparing ───────────────────────────────────────────────────────────────
//
// The old code listed hotels in whatever order PostgREST handed rows back,
// which is no order at all; the new functions list them by name. So lists are
// compared as sets, in one canonical order, and everything else as is.

const byRef = (a: HotelRef & { day?: string }, b: HotelRef & { day?: string }) =>
  (a.day ?? "").localeCompare(b.day ?? "") || a.name.localeCompare(b.name) || a.hotelId.localeCompare(b.hotelId);

function canonicalNow(n: AnalyticsNow): AnalyticsNow {
  return {
    ...n,
    attention: {
      cardTrouble: [...n.attention.cardTrouble].sort(byRef),
      roomShortfall: [...n.attention.roomShortfall].sort(byRef),
      syncBroken: [...n.attention.syncBroken].sort(byRef),
      engineSilent: [...n.attention.engineSilent].sort(byRef),
    },
  };
}

function canonicalRange(r: AnalyticsRange): AnalyticsRange {
  return {
    series: r.series,
    newPaying: [...r.newPaying].sort(byRef),
    churned: [...r.churned].sort(byRef),
    wonBack: [...r.wonBack].sort(byRef),
    funnel: r.funnel,
    medianHoursToLive: r.medianHoursToLive,
  };
}

// ── The seed ────────────────────────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10);
const d = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** A whole-second moment on a day, so milliseconds never enter the comparison. */
const at = (n: number, hhmmss: string) => `${d(n)}T${hhmmss}Z`;

const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const ALDER = id(1); // paying since the table began: never "new"
const BIRCH = id(2); // trialing now, a year plan with an amount-off code, silent engine
const CEDAR = id(3); // paid, cancelled, back: churn then win-back in the window; past due now with a failed card
const DOGWOOD = id(4); // trial then paying inside the window: new; billing fewer rooms than it runs
const ELM = id(5); // an internal plan: fleet, not money, still on the attention list
const FIR = id(6); // cancelled before the 30-day window: churn only in the 60-day one
const GUM = id(7); // connected, never ran, subscription incomplete
const HAZEL = id(8); // a hotel with no settings row: live, and first run inside the window
const SANDBOX = id(9); // is_test: only with the toggle
const IVY = id(10); // flagged test today, real in its snapshot rows: named by id when test is left out

const CODE_PCT = id(21);
const CODE_AMT = id(22);
const CODE_TRIAL = id(23);
const ADMIN = id(31);
const NOBODY = id(32);

/** Logins: id, address, the day they signed up (at noon), and when the address was confirmed. */
const USERS: [string, string | null, number, string | null][] = [
  [id(41), "owner@alder.example.com", -70, at(-70, "12:05:00")],
  [id(42), "jake+walkthrough@example.com", -5, at(-5, "12:01:00")],
  [id(43), "birch@example.com", -10, at(-10, "12:30:00")],
  // Signed up on day -6, confirmed on day -4.
  [id(44), "dogwood@example.com", -6, at(-4, "09:00:00")],
  // No address, so nothing to confirm.
  [id(45), null, -3, null],
  [id(46), "demo+one@example.com", -1, at(-1, "12:10:00")],
  [id(47), "early@example.com", -40, at(-40, "12:00:00")],
  // Typed in, never confirmed.
  [id(48), "never@example.com", -2, null],
  // Signed up before the 30-day window, confirmed inside it.
  [id(49), "late-confirm@example.com", -31, at(-28, "08:00:00")],
];

/** One snapshot row per day from `from` to `to` (inclusive, relative days). */
function days(hotel: string, from: number, to: number, status: string, entitled: boolean, opts: { plan?: string; list?: number; net?: number; test?: boolean } = {}) {
  const paying = entitled && status !== "trialing";
  const rows: string[] = [];
  for (let n = from; n <= to; n += 1) {
    rows.push(
      `('${d(n)}', '${hotel}', '${status}', ${entitled}, '${opts.plan ?? "stripe"}', 20, ${paying ? opts.list ?? 10000 : 0}, ${paying ? opts.net ?? opts.list ?? 10000 : 0}, false, ${opts.test ?? false})`,
    );
  }
  return rows;
}

describe("the migration file", () => {
  it("is on the list the SQL tests build production's schema from, after the definer lockdown", () => {
    expect(MIGRATION_ORDER).toContain(MIGRATION);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBeGreaterThan(MIGRATION_ORDER.indexOf("99_supabase_migration_definer_lockdown_v1.sql"));
  });

  it("is one transaction, creates no table and changes no policy, and closes each function it makes to anon", () => {
    const sql = readFileSync(resolve(ROOT, MIGRATION), "utf8").replace(/--.*$/gm, "");
    expect(sql.match(/\bbegin;/g)).toHaveLength(1);
    expect(sql.match(/\bcommit;/g)).toHaveLength(1);
    expect(sql).not.toMatch(/create table|alter table|create policy|drop policy/i);
    const made = [...sql.matchAll(/create (?:or replace )?function public\.(\w+)\s*\(/gi)].map((m) => m[1]);
    expect(made.sort()).toEqual(["analytics_now", "analytics_owner_emails", "analytics_range", "platform_count_users"]);
    for (const fn of made) {
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon`));
      expect(sql).toMatch(new RegExp(`function public\\.${fn}\\([\\s\\S]*?security definer`));
    }
  });
});

describe.skipIf(!PGLITE_DIR)("command center speed in PGlite", () => {
  let db: Db;
  let api: SupabaseClient;
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

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
    // The file under test, twice: it is safe to run again.
    await db.exec(fileSql(MIGRATION));
    await db.exec(fileSql(MIGRATION));
    await db.exec(`set timezone to 'UTC'`);

    const snapshots = [
      // Census day is d(-60): Alder and the sandbox were already paying.
      ...days(ALDER, -60, 0, "active", true, { list: 12000, net: 9600 }),
      ...days(BIRCH, -10, 0, "trialing", true),
      ...days(CEDAR, -50, -21, "active", true, { list: 20000 }),
      ...days(CEDAR, -20, -16, "canceled", false),
      ...days(CEDAR, -15, 0, "past_due", true, { list: 20000 }),
      ...days(DOGWOOD, -5, -4, "trialing", true),
      ...days(DOGWOOD, -3, 0, "active", true, { list: 45000 }),
      ...days(ELM, -30, 0, "active", false, { plan: "internal" }),
      // An internal plan on trial: not served money, still a trialing point.
      ...days(GUM, -2, -2, "trialing", false, { plan: "internal" }),
      ...days(FIR, -40, -31, "active", true, { list: 8000 }),
      ...days(FIR, -30, 0, "canceled", false),
      ...days(HAZEL, -8, 0, "active", true, { list: 15000, net: 15000 }),
      ...days(SANDBOX, -60, -3, "active", true, { list: 5000, test: true }),
      ...days(SANDBOX, -2, 0, "canceled", false, { test: true }),
      ...days(IVY, -12, 0, "active", true, { list: 7000 }),
    ];

    await db.exec(`
      select set_config('request.jwt.claim.role', 'service_role', false);
      insert into auth.users (id, email, created_at, email_confirmed_at) values
        ('${ADMIN}', 'admin@example.com', '${at(-100, "09:00:00")}', '${at(-100, "09:05:00")}'),
        ('${NOBODY}', 'someone@example.com', '${at(-100, "09:00:00")}', '${at(-100, "09:05:00")}'),
        ${USERS.map(
          ([u, email, n, confirmed]) =>
            `('${u}', ${email == null ? "null" : `'${email}'`}, '${at(n, "12:00:00")}', ${confirmed == null ? "null" : `'${confirmed}'`})`,
        ).join(",\n        ")};
      -- Profiles dated the sign-up, as main counted them; the count reads auth.
      insert into public.profiles (id, created_at) values
        ${USERS.map(([u, , n]) => `('${u}', '${at(n, "12:00:00")}')`).join(",\n        ")}
        on conflict (id) do update set created_at = excluded.created_at;
      update public.profiles set created_at = '${at(-100, "09:00:00")}' where id in ('${ADMIN}', '${NOBODY}');
      insert into public.app_roles (user_id, role) values ('${ADMIN}', 'platform_admin');

      insert into public.hotels (id, name, timezone, is_test) values
        ('${ALDER}', 'Alder Inn', 'UTC', false),
        ('${BIRCH}', 'Birch Lodge', 'UTC', false),
        ('${CEDAR}', 'Cedar House', 'UTC', false),
        ('${DOGWOOD}', 'Dogwood Rooms', 'UTC', false),
        ('${ELM}', 'Elm Suites', 'UTC', false),
        ('${FIR}', 'Fir Court', 'UTC', false),
        ('${GUM}', 'Gum Tree', 'UTC', false),
        ('${HAZEL}', 'Hazel Motel', 'UTC', false),
        ('${SANDBOX}', 'MAYA Sandbox', 'UTC', true),
        ('${IVY}', 'Ivy Walkthrough', 'UTC', true);

      insert into public.hotel_settings (hotel_id, simulation_mode) values
        ('${ALDER}', false), ('${BIRCH}', true), ('${CEDAR}', true), ('${DOGWOOD}', false),
        ('${ELM}', false), ('${FIR}', false), ('${GUM}', true), ('${SANDBOX}', false), ('${IVY}', false)
        on conflict (hotel_id) do update set simulation_mode = excluded.simulation_mode;
      delete from public.hotel_settings where hotel_id = '${HAZEL}';

      insert into public.signup_codes (id, code, kind, percent_off, amount_off_cents, trial_days) values
        ('${CODE_PCT}', 'TWENTY', 'percent_off', 20, null, null),
        ('${CODE_AMT}', 'FIFTY', 'amount_off', null, 5000, null),
        ('${CODE_TRIAL}', 'LONGTRIAL', 'trial', null, null, 30);

      insert into public.hotel_subscriptions
        (hotel_id, stripe_customer_id, status, billing_interval, billed_rooms, plan_kind, signup_code_id,
         card_verify_failed_at, room_shortfall_since, created_at) values
        ('${ALDER}', 'cus_a', 'active', 'month', 24, 'stripe', '${CODE_PCT}', null, null, '${at(-80, "10:00:00")}'),
        ('${BIRCH}', 'cus_b', 'trialing', 'year', 45, 'stripe', '${CODE_AMT}', null, null, '${at(-10, "11:00:00")}'),
        ('${CEDAR}', 'cus_c', 'past_due', 'month', 70, 'stripe', null, '${at(-1, "08:00:00")}', null, '${at(-55, "10:00:00")}'),
        ('${DOGWOOD}', 'cus_d', 'active', 'month', 90, 'stripe', '${CODE_TRIAL}', null, '${at(-2, "00:00:00")}', '${at(-5, "15:00:00")}'),
        ('${ELM}', 'cus_e', 'active', 'month', 12, 'internal', null, '${at(-3, "08:00:00")}', null, '${at(-30, "10:00:00")}'),
        ('${FIR}', 'cus_f', 'canceled', 'month', 16, 'stripe', null, null, '${at(-35, "00:00:00")}', '${at(-45, "10:00:00")}'),
        ('${GUM}', 'cus_g', 'incomplete', 'month', 8, 'stripe', null, null, null, '${at(-2, "10:00:00")}'),
        ('${HAZEL}', 'cus_h', 'active', 'year', 30, 'stripe', null, null, null, '${at(-8, "09:00:00")}'),
        ('${SANDBOX}', 'cus_s', 'active', 'month', 10, 'stripe', '${CODE_PCT}', '${at(-1, "08:00:00")}', null, '${at(-4, "10:00:00")}'),
        ('${IVY}', 'cus_i', 'active', 'month', 200, 'stripe', null, null, null, '${at(-12, "10:00:00")}');

      insert into public.pms_connections (hotel_id, pms_type, status) values
        ('${ALDER}', 'cloudbeds', 'connected'),
        ('${BIRCH}', 'cloudbeds', 'connected'),
        ('${CEDAR}', 'cloudbeds', 'error'),
        ('${DOGWOOD}', 'mews', 'connected'),
        ('${GUM}', 'cloudbeds', 'pending'),
        ('${HAZEL}', 'cloudbeds', 'connected'),
        ('${SANDBOX}', 'cloudbeds', 'disconnected'),
        ('${IVY}', 'mews', 'connected');

      insert into public.onboarding_states (hotel_id, connected_at, questions_completed_at) values
        ('${ALDER}', '${at(-62, "08:00:00")}', '${at(-61, "08:00:00")}'),
        ('${BIRCH}', '${at(-10, "10:00:00")}', '${at(-9, "16:20:00")}'),
        ('${CEDAR}', '${at(-56, "08:00:00")}', null),
        ('${DOGWOOD}', '${at(-6, "08:00:00")}', '${at(-4, "09:15:00")}'),
        ('${GUM}', '${at(-2, "09:00:00")}', null),
        ('${HAZEL}', '${at(-9, "22:00:00")}', '${at(-8, "07:00:00")}'),
        ('${SANDBOX}', '${at(-4, "10:00:00")}', '${at(-4, "11:00:00")}'),
        ('${IVY}', '${at(-13, "10:00:00")}', null)
        on conflict (hotel_id) do update set connected_at = excluded.connected_at, questions_completed_at = excluded.questions_completed_at;

      -- First runs: Alder long ago; Birch 3.5 hours after connecting; Dogwood 12
      -- hours; Hazel 10 hours 7 minutes; the sandbox 1 hour; Ivy (test) 2 hours.
      -- Cedar's first run came before its onboarding row says it connected.
      insert into public.evaluation_run_log (hotel_id, evaluation_run_id, evaluated_at) values
        ('${ALDER}', gen_random_uuid(), '${at(-59, "06:00:00")}'),
        ('${ALDER}', gen_random_uuid(), now() - interval '2 hours'),
        ('${BIRCH}', gen_random_uuid(), '${at(-10, "13:30:00")}'),
        ('${BIRCH}', gen_random_uuid(), now() - interval '30 hours'),
        ('${CEDAR}', gen_random_uuid(), '${at(-57, "08:00:00")}'),
        ('${CEDAR}', gen_random_uuid(), now() - interval '1 hour'),
        ('${DOGWOOD}', gen_random_uuid(), '${at(-6, "20:00:00")}'),
        ('${DOGWOOD}', gen_random_uuid(), now() - interval '3 hours'),
        ('${HAZEL}', gen_random_uuid(), '${at(-8, "08:07:00")}'),
        ('${SANDBOX}', gen_random_uuid(), '${at(-4, "11:00:00")}'),
        ('${IVY}', gen_random_uuid(), '${at(-13, "12:00:00")}'),
        ('${IVY}', gen_random_uuid(), now() - interval '5 hours');

      insert into public.hotel_metrics_daily (day, hotel_id, status, entitled, plan_kind, rooms, list_mrr_cents, net_mrr_cents, simulation, is_test) values
        ${snapshots.join(",\n        ")};
      select set_config('request.jwt.claim.role', 'service_role', false);
    `);
    api = postgrest(db);
  }, 240_000);

  afterAll(async () => {
    await db?.close();
  });

  describe("analytics_now gives the page what the old reads did", () => {
    for (const includeTest of [false, true]) {
      it(`${includeTest ? "including" : "excluding"} test properties`, async () => {
        const scope = { includeTest };
        const [before, after] = [await legacyLoadAnalyticsNow(api, scope), await loadAnalyticsNow(api, scope)];
        expect(canonicalNow(after)).toEqual(canonicalNow(before));
      });
    }

    it("and the numbers are the ones the seed says", async () => {
      const now = await loadAnalyticsNow(api, { includeTest: false });
      // Alder, Cedar (past due), Dogwood, Hazel pay; Birch trials; Elm is internal.
      expect(now.payingCount).toBe(4);
      expect(now.trialingCount).toBe(1);
      // Served: Alder, Dogwood and Hazel (no settings row) live; Birch and Cedar simulate.
      expect(now.liveCount).toBe(3);
      expect(now.simulationCount).toBe(2);
      expect(now.attention.cardTrouble.map((r) => r.name)).toEqual(["Cedar House", "Elm Suites"]);
      expect(now.attention.roomShortfall.map((r) => r.name)).toEqual(["Dogwood Rooms", "Fir Court"]);
      expect(now.attention.syncBroken.map((r) => [r.name, r.pmsType, r.status])).toEqual([
        ["Cedar House", "cloudbeds", "error"],
        ["Gum Tree", "cloudbeds", "pending"],
      ]);
      expect(now.attention.engineSilent.map((r) => r.name)).toEqual(["Birch Lodge", "Hazel Motel"]);
    });
  });

  describe("analytics_range gives the page what the old reads did", () => {
    const ranges: [string, number, number][] = [
      ["the default 30 days", -29, 0],
      ["the last 7 days", -6, 0],
      ["60 days, starting on the census day", -60, 0],
      ["a window in the past", -45, -25],
      ["one day", -3, -3],
      ["today only", 0, 0],
      ["a window before any snapshot", -120, -90],
      ["from after to", -3, -10],
    ];
    for (const [label, from, to] of ranges) {
      for (const includeTest of [false, true]) {
        it(`${label}, ${includeTest ? "including" : "excluding"} test properties`, async () => {
          const scope = { includeTest };
          const before = await legacyLoadAnalyticsRange(api, d(from), d(to), scope);
          const after = await loadAnalyticsRange(api, d(from), d(to), scope);
          expect(canonicalRange(after)).toEqual(canonicalRange(before));
        });
      }
    }

    it("and the events are the ones the seed says", async () => {
      const r = await loadAnalyticsRange(api, d(-29), d(0), { includeTest: false });
      expect(r.newPaying).toEqual([
        { hotelId: IVY, name: IVY, day: d(-12) },
        { hotelId: HAZEL, name: "Hazel Motel", day: d(-8) },
        { hotelId: DOGWOOD, name: "Dogwood Rooms", day: d(-3) },
      ]);
      expect(r.churned).toEqual([{ hotelId: CEDAR, name: "Cedar House", day: d(-20) }]);
      expect(r.wonBack).toEqual([{ hotelId: CEDAR, name: "Cedar House", day: d(-15) }]);
      // Alder has paid since the table's first day: never new.
      const wide = await loadAnalyticsRange(api, d(-60), d(0), { includeTest: false });
      expect(wide.newPaying.map((e) => e.hotelId)).not.toContain(ALDER);
      expect(wide.churned.map((e) => e.name)).toEqual(["Fir Court", "Cedar House"]);
      // Accounts: Birch, Dogwood and the one who signed up before the window
      // and confirmed inside it. The "+" ones are test; the one with no
      // address and the one who never confirmed don't count.
      expect(r.funnel).toEqual([
        { stage: "Accounts created", count: 3 },
        { stage: "Paid (checkout done)", count: 4 },
        { stage: "PMS connected", count: 4 },
        { stage: "Onboarding finished", count: 3 },
      ]);
      // Birch 3.5h, Hazel 10h07m, Dogwood 12h: the middle one.
      expect(r.medianHoursToLive).toBeCloseTo(10 + 7 / 60, 10);
      // Nothing on the page showed the newest snapshot day, so the call no
      // longer works it out.
      const [raw] = await q(`select public.analytics_range('${d(-29)}', '${d(0)}', false) as r`);
      expect(Object.keys(raw.r as object).sort()).toEqual(
        ["accounts", "churned", "connected", "finished", "median_hours_to_live", "new_paying", "paid", "series", "won_back"],
      );
    });
  });

  it("counts the first and last second of the window, where the old reads dropped one of them", async () => {
    // Gum's checkout moved into the last half second of day -1 for the test.
    await db.exec(`update public.hotel_subscriptions set created_at = '${d(-1)}T23:59:59.500Z' where hotel_id = '${GUM}'`);
    try {
      const before = await legacyLoadAnalyticsRange(api, d(-1), d(-1), { includeTest: false });
      const after = await loadAnalyticsRange(api, d(-1), d(-1), { includeTest: false });
      expect(after.funnel[1]).toEqual({ stage: "Paid (checkout done)", count: before.funnel[1].count + 1 });
    } finally {
      await db.exec(`update public.hotel_subscriptions set created_at = '${at(-2, "10:00:00")}' where hotel_id = '${GUM}'`);
    }
  });

  describe("an account counts once its email address is confirmed", () => {
    const accounts = async (from: number, to: number, includeTest = false) =>
      (await loadAnalyticsRange(api, d(from), d(to), { includeTest })).funnel[0];

    it("not while it is only typed in, and on the day it is confirmed", async () => {
      // never@ signed up on day -2 and has had a profile row since.
      expect(await accounts(-2, -2, true)).toEqual({ stage: "Accounts created", count: 0 });
      await db.exec(`update auth.users set email_confirmed_at = '${at(0, "00:30:00")}' where id = '${id(48)}'`);
      try {
        expect((await accounts(-2, -2, true)).count).toBe(0);
        expect((await accounts(0, 0)).count).toBe(1);
      } finally {
        await db.exec(`update auth.users set email_confirmed_at = null where id = '${id(48)}'`);
      }
    });

    it("on the day it was confirmed, not the day it signed up", async () => {
      // Dogwood's owner signed up on day -6 and confirmed on day -4.
      expect((await accounts(-6, -6)).count).toBe(0);
      expect((await accounts(-4, -4)).count).toBe(1);
      // Signed up on day -31, confirmed on day -28.
      expect((await accounts(-31, -29)).count).toBe(0);
      expect((await accounts(-28, -28)).count).toBe(1);
    });

    it("inside the window's edges to the microsecond, profile row or not", async () => {
      const edge: [string, string, string][] = [
        [id(51), "edge-before@example.com", `${d(-8)}T23:59:59.999999Z`],
        [id(52), "edge-first@example.com", `${d(-7)}T00:00:00Z`],
        [id(53), "edge-last@example.com", `${d(-7)}T23:59:59.999999Z`],
        [id(54), "edge-after@example.com", `${d(-6)}T00:00:00Z`],
      ];
      const ids = edge.map(([u]) => `'${u}'`).join(", ");
      await db.exec(`
        insert into auth.users (id, email, created_at, email_confirmed_at) values
          ${edge.map(([u, email, confirmed]) => `('${u}', '${email}', '${at(-9, "12:00:00")}', '${confirmed}')`).join(",\n          ")};
        -- Signing up made each a profile row; the count must not need one.
        delete from public.profiles where id in (${ids});
      `);
      try {
        expect((await accounts(-7, -7)).count).toBe(2);
        expect((await accounts(-8, -8)).count).toBe(1);
        expect((await accounts(-6, -6)).count).toBe(1);
        expect((await accounts(-8, -6)).count).toBe(4);
      } finally {
        await db.exec(`delete from auth.users where id in (${ids})`);
      }
    });

    it("leaves out a \"+\" address unless test is included", async () => {
      // jake+walkthrough confirmed on day -5, demo+one on day -1.
      expect((await accounts(-5, -5)).count).toBe(0);
      expect((await accounts(-5, -5, true)).count).toBe(1);
      expect((await accounts(-1, -1)).count).toBe(0);
      expect((await accounts(-1, -1, true)).count).toBe(1);
      // The 30-day window: Birch, Dogwood and the late confirmer, then both "+" ones too.
      expect((await accounts(-29, 0)).count).toBe(3);
      expect((await accounts(-29, 0, true)).count).toBe(5);
    });
  });

  describe("who may call", () => {
    const asRole = async <T>(role: string, sub: string | null, fn: () => Promise<T>): Promise<T> => {
      await db.exec(`
        select set_config('request.jwt.claim.role', '${role}', false);
        select set_config('request.jwt.claim.sub', '${sub ?? ""}', false);
        set session authorization authenticator;
        set role ${role};
      `);
      try {
        return await fn();
      } finally {
        await db.exec(`
          reset role;
          reset session authorization;
          select set_config('request.jwt.claim.role', 'service_role', false);
          select set_config('request.jwt.claim.sub', '', false);
        `);
      }
    };

    beforeAll(async () => {
      await db.exec(`
        do $$ begin
          if not exists (select 1 from pg_roles where rolname = 'authenticator') then
            create role authenticator noinherit;
          end if;
        end $$;
        grant anon, authenticated, service_role to authenticator;
      `);
    });

    it("anon cannot execute any of the four", async () => {
      for (const sql of [
        "select public.analytics_now(false)",
        `select public.analytics_range('${d(-7)}', '${d(0)}', false)`,
        `select * from public.analytics_owner_emails(array['${id(43)}']::uuid[])`,
        "select public.platform_count_users(null)",
      ]) {
        await expect(asRole("anon", null, () => q(sql))).rejects.toThrow(/permission denied/);
      }
    });

    it("a signed-in owner who is not a platform admin is refused", async () => {
      for (const sql of [
        "select public.analytics_now(false)",
        `select public.analytics_range('${d(-7)}', '${d(0)}', false)`,
        `select * from public.analytics_owner_emails(array['${id(43)}']::uuid[])`,
        "select public.platform_count_users(null)",
      ]) {
        await expect(asRole("authenticated", NOBODY, () => q(sql))).rejects.toThrow(/Not authorized/);
      }
    });

    it("a platform admin gets the answers, and the service role gets the analytics", async () => {
      const [admin] = await asRole("authenticated", ADMIN, () => q("select public.platform_count_users(null) as n, public.analytics_now(false) as now"));
      expect(admin.n).toBe(USERS.length + 2);
      expect((admin.now as { subs: unknown[] }).subs.length).toBeGreaterThan(0);
      const [service] = await asRole("service_role", null, () => q(`select public.analytics_range('${d(-7)}', '${d(0)}', false) as r`));
      expect((service.r as { series: unknown[] }).series.length).toBe(8);
    });

    it("hands a platform admin or the service role the owners' emails, and nothing for an id with none", async () => {
      const ids = `array['${id(43)}', '${id(44)}', '${id(45)}', '${id(99)}']::uuid[]`;
      const sql = `select user_id, email from public.analytics_owner_emails(${ids}) order by email`;
      const expected = [
        { user_id: id(43), email: "birch@example.com" },
        { user_id: id(44), email: "dogwood@example.com" },
      ];
      expect(await asRole("authenticated", ADMIN, () => q(sql))).toEqual(expected);
      expect(await asRole("service_role", null, () => q(sql))).toEqual(expected);
      expect(await asRole("service_role", null, () => q("select * from public.analytics_owner_emails(array[]::uuid[])"))).toEqual([]);
    });

    it("counts logins the way the list finds them", async () => {
      const [row] = await asRole("authenticated", ADMIN, () => q("select public.platform_count_users('example.com') as n, public.platform_count_users('+') as plus"));
      expect(row.n).toBe(USERS.length + 1); // every address but the missing one
      expect(row.plus).toBe(2);
    });
  });
});
