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
  entitled: number;
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

/** Aggregate per-hotel snapshot rows into one point per day. */
export function aggregateSeries(
  rows: { day: string; entitled: boolean; status: string; list_mrr_cents: number; net_mrr_cents: number }[],
): DayPoint[] {
  const byDay = new Map<string, DayPoint>();
  for (const r of rows) {
    const p = byDay.get(r.day) ?? { day: r.day, listMrrCents: 0, netMrrCents: 0, entitled: 0, trialing: 0 };
    if (r.entitled) {
      p.entitled += 1;
      p.listMrrCents += r.list_mrr_cents;
      p.netMrrCents += r.net_mrr_cents;
    }
    if (r.status === "trialing") p.trialing += 1;
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
  rows: { day: string; hotel_id: string; entitled: boolean }[],
  fromDay: string,
  toDay: string,
): { newPaying: { hotelId: string; day: string }[]; churned: { hotelId: string; day: string }[]; wonBack: { hotelId: string; day: string }[] } {
  const byHotel = new Map<string, { day: string; entitled: boolean }[]>();
  for (const r of rows) {
    if (!byHotel.has(r.hotel_id)) byHotel.set(r.hotel_id, []);
    byHotel.get(r.hotel_id)!.push({ day: r.day, entitled: r.entitled });
  }
  const newPaying: { hotelId: string; day: string }[] = [];
  const churned: { hotelId: string; day: string }[] = [];
  const wonBack: { hotelId: string; day: string }[] = [];
  for (const [hotelId, days] of byHotel) {
    days.sort((a, b) => (a.day < b.day ? -1 : 1));
    let everEntitled = false;
    let prevEntitled = false;
    for (const d of days) {
      const inRange = d.day >= fromDay && d.day <= toDay;
      if (d.entitled && !prevEntitled) {
        if (inRange) (everEntitled ? wonBack : newPaying).push({ hotelId, day: d.day });
      } else if (!d.entitled && prevEntitled && inRange) {
        churned.push({ hotelId, day: d.day });
      }
      everEntitled = everEntitled || d.entitled;
      prevEntitled = d.entitled;
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

async function loadSubsWithCodes(admin: SupabaseClient) {
  const { data: subs, error } = await admin
    .from("hotel_subscriptions")
    .select("hotel_id, status, billing_interval, billed_rooms, plan_kind, signup_code_id");
  if (error) throw new Error(`hotel_subscriptions: ${error.message}`);
  const codeIds = [...new Set((subs ?? []).map((s) => s.signup_code_id).filter(Boolean))] as string[];
  const codeById = new Map<string, SignupCode>();
  if (codeIds.length) {
    const { data: codes, error: codeErr } = await admin.from("signup_codes").select("*").in("id", codeIds);
    if (codeErr) throw new Error(`signup_codes: ${codeErr.message}`);
    for (const c of codes ?? []) codeById.set(String(c.id), c as SignupCode);
  }
  return { subs: (subs ?? []) as SubRow[], codeById };
}

/** One hotel's snapshot row, shared by the nightly writer and the lazy one. */
function rowFor(day: string, sub: SubRow, code: SignupCode | null, simulation: boolean) {
  const stripePlan = sub.plan_kind !== "internal";
  const list = stripePlan ? monthlyListCents(sub.billed_rooms, sub.billing_interval) : 0;
  const entitled = stripePlan && isEntitledStatus(sub.status);
  return {
    day,
    hotel_id: sub.hotel_id,
    status: sub.status,
    entitled,
    plan_kind: sub.plan_kind,
    rooms: sub.billed_rooms,
    list_mrr_cents: entitled ? list : 0,
    net_mrr_cents: entitled ? monthlyNetCents(list, code) : 0,
    simulation,
  };
}

/** Write (or refresh) every hotel's row for one UTC day. Idempotent. */
export async function snapshotHotelMetrics(admin: SupabaseClient, day: string): Promise<number> {
  const { subs, codeById } = await loadSubsWithCodes(admin);
  if (subs.length === 0) return 0;
  const { data: settings } = await admin.from("hotel_settings").select("hotel_id, simulation_mode");
  const simByHotel = new Map((settings ?? []).map((s) => [String(s.hotel_id), s.simulation_mode === true]));
  const rows = subs.map((s) =>
    rowFor(day, s, s.signup_code_id ? codeById.get(s.signup_code_id) ?? null : null, simByHotel.get(s.hotel_id) ?? false),
  );
  const { error } = await admin.from("hotel_metrics_daily").upsert(rows, { onConflict: "day,hotel_id" });
  if (error) throw new Error(`hotel_metrics_daily: ${error.message}`);
  return rows.length;
}

export async function loadAnalyticsNow(admin: SupabaseClient): Promise<AnalyticsNow> {
  const { subs, codeById } = await loadSubsWithCodes(admin);
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
  const nameById = new Map<string, string>();
  {
    const { data: hotels } = await admin.from("hotels").select("id, name, is_active");
    for (const h of hotels ?? []) nameById.set(String(h.id), String(h.name));
  }
  const ref = (hotelId: string): HotelRef => ({ hotelId, name: nameById.get(hotelId) ?? hotelId });

  {
    const { data: settings } = await admin
      .from("hotel_settings")
      .select("hotel_id, simulation_mode")
      .in("hotel_id", entitledIds.length ? entitledIds : ["00000000-0000-0000-0000-000000000000"]);
    for (const s of settings ?? []) {
      if (s.simulation_mode === true) now.simulationCount += 1;
      else now.liveCount += 1;
    }
  }

  // The attention list: states that name a customer and an action, nothing else.
  {
    const { data } = await admin
      .from("hotel_subscriptions")
      .select("hotel_id, card_verify_failed_at, room_shortfall_since, status")
      .or("card_verify_failed_at.not.is.null,room_shortfall_since.not.is.null");
    for (const r of data ?? []) {
      if (r.card_verify_failed_at && isEntitledStatus(String(r.status))) now.attention.cardTrouble.push(ref(String(r.hotel_id)));
      if (r.room_shortfall_since) now.attention.roomShortfall.push(ref(String(r.hotel_id)));
    }
  }
  {
    const { data } = await admin.from("pms_connections").select("hotel_id, pms_type, status");
    for (const c of data ?? []) {
      if (String(c.status) !== "connected") {
        now.attention.syncBroken.push({ ...ref(String(c.hotel_id)), pmsType: String(c.pms_type), status: String(c.status) });
      }
    }
  }
  {
    // Entitled hotels the engine hasn't visited in a day: paying for silence.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data } = await admin
      .from("evaluation_run_log")
      .select("hotel_id, evaluated_at")
      .gte("evaluated_at", cutoff);
    const seen = new Set((data ?? []).map((r) => String(r.hotel_id)));
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
): Promise<AnalyticsRange> {
  // Full history up to the range end: deriveEvents needs the before-times so a
  // long-standing customer doesn't read as "new" on the window's first day.
  const { data: snapRows, error } = await admin
    .from("hotel_metrics_daily")
    .select("day, hotel_id, entitled, status, list_mrr_cents, net_mrr_cents")
    .lte("day", toDay)
    .order("day", { ascending: true });
  if (error) throw new Error(`hotel_metrics_daily: ${error.message}`);
  const all = (snapRows ?? []).map((r) => ({
    day: String(r.day),
    hotel_id: String(r.hotel_id),
    entitled: r.entitled === true,
    status: String(r.status),
    list_mrr_cents: Number(r.list_mrr_cents),
    net_mrr_cents: Number(r.net_mrr_cents),
  }));

  const series = aggregateSeries(all.filter((r) => r.day >= fromDay));
  const events = deriveEvents(all, fromDay, toDay);

  const nameById = new Map<string, string>();
  {
    const { data: hotels } = await admin.from("hotels").select("id, name");
    for (const h of hotels ?? []) nameById.set(String(h.id), String(h.name));
  }
  const named = (e: { hotelId: string; day: string }): SubscriptionEvent => ({
    ...e,
    name: nameById.get(e.hotelId) ?? e.hotelId,
  });

  const fromTs = `${fromDay}T00:00:00Z`;
  const toTs = `${toDay}T23:59:59Z`;
  const countIn = async (table: string, col: string, extra?: (q: unknown) => unknown) => {
    let q = admin.from(table).select("*", { count: "exact", head: true }).gte(col, fromTs).lte(col, toTs);
    if (extra) q = extra(q) as typeof q;
    const { count } = await q;
    return count ?? 0;
  };
  const funnel = [
    { stage: "Accounts created", count: await countIn("profiles", "created_at") },
    { stage: "Paid (checkout done)", count: events.newPaying.length + events.wonBack.length },
    { stage: "PMS connected", count: await countIn("onboarding_states", "connected_at") },
    { stage: "Onboarding finished", count: await countIn("onboarding_states", "questions_completed_at") },
  ];

  // First engine run per hotel stands in for "first live price" — the price
  // table keeps no timestamps, and the first run is when pricing began.
  let medianHoursToLive: number | null = null;
  {
    const { data: runs } = await admin
      .from("evaluation_run_log")
      .select("hotel_id, evaluated_at")
      .order("evaluated_at", { ascending: true })
      .limit(5000);
    const firstRun = new Map<string, string>();
    for (const r of runs ?? []) {
      const id = String(r.hotel_id);
      if (!firstRun.has(id)) firstRun.set(id, String(r.evaluated_at));
    }
    const { data: states } = await admin
      .from("onboarding_states")
      .select("hotel_id, connected_at")
      .not("connected_at", "is", null);
    const hours: number[] = [];
    for (const s of states ?? []) {
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
