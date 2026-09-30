import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isEntitledStatus } from "@/lib/billing/entitlement";
import type { SignupCode } from "@/lib/billing/codes";
import { priceCents, type BillingInterval } from "@/lib/billing/tiers";
import { isMissingFunction } from "./product-analytics";

/**
 * The business panel's numbers, in one place.
 *
 * Two kinds of question live here and they read from different sources. "What
 * is true right now" comes from the live tables. "How did it change" comes from
 * hotel_metrics_daily — the nightly snapshot — because subscription rows are
 * upserted in place and remember nothing. Everything is month-equivalent cents
 * (annual divided by twelve) so monthly and annual properties sum into one line.
 *
 * Each question is one database call: analytics_now and analytics_range in
 * 99_supabase_migration_command_center_speed_v1.sql. The page used to read the
 * tables here one request at a time, which is what made it slow. The price
 * brackets stay on this side (lib/billing/tiers.ts, the same ones pushed to
 * Stripe): analytics_now hands back each subscription's facts and the money is
 * worked out below, so there is never a second copy of the brackets to drift.
 */

export type DayPoint = {
  day: string;
  listMrrCents: number;
  netMrrCents: number;
  /** Paying = serving AND past its trial. A trial collects nothing yet, so it
   *  is counted on its own line and contributes no money on any surface. */
  paying: number;
  trialing: number;
};

export type HotelRef = { hotelId: string; name: string };

export type SubscriptionEvent = HotelRef & { day: string };

export type AnalyticsRange = {
  series: DayPoint[];
  newPaying: SubscriptionEvent[];
  churned: SubscriptionEvent[];
  wonBack: SubscriptionEvent[];
  funnel: { stage: string; count: number }[];
  /** Median hours from PMS connect to the first engine run, for hotels whose
   *  first run landed in the range. Null until someone completes the journey. */
  medianHoursToLive: number | null;
  /** The newest snapshot day up to the range's end, or null before the first. */
  lastSnapshotDay: string | null;
};

/** Off by default everywhere: the panel answers business questions, and a
 *  walkthrough signup is not a customer. The toggle exists so the panel itself
 *  can be verified with the only data a young deployment has. */
export type AnalyticsScope = { includeTest: boolean };

export type AnalyticsNow = {
  listMrrCents: number;
  netMrrCents: number;
  payingCount: number;
  trialingCount: number;
  trialPotentialCents: number;
  byBracket: { label: string; count: number; netMrrCents: number }[];
  liveCount: number;
  simulationCount: number;
  attention: {
    cardTrouble: HotelRef[];
    roomShortfall: HotelRef[];
    syncBroken: (HotelRef & { pmsType: string; status: string })[];
    engineSilent: HotelRef[];
  };
};

/** The file that makes analytics_now and analytics_range, named when they are missing. */
export const SPEED_MIGRATION = "99_supabase_migration_command_center_speed_v1.sql";

/** A database that has not had SPEED_MIGRATION run yet: the page says which file to run. */
export class AnalyticsMigrationMissing extends Error {
  constructor() {
    super(`Run ${SPEED_MIGRATION} to see these.`);
    this.name = "AnalyticsMigrationMissing";
  }
}

/** Month-equivalent list price for a subscription row. */
export function monthlyListCents(rooms: number, interval: BillingInterval): number {
  const period = priceCents(rooms, interval);
  return interval === "year" ? Math.round(period / 12) : period;
}

/**
 * What the bank sees monthly after the hotel's code, floored at zero.
 *
 * Same deliberate approximation as the code desk's rollUpMoney: a repeating
 * discount whose months have already run is still netted off, because Stripe's
 * invoices are the record of what was actually collected — this is a steering
 * number, not accounting.
 */
export function monthlyNetCents(listMonthly: number, code: Pick<SignupCode, "kind" | "percent_off" | "amount_off_cents"> | null): number {
  if (!code) return listMonthly;
  if (code.kind === "percent_off") {
    return Math.round((listMonthly * (100 - Number(code.percent_off ?? 0))) / 100);
  }
  if (code.kind === "amount_off") {
    return Math.max(0, listMonthly - Number(code.amount_off_cents ?? 0));
  }
  return listMonthly;
}

const BRACKETS = [
  { label: "1–20", max: 20 },
  { label: "21–40", max: 40 },
  { label: "41–60", max: 60 },
  { label: "61–80", max: 80 },
  { label: "81–500", max: 500 },
];

/** One Stripe-plan subscription as analytics_now returns it: facts, no price. */
export type NowSubscription = {
  hotel_id: string;
  status: string;
  billing_interval: BillingInterval;
  billed_rooms: number;
  code_kind: SignupCode["kind"] | null;
  percent_off: number | string | null;
  amount_off_cents: number | null;
  simulating: boolean;
};

type NowRef = { hotel_id: string; name: string };

export type AnalyticsNowRow = {
  subs: NowSubscription[];
  card_trouble: NowRef[];
  room_shortfall: NowRef[];
  sync_broken: (NowRef & { pms_type: string; status: string })[];
  engine_silent: NowRef[];
};

/** analytics_now's answer, priced: the tiles, the brackets and the attention list. */
export function priceNow(row: AnalyticsNowRow): AnalyticsNow {
  const now: AnalyticsNow = {
    listMrrCents: 0,
    netMrrCents: 0,
    payingCount: 0,
    trialingCount: 0,
    trialPotentialCents: 0,
    byBracket: BRACKETS.map((b) => ({ label: b.label, count: 0, netMrrCents: 0 })),
    liveCount: 0,
    simulationCount: 0,
    attention: { cardTrouble: [], roomShortfall: [], syncBroken: [], engineSilent: [] },
  };

  for (const s of row.subs ?? []) {
    const rooms = Number(s.billed_rooms);
    const list = monthlyListCents(rooms, s.billing_interval);
    const code = s.code_kind ? { kind: s.code_kind, percent_off: s.percent_off == null ? null : Number(s.percent_off), amount_off_cents: s.amount_off_cents } : null;
    const net = monthlyNetCents(list, code);
    if (s.status === "trialing") {
      now.trialingCount += 1;
      now.trialPotentialCents += net;
    } else if (isEntitledStatus(s.status)) {
      now.payingCount += 1;
      now.listMrrCents += list;
      now.netMrrCents += net;
      const bracket = now.byBracket[BRACKETS.findIndex((b) => rooms <= b.max)] ?? now.byBracket[now.byBracket.length - 1];
      bracket.count += 1;
      bracket.netMrrCents += net;
    }
    // Counted off the served set rather than the settings rows, so a hotel
    // with no settings row still lands on one side (live): silently belonging
    // to neither is how these two stop summing to the tile above them.
    if (isEntitledStatus(s.status)) {
      if (s.simulating) now.simulationCount += 1;
      else now.liveCount += 1;
    }
  }

  const ref = (r: NowRef): HotelRef => ({ hotelId: String(r.hotel_id), name: String(r.name) });
  now.attention.cardTrouble = (row.card_trouble ?? []).map(ref);
  now.attention.roomShortfall = (row.room_shortfall ?? []).map(ref);
  now.attention.syncBroken = (row.sync_broken ?? []).map((r) => ({ ...ref(r), pmsType: String(r.pms_type), status: String(r.status) }));
  now.attention.engineSilent = (row.engine_silent ?? []).map(ref);
  return now;
}

export type AnalyticsRangeRow = {
  series: { day: string; list_mrr_cents: number; net_mrr_cents: number; paying: number; trialing: number }[];
  new_paying: (NowRef & { day: string })[];
  won_back: (NowRef & { day: string })[];
  churned: (NowRef & { day: string })[];
  accounts: number;
  paid: number;
  connected: number;
  finished: number;
  median_hours_to_live: number | null;
  last_snapshot_day: string | null;
};

/** analytics_range's answer, in the page's shape. */
export function shapeRange(row: AnalyticsRangeRow): AnalyticsRange {
  const event = (e: NowRef & { day: string }): SubscriptionEvent => ({ hotelId: String(e.hotel_id), name: String(e.name), day: String(e.day) });
  return {
    series: (row.series ?? []).map((p) => ({
      day: String(p.day),
      listMrrCents: Number(p.list_mrr_cents),
      netMrrCents: Number(p.net_mrr_cents),
      paying: Number(p.paying),
      trialing: Number(p.trialing),
    })),
    newPaying: (row.new_paying ?? []).map(event),
    churned: (row.churned ?? []).map(event),
    wonBack: (row.won_back ?? []).map(event),
    funnel: [
      { stage: "Accounts created", count: Number(row.accounts ?? 0) },
      { stage: "Paid (checkout done)", count: Number(row.paid ?? 0) },
      { stage: "PMS connected", count: Number(row.connected ?? 0) },
      { stage: "Onboarding finished", count: Number(row.finished ?? 0) },
    ],
    medianHoursToLive: row.median_hours_to_live == null ? null : Number(row.median_hours_to_live),
    lastSnapshotDay: row.last_snapshot_day == null ? null : String(row.last_snapshot_day),
  };
}

/** What is true right now: one call to analytics_now, priced here. */
export async function loadAnalyticsNow(client: SupabaseClient, scope: AnalyticsScope): Promise<AnalyticsNow> {
  const { data, error } = await client.rpc("analytics_now", { p_include_test: scope.includeTest });
  if (error) {
    if (isMissingFunction(error)) throw new AnalyticsMigrationMissing();
    throw new Error(`analytics_now: ${error.message}`);
  }
  return priceNow((data ?? {}) as AnalyticsNowRow);
}

/** How it changed between two UTC days, inclusive: one call to analytics_range. */
export async function loadAnalyticsRange(
  client: SupabaseClient,
  fromDay: string,
  toDay: string,
  scope: AnalyticsScope,
): Promise<AnalyticsRange> {
  const { data, error } = await client.rpc("analytics_range", {
    p_from: fromDay,
    p_to: toDay,
    p_include_test: scope.includeTest,
  });
  if (error) {
    if (isMissingFunction(error)) throw new AnalyticsMigrationMissing();
    throw new Error(`analytics_range: ${error.message}`);
  }
  return shapeRange((data ?? {}) as AnalyticsRangeRow);
}

// ── The nightly snapshot ────────────────────────────────────────────────────

/**
 * PostgREST silently caps a response at 1000 rows. A truncated read here
 * doesn't error, it just quietly writes fewer hotels, so the snapshot pages
 * every read, ordered by a unique column so no row is skipped or repeated
 * between pages.
 */
async function pageAll<T>(
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

type SubRow = {
  hotel_id: string;
  status: string;
  billing_interval: BillingInterval;
  billed_rooms: number;
  plan_kind: string;
  signup_code_id: string | null;
};

/** One hotel's snapshot row. */
function rowFor(day: string, sub: SubRow, code: SignupCode | null, simulation: boolean) {
  const stripePlan = sub.plan_kind !== "internal";
  const list = stripePlan ? monthlyListCents(sub.billed_rooms, sub.billing_interval) : 0;
  const entitled = stripePlan && isEntitledStatus(sub.status);
  // A trial is served but collects nothing, so it carries no money here —
  // otherwise the chart sums it as revenue while the tile excludes it, and the
  // same screen shows two different MRRs.
  const paying = entitled && sub.status !== "trialing";
  return {
    day,
    hotel_id: sub.hotel_id,
    status: sub.status,
    entitled,
    plan_kind: sub.plan_kind,
    rooms: sub.billed_rooms,
    list_mrr_cents: paying ? list : 0,
    net_mrr_cents: paying ? monthlyNetCents(list, code) : 0,
    simulation,
  };
}

/**
 * Write (or refresh) every hotel's row for one UTC day. Idempotent.
 *
 * Written by the nightly cron (/api/admin/metrics-snapshot), after the
 * analytics page has answered (never while it waits), and by the page's
 * Refresh. The three reads go together; only the codes wait for the
 * subscriptions that name them.
 */
export async function snapshotHotelMetrics(admin: SupabaseClient, day: string): Promise<number> {
  // Snapshots include test hotels, flagged — the row is a historical fact and
  // the reader decides what to count. Filtering at write time would make a
  // hotel flagged today rewrite last week.
  const [hotelRows, allSubs, settings] = await Promise.all([
    pageAll<{ id: string; is_test: boolean | null }>(
      (f, t) => admin.from("hotels").select("id, is_test").order("id", { ascending: true }).range(f, t),
      "hotels",
    ),
    pageAll<SubRow>(
      (f, t) =>
        admin
          .from("hotel_subscriptions")
          .select("hotel_id, status, billing_interval, billed_rooms, plan_kind, signup_code_id")
          .order("hotel_id", { ascending: true })
          .range(f, t),
      "hotel_subscriptions",
    ),
    pageAll<{ hotel_id: string; simulation_mode: boolean | null }>(
      (f, t) => admin.from("hotel_settings").select("hotel_id, simulation_mode").order("hotel_id", { ascending: true }).range(f, t),
      "hotel_settings",
    ),
  ]);
  const testById = new Map(hotelRows.map((h) => [String(h.id), h.is_test === true]));
  const subs = allSubs.filter((s) => testById.has(String(s.hotel_id)));
  if (subs.length === 0) return 0;

  const codeIds = [...new Set(subs.map((s) => s.signup_code_id).filter(Boolean))] as string[];
  const codeById = new Map<string, SignupCode>();
  if (codeIds.length) {
    const { data: codes, error: codeErr } = await admin.from("signup_codes").select("*").in("id", codeIds);
    if (codeErr) throw new Error(`signup_codes: ${codeErr.message}`);
    for (const c of codes ?? []) codeById.set(String(c.id), c as SignupCode);
  }

  const simByHotel = new Map(settings.map((s) => [String(s.hotel_id), s.simulation_mode === true]));
  const rows = subs.map((s) => ({
    ...rowFor(day, s, s.signup_code_id ? codeById.get(s.signup_code_id) ?? null : null, simByHotel.get(s.hotel_id) ?? false),
    is_test: testById.get(s.hotel_id) ?? false,
  }));
  const { error } = await admin.from("hotel_metrics_daily").upsert(rows, { onConflict: "day,hotel_id" });
  if (error) throw new Error(`hotel_metrics_daily: ${error.message}`);
  return rows.length;
}
