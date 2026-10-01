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
 * The cut-off for starting an evaluation is a flat minEvalMs before the
 * invocation's deadline. Sizing it from earlier, smaller hotels would let a
 * large property start an evaluation it cannot finish; the cost of the flat
 * reserve is an occasional small hotel priced one tick later.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { mwsEnv } from "../mews/env.ts";

export type ScheduledLoopConfig = {
  /** Wall clock one invocation may spend on hotels, from its start. */
  invocationBudgetMs: number;
  /** A hotel does not start with less than this left, however fast earlier ones were. */
  minHotelReserveMs: number;
  /**
   * Kept back from each hotel's PMS read for the base rate refresh, evaluation
   * and push after it. Not raised when the horizon went from 45 nights to 60:
   * the engine pages its reads across the whole horizon, so its round trips
   * barely grow with it, and the refresh is one PMS read at most hourly per
   * hotel (two small queries otherwise). The refresh's deadline is the
   * evaluation cut-off (minEvalMs before the invocation's end): it does not
   * start with less than a minute to that, and the PMS client stops waiting
   * out rate limits past it, so a slow refresh moves the evaluation to the
   * next tick instead of running into the wall clock.
   */
  evalReserveMs: number;
  /** The PMS read's own budget; the deadline passed down is never later than this from its start. */
  syncBudgetMs: number;
  /**
   * A hotel whose read ends with less than this left before the invocation's
   * deadline skips evaluation and push for this tick, and is released due again
   * shortly. Starting an evaluation that runs past the wall clock got the
   * invocation killed before it released anything.
   */
  minEvalMs: number;
};

/** How soon a hotel that ran out of time to evaluate is due again. */
export const OUT_OF_TIME_RETRY_SECONDS = 30;

/**
 * How soon a healthy hotel whose daily pass has nights left is due again
 * (pricing-plan.ts). With the cron running every minute, a wave of hotels
 * sharing a time zone finishes its passes within minutes of midnight; on a
 * five-minute cron it changes nothing.
 */
export const PASS_WORK_RETRY_SECONDS = 60;

/** release_pms_sync's interval for a hotel after its tick (see the three constants above). */
export function releaseIntervalSeconds(input: {
  outOfTime: boolean;
  syncOk: boolean;
  passWorkLeft: boolean;
  syncIntervalSeconds: number;
  invocationStartedAt: number;
  now: number;
}): number {
  if (input.outOfTime) return OUT_OF_TIME_RETRY_SECONDS;
  if (!input.syncOk) return input.syncIntervalSeconds;
  const healthy = healthyReleaseIntervalSeconds(input.syncIntervalSeconds, input.invocationStartedAt, input.now);
  return input.passWorkLeft ? Math.min(PASS_WORK_RETRY_SECONDS, healthy) : healthy;
}

/**
 * How late the cron may start an invocation, and how far the edge clock may
 * sit from the database's, without a healthy hotel missing its next tick.
 */
export const DUE_SLACK_SECONDS = 30;

/**
 * The least time between a hotel's healthy release and its next sync, however
 * late in its invocation it was released. Never more than the interval itself.
 */
export const MIN_HEALTHY_GAP_SECONDS = 60;

/**
 * The p_interval_seconds for release_pms_sync after a healthy run: the sync
 * interval counted from the start of the invocation, less DUE_SLACK_SECONDS,
 * rather than from the release, and never under MIN_HEALTHY_GAP_SECONDS.
 *
 * release_pms_sync makes a hotel due its interval after its own now(). A
 * hotel released a few seconds into an invocation was then due a few seconds
 * after the next tick's claim, and waited for the tick after: on a 5-minute
 * cron every hotel synced every 10 minutes (measured: 35 syncs in 6 hours,
 * every gap 9.9 to 10.1 minutes). Counted from the invocation's start it is
 * due by the next tick. It still can't run twice at once or twice in one
 * invocation: an invocation claims only when it starts, and a claimed hotel
 * stays leased until it is released.
 *
 * The floor is for a hotel released near the end of its invocation. Due at
 * once, the next invocation could take it first and sync it again seconds
 * after this one finished: a large property's reservation reads and pricing
 * twice over, and more of Cloudbeds' 429s. Such a hotel waits the floor and
 * is taken by the invocation after.
 *
 * Healthy releases only. A failure's backoff and the out-of-time retry are
 * still measured from the release.
 */
export function healthyReleaseIntervalSeconds(intervalSeconds: number, invocationStartedAt: number, now: number): number {
  const elapsedSeconds = Math.max(0, now - invocationStartedAt) / 1000;
  const anchored = Math.floor(intervalSeconds - elapsedSeconds - DUE_SLACK_SECONDS);
  return Math.max(0, anchored, Math.min(MIN_HEALTHY_GAP_SECONDS, intervalSeconds));
}

/**
 * How long a claimed hotel the scheduler may not work on waits before it can
 * be claimed again: a lapsed subscription, a property not active, a
 * connection parked for payment, or a purged property waiting for its import.
 */
export const NOT_WORKABLE_RETRY_SECONDS = 60 * 60;

/** Why the scheduler dropped a claimed hotel before working on it. */
export type DroppedHotel = { hotelId: string; status: string };

/**
 * Hands back the claimed hotels the scheduler dropped before any work (audit
 * A27). Left leased, each came back first in line every time its lease ran
 * out, ten minutes later, since its due time only got older, so enough of
 * them crowded every batch and paying hotels were never priced. Those it
 * may not work on wait NOT_WORKABLE_RETRY_SECONDS. One dropped only because
 * a read failed (`unknown`) gets its lease back with its due time untouched,
 * so a database blip never delays a paying hotel. `missing` has no row.
 *
 * claim_pms_sync_batch leaves these out once
 * 99_supabase_migration_sync_claim_paying_only_v1.sql has run, which also
 * makes a hotel due at once when its subscription restarts or it is switched
 * back on; this is what stops the crowding before that, and for a hotel that
 * lapsed between the claim and the check. Never throws: the lease runs out on
 * its own.
 */
export async function handBackDropped(
  supabase: SupabaseClient,
  pmsType: string,
  workerId: string,
  dropped: DroppedHotel[],
  log: (line: Record<string, unknown>) => void,
  nowMs: number = Date.now(),
): Promise<void> {
  const wait = dropped.filter((d) => d.status !== "unknown" && d.status !== "missing").map((d) => d.hotelId);
  const asIs = dropped.filter((d) => d.status === "unknown").map((d) => d.hotelId);
  const release = async (ids: string[], dueAt: string | null) => {
    if (ids.length === 0) return;
    try {
      const { error } = await supabase
        .from("pms_connections")
        .update({ sync_lease_until: null, sync_lease_owner: null, ...(dueAt ? { sync_due_at: dueAt } : {}) })
        .eq("pms_type", pmsType)
        .eq("sync_lease_owner", workerId)
        .in("hotel_id", ids);
      if (error) throw new Error(error.message);
    } catch (e) {
      log({ step: "hand_back_dropped", hotels: ids.length, error: e instanceof Error ? e.message : String(e) });
    }
  };
  await release(wait, new Date(nowMs + NOT_WORKABLE_RETRY_SECONDS * 1000).toISOString());
  await release(asIs, null);
}

/**
 * The claimed hotels, most overdue first. claim_pms_sync_batch picks the
 * batch by sync_due_at but hands it back in whatever order its UPDATE
 * returned rows, so a hotel's place in the loop, and with it how long after
 * its last sync it runs, moved from one invocation to the next. Unknown due
 * times go last; a failed read keeps the claim's order.
 */
export async function orderClaimedByDue(
  supabase: SupabaseClient,
  pmsType: string,
  hotelIds: string[],
  log: (line: Record<string, unknown>) => void,
): Promise<string[]> {
  if (hotelIds.length < 2) return hotelIds;
  const { data, error } = await supabase
    .from("pms_connections")
    .select("hotel_id, sync_due_at")
    .eq("pms_type", pmsType)
    .in("hotel_id", hotelIds);
  if (error) {
    log({ step: "order_claimed", error: error.message });
    return hotelIds;
  }
  const dueAt = new Map<string, number>();
  for (const r of (data ?? []) as { hotel_id: unknown; sync_due_at: unknown }[]) {
    const ms = r.sync_due_at != null ? Date.parse(String(r.sync_due_at)) : NaN;
    if (Number.isFinite(ms)) dueAt.set(String(r.hotel_id), ms);
  }
  const at = (id: string) => dueAt.get(id) ?? Infinity;
  // Array sort is stable, so equal due times keep the claim's order.
  return [...hotelIds].sort((a, b) => (at(a) === at(b) ? 0 : at(a) < at(b) ? -1 : 1));
}

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
   * past `evaluateBy` there is no time left to start evaluating it.
   */
  processHotel: (
    hotelId: string,
    deadlineAt: number,
    invocationDeadline: number,
    evaluateBy: number,
  ) => Promise<void>;
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
      await deps.processHotel(hotelId, Math.max(now, deadlineAt), invocationDeadline, invocationDeadline - config.minEvalMs);
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
 * is no connection row to hold (the RPC says "missing"), so no cron claims the
 * hotel either and it runs as dispatches always did.
 *
 * A claim that errors, or answers anything else, is "busy". Running unleased on
 * a claim nobody could read put the dispatch alongside a cron run that did hold
 * the lease: two sweeps on one checkpoint, two isolates pacing one PMS
 * credential, two evaluations writing the same ladder transitions, and the
 * same rates pushed twice with both runs racing on the ledger.
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
    log({ step: "dispatch_claim", hotelId, error: error.message, treatedAs: "busy" });
    return "busy";
  }
  if (data === "claimed") return "claimed";
  if (data === "missing") return "unleased";
  if (data !== "busy") log({ step: "dispatch_claim", hotelId, answer: String(data), treatedAs: "busy" });
  return "busy";
}

/** How long from the invocation's start a busy single-hotel dispatch keeps trying. */
export const DISPATCH_BUSY_WAIT_MS = 60_000;
/** Between tries while the hotel is busy. */
export const DISPATCH_BUSY_RETRY_MS = 3_000;

/**
 * claimDispatchedHotel, waiting a bounded time while the hotel is busy. A claim
 * that errored reads as busy, so a passing blip is simply tried again.
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
