/**
 * Which nights a rule is about to change, before the owner switches it on or
 * saves it: the activation popup's calendar and its "X days will be affected
 * by this rule".
 *
 * The answer is the engine's, never an estimate. Two dry runs of the same
 * evaluateHotel the scheduled sync runs (DryRun in engine/evaluate.ts: the
 * real engine on the hotel's real data, writing nothing), at the same
 * instant: "after", the hotel with the rule as it will be once the owner
 * applies it (on, with the draft's settings, no Skip), and "before", the
 * hotel exactly as stored. A night is affected when at least one room type's
 * price differs between the two, to the cent. That takes every other rule
 * into account (stronger rules covering weaker ones, holds, waits, the one
 * change a room type gets per run), typed prices, floors and ceilings,
 * closed nights and nights left unpriced, because it is their output.
 *
 * Nights are priced independently (the pricing cadence rests on it:
 * cadence-equivalence.test.ts), so only the nights where the rule can have
 * any part are run, and "before" only where it did:
 *
 *   1. Nights the rule's scope and a days-before-arrival condition leave
 *      out are dropped (the engine never judges it there, and every
 *      condition must hold), except where it already has a change on the
 *      price. Pure, no reads.
 *   2. A standard (ladder) rule's decisions read only its own numbers and
 *      state, never another rule's: a dry run of its ladder part alone finds
 *      the nights where its change on the price moves (on, off, a new
 *      amount), and only those are run whole, both ways. For an edit to a
 *      rule that is on, the rule as stored is run the same way, since left
 *      alone it would act on what it matches now too.
 *   3. An event rule (booking speed or pickup count) runs whole on the
 *      nights left; "before" then runs where it had a part (a change on the
 *      price, or its condition met: DryRunCapture.touched), or, for an edit
 *      to a rule that is on, on the same nights as "after". Unless the edit
 *      changes only the amount (or the undo box) and moves the rule past no
 *      other rule's change in the order they rank in: then the rule as
 *      stored meets its condition exactly where the rule as saved does,
 *      except where it has fires (open or taken off, where it can wait),
 *      and "before" runs on those nights alone.
 *
 * Every run of one preview (one request: the whole window, or one of the
 * popup's parts) reads the booking history booking speed compares with once
 * and shares it, with the season model, each night's comparable nights and
 * each reading worked out from it (they are at the same instant against the
 * same data), and reads the history of nights already over from the hotel
 * day's store where a scheduled run saved it (HistoryLoad in
 * engine/booking-speed-provider.ts). booking-speed-reuse.test.ts proves the
 * days and prices come out exactly as without.
 *
 * rule-preview.test.ts proves each step gives the nights a full "after"
 * against a full "before" gives, and that Apply then changes exactly those
 * prices, on both copies of the engine.
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { historyReuse, type HistoryLoad } from "@/lib/engine/booking-speed-provider";
import { dryRunCapture, evaluateHotel, type DryRunCapture } from "@/lib/engine/evaluate";
import type { LadderOp } from "@/lib/engine/ladder";
import { computeDta } from "@/lib/engine/metrics";
import { comparePickupRules, versionRanksOf, type RankedRule } from "@/lib/engine/pickup";
import { fetchAllRows } from "@/lib/engine/snapshots";
import { ruleScopeMatches } from "@/lib/engine/scope";
import { addCalendarDays, evalIsoToHotelDateString } from "@/lib/engine/timezone";
import { farOutCutFacts, type FarOutCutFacts } from "@/lib/rule-form";
import type { EngineRule, RuleCondition } from "@/types/domain";

/** evaluateHotel, or the edge functions' copy of it (the tests run both). */
export type EvaluateFn = typeof evaluateHotel;

/** A rule in the shape the engine reads rules in: pricing_rules with its condition and room type sets. */
export type EngineRuleRow = Record<string, unknown> & { id: string };

/** The columns the engine reads a rule with (evaluate.ts ruleSelect), for reading a stored rule the same way. */
export const ENGINE_RULE_COLUMNS = `
  id, hotel_id, name, is_active, version, priority,
  start_date, end_date, is_annual, dow_mask,
  action_type, action_direction, action_value,
  is_pickup_rule, created_at, updated_at, undo_on_cancellation, skip_at, version_ranks,
  rule_condition (
    occupancy_operator, occupancy_threshold,
    dta_operator, dta_threshold_days,
    pickup_operator, pickup_threshold, pickup_window_days, pickup_metric, pickup_cooldown_days,
    booking_speed_operator, booking_speed_level,
    booking_speed_window_days, booking_speed_cooldown_days
  ),
  rule_signal_room_type ( room_type_id ),
  rule_affected_room_type ( room_type_id )
`;

export type PreviewInput = {
  hotelId: string;
  /** The rule as it will be after Apply, in the engine's shape. Taken as on, with no Skip. */
  after: EngineRuleRow;
  /**
   * The rule as stored, when it is on now (an edit to a rule that is on):
   * left alone, it would act on what it matches now, so the nights where it
   * would count too.
   */
  before?: EngineRuleRow | null;
  /** The instant both runs are for. */
  at: string;
  /** The hotel's pricing window, in nights (hotelPricingHorizon). */
  horizonDays: number;
  /** The nights of the window to look at (a chunk of the popup's calendar); the whole window when left out. */
  from?: string;
  to?: string;
};

/**
 * How a preview reads the booking history (see the header): shared by its
 * runs and read from the store, unless a test asks for every run to read
 * afresh to compare.
 */
export type PreviewHistory = { reuse?: boolean; store?: boolean };

function historyFor(opts: PreviewHistory): HistoryLoad {
  return { reuse: opts.reuse === false ? null : historyReuse(), store: opts.store === false ? null : "read" };
}

export type PreviewResult = {
  ruleId: string;
  at: string;
  /** The hotel's today and the window's last night. */
  today: string;
  lastNight: string;
  horizonDays: number;
  /** The nights this answer covers. */
  from: string;
  to: string;
  /** Nights where Apply changes at least one room type's price, sorted. */
  affected: string[];
  /** Per affected night, how many room types' prices change. */
  roomTypesChanged: Record<string, number>;
  /** Nights where the rule had any part (priced first after the save). */
  touched: string[];
  /** Nights run whole, "after" and "before" together. */
  nightsChecked: number;
  /**
   * Nights of this answer the rule as saved can act on at all: in its scope
   * with any days-before-arrival condition met (nightsInScope). What the
   * popup calls the nights a cut on low pickup reaches (farOutCut).
   */
  reach: number;
  /**
   * The facts the popup adds for a cut on low pickup with no
   * days-before-arrival condition (farOutCutFacts in rule-form.ts), null
   * for every other rule.
   */
  farOutCut: FarOutCutFacts | null;
  kind: "standard" | "event";
  ms: number;
};

/** farOutCutFacts for a rule in the engine's read shape. */
export function farOutCutOfRow(row: EngineRuleRow): FarOutCutFacts | null {
  const rc = one<Record<string, unknown>>(row.rule_condition);
  return farOutCutFacts(rc as RuleCondition | undefined, row.action_direction as string | null | undefined);
}

/** YYYY-MM-DD */
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function nightsFrom(first: string, last: string): string[] {
  const out: string[] = [];
  for (let d = first; d <= last; d = addCalendarDays(d, 1)) out.push(d);
  return out;
}

function one<T>(v: unknown): T | undefined {
  return (Array.isArray(v) ? v[0] : v) as T | undefined;
}

function ids(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String((x as { room_type_id: unknown }).room_type_id)) : [];
}

/** Whether the rule counts bookings (booking speed or pickup): the engine's event rules. */
export function isEventRuleRow(row: EngineRuleRow): boolean {
  return Boolean(row.is_pickup_rule);
}

/**
 * Nights of `nights` where the rule could have any part: in its scope (its
 * date window, weekdays, a room type to change) with a days-before-arrival
 * condition met, as the engine judges both. Deliberately loose on the
 * signal set, which the engine may have emptied: a night is only dropped
 * when the engine never judges the rule there.
 */
export function nightsInScope(row: EngineRuleRow, nights: readonly string[], today: string, at: string, timeZone: string): string[] {
  const rc = one<Record<string, unknown>>(row.rule_condition) ?? {};
  const scopeRule = {
    is_active: true,
    signal_room_type_ids: ids(row.rule_signal_room_type),
    affected_room_type_ids: ids(row.rule_affected_room_type),
    start_date: (row.start_date as string | null) ?? null,
    end_date: (row.end_date as string | null) ?? null,
    is_annual: Boolean(row.is_annual),
    dow_mask: Number(row.dow_mask ?? 127),
  } as unknown as EngineRule;
  const dtaOp = rc.dta_operator as string | null | undefined;
  const dtaDays = rc.dta_threshold_days != null ? Number(rc.dta_threshold_days) : null;
  return nights.filter((d) => {
    if (!ruleScopeMatches(scopeRule, d, at, timeZone, { requireSignals: false })) return false;
    if (dtaOp && dtaDays != null) {
      const dta = computeDta(d, today);
      if (dtaOp === "gt" && !(dta > dtaDays)) return false;
      if (dtaOp === "lt" && !(dta < dtaDays)) return false;
    }
    return true;
  });
}

/**
 * Nights where the rule has a change on the price now: a ladder row that is
 * on, or a fire still on the night. Paged in a stable order: a rule on a
 * large property can have more rows than one read returns (PostgREST's max
 * rows), and a night left out here is a night the popup never checks and a
 * Skip never marks.
 */
export async function nightsWithState(
  client: SupabaseClient,
  hotelId: string,
  ruleId: string,
  first: string,
  last: string,
): Promise<string[]> {
  const out = new Set<string>();
  const read = (what: string, query: () => unknown) =>
    fetchAllRows(query).catch((e: unknown) => {
      throw new Error(`Could not read the rule's changes (${what}): ${e instanceof Error ? e.message : String(e)}`);
    });
  const [ladder, fires] = await Promise.all([
    read("ladder_rule_state", () =>
      client
        .from("ladder_rule_state")
        .select("stay_date, room_type_id")
        .eq("rule_id", ruleId)
        .eq("is_active", true)
        .gte("stay_date", first)
        .lte("stay_date", last)
        .order("stay_date", { ascending: true })
        .order("room_type_id", { ascending: true }),
    ),
    read("pickup_event", () =>
      client
        .from("pickup_event")
        .select("stay_date, id")
        .eq("hotel_id", hotelId)
        .eq("rule_id", ruleId)
        .is("retired_at", null)
        .gte("stay_date", first)
        .lte("stay_date", last)
        .order("stay_date", { ascending: true })
        .order("id", { ascending: true }),
    ),
  ]);
  for (const r of [...ladder, ...fires]) out.add(String((r as { stay_date: unknown }).stay_date).slice(0, 10));
  return [...out].sort();
}

/**
 * Nights where the rule has a fire row at all, on the price or taken off
 * (cancellations, a typed price, an edit): where it can be waiting, or have
 * "Stop for this night" answers, without a change on the price. Paged.
 */
async function nightsWithFires(client: SupabaseClient, hotelId: string, ruleId: string, first: string, last: string): Promise<string[]> {
  const rows = await fetchAllRows(() =>
    client
      .from("pickup_event")
      .select("stay_date, id")
      .eq("hotel_id", hotelId)
      .eq("rule_id", ruleId)
      .gte("stay_date", first)
      .lte("stay_date", last)
      .order("stay_date", { ascending: true })
      .order("id", { ascending: true }),
  ).catch((e: unknown) => {
    throw new Error(`Could not read the rule's changes (pickup_event): ${e instanceof Error ? e.message : String(e)}`);
  });
  return [...new Set(rows.map((r) => String((r as { stay_date: unknown }).stay_date).slice(0, 10)))].sort();
}

/** The condition columns that decide what a rule counts and when (ENGINE_RULE_COLUMNS). */
const COUNT_COLUMNS = [
  "occupancy_operator",
  "occupancy_threshold",
  "dta_operator",
  "dta_threshold_days",
  "pickup_operator",
  "pickup_threshold",
  "pickup_window_days",
  "pickup_metric",
  "pickup_cooldown_days",
  "booking_speed_operator",
  "booking_speed_level",
  "booking_speed_window_days",
  "booking_speed_cooldown_days",
] as const;

function plain(v: unknown): string | number | boolean | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  const s = String(v);
  return s.trim() !== "" && Number.isFinite(Number(s)) ? Number(s) : s;
}

/** A rule row as comparePickupRules reads it. */
function rankOfRow(row: EngineRuleRow): RankedRule {
  const rc = one<Record<string, unknown>>(row.rule_condition) ?? {};
  return {
    id: String(row.id),
    version: Number(row.version ?? 1),
    priority: Number(row.priority ?? 100),
    action_type: row.action_type as RankedRule["action_type"],
    action_direction: row.action_direction as RankedRule["action_direction"],
    action_value: Number(row.action_value),
    created_at: String(row.created_at ?? ""),
    condition: {
      occupancy_operator: (rc.occupancy_operator ?? null) as RankedRule["condition"]["occupancy_operator"],
      dta_operator: (rc.dta_operator ?? null) as RankedRule["condition"]["dta_operator"],
      pickup_operator: (rc.pickup_operator ?? null) as RankedRule["condition"]["pickup_operator"],
      pickup_threshold: rc.pickup_threshold != null ? Number(rc.pickup_threshold) : null,
      pickup_metric: (rc.pickup_metric ?? null) as RankedRule["condition"]["pickup_metric"],
      booking_speed_operator: (rc.booking_speed_operator ?? null) as RankedRule["condition"]["booking_speed_operator"],
      booking_speed_level: rc.booking_speed_level != null ? String(rc.booking_speed_level) : null,
    },
  };
}

/**
 * Whether the rule as saved counts, waits, scopes and competes exactly as
 * the rule as stored, but for its amount (and the undo box, which only
 * judges the rule's own changes on the price): the same condition, room
 * types, dates, weekdays, direction and priority, a booking speed or pickup
 * rule both times, and no Skip on the stored one (its holds make it act
 * differently from the rule as saved, which has none).
 */
export function countsTheSameWay(before: EngineRuleRow, after: EngineRuleRow): boolean {
  if (!isEventRuleRow(before) || !isEventRuleRow(after)) return false;
  if (before.skip_at != null) return false;
  const cb = one<Record<string, unknown>>(before.rule_condition) ?? {};
  const ca = one<Record<string, unknown>>(after.rule_condition) ?? {};
  if (COUNT_COLUMNS.some((k) => plain(cb[k]) !== plain(ca[k]))) return false;
  const set = (v: unknown) => [...new Set(ids(v))].sort().join(",");
  if (set(before.rule_signal_room_type) !== set(after.rule_signal_room_type)) return false;
  if (set(before.rule_affected_room_type) !== set(after.rule_affected_room_type)) return false;
  for (const k of ["start_date", "end_date", "is_annual", "dow_mask", "action_direction", "priority"]) {
    if (plain(before[k]) !== plain(after[k])) return false;
  }
  return Date.parse(String(before.created_at)) === Date.parse(String(after.created_at));
}

/**
 * Whether a rule moving from `was` to `now` (its amount alone) keeps its
 * place against `other` on every cell, whatever the cell's base price:
 * both amounts of one kind with `other`'s, each either equal to `other`'s
 * or at least a whole point or dollar away (so rounding never makes a tie
 * that wasn't there), and the same order at a base of 100. At a base of 0
 * every percent ties and the rest of the order decides, the same both times.
 */
export function keepsItsPlace(other: RankedRule, was: RankedRule, now: RankedRule): boolean {
  if (other.action_type !== was.action_type || other.action_type !== now.action_type) return false;
  const clear = (d: number) => d === 0 || Math.abs(d) >= 1;
  if (!clear(other.action_value - was.action_value) || !clear(other.action_value - now.action_value)) return false;
  return Math.sign(comparePickupRules(other, was, 100, 100)) === Math.sign(comparePickupRules(other, now, 100, 100));
}

/**
 * Whether "before" needs to run only where the rule as saved has a part (see
 * previewRule): the rule counts the same way (countsTheSameWay) and keeps
 * its place against every other rule's way of ranking a change, each rule's
 * as it is and each earlier version still recorded (version_ranks), raises
 * and cuts alike (the strongest candidate on a cell fires, whichever way).
 * False when anything can't be read or isn't known, and the full run
 * decides.
 */
async function storedActsOnlyWhereSavedDoes(
  client: SupabaseClient,
  hotelId: string,
  before: EngineRuleRow,
  after: EngineRuleRow,
): Promise<boolean> {
  if (!countsTheSameWay(before, after)) return false;
  const { data, error } = await client
    .from("pricing_rules")
    .select(
      "id, version, priority, action_type, action_direction, action_value, created_at, is_pickup_rule, version_ranks, rule_condition ( occupancy_operator, dta_operator, pickup_operator, pickup_threshold, pickup_metric, booking_speed_operator, booking_speed_level )",
    )
    .eq("hotel_id", hotelId);
  if (error || !data) return false;
  const ruleId = String(before.id);
  const others: RankedRule[] = [];
  for (const row of data as unknown as EngineRuleRow[]) {
    if (String(row.id) === ruleId) continue;
    const rank = rankOfRow(row);
    if (isEventRuleRow(row)) others.push(rank);
    if (row.version_ranks == null) continue;
    const ranks = versionRanksOf(row.version_ranks);
    if (!ranks) return false;
    for (const was of Object.values(ranks)) {
      if (was.action_type === undefined || was.action_direction === undefined || was.action_value === undefined) return false;
      others.push({
        ...rank,
        priority: was.priority,
        condition: { ...was.condition },
        action_type: was.action_type,
        action_direction: was.action_direction,
        action_value: was.action_value,
      });
    }
  }
  const was = rankOfRow(before);
  const now = rankOfRow(after);
  return others.every((other) => keepsItsPlace(other, was, now));
}

/** The nights (and how many room types on each) where two runs' prices differ, to the cent. */
export function nightsThatDiffer(
  after: ReadonlyMap<string, number>,
  before: ReadonlyMap<string, number>,
  nights: ReadonlySet<string>,
): Map<string, number> {
  const out = new Map<string, number>();
  const cents = (v: number | undefined) => (v === undefined ? null : Math.round(v * 100));
  const keys = new Set([...after.keys(), ...before.keys()]);
  for (const key of keys) {
    const night = key.slice(0, 10);
    if (!nights.has(night)) continue;
    if (cents(after.get(key)) !== cents(before.get(key))) out.set(night, (out.get(night) ?? 0) + 1);
  }
  return out;
}

/** Whether a ladder decision moves the rule's change on the price. */
export function ladderOpMovesPrice(op: LadderOp): boolean {
  if (op.kind === "activate") return op.effect || op.hadEffect;
  return op.hadEffect;
}

async function hotelClock(client: SupabaseClient, hotelId: string, at: string): Promise<{ timeZone: string; today: string }> {
  const { data, error } = await client.from("hotels").select("timezone").eq("id", hotelId).maybeSingle();
  if (error) throw new Error(`Could not read the hotel's time zone: ${error.message}`);
  const timeZone = (data?.timezone as string | null) ?? "UTC";
  return { timeZone, today: evalIsoToHotelDateString(at, timeZone) };
}

/**
 * The nights Apply would change, for the nights asked (see the header).
 * `client` must be able to read every engine table (the service role, behind
 * the route's gate); the runs write nothing, and readOnlyClient makes sure.
 */
export async function previewRule(
  client: SupabaseClient,
  input: PreviewInput,
  evaluate: EvaluateFn = evaluateHotel,
  historyOpts: PreviewHistory = {},
): Promise<PreviewResult> {
  const started = Date.now();
  const ruleId = String(input.after.id);
  const horizon = Math.max(1, Math.floor(input.horizonDays));
  const { timeZone, today } = await hotelClock(client, input.hotelId, input.at);
  const lastNight = addCalendarDays(today, horizon - 1);
  const from = input.from && YMD.test(input.from) && input.from > today ? input.from : today;
  const to = input.to && YMD.test(input.to) && input.to < lastNight ? input.to : lastNight;
  const kind = isEventRuleRow(input.after) ? "event" : "standard";
  const after = { ...input.after, is_active: true, skip_at: null };
  // The nights of this answer the rule as saved can act on (its reach).
  const afterScope = from > to ? [] : nightsInScope(after, nightsFrom(from, to), today, input.at, timeZone);
  const result = (affected: Map<string, number>, touched: Iterable<string>, nightsChecked: number): PreviewResult => ({
    ruleId,
    at: input.at,
    today,
    lastNight,
    horizonDays: horizon,
    from,
    to,
    affected: [...affected.keys()].sort(),
    roomTypesChanged: Object.fromEntries([...affected.entries()].sort()),
    touched: [...new Set(touched)].sort(),
    nightsChecked,
    reach: afterScope.length,
    farOutCut: farOutCutOfRow(after),
    kind,
    ms: Date.now() - started,
  });
  if (from > to) return result(new Map(), [], 0);

  const ro = readOnlyClient(client);
  const history = historyFor(historyOpts);
  const run = async (nights: string[], withRule: boolean, opts: { watch?: boolean; ladderOnly?: boolean } = {}) => {
    const capture = dryRunCapture();
    if (nights.length === 0) return capture;
    await evaluate(ro, input.hotelId, input.at, horizon, {
      nights,
      history,
      dryRun: {
        ...(withRule ? { rule: after } : {}),
        ...(opts.watch ? { watch: ruleId } : {}),
        ...(opts.ladderOnly ? { ladderOnly: true } : {}),
        capture,
      },
    });
    return capture;
  };

  // The rule as stored, where it acts now (an edit to a rule that is on).
  const before = input.before?.is_active ? input.before : null;
  const window = nightsFrom(from, to);
  const state = await nightsWithState(client, input.hotelId, ruleId, from, to);
  const scoped = new Set([
    ...afterScope,
    ...(before ? nightsInScope(before, window, today, input.at, timeZone) : []),
    ...state,
  ]);
  const p0 = [...scoped].sort();

  if (kind === "standard" && (!before || !isEventRuleRow(before))) {
    // Where its ladder part moves its change on the price, as saved or as
    // stored: only there can the hotel's prices differ.
    const [ladderAfter, ladderBefore] = await Promise.all([
      run(p0, true, { watch: true, ladderOnly: true }),
      before ? run(p0, false, { watch: true, ladderOnly: true }) : Promise.resolve(dryRunCapture()),
    ]);
    const p1 = [
      ...new Set([...ladderAfter.ladderOps, ...ladderBefore.ladderOps].filter(ladderOpMovesPrice).map((op) => op.stayDate)),
    ].sort();
    const [a, b] = await Promise.all([run(p1, true), run(p1, false)]);
    return result(nightsThatDiffer(a.prices, b.prices, new Set(p1)), p1, p1.length * 2);
  }

  if (before && (await storedActsOnlyWhereSavedDoes(client, input.hotelId, before, after))) {
    // Only the amount (or the undo box) changed, and no other rule's change
    // ranks differently against it: the rule as stored can act only where the
    // rule as saved has a part, or where it has a change on the price, now or
    // taken off (its wait and its answers live there). "Before" runs there.
    const a = await run(p0, true, { watch: true });
    const fired = await nightsWithFires(client, input.hotelId, ruleId, from, to);
    const bNights = [...new Set([...a.touched, ...fired])].filter((d) => scoped.has(d)).sort();
    const b = await run(bNights, false);
    return result(nightsThatDiffer(a.prices, b.prices, new Set(bNights)), bNights, p0.length + bNights.length);
  }

  if (before) {
    // The rule acts both ways: every night it could act on, both ways.
    const [a, b] = await Promise.all([run(p0, true, { watch: true }), run(p0, false, { watch: true })]);
    const touched = [...new Set([...a.touched, ...b.touched])].filter((d) => scoped.has(d)).sort();
    return result(nightsThatDiffer(a.prices, b.prices, scoped), touched, p0.length * 2);
  }

  const a: DryRunCapture = await run(p0, true, { watch: true });
  const touched = [...a.touched].filter((d) => scoped.has(d)).sort();
  const b = await run(touched, false);
  return result(nightsThatDiffer(a.prices, b.prices, new Set(touched)), touched, p0.length + touched.length);
}

/**
 * The owner's Skip, as save_rule writes it
 * (99_supabase_migration_rule_activation_v1.sql): the days the popup showed
 * are held, each until the rule stops being true there and then becomes
 * true again, and every other day works as Apply would have it.
 *
 * A standard rule's holds are marks on its ladder rows, from its ladder
 * decisions on Apply on those days (a ladder-only dry run at the instant of
 * the Skip): each one that would move the rule's part in a price becomes
 * one that leaves it as it is (see SKIP in engine/ladder.ts):
 *
 *   - an activation: held (on, no change on the price);
 *   - a change taken off: kept, at its amount, until the rule is true there
 *     (carried instead, where the rule is true but no longer covers the
 *     room type or night: it then waits for the rule to stop first);
 *   - a change moved to the edited rule's amount: carried, at its old
 *     amount, while the rule holds, then kept;
 *   - anything that moves no price is left for the next run to do as Apply.
 *
 * A booking speed or pickup rule's holds are made by save_rule itself from
 * the days (rule_skip_hold): every room type it changes and every one with a
 * change of it on the price; the engine judges them as it goes (see SKIP in
 * engine/pickup.ts).
 */
export type SkipMark = { d: string; rt: string; w: "held" | "kept" | "carried" };

export function skipMarksFrom(ops: readonly LadderOp[], nights?: ReadonlySet<string>): SkipMark[] {
  const last = new Map<string, LadderOp>();
  for (const op of ops) if (!nights || nights.has(op.stayDate)) last.set(`${op.stayDate}|${op.roomTypeId}`, op);
  const out: SkipMark[] = [];
  for (const op of last.values()) {
    const at = { d: op.stayDate, rt: op.roomTypeId };
    if (op.kind === "activate") {
      if (op.effect) out.push({ ...at, w: "held" });
    } else if (op.kind === "deactivate") {
      if (op.hadEffect) out.push({ ...at, w: op.holds ? "carried" : "kept" });
    } else if (op.hadEffect && op.amountChanges) {
      out.push({ ...at, w: "carried" });
    }
  }
  return out.sort((x, y) => (x.d === y.d ? x.rt.localeCompare(y.rt) : x.d.localeCompare(y.d)));
}

/** What a Skip saves: a standard rule's marks, and the days it holds. */
export type SkipPlan = { marks: SkipMark[]; holdNights: string[] };

/**
 * The Skip for the rule as it will be saved, holding `held` (the days the
 * popup showed), or, when the popup could not work them out ("all"), every
 * day the rule could act on: in its scope, or with a change of it on the
 * price.
 */
export async function skipPlanForRule(
  client: SupabaseClient,
  input: Omit<PreviewInput, "from" | "to">,
  held: readonly string[] | "all",
  evaluate: EvaluateFn = evaluateHotel,
): Promise<SkipPlan> {
  const ruleId = String(input.after.id);
  const horizon = Math.max(1, Math.floor(input.horizonDays));
  const { timeZone, today } = await hotelClock(client, input.hotelId, input.at);
  const lastNight = addCalendarDays(today, horizon - 1);
  const after = { ...input.after, is_active: true, skip_at: null };
  let nights: string[];
  if (held === "all") {
    const state = await nightsWithState(client, input.hotelId, ruleId, today, lastNight);
    nights = [...new Set([...nightsInScope(after, nightsFrom(today, lastNight), today, input.at, timeZone), ...state])].sort();
  } else {
    nights = [...new Set(held)].filter((d) => YMD.test(d) && d >= today && d <= lastNight).sort();
  }
  if (nights.length === 0) return { marks: [], holdNights: [] };
  if (isEventRuleRow(after)) return { marks: [], holdNights: nights };
  const capture = dryRunCapture();
  await evaluate(readOnlyClient(client), input.hotelId, input.at, horizon, {
    nights,
    dryRun: { rule: after, watch: ruleId, ladderOnly: true, capture },
  });
  return { marks: skipMarksFrom(capture.ladderOps, new Set(nights)), holdNights: nights };
}

/**
 * Everything that can change a preview's answer, hashed: the hotel's time
 * zone and date, the last engine run that priced anything (a run changes the
 * rules' state), the touched-nights queue (bookings, typed prices, base
 * rates, rooms out of service and alert answers all mark nights), the
 * request for a new pass (other rules, room types, floors, closed periods,
 * the "not a fair comparison" flags), and every rule's version, switch and
 * Skip. Taken when the popup's numbers are worked out and again when the
 * owner clicks Apply or Skip: when it moved, the numbers are worked out
 * again before anything is saved.
 */
export async function previewFingerprint(client: SupabaseClient, hotelId: string, at: string): Promise<string> {
  const parts: unknown[] = [hotelId];
  const settle = async (label: string, q: PromiseLike<{ data: unknown; error: { message: string } | null }>) => {
    const { data, error } = await q;
    parts.push(label, error ? `error:${error.message}` : data);
  };
  const { timeZone, today } = await hotelClock(client, hotelId, at);
  parts.push(timeZone, today);
  await Promise.all([
    settle(
      "run",
      client
        .from("evaluation_run_log")
        .select("evaluated_at")
        .eq("hotel_id", hotelId)
        .or("run_kind.is.null,run_kind.neq.idle")
        .order("evaluated_at", { ascending: false })
        .limit(1),
    ),
    settle(
      "marks",
      client
        .from("pricing_dirty_nights")
        .select("stay_date, mark_seq")
        .eq("hotel_id", hotelId)
        .order("mark_seq", { ascending: false })
        .limit(1),
    ),
    settle("pass", client.from("hotel_pricing_state").select("full_reprice_seq").eq("hotel_id", hotelId).limit(1)),
    settle(
      "rules",
      client
        .from("pricing_rules")
        .select("id, version, is_active, updated_at, skip_at")
        .eq("hotel_id", hotelId)
        .order("id", { ascending: true }),
    ),
  ]);
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

/** The functions a dry run may call: reads only. */
const READ_RPCS = new Set([
  "audit_last_signatures",
  "booking_history_cache_get",
  "booking_speed_first_stay_date",
  "booking_speed_history_summary",
  "booking_speed_windows",
  "engine_booked_before",
  "engine_reservation_cells",
  "engine_run_gaps",
  "pickup_fire_heads",
  "snapshot_cells_at",
]);

const WRITES = new Set(["insert", "upsert", "update", "delete"]);

/**
 * A client that can only read: any insert, upsert, update or delete, and
 * any function outside the engine's reads, throws. The dry runs go through
 * it, so a write that slipped past the engine's dry-run switch fails loudly
 * instead of moving a price.
 */
export function readOnlyClient(client: SupabaseClient): SupabaseClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "from") {
        return (table: string) => {
          const builder = target.from(table);
          return new Proxy(builder, {
            get(b, p, r) {
              if (typeof p === "string" && WRITES.has(p)) {
                return () => {
                  throw new Error(`A dry run tried to ${p} ${table}.`);
                };
              }
              const v = Reflect.get(b, p, r);
              return typeof v === "function" ? v.bind(b) : v;
            },
          });
        };
      }
      if (prop === "rpc") {
        return (fn: string, args?: unknown, opts?: unknown) => {
          if (!READ_RPCS.has(fn)) throw new Error(`A dry run tried to call ${fn}.`);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (target.rpc as any)(fn, args, opts);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as SupabaseClient;
}

/* ── Several new rules at once ────────────────────────────────── */

/** Floors and ceilings about to be set with the rules, by room type (an import's limits). */
export type LimitOverrides = Record<string, { floor_price?: number; ceiling_price?: number }>;

export type SetPreviewInput = {
  hotelId: string;
  /** The new rules, as they will be after Apply, in the engine's shape. Taken as on, with no Skip. */
  rules: EngineRuleRow[];
  /**
   * Floors and ceilings saved with them. Both runs clamp to these, so the
   * days are the ones the rules change on the limits they will have.
   */
  limits?: LimitOverrides;
  at: string;
  horizonDays: number;
  from?: string;
  to?: string;
};

/**
 * The nights Apply would change when several new rules are switched on
 * together (an import from PIE): the popup's one count and calendar for all
 * of them. The same method as previewRule, for a set: a night is affected
 * when a full dry run with every one of them on prices any room type
 * differently, to the cent, from a full dry run of the hotel as it is
 * (both on the limits about to be set). Only nights where one of them can
 * have a part are run: for standard rules, where a ladder-only run of them
 * finds their change on the price moving; otherwise where any of them was
 * in scope, then "before" where any had a part.
 */
export async function previewRuleSet(
  client: SupabaseClient,
  input: SetPreviewInput,
  evaluate: EvaluateFn = evaluateHotel,
  historyOpts: PreviewHistory = {},
): Promise<PreviewResult> {
  const started = Date.now();
  const ids = input.rules.map((r) => String(r.id));
  const horizon = Math.max(1, Math.floor(input.horizonDays));
  const { timeZone, today } = await hotelClock(client, input.hotelId, input.at);
  const lastNight = addCalendarDays(today, horizon - 1);
  const from = input.from && YMD.test(input.from) && input.from > today ? input.from : today;
  const to = input.to && YMD.test(input.to) && input.to < lastNight ? input.to : lastNight;
  const after = input.rules.map((r) => ({ ...r, is_active: true, skip_at: null }));
  const kind = after.some(isEventRuleRow) ? "event" : "standard";
  const window = from > to ? [] : nightsFrom(from, to);
  const scope = new Set<string>();
  for (const rule of after) for (const d of nightsInScope(rule, window, today, input.at, timeZone)) scope.add(d);
  const result = (affected: Map<string, number>, touched: Iterable<string>, nightsChecked: number): PreviewResult => ({
    ruleId: ids[0] ?? "",
    at: input.at,
    today,
    lastNight,
    horizonDays: horizon,
    from,
    to,
    affected: [...affected.keys()].sort(),
    roomTypesChanged: Object.fromEntries([...affected.entries()].sort()),
    touched: [...new Set(touched)].sort(),
    nightsChecked,
    reach: scope.size,
    farOutCut: after.map(farOutCutOfRow).find((f) => f !== null) ?? null,
    kind,
    ms: Date.now() - started,
  });
  if (from > to || after.length === 0) return result(new Map(), [], 0);

  const ro = readOnlyClient(client);
  const history = historyFor(historyOpts);
  const run = async (nights: string[], withRules: boolean, opts: { watch?: boolean; ladderOnly?: boolean } = {}) => {
    const capture = dryRunCapture();
    if (nights.length === 0) return capture;
    await evaluate(ro, input.hotelId, input.at, horizon, {
      nights,
      history,
      dryRun: {
        ...(withRules ? { rules: after } : {}),
        ...(input.limits ? { roomTypeLimits: input.limits } : {}),
        ...(opts.watch ? { watch: ids } : {}),
        ...(opts.ladderOnly ? { ladderOnly: true } : {}),
        capture,
      },
    });
    return capture;
  };

  const p0 = [...scope].sort();
  if (kind === "standard") {
    const ladder = await run(p0, true, { watch: true, ladderOnly: true });
    const p1 = [...new Set(ladder.ladderOps.filter(ladderOpMovesPrice).map((op) => op.stayDate))].sort();
    const [a, b] = await Promise.all([run(p1, true), run(p1, false)]);
    return result(nightsThatDiffer(a.prices, b.prices, new Set(p1)), p1, p1.length * 2);
  }
  const a = await run(p0, true, { watch: true });
  const touched = [...a.touched].filter((d) => scope.has(d)).sort();
  const b = await run(touched, false);
  return result(nightsThatDiffer(a.prices, b.prices, new Set(touched)), touched, p0.length + touched.length);
}

/**
 * The Skip for several new rules switched on together: for each, the
 * days the popup showed (or, when it could not work them out, every day it
 * could act on), and a standard rule's marks on them from one ladder-only
 * dry run of them all (skipPlanForRule, for a set).
 */
export async function skipPlanForRules(
  client: SupabaseClient,
  input: Omit<SetPreviewInput, "from" | "to">,
  held: readonly string[] | "all",
  evaluate: EvaluateFn = evaluateHotel,
): Promise<Map<string, SkipPlan>> {
  const horizon = Math.max(1, Math.floor(input.horizonDays));
  const { timeZone, today } = await hotelClock(client, input.hotelId, input.at);
  const lastNight = addCalendarDays(today, horizon - 1);
  const after = input.rules.map((r) => ({ ...r, is_active: true, skip_at: null }));
  const window = nightsFrom(today, lastNight);
  const heldNights = held === "all" ? null : [...new Set(held)].filter((d) => YMD.test(d) && d >= today && d <= lastNight).sort();
  const nightsOf = new Map<string, string[]>();
  for (const rule of after) nightsOf.set(String(rule.id), heldNights ?? nightsInScope(rule, window, today, input.at, timeZone));
  const out = new Map<string, SkipPlan>();
  const standard = after.filter((r) => !isEventRuleRow(r) && (nightsOf.get(String(r.id)) ?? []).length > 0);
  let ops: LadderOp[] = [];
  if (standard.length > 0) {
    const nights = [...new Set(standard.flatMap((r) => nightsOf.get(String(r.id)) ?? []))].sort();
    const capture = dryRunCapture();
    await evaluate(readOnlyClient(client), input.hotelId, input.at, horizon, {
      nights,
      dryRun: {
        rules: standard,
        watch: standard.map((r) => String(r.id)),
        ladderOnly: true,
        ...(input.limits ? { roomTypeLimits: input.limits } : {}),
        capture,
      },
    });
    ops = capture.ladderOps;
  }
  for (const rule of after) {
    const id = String(rule.id);
    const nights = nightsOf.get(id) ?? [];
    if (nights.length === 0) out.set(id, { marks: [], holdNights: [] });
    else if (isEventRuleRow(rule)) out.set(id, { marks: [], holdNights: nights });
    else out.set(id, { marks: skipMarksFrom(ops.filter((op) => op.rule.id === id), new Set(nights)), holdNights: nights });
  }
  return out;
}
