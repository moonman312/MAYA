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
 *   - no open manual price is at that rate already, and no price typed in
 *     MAYA after the send is still on its way there;
 *   - not every settled night read differs by one and the same ratio. That is
 *     the PMS reporting MAYA's prices through some rule of its own (tax
 *     included, a markup), not a person editing nights, and adopting would
 *     freeze the whole window. Nothing is adopted and the count is logged.
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
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingColumnError, isMissingRelationError } from "../engine/snapshots.ts";
import { mwsEnv } from "../mews/env.ts";
import { setManualPrices } from "./manual-price.ts";
import { type RateTargetMap, upsertLedger } from "./rate-push.ts";

const DEFAULT_SETTLE_MINUTES = 60;
const HALF_CENT = 0.005 + 1e-9;
/** numeric(10,2). */
const MAX_PRICE = 99_999_999.99;
/** Fewer settled nights than this never read as a systematic difference. */
const SYSTEMATIC_MIN_NIGHTS = 10;
/** Ratios this close are one ratio. */
const SYSTEMATIC_RATIO_SPREAD = 0.005;

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
  /** Differ from MAYA's last send, which is not settled or not old enough yet. */
  waiting: number;
  /** Differ, with a price typed in MAYA since the send still to go out. */
  typedSinceSend: number;
  /** Differed all by one ratio, so none was adopted. */
  systematic: number;
};

/** Which nights are hand edits, which are in step already, and why the rest are not. Reads nothing. */
export function planPmsEdits(input: {
  reads: PushedNightRead[];
  targets: RateTargetMap;
  manual: Map<string, OpenManualPrice>;
  nowMs: number;
  settleMs: number;
}): PmsEditPlan {
  const plan: PmsEditPlan = { edits: [], inStep: [], landed: [], waiting: 0, typedSinceSend: 0, systematic: 0 };
  // Settled, old enough and sent to the rate read: the nights a change can be told on.
  const comparable: { pmsRate: number; sent: number }[] = [];

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
    const settled = sent && l.confirmed_at != null;
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
    if (holds && !settled) plan.landed.push(r);
    if (!settled || !oldEnough) {
      if (!holds) plan.waiting += 1;
      continue;
    }
    comparable.push({ pmsRate: r.pmsRate, sent: ledgerPrice });
    if (holds) continue;
    if (manual && manual.source === "maya" && manual.setAtMs > pushedAtMs && ratesDiffer(manual.price, ledgerPrice)) {
      plan.typedSinceSend += 1;
      continue;
    }
    plan.edits.push({ read: r, price: Math.round(r.pmsRate * 100) / 100 });
  }

  if (
    plan.edits.length >= SYSTEMATIC_MIN_NIGHTS &&
    plan.edits.length === comparable.length &&
    oneRatio(comparable)
  ) {
    plan.systematic = plan.edits.length;
    plan.edits = [];
  }
  return plan;
}

/** Every PMS rate is its sent price times one factor other than 1. */
function oneRatio(nights: { pmsRate: number; sent: number }[]): boolean {
  if (nights.some((n) => !(n.sent > 0))) return false;
  const ratios = nights.map((n) => n.pmsRate / n.sent);
  const first = ratios[0];
  if (Math.abs(first - 1) <= SYSTEMATIC_RATIO_SPREAD) return false;
  return ratios.every((x) => Math.abs(x - first) <= SYSTEMATIC_RATIO_SPREAD * first);
}

export type PmsEditsResult = {
  adopted: number;
  inStep: number;
  /** Sends found in the PMS and stamped settled. */
  landed: number;
  suppressedRules: number;
  retiredPickups: number;
};

/**
 * Adopt the plan's edits as manual prices, bring the ledger in step with what
 * the PMS holds, and stamp the sends it found there as settled. `at` is the
 * tick's instant: set_at, and the evaluation that follows prices at it.
 * Throws the database's error on a failed write.
 */
export async function applyPmsEdits(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: string,
  plan: Pick<PmsEditPlan, "edits" | "inStep" | "landed">,
  at: string,
): Promise<PmsEditsResult> {
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

  const rows = [...plan.edits, ...plan.inStep].map(({ read, price }) => {
    const l = read.ledger;
    return {
      hotel_id: hotelId,
      pms_type: l.pms_type != null ? String(l.pms_type) : pmsType,
      room_type_id: read.roomTypeId,
      external_room_type_id: read.externalRoomTypeId,
      stay_date: read.stayDate,
      price,
      external_rate_id: l.external_rate_id != null ? String(l.external_rate_id) : null,
      status: "sent",
      pms_job_reference: l.pms_job_reference != null ? String(l.pms_job_reference) : null,
      error: null,
      attempts: l.attempts != null ? Number(l.attempts) : 1,
      pushed_at: l.pushed_at != null ? String(l.pushed_at) : null,
      sent_price: price,
      // The rate was read there just now.
      confirmed_at: l.confirmed_at != null ? String(l.confirmed_at) : at,
      pms_edited_at: at,
    };
  });
  // The row as it was read, now settled. Written whole, as the ledger's
  // upserts all are; the tick holds the hotel's lease, so nothing wrote it since.
  const landed = plan.landed.map((read) => {
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
      confirmed_at: at,
      pms_edited_at: l.pms_edited_at != null ? String(l.pms_edited_at) : null,
    };
  });
  for (const batch of [rows, landed]) {
    for (let i = 0; i < batch.length; i += 500) {
      const error = await upsertLedger(supabase, batch.slice(i, i + 500));
      if (error) throw new Error(`Failed to record PMS rates in the ledger: ${error.message}`);
    }
  }

  return {
    adopted: plan.edits.length,
    inStep: plan.inStep.length,
    landed: plan.landed.length,
    suppressedRules: reset.suppressedRules,
    retiredPickups: reset.retiredPickups,
  };
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
  const none: PmsEditsResult = { adopted: 0, inStep: 0, landed: 0, suppressedRules: 0, retiredPickups: 0 };
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
      .select("simulation_mode")
      .eq("hotel_id", hotelId)
      .maybeSingle();
    if (settingsError) throw settingsError;
    // A missing row is simulation, as the push reads it.
    if (settings?.simulation_mode !== false) return none;

    const manual = await readOpenManualPrices(supabase, hotelId, window.firstDate, window.lastDate);
    if (!manual) return none;
    plan = planPmsEdits({ reads: inWindow, targets, manual, nowMs: Date.parse(at), settleMs: pmsEditSettleMs() });
    const result =
      plan.edits.length > 0 || plan.inStep.length > 0 || plan.landed.length > 0
        ? await applyPmsEdits(supabase, hotelId, pmsType, plan, at)
        : none;
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
        console.error(
          JSON.stringify({
            fn: "adoptPmsEdits",
            hotelId,
            schema: "pre-migration",
            migration: "99_supabase_migration_push_guardrails_v1.sql",
          }),
        );
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

/** One line per hotel per refresh, counts only. */
function logPlan(hotelId: string, pmsType: string, plan: PmsEditPlan, result: PmsEditsResult): void {
  if (plan.edits.length + plan.inStep.length + plan.landed.length + plan.waiting + plan.typedSinceSend + plan.systematic === 0) return;
  console.log(
    JSON.stringify({
      fn: "adoptPmsEdits",
      hotelId,
      pmsType,
      found: plan.edits.length,
      adopted: result.adopted,
      inStep: result.inStep,
      landed: result.landed,
      suppressedRules: result.suppressedRules,
      retiredPickups: result.retiredPickups,
      waiting: plan.waiting,
      typedSinceSend: plan.typedSinceSend,
      systematic: plan.systematic,
    }),
  );
}
