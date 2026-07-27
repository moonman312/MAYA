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
  cloudbedsGetRatePlans,
  cloudbedsPatchRate,
  type CloudbedsRateInterval,
} from "./client.ts";
import type { CloudbedsResolvedCredentials } from "./types.ts";
import type {
  CellPushResult,
  PmsRatePushAdapter,
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
      const plans = await cloudbedsGetRatePlans(creds, start, end);
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
  };
}
