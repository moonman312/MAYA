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
};

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
  };
}

export type ScheduledLoopDeps = {
  now: () => number;
  /**
   * Sync, evaluate, push and release one hotel. `deadlineAt` bounds its PMS
   * read; `invocationDeadline` is when the whole invocation is out of time.
   */
  processHotel: (hotelId: string, deadlineAt: number, invocationDeadline: number) => Promise<void>;
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
    try {
      await deps.processHotel(hotelId, Math.max(now, deadlineAt), invocationDeadline);
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
