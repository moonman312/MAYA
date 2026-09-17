/**
 * A rate the hotel changed in its PMS on a night MAYA had already sent to is
 * treated exactly like a manual price typed in MAYA: it becomes an open
 * manual_price row at the PMS rate (source 'pms', no user), with the same
 * reset (setManualPrices). A rule that fires later stacks on it, and clearing
 * it in MAYA hands the night back to MAYA's pricing.
 *
 * The base rate refresh reads the PMS for the window every hour and calls
 * this with each night MAYA has sent to. The hard part is never taking MAYA's
 * own output for a hotel's change. A night is a hand edit only when all of
 * these hold:
 *
 *   - the hotel is live (a simulating hotel sends nothing);
 *   - its ledger row is 'sent': not a send still marked in progress, a
 *     refused or rejected send, a job never confirmed, or a skip;
 *   - that send is settled (rate_updates.confirmed_at): the vendor reported
 *     its job applied (the push stamps that), or a read here found its price
 *     in the PMS (this stamps that). A vendor's word that it took the rates
 *     is not enough. Think answers 202 and applies them later, and its queue
 *     has dropped a batch: an earlier price of MAYA's still in the PMS under
 *     a later one that never landed looks exactly like a hotel's change;
 *   - it went out at least the settle window ago (MAYA_PMS_EDIT_SETTLE_MINUTES,
 *     60 by default), so a PMS still catching up is not read as a change;
 *   - it went to the rate this read quoted (same room type, same rate id): a
 *     re-resolved target, or another rate plan, quotes a different number;
 *   - the PMS rate differs from the price sent by more than half a cent, and
 *     is not that price rounded to a whole unit (a PMS keeping whole units,
 *     or a currency without cents);
 *   - no price typed in MAYA after the send is still on its way there;
 *   - it is not one of the nights explained by a ratio shared by nearly all
 *     the settled nights read (SYSTEMATIC_SHARE), to within a whole unit.
 *     That is the PMS reporting MAYA's prices through some rule of its own
 *     (tax included, a markup), not a person editing nights, and adopting
 *     would freeze the window at prices the rule has inflated, which rules
 *     stacked on them would inflate again. Those nights are counted and
 *     logged; a night that does not fit the ratio is still a change. A
 *     settled night still quoting MAYA's own price counts against a ratio,
 *     so a hotel raising some of its nights by one percentage is taken.
 *
 * A rate of 0 is not a price to adopt. Every other read of MAYA's takes a
 * PMS 0 as a night closed or not loaded (zero_base), and a manual price of 0
 * lets a rule stacked on it through under the floor: a +$20 rule opened a
 * night the hotel had just closed at $20. So a settled night the PMS now has
 * at 0 is the hotel closing it. Its base rate goes to 0, exactly as a night
 * closed before MAYA ever sent to it, so the engine stops pricing it and the
 * push has nothing to send; the ledger says the PMS holds 0, so the calendar
 * reads a rate the hotel opens it at later as the hotel's own; and an open
 * manual price on it is cleared, as the change log's Clear does, since it
 * would otherwise go on being sent over the closed night. A price typed in
 * MAYA since the send is left to go out, as with any change.
 *
 * When the push held a night's manual price back (a comp night's 0 MAYA
 * would not send) and the hotel then set that price by hand, the ledger is
 * brought in step, so the push stops trying to send what is already there.
 *
 * A night whose PMS rate equals its open manual price while MAYA's settled
 * send there was another number is a change like any other. MAYA sent a
 * rule stacked on the manual price, and the hotel set the manual price back
 * by hand: taking it again suppresses that rule, so MAYA publishes what the
 * hotel set rather than keep counting its own price as there.
 *
 * After adopting, the ledger row says the PMS holds the rate (price and
 * sent_price, pms_edited_at stamped), so the evaluation that follows in the
 * same tick publishes the PMS rate and the push finds nothing to send. The
 * send's job reference and confirmation stay as they were.
 *
 * A send never confirmed or read back is never settled, so a change the
 * hotel made before MAYA first saw its price there is not taken; nor is one
 * on a night whose last send never landed.
 *
 * Nor is a change on a night whose send settled before the hotel last went
 * live (hotel_settings.live_since). While MAYA only simulated, the hotel went
 * on pricing by hand, and taking those rates as manual prices when it goes
 * live again would keep MAYA off every night it priced, where going live
 * says MAYA's prices replace the hotel's. Such a rate becomes the night's
 * base instead, as a night MAYA never sent to is read again, and MAYA prices
 * on it; the ledger says the PMS holds it, read now, so a change after this
 * is taken. A night whose open manual price came from the PMS was the
 * hotel's already, and its new rate is taken as before. A send whose price
 * the PMS still has is stamped again, so a change the hotel makes to it
 * from now on is taken.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingColumnError, isMissingRelationError } from "../engine/snapshots.ts";
import { mwsEnv } from "../mews/env.ts";
import { hotelRuleIds, setManualPrices } from "./manual-price.ts";
import { type RateTargetMap, upsertLedger } from "./rate-push.ts";

const DEFAULT_SETTLE_MINUTES = 60;
const HALF_CENT = 0.005 + 1e-9;
/** numeric(10,2). */
const MAX_PRICE = 99_999_999.99;
/** Fewer nights than this sharing a ratio never read as a systematic difference. */
const SYSTEMATIC_MIN_NIGHTS = 10;
/** The share of the settled nights read a ratio has to explain to be the PMS's own rule. */
const SYSTEMATIC_SHARE = 0.8;
/** A ratio this close to 1 is MAYA's price, not a rule. */
const SYSTEMATIC_RATIO_SPREAD = 0.005;
/**
 * How far a PMS rate may sit from the price sent times the ratio and still
 * fit it: a whole unit, for a PMS that rounds what it reports to one, with the
 * ratio itself read off a rounded rate.
 */
const SYSTEMATIC_FIT = 1;

/** How long a settled send must have been in the PMS before a different rate there is the hotel's, from MAYA_PMS_EDIT_SETTLE_MINUTES. */
export function pmsEditSettleMs(raw: string | undefined = mwsEnv("MAYA_PMS_EDIT_SETTLE_MINUTES")): number {
  const n = Number(raw);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTLE_MINUTES) * 60_000;
}

function ratesDiffer(a: number, b: number): boolean {
  return !(Math.abs(a - b) <= HALF_CENT);
}

/** Whether a PMS rate is MAYA's price as the PMS keeps it: the same to the cent, or that price rounded to a whole unit. */
export function pmsHoldsPrice(pmsRate: number, mayaPrice: number): boolean {
  if (!ratesDiffer(pmsRate, mayaPrice)) return true;
  const whole = !ratesDiffer(pmsRate, Math.round(pmsRate));
  return whole && Math.abs(pmsRate - mayaPrice) < 1;
}

/** One night MAYA has sent to, as the refresh just read it. */
export type PushedNightRead = {
  stayDate: string;
  roomTypeId: string;
  externalRoomTypeId: string;
  /** What the PMS quotes for the night now. */
  pmsRate: number;
  /** The night's rate_updates row, with the settle columns. */
  ledger: Record<string, unknown>;
};

export type OpenManualPrice = { price: number; source: "maya" | "pms"; setAtMs: number };

export type PmsEditPlan = {
  /** Hand edits to adopt, at the PMS rate in cents. */
  edits: { read: PushedNightRead; price: number }[];
  /** Nights the push holds back at their open manual price, which the PMS has already. */
  inStep: { read: PushedNightRead; price: number }[];
  /** Sends not settled yet whose price the PMS has: settled now. */
  landed: PushedNightRead[];
  /** Settled nights the PMS now has at 0: closed by the hotel. */
  closed: PushedNightRead[];
  /** Nights changed while MAYA only simulated: the PMS rate is the night's base again. */
  rebased: { read: PushedNightRead; price: number }[];
  /** Differ from MAYA's last send, which is not settled or not old enough yet. */
  waiting: number;
  /** Differ, with a price typed in MAYA since the send still to go out. */
  typedSinceSend: number;
  /** Differed by the ratio nearly all settled nights share, so were not adopted. */
  systematic: number;
};

/**
 * Which nights are hand edits, which are in step already, and why the rest
 * are not. `liveSinceMs` is when the hotel last went live, NaN when not
 * known. Reads nothing.
 */
export function planPmsEdits(input: {
  reads: PushedNightRead[];
  targets: RateTargetMap;
  manual: Map<string, OpenManualPrice>;
  nowMs: number;
  settleMs: number;
  liveSinceMs?: number;
}): PmsEditPlan {
  const plan: PmsEditPlan = { edits: [], inStep: [], landed: [], closed: [], rebased: [], waiting: 0, typedSinceSend: 0, systematic: 0 };
  const liveSinceMs = input.liveSinceMs ?? NaN;
  // Settled, old enough, sent to the rate read and not typed over since: the
  // nights a change can be told on, whether the PMS still quotes MAYA's price.
  let comparable = 0;
  // Of those, the ones it does not.
  const differing: { read: PushedNightRead; pmsRate: number; sent: number; whileLive: boolean }[] = [];

  for (const r of input.reads) {
    const l = r.ledger;
    if (!Number.isFinite(r.pmsRate) || r.pmsRate < 0 || r.pmsRate > MAX_PRICE) continue;
    const key = `${r.stayDate}|${r.roomTypeId}`;
    const target = input.targets[r.externalRoomTypeId];
    const sameTarget =
      !!target && l.external_rate_id != null && String(l.external_rate_id) === target &&
      String(l.external_room_type_id ?? "") === r.externalRoomTypeId;
    const pushedAtMs = l.pushed_at != null ? Date.parse(String(l.pushed_at)) : NaN;
    const oldEnough = pushedAtMs <= input.nowMs - input.settleMs;
    const sent = l.status === "sent";
    const confirmedAtMs = l.confirmed_at != null ? Date.parse(String(l.confirmed_at)) : NaN;
    const settled = sent && l.confirmed_at != null;
    // Known to be in the PMS since the hotel last went live.
    const settledWhileLive = settled && !(liveSinceMs > confirmedAtMs);
    const ledgerPrice = l.price != null ? Number(l.price) : NaN;
    const manual = input.manual.get(key);

    if (l.status === "skipped" && manual && Number.isFinite(manual.price) && pmsHoldsPrice(r.pmsRate, manual.price)) {
      const heldBackThisPrice = !ratesDiffer(ledgerPrice, manual.price);
      if (heldBackThisPrice && sameTarget && oldEnough) plan.inStep.push({ read: r, price: manual.price });
      continue;
    }

    if (!sent || !Number.isFinite(ledgerPrice)) continue;
    if (!sameTarget) continue;
    const holds = pmsHoldsPrice(r.pmsRate, ledgerPrice);
    if (holds && !settledWhileLive) plan.landed.push(r);
    if (!settled || !oldEnough) {
      if (!holds) plan.waiting += 1;
      continue;
    }
    if (holds) {
      comparable += 1;
      continue;
    }
    if (manual && manual.source === "maya" && manual.setAtMs > pushedAtMs && ratesDiffer(manual.price, ledgerPrice)) {
      plan.typedSinceSend += 1;
      continue;
    }
    // Neither MAYA's price nor any ratio of it: no say in whether there is one.
    if (!ratesDiffer(r.pmsRate, 0)) {
      plan.closed.push(r);
      continue;
    }
    comparable += 1;
    differing.push({ read: r, pmsRate: r.pmsRate, sent: ledgerPrice, whileLive: settledWhileLive || manual?.source === "pms" });
  }

  const fits = sharedRatio(differing);
  const systematic = fits.size >= SYSTEMATIC_MIN_NIGHTS && fits.size >= SYSTEMATIC_SHARE * comparable;
  if (systematic) plan.systematic = fits.size;
  differing.forEach((d, i) => {
    if (systematic && fits.has(i)) return;
    const change = { read: d.read, price: Math.round(d.pmsRate * 100) / 100 };
    if (d.whileLive) plan.edits.push(change);
    else plan.rebased.push(change);
  });
  return plan;
}

/**
 * The nights (by index) that fit the ratio fitting the most of them: PMS
 * rate within SYSTEMATIC_FIT of the price sent times it. Each night's own
 * ratio is tried, largest prices first, since theirs carries the least
 * rounding. Empty when no ratio away from 1 fits SYSTEMATIC_MIN_NIGHTS.
 */
function sharedRatio(nights: { pmsRate: number; sent: number }[]): Set<number> {
  let best = new Set<number>();
  if (nights.length < SYSTEMATIC_MIN_NIGHTS) return best;
  const order = nights
    .map((_, i) => i)
    .filter((i) => nights[i].sent > 0 && nights[i].pmsRate > 0)
    .sort((a, b) => nights[b].sent - nights[a].sent);
  for (const i of order) {
    if (best.size === order.length) break;
    const ratio = nights[i].pmsRate / nights[i].sent;
    if (Math.abs(ratio - 1) <= SYSTEMATIC_RATIO_SPREAD) continue;
    const fit = new Set<number>();
    for (const j of order) {
      if (Math.abs(nights[j].pmsRate - nights[j].sent * ratio) <= SYSTEMATIC_FIT) fit.add(j);
    }
    if (fit.size > best.size) best = fit;
  }
  return best.size >= SYSTEMATIC_MIN_NIGHTS ? best : new Set();
}

export type PmsEditsResult = {
  adopted: number;
  inStep: number;
  /** Sends found in the PMS and stamped settled. */
  landed: number;
  /** Nights closed in the PMS, now at a base of 0. */
  closed: number;
  /** Open manual prices on those nights, cleared. */
  clearedManual: number;
  /** Nights changed while MAYA only simulated, now at that rate as their base. */
  rebased: number;
  suppressedRules: number;
  retiredPickups: number;
};

/** A night's ledger row as read, with what this step now knows about it. */
function ledgerRow(hotelId: string, pmsType: string, read: PushedNightRead, over: Record<string, unknown>): Record<string, unknown> {
  const l = read.ledger;
  return {
    hotel_id: hotelId,
    pms_type: l.pms_type != null ? String(l.pms_type) : pmsType,
    room_type_id: read.roomTypeId,
    external_room_type_id: read.externalRoomTypeId,
    stay_date: read.stayDate,
    price: Number(l.price),
    external_rate_id: l.external_rate_id != null ? String(l.external_rate_id) : null,
    status: "sent",
    pms_job_reference: l.pms_job_reference != null ? String(l.pms_job_reference) : null,
    error: null,
    attempts: l.attempts != null ? Number(l.attempts) : 1,
    pushed_at: l.pushed_at != null ? String(l.pushed_at) : null,
    sent_price: l.sent_price != null ? Number(l.sent_price) : Number(l.price),
    confirmed_at: l.confirmed_at != null ? String(l.confirmed_at) : null,
    pms_edited_at: l.pms_edited_at != null ? String(l.pms_edited_at) : null,
    ...over,
  };
}

/**
 * Adopt the plan's edits as manual prices, close the nights the hotel closed,
 * take the rates it set while MAYA only simulated as base rates, bring the
 * ledger in step with what the PMS holds, and stamp the sends it found there
 * as settled. `at` is the tick's instant: set_at, and the evaluation that
 * follows prices at it. Throws the database's error on a failed write.
 *
 * Base rates go first: on their own they only have MAYA price a night on the
 * rate the PMS has. A failure after them leaves the ledger saying MAYA's
 * price is there, so the next refresh finds the night again.
 */
export async function applyPmsEdits(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: string,
  plan: Pick<PmsEditPlan, "edits" | "inStep" | "landed" | "closed" | "rebased">,
  at: string,
  manual: Map<string, OpenManualPrice> = new Map(),
): Promise<PmsEditsResult> {
  await writeBaseRates(supabase, hotelId, plan.rebased, at);
  const clearedManual = await closeNights(supabase, hotelId, plan.closed, manual, at);
  let reset = { suppressedRules: 0, retiredPickups: 0 };
  if (plan.edits.length > 0) {
    reset = await setManualPrices(
      supabase,
      hotelId,
      plan.edits.map(({ read, price }) => ({ roomTypeId: read.roomTypeId, stayDate: read.stayDate, price })),
      { source: "pms", pmsType },
      at,
    );
  }

  // Rows are written whole, from the row as read, as the ledger's upserts all
  // are; the tick holds the hotel's lease, so nothing wrote them since.
  const inStep = [...plan.edits, ...plan.inStep].map(({ read, price }) =>
    ledgerRow(hotelId, pmsType, read, {
      price,
      sent_price: price,
      // The rate was read there just now.
      confirmed_at: read.ledger.confirmed_at != null ? String(read.ledger.confirmed_at) : at,
      pms_edited_at: at,
    })
  );
  // Read there just now, since the hotel went live: a change from here is the hotel's.
  for (const { read, price } of [...plan.closed.map((read) => ({ read, price: 0 })), ...plan.rebased]) {
    inStep.push(ledgerRow(hotelId, pmsType, read, { price, sent_price: price, confirmed_at: at, pms_edited_at: at }));
  }
  const landed = plan.landed.map((read) => ledgerRow(hotelId, pmsType, read, { confirmed_at: at }));
  for (const batch of [inStep, landed]) {
    for (let i = 0; i < batch.length; i += 500) {
      const error = await upsertLedger(supabase, batch.slice(i, i + 500));
      if (error) throw new Error(`Failed to record PMS rates in the ledger: ${error.message}`);
    }
  }

  return {
    adopted: plan.edits.length,
    inStep: plan.inStep.length,
    landed: plan.landed.length,
    closed: plan.closed.length,
    clearedManual,
    rebased: plan.rebased.length,
    suppressedRules: reset.suppressedRules,
    retiredPickups: reset.retiredPickups,
  };
}

/** Nights' base rates, as the PMS has them. */
async function writeBaseRates(
  supabase: SupabaseClient,
  hotelId: string,
  nights: { read: PushedNightRead; price: number }[],
  at: string,
): Promise<void> {
  const rows = nights.map(({ read, price }) => ({
    hotel_id: hotelId,
    stay_date: read.stayDate,
    room_type_id: read.roomTypeId,
    price,
    source: "pms",
    captured_at: at,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase
      .from("base_rate_calendar")
      .upsert(rows.slice(i, i + 500), { onConflict: "hotel_id,stay_date,room_type_id" });
    if (error) throw new Error(`Failed to write base rates read in the PMS: ${error.message}`);
  }
}

/**
 * Nights the hotel closed: base rate 0, and any open manual price on them
 * cleared with the rules it paused let go again, as a Clear in MAYA does.
 * Returns how many manual prices were cleared.
 */
async function closeNights(
  supabase: SupabaseClient,
  hotelId: string,
  nights: PushedNightRead[],
  manual: Map<string, OpenManualPrice>,
  at: string,
): Promise<number> {
  if (nights.length === 0) return 0;
  await writeBaseRates(supabase, hotelId, nights.map((read) => ({ read, price: 0 })), at);

  const withManual = nights.filter((r) => manual.has(`${r.stayDate}|${r.roomTypeId}`));
  if (withManual.length === 0) return 0;
  const byRoomType = new Map<string, string[]>();
  for (const r of withManual) byRoomType.set(r.roomTypeId, [...(byRoomType.get(r.roomTypeId) ?? []), r.stayDate]);
  let cleared = 0;
  // Cleared before the rules are let go: the other way round, a failure
  // between the two would have the rules apply on top of the manual price.
  for (const [roomTypeId, dates] of byRoomType) {
    for (let i = 0; i < dates.length; i += 100) {
      const { data, error } = await supabase
        .from("manual_price")
        .update({ cleared_at: at, cleared_by: null })
        .eq("hotel_id", hotelId)
        .eq("room_type_id", roomTypeId)
        .in("stay_date", dates.slice(i, i + 100))
        .is("cleared_at", null)
        .select("stay_date");
      if (error) throw new Error(`Failed to clear manual prices on closed nights: ${error.message}`);
      cleared += (data ?? []).length;
    }
  }
  const ruleIds = await hotelRuleIds(supabase, hotelId);
  if (ruleIds.length === 0) return cleared;
  for (const [roomTypeId, dates] of byRoomType) {
    for (let i = 0; i < dates.length; i += 100) {
      const { error } = await supabase
        .from("ladder_rule_state")
        .update({ suppressed_at: null })
        .in("rule_id", ruleIds)
        .eq("room_type_id", roomTypeId)
        .in("stay_date", dates.slice(i, i + 100))
        .not("suppressed_at", "is", null);
      if (error) throw new Error(`Failed to let rules go on closed nights: ${error.message}`);
    }
  }
  return cleared;
}

/**
 * The refresh's step: find this hotel's hand edits among the nights MAYA has
 * sent to and adopt them, and stamp the sends it finds in the PMS as settled.
 * Reads nothing more unless some night's PMS rate differs from its ledger
 * row, the row is a skip, or its send is not settled yet, and does nothing
 * for a hotel that is not live or a database without the columns that say
 * where a price came from. Logs one line of counts when there was anything
 * to count. Never throws: a failed write is logged and the next refresh
 * looks again.
 */
export async function adoptPmsEdits(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: string,
  reads: PushedNightRead[],
  targets: RateTargetMap,
  window: { firstDate: string; lastDate: string },
  at: string,
): Promise<PmsEditsResult> {
  const none: PmsEditsResult = { adopted: 0, inStep: 0, landed: 0, closed: 0, clearedManual: 0, rebased: 0, suppressedRules: 0, retiredPickups: 0 };
  const inWindow = reads.filter((r) => r.stayDate >= window.firstDate && r.stayDate <= window.lastDate);
  const worthALook = inWindow.some((r) =>
    r.ledger.status === "skipped" ||
    (r.ledger.status === "sent" &&
      r.ledger.price != null &&
      (r.ledger.confirmed_at == null || !pmsHoldsPrice(r.pmsRate, Number(r.ledger.price))))
  );
  if (!worthALook) return none;

  let plan: PmsEditPlan | null = null;
  try {
    const { data: settings, error: settingsError } = await supabase
      .from("hotel_settings")
      .select("simulation_mode, live_since")
      .eq("hotel_id", hotelId)
      .maybeSingle();
    if (settingsError) {
      if (isMissingColumnError(settingsError)) return logPreMigration(hotelId);
      throw settingsError;
    }
    // A missing row is simulation, as the push reads it.
    if (settings?.simulation_mode !== false) return none;

    const manual = await readOpenManualPrices(supabase, hotelId, window.firstDate, window.lastDate);
    if (!manual) return none;
    plan = planPmsEdits({
      reads: inWindow,
      targets,
      manual,
      nowMs: Date.parse(at),
      settleMs: pmsEditSettleMs(),
      liveSinceMs: settings.live_since != null ? Date.parse(String(settings.live_since)) : NaN,
    });
    const found = plan.edits.length + plan.inStep.length + plan.landed.length + plan.closed.length + plan.rebased.length;
    const result = found > 0 ? await applyPmsEdits(supabase, hotelId, pmsType, plan, at, manual) : none;
    logPlan(hotelId, pmsType, plan, result);
    return result;
  } catch (e) {
    if (plan) logPlan(hotelId, pmsType, plan, none);
    console.error(
      JSON.stringify({
        fn: "adoptPmsEdits",
        hotelId,
        pmsType,
        error: (e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e)).slice(0, 300),
      }),
    );
    return none;
  }
}

/** The window's open manual prices; null on a database that can't say where a price came from yet. */
async function readOpenManualPrices(
  supabase: SupabaseClient,
  hotelId: string,
  firstDate: string,
  lastDate: string,
): Promise<Map<string, OpenManualPrice> | null> {
  const out = new Map<string, OpenManualPrice>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("manual_price")
      .select("stay_date, room_type_id, price, set_at, source")
      .eq("hotel_id", hotelId)
      .gte("stay_date", firstDate)
      .lte("stay_date", lastDate)
      .is("cleared_at", null)
      .order("stay_date", { ascending: true })
      .order("room_type_id", { ascending: true })
      .range(from, from + 999);
    if (error) {
      if (isMissingColumnError(error) || isMissingRelationError(error)) {
        logPreMigration(hotelId);
        return null;
      }
      throw error;
    }
    const rows = (data ?? []) as Record<string, unknown>[];
    for (const m of rows) {
      if (!m.room_type_id || m.price == null) continue;
      out.set(`${m.stay_date}|${m.room_type_id}`, {
        price: Number(m.price),
        source: m.source === "pms" ? "pms" : "maya",
        setAtMs: m.set_at != null ? Date.parse(String(m.set_at)) : NaN,
      });
    }
    if (rows.length < 1000) break;
  }
  return out;
}

/** A database without the columns this reads: nothing is taken. */
function logPreMigration(hotelId: string): PmsEditsResult {
  console.error(
    JSON.stringify({
      fn: "adoptPmsEdits",
      hotelId,
      schema: "pre-migration",
      migration: "99_supabase_migration_push_guardrails_v1.sql",
    }),
  );
  return { adopted: 0, inStep: 0, landed: 0, closed: 0, clearedManual: 0, rebased: 0, suppressedRules: 0, retiredPickups: 0 };
}

/** One line per hotel per refresh, counts only. */
function logPlan(hotelId: string, pmsType: string, plan: PmsEditPlan, result: PmsEditsResult): void {
  const found = plan.edits.length + plan.inStep.length + plan.landed.length + plan.closed.length + plan.rebased.length;
  if (found + plan.waiting + plan.typedSinceSend + plan.systematic === 0) return;
  console.log(
    JSON.stringify({
      fn: "adoptPmsEdits",
      hotelId,
      pmsType,
      found: plan.edits.length,
      adopted: result.adopted,
      inStep: result.inStep,
      landed: result.landed,
      closed: result.closed,
      clearedManual: result.clearedManual,
      rebased: result.rebased,
      suppressedRules: result.suppressedRules,
      retiredPickups: result.retiredPickups,
      waiting: plan.waiting,
      typedSinceSend: plan.typedSinceSend,
      systematic: plan.systematic,
    }),
  );
}
