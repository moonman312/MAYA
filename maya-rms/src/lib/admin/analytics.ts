import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isEntitledStatus } from "@/lib/billing/entitlement";
import type { SignupCode } from "@/lib/billing/codes";
import { priceCents, type BillingInterval } from "@/lib/billing/tiers";

/**
 * The business panel's numbers, in one place.
 *
 * Two kinds of question live here and they read from different sources. "What
 * is true right now" comes from the live tables. "How did it change" comes from
 * hotel_metrics_daily — the nightly snapshot — because subscription rows are
 * upserted in place and remember nothing. Everything is month-equivalent cents
 * (annual divided by twelve) so monthly and annual properties sum into one line.
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

/** True when a snapshot row represents money actually being collected. */
export function isPayingRow(row: { entitled: boolean; status: string }): boolean {
  return row.entitled && row.status !== "trialing";
}

/** Aggregate per-hotel snapshot rows into one point per day. */
export function aggregateSeries(
  rows: { day: string; entitled: boolean; status: string; list_mrr_cents: number; net_mrr_cents: number }[],
): DayPoint[] {
  const byDay = new Map<string, DayPoint>();
  for (const r of rows) {
    const p = byDay.get(r.day) ?? { day: r.day, listMrrCents: 0, netMrrCents: 0, paying: 0, trialing: 0 };
    if (isPayingRow(r)) {
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

/**
 * Subscription lifecycle events, derived by comparing each hotel's consecutive
 * snapshot days. First entitled day ever = new; entitled→not = churn; back
 * again = win-back. The derivation wants history BEFORE the range too, or a
 * long-standing customer's first day inside the window would read as "new" —
 * callers pass every row from the beginning of time up to the range end, and
 * only events landing inside [fromDay, toDay] are reported.
 */
export function deriveEvents(
  rows: { day: string; hotel_id: string; entitled: boolean; status: string }[],
  fromDay: string,
  toDay: string,
): { newPaying: { hotelId: string; day: string }[]; churned: { hotelId: string; day: string }[]; wonBack: { hotelId: string; day: string }[] } {
  // The day the table itself begins is a census of who already existed, not a
  // day everyone signed up. Without this, the migration's first run reports the
  // entire customer base as new — and the default 30-day range keeps saying so
  // for a month.
  const firstDay = rows.reduce<string | null>((min, r) => (min === null || r.day < min ? r.day : min), null);

  const byHotel = new Map<string, { day: string; paying: boolean }[]>();
  for (const r of rows) {
    if (!byHotel.has(r.hotel_id)) byHotel.set(r.hotel_id, []);
    byHotel.get(r.hotel_id)!.push({ day: r.day, paying: isPayingRow(r) });
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

export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * PostgREST silently caps a response at 1000 rows, and every table here grows
 * past that within weeks — hotel_metrics_daily writes one row per hotel per
 * day. A truncated read here doesn't error, it just quietly reports less money
 * than exists, so nothing in this file may select without paging.
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

const BRACKETS = [
  { label: "1–20", max: 20 },
  { label: "21–40", max: 40 },
  { label: "41–60", max: 60 },
  { label: "61–80", max: 80 },
  { label: "81–500", max: 500 },
];

type SubRow = {
  hotel_id: string;
  status: string;
  billing_interval: BillingInterval;
  billed_rooms: number;
  plan_kind: string;
  signup_code_id: string | null;
};

/** Hotels the panel is allowed to count, and their names. */
async function loadScopedHotels(admin: SupabaseClient, scope: AnalyticsScope) {
  const rows = await pageAll<{ id: string; name: string }>((from, to) => {
    let q = admin.from("hotels").select("id, name, is_test");
    if (!scope.includeTest) q = q.eq("is_test", false);
    return q.range(from, to);
  }, "hotels");
  const nameById = new Map<string, string>();
  for (const h of rows) nameById.set(String(h.id), String(h.name));
  return nameById;
}

async function loadSubsWithCodes(admin: SupabaseClient, allowed: Map<string, string>) {
  const subs = await pageAll<SubRow>(
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

/** One hotel's snapshot row, shared by the nightly writer and the lazy one. */
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

/** Write (or refresh) every hotel's row for one UTC day. Idempotent. */
export async function snapshotHotelMetrics(admin: SupabaseClient, day: string): Promise<number> {
  // Snapshots include test hotels, flagged — the row is a historical fact and
  // the reader decides what to count. Filtering at write time would make a
  // hotel flagged today rewrite last week.
  const { data: hotelRows } = await admin.from("hotels").select("id, name, is_test");
  const testById = new Map((hotelRows ?? []).map((h) => [String(h.id), h.is_test === true]));
  const allHotels = new Map((hotelRows ?? []).map((h) => [String(h.id), String(h.name)]));
  const { subs, codeById } = await loadSubsWithCodes(admin, allHotels);
  if (subs.length === 0) return 0;
  const { data: settings } = await admin.from("hotel_settings").select("hotel_id, simulation_mode");
  const simByHotel = new Map((settings ?? []).map((s) => [String(s.hotel_id), s.simulation_mode === true]));
  const rows = subs.map((s) => ({
    ...rowFor(day, s, s.signup_code_id ? codeById.get(s.signup_code_id) ?? null : null, simByHotel.get(s.hotel_id) ?? false),
    is_test: testById.get(s.hotel_id) ?? false,
  }));
  const { error } = await admin.from("hotel_metrics_daily").upsert(rows, { onConflict: "day,hotel_id" });
  if (error) throw new Error(`hotel_metrics_daily: ${error.message}`);
  return rows.length;
}

export async function loadAnalyticsNow(admin: SupabaseClient, scope: AnalyticsScope): Promise<AnalyticsNow> {
  const nameById = await loadScopedHotels(admin, scope);
  const { subs, codeById } = await loadSubsWithCodes(admin, nameById);
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
      const bracket = now.byBracket[BRACKETS.findIndex((b) => s.billed_rooms <= b.max)] ?? now.byBracket[now.byBracket.length - 1];
      bracket.count += 1;
      bracket.netMrrCents += net;
    }
  }

  const entitledIds = stripeSubs.filter((s) => isEntitledStatus(s.status)).map((s) => s.hotel_id);
  const ref = (hotelId: string): HotelRef => ({ hotelId, name: nameById.get(hotelId) ?? hotelId });

  {
    const entitledSet = new Set(entitledIds);
    const settings = await pageAll<{ hotel_id: string; simulation_mode: boolean }>(
      (f, t) => admin.from("hotel_settings").select("hotel_id, simulation_mode").range(f, t),
      "hotel_settings",
    );
    // Counted off the entitled set rather than the settings rows, so a hotel
    // with no settings row still lands on one side — silently belonging to
    // neither is how these two stop summing to the tile above them.
    const simulating = new Set(settings.filter((r) => r.simulation_mode === true).map((r) => String(r.hotel_id)));
    for (const id of entitledSet) {
      if (simulating.has(id)) now.simulationCount += 1;
      else now.liveCount += 1;
    }
  }

  // The attention list: states that name a customer and an action, nothing else.
  {
    const rows = await pageAll<Record<string, unknown>>(
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
    const conns = await pageAll<Record<string, unknown>>(
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
    // Entitled hotels the engine hasn't visited in a day: paying for silence.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const runs = await pageAll<{ hotel_id: string }>(
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

export async function loadAnalyticsRange(
  admin: SupabaseClient,
  fromDay: string,
  toDay: string,
  scope: AnalyticsScope,
): Promise<AnalyticsRange> {
  const nameById = await loadScopedHotels(admin, scope);
  // Full history up to the range end: deriveEvents needs the before-times so a
  // long-standing customer doesn't read as "new" on the window's first day.
  const snapRows = await pageAll<Record<string, unknown>>((from, to) => {
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

  const series = aggregateSeries(all.filter((r) => r.day >= fromDay));
  const events = deriveEvents(all, fromDay, toDay);
  const named = (e: { hotelId: string; day: string }): SubscriptionEvent => ({
    ...e,
    name: nameById.get(e.hotelId) ?? e.hotelId,
  });

  const fromTs = `${fromDay}T00:00:00Z`;
  const toTs = `${toDay}T23:59:59Z`;
  const hotelIds = [...nameById.keys()];
  /** Onboarding milestones, counted only for hotels the scope allows. */
  const countStage = async (col: string) => {
    if (hotelIds.length === 0) return 0;
    // Paged rather than counted: `.in()` on every hotel id is a URI the server
    // will eventually refuse, and a swallowed failure here would render as a
    // funnel stage of zero — indistinguishable from nobody converting.
    const rows = await pageAll<{ hotel_id: string }>(
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
  // An account exists before any hotel does, so there is no is_test flag to
  // read — the email is the only signal, and a +suffix address is the
  // convention every test account here follows (the same one the migration
  // used to flag their properties). profiles carries no email, so this asks
  // auth, which is also the only place a never-onboarded signup appears.
  let accounts = 0;
  {
    const profiles = await pageAll<{ id: string }>(
      (f, t) =>
        admin.from("profiles").select("id, created_at").gte("created_at", fromTs).lte("created_at", toTs).range(f, t),
      "profiles",
    );
    const ids = new Set(profiles.map((p) => String(p.id)));
    if (ids.size === 0 || scope.includeTest) {
      accounts = ids.size;
    } else {
      // Every page of users, not the first: GoTrue returns newest-first, so a
      // single page would progressively lose the test accounts of older ranges
      // and over-count real signups. A failure throws rather than silently
      // counting every walkthrough as a customer.
      const testIds = new Set<string>();
      for (let page = 1; page <= 20; page += 1) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        if (error) throw new Error(`auth.listUsers: ${error.message}`);
        const users = data?.users ?? [];
        for (const u of users) {
          if (String(u.email ?? "").includes("+")) testIds.add(u.id);
        }
        if (users.length < 200) break;
      }
      accounts = [...ids].filter((id) => !testIds.has(id)).length;
    }
  }
  // From the subscription's own created_at, not the snapshot: the snapshot
  // table starts empty, so deriving this from it reported zero paid signups
  // beside real account and connect counts — a checkout collapse that never
  // happened.
  let paid = 0;
  {
    const rows = await pageAll<{ hotel_id: string }>(
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

  // First engine run per hotel stands in for "first live price" — the price
  // table keeps no timestamps, and the first run is when pricing began.
  let medianHoursToLive: number | null = null;
  {
    const runs = await pageAll<{ hotel_id: string; evaluated_at: string }>(
      (f, t) =>
        admin.from("evaluation_run_log").select("hotel_id, evaluated_at").order("evaluated_at", { ascending: true }).range(f, t),
      "evaluation_run_log",
    );
    const firstRun = new Map<string, string>();
    for (const r of runs) {
      const id = String(r.hotel_id);
      if (!firstRun.has(id)) firstRun.set(id, String(r.evaluated_at));
    }
    const states = await pageAll<{ hotel_id: string; connected_at: string }>(
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
    medianHoursToLive = medianOf(hours);
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
