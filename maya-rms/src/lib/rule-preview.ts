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
 *      amount), and only those are run whole, both ways.
 *   3. An event rule (booking speed or pickup count) runs whole on the
 *      nights left; "before" then runs where it had a part (a change on the
 *      price, or its condition met: DryRunCapture.touched).
 *
 * rule-preview.test.ts proves each step gives the nights a full "after"
 * against a full "before" gives, and that Apply then changes exactly those
 * prices, on both copies of the engine.
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dryRunCapture, evaluateHotel, type DryRunCapture } from "@/lib/engine/evaluate";
import type { LadderOp } from "@/lib/engine/ladder";
import { computeDta } from "@/lib/engine/metrics";
import { ruleScopeMatches } from "@/lib/engine/scope";
import { addCalendarDays, evalIsoToHotelDateString } from "@/lib/engine/timezone";
import type { EngineRule } from "@/types/domain";

/** evaluateHotel, or the edge functions' copy of it (the tests run both). */
export type EvaluateFn = typeof evaluateHotel;

/** A rule in the shape the engine reads rules in: pricing_rules with its condition and room type sets. */
export type EngineRuleRow = Record<string, unknown> & { id: string };

/** The columns the engine reads a rule with (evaluate.ts ruleSelect), for reading a stored rule the same way. */
export const ENGINE_RULE_COLUMNS = `
  id, hotel_id, name, is_active, version, priority,
  start_date, end_date, is_annual, dow_mask,
  action_type, action_direction, action_value,
  is_pickup_rule, created_at, updated_at, undo_on_cancellation, skip_at,
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
  /** The instant both runs are for. */
  at: string;
  /** The hotel's pricing window, in nights (hotelPricingHorizon). */
  horizonDays: number;
  /** The nights of the window to look at (a chunk of the popup's calendar); the whole window when left out. */
  from?: string;
  to?: string;
};

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
  kind: "standard" | "event";
  ms: number;
};

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

/** Nights where the rule has a change on the price now: a ladder row that is on, or a fire still on the night. */
async function nightsWithState(client: SupabaseClient, hotelId: string, ruleId: string, first: string, last: string): Promise<string[]> {
  const out = new Set<string>();
  const [ladder, fires] = await Promise.all([
    client
      .from("ladder_rule_state")
      .select("stay_date")
      .eq("rule_id", ruleId)
      .eq("is_active", true)
      .gte("stay_date", first)
      .lte("stay_date", last),
    client
      .from("pickup_event")
      .select("stay_date")
      .eq("hotel_id", hotelId)
      .eq("rule_id", ruleId)
      .is("retired_at", null)
      .gte("stay_date", first)
      .lte("stay_date", last),
  ]);
  if (ladder.error) throw new Error(`Could not read the rule's changes: ${ladder.error.message}`);
  if (fires.error) throw new Error(`Could not read the rule's changes: ${fires.error.message}`);
  for (const r of [...(ladder.data ?? []), ...(fires.data ?? [])]) out.add(String((r as { stay_date: unknown }).stay_date).slice(0, 10));
  return [...out].sort();
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
    kind,
    ms: Date.now() - started,
  });
  if (from > to) return result(new Map(), [], 0);

  const ro = readOnlyClient(client);
  const run = async (nights: string[], withRule: boolean, opts: { watch?: boolean; ladderOnly?: boolean } = {}) => {
    const capture = dryRunCapture();
    if (nights.length === 0) return capture;
    await evaluate(ro, input.hotelId, input.at, horizon, {
      nights,
      dryRun: {
        ...(withRule ? { rule: after } : {}),
        ...(opts.watch ? { watch: ruleId } : {}),
        ...(opts.ladderOnly ? { ladderOnly: true } : {}),
        capture,
      },
    });
    return capture;
  };

  const state = await nightsWithState(client, input.hotelId, ruleId, from, to);
  const scoped = new Set([...nightsInScope(after, nightsFrom(from, to), today, input.at, timeZone), ...state]);
  const p0 = [...scoped].sort();

  if (kind === "standard") {
    // Where its ladder part moves its change on the price: only there can
    // the hotel's prices differ.
    const ladder = await run(p0, true, { watch: true, ladderOnly: true });
    const p1 = [...new Set(ladder.ladderOps.filter(ladderOpMovesPrice).map((op) => op.stayDate))].sort();
    const [a, b] = await Promise.all([run(p1, true), run(p1, false)]);
    return result(nightsThatDiffer(a.prices, b.prices, new Set(p1)), p1, p1.length * 2);
  }

  const a: DryRunCapture = await run(p0, true, { watch: true });
  const touched = [...a.touched].filter((d) => scoped.has(d)).sort();
  const b = await run(touched, false);
  return result(nightsThatDiffer(a.prices, b.prices, new Set(touched)), touched, p0.length + touched.length);
}

/**
 * The owner's Skip, as marks on the rule's ladder rows, for save_rule to
 * write with the rule (99_supabase_migration_rule_activation_v1.sql). From
 * the rule's ladder decisions on Apply (a ladder-only dry run over the whole
 * window, at the instant of the Skip), each one that would move a price
 * becomes one that leaves it where it is (see SKIP in engine/ladder.ts):
 *
 *   - an activation: a held row (on, no change on the price);
 *   - a change taken off: kept, at its amount, until the rule is true there;
 *   - a change moved to the edited rule's amount: made the edited rule's,
 *     at its old amount;
 *   - anything that moves no price (a row with no change on the price) is
 *     written as Apply writes it.
 */
export type SkipMark = { d: string; rt: string; w: "held" | "kept" | "version" | "off" | "restamp" };

export function skipMarksFrom(ops: readonly LadderOp[]): SkipMark[] {
  const last = new Map<string, LadderOp>();
  for (const op of ops) last.set(`${op.stayDate}|${op.roomTypeId}`, op);
  const out: SkipMark[] = [];
  for (const op of last.values()) {
    const at = { d: op.stayDate, rt: op.roomTypeId };
    if (op.kind === "activate") out.push({ ...at, w: "held" });
    else if (op.kind === "deactivate") out.push({ ...at, w: op.hadEffect ? "kept" : "off" });
    else out.push({ ...at, w: op.hadEffect ? "version" : "restamp" });
  }
  return out.sort((x, y) => (x.d === y.d ? x.rt.localeCompare(y.rt) : x.d.localeCompare(y.d)));
}

/** The Skip marks for the rule as it will be saved (skipMarksFrom), over the whole window. */
export async function skipMarksForRule(
  client: SupabaseClient,
  input: Omit<PreviewInput, "from" | "to">,
  evaluate: EvaluateFn = evaluateHotel,
): Promise<SkipMark[]> {
  const ruleId = String(input.after.id);
  const horizon = Math.max(1, Math.floor(input.horizonDays));
  const { timeZone, today } = await hotelClock(client, input.hotelId, input.at);
  const lastNight = addCalendarDays(today, horizon - 1);
  const after = { ...input.after, is_active: true, skip_at: null };
  const state = await nightsWithState(client, input.hotelId, ruleId, today, lastNight);
  const nights = [...new Set([...nightsInScope(after, nightsFrom(today, lastNight), today, input.at, timeZone), ...state])].sort();
  if (nights.length === 0) return [];
  const capture = dryRunCapture();
  await evaluate(readOnlyClient(client), input.hotelId, input.at, horizon, {
    nights,
    dryRun: { rule: after, watch: ruleId, ladderOnly: true, capture },
  });
  return skipMarksFrom(capture.ladderOps);
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
