/**
 * Cloudbeds rate-push adapter. Implements the shared PmsRatePushAdapter:
 *   • resolveRateTargets — map external_room_type_id (Cloudbeds roomTypeID) to
 *     its base rateID from getRatePlans (non-derived; base rates lack
 *     `ratePlanID`). Only non-derived rates are updatable via patchRate, and
 *     only the base rate is ever a target (chooseBaseRates).
 *   • pushCells — group by rateID, chunk into ≤30 intervals (one per night, or
 *     one per run of same-price nights with CLOUDBEDS_MERGE_RATE_INTERVALS),
 *     and POST patchRate.
 *
 * ⚠ VERIFY against the live sandbox: getRatePlans field names (roomTypeID,
 * rateID, isDerived, ratePlanID) and the patchRate success/job envelope.
 * @see https://developers.cloudbeds.com/docs/revenue-management-system-rms
 */

import {
  cloudbedsGetRateJobs,
  cloudbedsGetRatePlans,
  cloudbedsPatchRate,
  type CloudbedsRateInterval,
} from "./client.ts";
import { CLOUDBEDS_MERGE_RATE_INTERVALS } from "./constants.ts";
import type { CloudbedsResolvedCredentials } from "./types.ts";
import type { TargetGap } from "../pms/push-failure.ts";
import type {
  CellPushResult,
  PmsRatePushAdapter,
  RateCalendarEntry,
  RateCell,
  RateTargetMap,
} from "../pms/rate-push.ts";

const MAX_INTERVALS_PER_CALL = 30; // Cloudbeds patchRate limit

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function str(obj: any, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/**
 * The intervals one rate's cells go out as. Unmerged, every night is its own
 * interval (startDate = endDate, inclusive, per the Cloudbeds example).
 * Merged, consecutive nights at the same price share one interval.
 */
export function rateIntervalRuns<C extends RateCell>(
  cells: C[],
  merge: boolean,
): { interval: CloudbedsRateInterval; cells: C[] }[] {
  if (!merge) {
    return cells.map((c) => ({ interval: { startDate: c.stayDate, endDate: c.stayDate, rate: c.price }, cells: [c] }));
  }
  const sorted = [...cells].sort((a, b) => (a.stayDate < b.stayDate ? -1 : a.stayDate > b.stayDate ? 1 : 0));
  const runs: { interval: CloudbedsRateInterval; cells: C[] }[] = [];
  for (const c of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.interval.rate === c.price && addOneDay(last.interval.endDate) === c.stayDate) {
      last.interval.endDate = c.stayDate;
      last.cells.push(c);
    } else {
      runs.push({ interval: { startDate: c.stayDate, endDate: c.stayDate, rate: c.price }, cells: [c] });
    }
  }
  return runs;
}

export function createCloudbedsRateAdapter(
  creds: CloudbedsResolvedCredentials,
  mergeIntervals: boolean = CLOUDBEDS_MERGE_RATE_INTERVALS,
  auth: {
    /**
     * Fresh credentials for a write refused with 401. Credentials are resolved
     * once when the sync starts, and a token that expires during the tick
     * would otherwise read as a revoked grant.
     */
    refreshCredentials?: () => Promise<CloudbedsResolvedCredentials | null>;
  } = {},
): PmsRatePushAdapter {
  let current = creds;
  let refreshedOnce = false;
  // ONE call for the whole window. detailedRates returns roomRateDetailed[]
  // — a per-night breakdown — which is both what Cloudbeds requires of an
  // RMS integration and the only way to get per-night numbers: without it a
  // range collapses to a single aggregated roomRate per plan (verified
  // 2026-09-08: a 3-day window returned roomRate 338 and no dates).
  // endDate is exclusive, so ask for one extra day to include it.
  const ratePlansFor = (startDate: string, endDate: string, deadlineAt?: number) =>
    cloudbedsGetRatePlans(current, startDate, addOneDay(endDate), { detailedRates: true, deadlineAt });
  // What the last catalog read said about room types it left out. Null until
  // a read lists something: an empty answer is a hiccup, not a teardown, and
  // says nothing about any room type.
  let lastGaps: Record<string, TargetGap> | null = null;
  const noteGaps = (plans: unknown[], withoutBaseRate: Record<string, number>) => {
    lastGaps = plans.length > 0 ? targetGaps(withoutBaseRate) : null;
  };

  return {
    pmsType: "cloudbeds",

    async resolveRateTargets(opts: { today?: string; deadlineAt?: number } = {}): Promise<RateTargetMap> {
      // getRatePlans requires a date window even for the catalog; a 1-day range
      // from the hotel's today is enough, since the roomTypeID → rateID mapping
      // is date-independent. The UTC date is only a fallback for a caller
      // outside the push path.
      const start = opts.today ?? new Date().toISOString().slice(0, 10);
      const plans = await cloudbedsGetRatePlans(current, start, addOneDay(start), {
        detailedRates: true,
        deadlineAt: opts.deadlineAt,
      });
      const { targets, withoutBaseRate } = chooseBaseRates(plans);
      logRateTargets(current.propertyId, targets, withoutBaseRate);
      noteGaps(plans, withoutBaseRate);
      return targets;
    },

    missingTargetReason(externalRoomTypeId: string): TargetGap | null {
      if (!lastGaps) return null;
      return lastGaps[externalRoomTypeId] ?? "not_in_catalog";
    },

    async pushCells(
      cells: Array<RateCell & { externalRateId: string }>,
      opts: { deadlineAt?: number } = {},
    ): Promise<CellPushResult[]> {
      // Group cells by rateID.
      const byRate = new Map<string, Array<RateCell & { externalRateId: string }>>();
      for (const c of cells) {
        const list = byRate.get(c.externalRateId) ?? [];
        list.push(c);
        byRate.set(c.externalRateId, list);
      }

      const results: CellPushResult[] = [];
      for (const [rateId, group] of byRate) {
        // Chunk into ≤30 intervals per patchRate call. Each interval keeps the
        // cells it covers, so every cell still gets its own ledger result.
        const runs = rateIntervalRuns(group, mergeIntervals);
        for (let i = 0; i < runs.length; i += MAX_INTERVALS_PER_CALL) {
          const chunk = runs.slice(i, i + MAX_INTERVALS_PER_CALL);
          // Checked before every call, not once per batch: one call can spend
          // minutes in 429 back-off, and ten of them used to run past the
          // invocation's end with nothing recorded.
          if (opts.deadlineAt != null && Date.now() > opts.deadlineAt) {
            for (const run of chunk) {
              for (const c of run.cells) results.push({ cell: c, ok: false, deferred: true });
            }
            continue;
          }
          const intervals: CloudbedsRateInterval[] = chunk.map((run) => run.interval);
          let res = await cloudbedsPatchRate(current, rateId, intervals);
          // Once per adapter: an expired token gets one fresh try, a refused
          // grant still comes back refused.
          if (!res.ok && res.status === 401 && auth.refreshCredentials && !refreshedOnce) {
            refreshedOnce = true;
            const fresh = await auth.refreshCredentials().catch(() => null);
            if (fresh) {
              current = fresh;
              res = await cloudbedsPatchRate(current, rateId, intervals);
            }
          }
          for (const run of chunk) {
            for (const c of run.cells) {
              results.push(
                res.ok
                  ? { cell: c, ok: true, jobReference: res.jobReferenceID }
                  : { cell: c, ok: false, error: res.error, httpStatus: res.status },
              );
            }
          }
        }
      }
      return results;
    },

    async fetchJobOutcomes(
      jobReferences: string[],
    ): Promise<Record<string, { done: boolean; ok: boolean; message?: string }>> {
      // One call returns the recent job list; we match ours out of it rather
      // than asking per job, because Cloudbeds has no per-reference lookup.
      const wanted = new Set(jobReferences.map(String));
      const out: Record<string, { done: boolean; ok: boolean; message?: string }> = {};
      const jobs = await cloudbedsGetRateJobs(current);
      for (const job of jobs) {
        if (!wanted.has(job.jobReferenceID)) continue;
        const status = job.status.toLowerCase();
        // Anything still moving is left undecided so the next tick asks again.
        if (status !== "completed" && status !== "failed" && status !== "error") {
          out[job.jobReferenceID] = { done: false, ok: false };
          continue;
        }
        // A job can complete with per-update failures, and those carry the
        // reason in `message` — a completed envelope is not on its own proof
        // that every rate in it applied.
        const failure = job.updates.find((u) => typeof u.message === "string" && u.message.trim());
        const ok = status === "completed" && !failure;
        out[job.jobReferenceID] = {
          done: true,
          ok,
          ...(ok ? {} : { message: failure?.message?.trim() || `job ${status}` }),
        };
      }
      return out;
    },

    async fetchRateCalendar(
      startDate: string,
      endDate: string,
      targets: RateTargetMap,
      opts: { deadlineAt?: number } = {},
    ): Promise<RateCalendarEntry[]> {
      return calendarEntries(await ratePlansFor(startDate, endDate, opts.deadlineAt), startDate, endDate, targets);
    },

    async readBaseRateCalendar(
      startDate: string,
      endDate: string,
      opts: { deadlineAt?: number } = {},
    ): Promise<{ targets: RateTargetMap; entries: RateCalendarEntry[] }> {
      // The catalog and the nightly rates arrive in the same response, so a
      // whole horizon's refresh is one getRatePlans call.
      const plans = await ratePlansFor(startDate, endDate, opts.deadlineAt);
      const { targets, withoutBaseRate } = chooseBaseRates(plans);
      logRateTargets(current.propertyId, targets, withoutBaseRate);
      noteGaps(plans, withoutBaseRate);
      return { targets, entries: calendarEntries(plans, startDate, endDate, targets) };
    },
  };
}

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isNonDerived(p: any): boolean {
  // Cloudbeds' rule is "only update rates with isDerived set to FALSE", and
  // that phrasing is deliberate. Skipping only an affirmative true left this
  // fail-OPEN: a plan with the field absent, null, 1 or "1" became a push
  // target, Cloudbeds accepted the job and then rejected the cell, and the
  // property's real rate never moved. Require the affirmative. (Live shape on
  // the sandbox is a real boolean, checked 2026-09-10.)
  return p?.isDerived === false || p?.isDerived === "false";
}

/**
 * Each room type's base rate, and nothing else.
 *
 * The base rate is the non-derived plan with no ratePlanID and no
 * ratePlanNamePublic; every rate plan built on top of it carries both. This
 * used to fall back to the first other non-derived plan when a room type had
 * no base, and an independent package or long-stay plan is non-derived too,
 * so MAYA's price could land on the breakfast package while the room's own
 * rate never moved. A room type without a base rate is now left out: its
 * cells are recorded as skipped "no rate target for room type" instead.
 *
 * `withoutBaseRate` counts, per room type left out, the non-derived plans it
 * did have, so a property whose base rates look different from the sandbox's
 * shows up in the log rather than as silence.
 */
export function chooseBaseRates(plans: unknown[]): {
  targets: RateTargetMap;
  withoutBaseRate: Record<string, number>;
} {
  const targets: RateTargetMap = {};
  const otherPlans = new Map<string, Set<string>>();
  for (const plan of plans) {
    // deno-lint-ignore no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = plan as any;
    const roomTypeId = str(p, ["roomTypeID", "roomTypeId"]);
    if (!roomTypeId) continue;
    const others = otherPlans.get(roomTypeId) ?? new Set<string>();
    otherPlans.set(roomTypeId, others);
    if (!isNonDerived(p)) continue;
    const rateId = str(p, ["rateID", "rateId"]);
    if (!rateId) continue;
    const isBase = p.ratePlanID == null && p.ratePlanNamePublic == null;
    if (!isBase) {
      others.add(rateId);
      continue;
    }
    if (!targets[roomTypeId]) targets[roomTypeId] = rateId;
  }
  const withoutBaseRate: Record<string, number> = {};
  for (const [roomTypeId, others] of otherPlans) {
    if (!targets[roomTypeId]) withoutBaseRate[roomTypeId] = others.size;
  }
  return { targets, withoutBaseRate };
}

/**
 * Why each room type chooseBaseRates saw was left out. One with other
 * non-derived plans has rates but no base among them (packages); one with
 * none has only rates that follow another plan. A room type the catalog did
 * not list at all is absent here, and reads as not_in_catalog.
 */
function targetGaps(withoutBaseRate: Record<string, number>): Record<string, TargetGap> {
  const gaps: Record<string, TargetGap> = {};
  for (const [roomTypeId, others] of Object.entries(withoutBaseRate)) {
    gaps[roomTypeId] = others > 0 ? "no_base_rate" : "derived_only";
  }
  return gaps;
}

/** The resolved map, one line per resolve. Ids and counts only. */
function logRateTargets(propertyId: string, targets: RateTargetMap, withoutBaseRate: Record<string, number>): void {
  console.log(
    JSON.stringify({
      fn: "cloudbedsRateTargets",
      propertyId,
      targets,
      ...(Object.keys(withoutBaseRate).length > 0 ? { withoutBaseRate } : {}),
    }),
  );
}

/**
 * Each targeted room type's nightly rate from its targeted plan only. Reading
 * every non-derived plan gave a room type one entry per plan per night: a
 * package's rate could become the base, and two entries for one cell in one
 * write made Postgres reject the whole chunk.
 */
function calendarEntries(
  plans: unknown[],
  startDate: string,
  endDate: string,
  targets: RateTargetMap,
): RateCalendarEntry[] {
  const out: RateCalendarEntry[] = [];
  for (const plan of plans) {
    // deno-lint-ignore no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = plan as any;
    // Derived plans reprice off their parent, so the parent carries the
    // property's own rate — the same choice resolveRateTargets makes.
    if (!isNonDerived(p)) continue;
    const roomTypeId = str(p, ["roomTypeID", "roomTypeId"]);
    if (!roomTypeId || !targets[roomTypeId]) continue;
    if (str(p, ["rateID", "rateId"]) !== targets[roomTypeId]) continue;
    const nights = Array.isArray(p.roomRateDetailed) ? p.roomRateDetailed : [];
    for (const night of nights as Record<string, unknown>[]) {
      const date = String(night.date ?? "");
      if (!date || date < startDate || date > endDate) continue;
      // null/undefined is a MISSING rate, and Number(null) is 0 — writing
      // that would hand the engine a $0 base and price the night at the
      // floor. An explicit 0 is a real comp rate and is kept.
      if (night.rate == null) continue;
      const price = Number(night.rate);
      if (!Number.isFinite(price)) continue;
      out.push({ stayDate: date, externalRoomTypeId: roomTypeId, price });
    }
  }
  return out;
}

/** YYYY-MM-DD + 1 day, via UTC so no local-timezone drift. */
function addOneDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
