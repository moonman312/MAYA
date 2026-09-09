/**
 * Cloudbeds rate-push adapter. Implements the shared PmsRatePushAdapter:
 *   • resolveRateTargets — map external_room_type_id (Cloudbeds roomTypeID) to
 *     its base BAR rateID from getRatePlans (non-derived; base rates lack
 *     `ratePlanID`). Only non-derived rates are updatable via patchRate.
 *   • pushCells — group by rateID, chunk into ≤30 single-night intervals, and
 *     POST patchRate.
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
import type { CloudbedsResolvedCredentials } from "./types.ts";
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

export function createCloudbedsRateAdapter(
  creds: CloudbedsResolvedCredentials,
): PmsRatePushAdapter {
  return {
    pmsType: "cloudbeds",

    async resolveRateTargets(): Promise<RateTargetMap> {
      // getRatePlans requires a date window even for the catalog; a 1-day range
      // is enough — the roomTypeID → rateID mapping is date-independent.
      const start = new Date().toISOString().slice(0, 10);
      const end = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      const plans = await cloudbedsGetRatePlans(creds, start, end, { detailedRates: true });
      // Per room type, pick a non-derived rate, preferring the base BAR
      // (base rates lack `ratePlanID`).
      const chosen = new Map<string, { rateId: string; isBase: boolean }>();
      for (const plan of plans) {
        // deno-lint-ignore no-explicit-any
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = plan as any;
        if (p.isDerived === true || p.isDerived === "true") continue; // not updatable
        const roomTypeId = str(p, ["roomTypeID", "roomTypeId"]);
        const rateId = str(p, ["rateID", "rateId"]);
        if (!roomTypeId || !rateId) continue;
        const isBase = p.ratePlanID == null && p.ratePlanNamePublic == null;
        const prev = chosen.get(roomTypeId);
        if (!prev || (isBase && !prev.isBase)) {
          chosen.set(roomTypeId, { rateId, isBase });
        }
      }
      const map: RateTargetMap = {};
      for (const [roomTypeId, v] of chosen) map[roomTypeId] = v.rateId;
      return map;
    },

    async pushCells(
      cells: Array<RateCell & { externalRateId: string }>,
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
        // Chunk into ≤30 single-night intervals per patchRate call.
        for (let i = 0; i < group.length; i += MAX_INTERVALS_PER_CALL) {
          const chunk = group.slice(i, i + MAX_INTERVALS_PER_CALL);
          const intervals: CloudbedsRateInterval[] = chunk.map((c) => ({
            startDate: c.stayDate,
            endDate: c.stayDate, // single night (inclusive), per Cloudbeds example
            rate: c.price,
          }));
          const res = await cloudbedsPatchRate(creds, rateId, intervals);
          for (const c of chunk) {
            results.push(
              res.ok
                ? { cell: c, ok: true, jobReference: res.jobReferenceID }
                : { cell: c, ok: false, error: res.error },
            );
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
      const jobs = await cloudbedsGetRateJobs(creds);
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
    ): Promise<RateCalendarEntry[]> {
      // ONE call for the whole window. detailedRates returns roomRateDetailed[]
      // — a per-night breakdown — which is both what Cloudbeds requires of an
      // RMS integration and the only way to get per-night numbers: without it a
      // range collapses to a single aggregated roomRate per plan (verified
      // 2026-09-08: a 3-day window returned roomRate 338 and no dates).
      // endDate is exclusive, so ask for one extra day to include it.
      const roomTypesWanted = new Set(Object.keys(targets));
      const plans = await cloudbedsGetRatePlans(creds, startDate, addOneDay(endDate), {
        detailedRates: true,
      });

      const out: RateCalendarEntry[] = [];
      for (const plan of plans) {
        // Derived plans reprice off their parent, so the parent carries the
        // property's own rate — the same choice resolveRateTargets makes.
        if (plan.isDerived === true || plan.isDerived === "true") continue;
        const roomTypeId = String(plan.roomTypeID ?? "");
        if (!roomTypesWanted.has(roomTypeId)) continue;
        const nights = Array.isArray(plan.roomRateDetailed) ? plan.roomRateDetailed : [];
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
    },
  };
}

/** YYYY-MM-DD + 1 day, via UTC so no local-timezone drift. */
function addOneDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
