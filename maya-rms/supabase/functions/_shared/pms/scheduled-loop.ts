/**
 * The per-hotel loop every scheduled sync function runs, with a wall clock.
 *
 * One invocation claims a batch of hotels under a lease and works through
 * them in order. With no clock, one large property could spend the whole
 * invocation: the runtime killed it mid-hotel, every hotel still waiting in
 * the batch stayed leased until its lease expired, and because claims are
 * ordered by sync_due_at the same big hotel came back first on the next tick
 * and did it again.
 *
 * Here a hotel only starts when there is time left for one like the slowest
 * seen so far. The rest are handed back straight away, their due time and
 * failure count untouched, so the next tick can take them at once. Each
 * started hotel gets a deadline for its PMS read that leaves room for its
 * evaluation, and a hotel whose work throws is still released.
 *
 * The cut-off for starting an evaluation follows the slowest evaluate and push
 * seen so far in the invocation, between EVAL_RESERVE_FLOOR_MS and minEvalMs.
 * A flat minEvalMs made a small hotel late in the batch read its PMS and then
 * skip pricing it, a whole tick later than it needed to be.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { mwsEnv } from "../mews/env.ts";

export type ScheduledLoopConfig = {
  /** Wall clock one invocation may spend on hotels, from its start. */
  invocationBudgetMs: number;
  /** A hotel does not start with less than this left, however fast earlier ones were. */
  minHotelReserveMs: number;
  /** Kept back from each hotel's PMS read for the evaluation and push after it. */
  evalReserveMs: number;
  /** The PMS read's own budget; the deadline passed down is never later than this from its start. */
  syncBudgetMs: number;
  /**
   * A hotel whose read ends with less than this left before the invocation's
   * deadline skips evaluation and push for this tick, and is released due again
   * shortly. Starting an evaluation that runs past the wall clock got the
   * invocation killed before it released anything. Once a hotel has evaluated,
   * the slowest evaluate and push seen replaces it, never below
   * EVAL_RESERVE_FLOOR_MS and never above this.
   */
  minEvalMs: number;
};

/** The least time kept back for an evaluation, however fast earlier ones were. */
export const EVAL_RESERVE_FLOOR_MS = 5_000;

/** How soon a hotel that ran out of time to evaluate is due again. */
export const OUT_OF_TIME_RETRY_SECONDS = 30;

function envMs(name: string, fallback: number): number {
  const raw = mwsEnv(name)?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function scheduledLoopConfigFromEnv(syncBudgetMs: number): ScheduledLoopConfig {
  return {
    invocationBudgetMs: envMs("MAYA_SYNC_INVOCATION_BUDGET_MS", 330_000),
    minHotelReserveMs: envMs("MAYA_SYNC_HOTEL_RESERVE_MS", 30_000),
    evalReserveMs: envMs("MAYA_SYNC_EVAL_RESERVE_MS", 60_000),
    syncBudgetMs,
    minEvalMs: envMs("MAYA_SYNC_MIN_EVAL_MS", 30_000),
  };
}

export type ScheduledLoopDeps = {
  now: () => number;
  /**
   * Sync, evaluate, push and release one hotel. `deadlineAt` bounds its PMS
   * read; `invocationDeadline` is when the whole invocation is out of time;
   * past `evaluateBy` there is no time left to start evaluating it. Resolves
   * to how long its evaluate and push took, or nothing when they did not run.
   */
  processHotel: (
    hotelId: string,
    deadlineAt: number,
    invocationDeadline: number,
    evaluateBy: number,
  ) => Promise<number | void>;
  /** Give back a claim that was never started, without touching its schedule. */
  handBack: (hotelId: string) => Promise<void>;
  /** Release a hotel whose work threw before it released itself. */
  releaseFailed: (hotelId: string) => Promise<void>;
  log: (line: Record<string, unknown>) => void;
};

export type ScheduledLoopResult = {
  started: string[];
  handedBack: string[];
  crashed: string[];
};

export async function runScheduledHotels(
  hotelIds: string[],
  startedAt: number,
  config: ScheduledLoopConfig,
  deps: ScheduledLoopDeps,
): Promise<ScheduledLoopResult> {
  const invocationDeadline = startedAt + config.invocationBudgetMs;
  const result: ScheduledLoopResult = { started: [], handedBack: [], crashed: [] };
  let slowestMs = 0;
  // Slowest evaluate and push so far; 0 until one has run.
  let slowestEvalMs = 0;

  for (let i = 0; i < hotelIds.length; i++) {
    const hotelId = hotelIds[i];
    const now = deps.now();
    const reserve = Math.max(config.minHotelReserveMs, slowestMs);
    // The first hotel always starts: an invocation that did nothing would
    // leave the batch exactly where it was.
    if (i > 0 && invocationDeadline - now < reserve) {
      const rest = hotelIds.slice(i);
      for (const id of rest) {
        try {
          await deps.handBack(id);
        } catch (e) {
          deps.log({ step: "hand_back", hotelId: id, error: e instanceof Error ? e.message : String(e) });
        }
      }
      result.handedBack = rest;
      deps.log({
        step: "out_of_time",
        handedBack: rest.length,
        remainingMs: invocationDeadline - now,
        reserveMs: reserve,
      });
      break;
    }

    const deadlineAt = Math.min(now + config.syncBudgetMs, invocationDeadline - config.evalReserveMs);
    result.started.push(hotelId);
    const evalReserve =
      slowestEvalMs > 0
        ? Math.min(config.minEvalMs, Math.max(EVAL_RESERVE_FLOOR_MS, slowestEvalMs))
        : config.minEvalMs;
    try {
      const evalMs = await deps.processHotel(hotelId, Math.max(now, deadlineAt), invocationDeadline, invocationDeadline - evalReserve);
      if (typeof evalMs === "number" && Number.isFinite(evalMs)) slowestEvalMs = Math.max(slowestEvalMs, evalMs);
    } catch (e) {
      result.crashed.push(hotelId);
      deps.log({ step: "hotel_crashed", hotelId, error: e instanceof Error ? e.message : String(e) });
      try {
        await deps.releaseFailed(hotelId);
      } catch {
        // The lease expires on its own.
      }
    }
    slowestMs = Math.max(slowestMs, deps.now() - now);
  }
  return result;
}

/**
 * Lease for a single-hotel dispatch (`{ hotel_id }` posted, as a manual price
 * save does). Longer than one invocation's wall clock, so a cron tick can
 * never take the same hotel while the dispatch is still on it.
 */
export const DISPATCH_LEASE_SECONDS = 420;

/**
 * What a single-hotel dispatch may do. "claimed": it holds the lease and must
 * release it. "busy": another invocation or a manual sync holds it, so this one
 * does nothing; that run evaluates and pushes the same hotel. "unleased": there
 * is no connection row to hold, or the claim could not be read, so it runs as
 * dispatches always did.
 *
 * Without a lease a dispatch ran the same hotel alongside the cron: two sweeps
 * on one checkpoint, two isolates pacing one PMS credential, and two
 * evaluations writing the same ladder transitions.
 */
export async function claimDispatchedHotel(
  supabase: SupabaseClient,
  pmsType: string,
  hotelId: string,
  owner: string,
  log: (line: Record<string, unknown>) => void,
): Promise<"claimed" | "busy" | "unleased"> {
  const { data, error } = await supabase.rpc("claim_pms_sync_one", {
    p_hotel_id: hotelId,
    p_pms_type: pmsType,
    p_lease_seconds: DISPATCH_LEASE_SECONDS,
    p_owner: owner,
  });
  if (error) {
    log({ step: "dispatch_claim", hotelId, error: error.message });
    return "unleased";
  }
  if (data === "claimed") return "claimed";
  if (data === "busy") return "busy";
  return "unleased";
}

/** How long from the invocation's start a busy single-hotel dispatch keeps trying. */
export const DISPATCH_BUSY_WAIT_MS = 60_000;
/** Between tries while the hotel is busy. */
export const DISPATCH_BUSY_RETRY_MS = 3_000;

/**
 * claimDispatchedHotel, waiting a bounded time while the hotel is busy.
 *
 * Stepping aside at once assumed the holder would price and push the change
 * that prompted the dispatch, but a manual sync only reads the PMS, and a cron
 * run may have read published_price before the save. The saved price then sat
 * until the next due tick, minutes away, while the UI said it was being sent.
 * Holders mostly finish within a minute, so this tries again every
 * DISPATCH_BUSY_RETRY_MS until DISPATCH_BUSY_WAIT_MS after `startedAt`, then
 * gives up as "busy".
 */
export async function claimDispatchedHotelWaiting(
  supabase: SupabaseClient,
  pmsType: string,
  hotelId: string,
  owner: string,
  log: (line: Record<string, unknown>) => void,
  startedAt: number,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  },
): Promise<"claimed" | "busy" | "unleased"> {
  let tries = 0;
  for (;;) {
    const claim = await claimDispatchedHotel(supabase, pmsType, hotelId, owner, log);
    tries++;
    if (claim !== "busy") {
      if (tries > 1) log({ step: "dispatch_claim_waited", hotelId, tries, claim, waitedMs: clock.now() - startedAt });
      return claim;
    }
    if (clock.now() + DISPATCH_BUSY_RETRY_MS > startedAt + DISPATCH_BUSY_WAIT_MS) {
      log({ step: "dispatch_busy", hotelId, tries, waitedMs: clock.now() - startedAt });
      return "busy";
    }
    await clock.sleep(DISPATCH_BUSY_RETRY_MS);
  }
}
