/**
 * Think rate-push adapter. Implements the shared PmsRatePushAdapter:
 *   • resolveRateTargets — map each room type to the property's base STANDARD
 *     rate type (chooseThinkBaseRates). DERIVED rate types reprice themselves
 *     off their parent, so writing the parent is the whole job.
 *   • pushCells — group by rate type and PUT gzipped daily-rate rows.
 *
 * VERIFIED live 2026-08-05 on the sandbox: the gzip body is mandatory (plain
 * JSON is a 500 media-type error) and the server 202s, applying the update
 * asynchronously. A 202 is recorded as sent — the same optimistic contract as
 * Cloudbeds' patchRate job reference — and the ledger's retry ceiling covers
 * a queue that quietly drops a batch. The sandbox's queue did exactly that
 * during testing, so until Think confirms the row contract the shape here is
 * the strongest available guess: it round-trips what GET /daily returns.
 */

import {
  thinkGetDailyRates,
  thinkGetRateTypes,
  thinkPutDailyRates,
  ThinkHttpError,
  type ThinkDailyRateRow,
} from "./client.ts";
import type { TargetGap } from "../pms/push-failure.ts";
import type { ThinkCredentials } from "./types.ts";
import type {
  CellPushResult,
  PmsRatePushAdapter,
  RateCalendarEntry,
  RateCell,
  RateTargetMap,
} from "../pms/rate-push.ts";

const MAX_ROWS_PER_CALL = 500;

export function createThinkRateAdapter(
  creds: ThinkCredentials,
  thinkHotelId: string,
  auth: {
    /**
     * Fresh credentials for a write refused with 401. Credentials are resolved
     * once per tick, and a token that expires during it would otherwise read
     * as a revoked grant.
     */
    refreshCredentials?: () => Promise<ThinkCredentials | null>;
  } = {},
): PmsRatePushAdapter {
  let current = creds;
  let refreshedOnce = false;
  // Whether the last catalog read listed any rate type: null before one, or
  // after one that came back empty, which says nothing about any room type.
  let lastReadListed: boolean | null = null;
  return {
    pmsType: "think",

    async resolveRateTargets(readOpts: { deadlineAt?: number } = {}): Promise<RateTargetMap> {
      const rateTypes = await thinkGetRateTypes(current, thinkHotelId, { deadlineAt: readOpts.deadlineAt });
      const { targets, withoutBaseRate } = chooseThinkBaseRates(rateTypes);
      lastReadListed = rateTypes.length > 0 ? true : null;
      console.log(
        JSON.stringify({
          fn: "thinkRateTargets",
          thinkHotelId,
          targets,
          ...(Object.keys(withoutBaseRate).length > 0 ? { withoutBaseRate } : {}),
        }),
      );
      return targets;
    },

    // Think marks rate types STANDARD or DERIVED and nothing more, so after a
    // read that listed rate types, a room type left out has no base rate as
    // far as MAYA can tell: none, or two standard types tied for it.
    missingTargetReason(): TargetGap | null {
      return lastReadListed ? "no_base_rate" : null;
    },

    async pushCells(
      cells: Array<RateCell & { externalRateId: string }>,
      opts: { deadlineAt?: number } = {},
    ): Promise<CellPushResult[]> {
      const byRate = new Map<string, Array<RateCell & { externalRateId: string }>>();
      for (const c of cells) {
        const list = byRate.get(c.externalRateId) ?? [];
        list.push(c);
        byRate.set(c.externalRateId, list);
      }

      const results: CellPushResult[] = [];
      for (const [rateTypeId, group] of byRate) {
        for (let i = 0; i < group.length; i += MAX_ROWS_PER_CALL) {
          const chunk = group.slice(i, i + MAX_ROWS_PER_CALL);
          if (opts.deadlineAt != null && Date.now() > opts.deadlineAt) {
            for (const c of chunk) results.push({ cell: c, ok: false, deferred: true });
            continue;
          }
          const rows: ThinkDailyRateRow[] = chunk.map((c) => ({
            roomTypeId: c.externalRoomTypeId,
            rateTypeId,
            date: c.stayDate,
            price: c.price,
          }));
          try {
            let res;
            try {
              res = await thinkPutDailyRates(current, thinkHotelId, rateTypeId, rows);
            } catch (e) {
              // Once per adapter: an expired token gets one fresh try.
              if (!(e instanceof ThinkHttpError && e.status === 401 && auth.refreshCredentials && !refreshedOnce)) throw e;
              refreshedOnce = true;
              const fresh = await auth.refreshCredentials().catch(() => null);
              if (!fresh) throw e;
              current = fresh;
              res = await thinkPutDailyRates(current, thinkHotelId, rateTypeId, rows);
            }
            for (const c of chunk) {
              results.push({ cell: c, ok: true, jobReference: `accepted:${res.status}` });
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : "push failed";
            const httpStatus = e instanceof ThinkHttpError ? e.status : null;
            for (const c of chunk) results.push({ cell: c, ok: false, error: msg, httpStatus });
          }
        }
      }
      return results;
    },

    async fetchRateCalendar(
      startDate: string,
      endDate: string,
      targets: RateTargetMap,
      readOpts: { deadlineAt?: number } = {},
    ): Promise<RateCalendarEntry[]> {
      // One call per distinct rate type covers every room-night in the window,
      // so a horizon costs as many requests as the property has base rates.
      const wanted = new Map<string, Set<string>>();
      for (const [roomTypeId, rateTypeId] of Object.entries(targets)) {
        const set = wanted.get(rateTypeId) ?? new Set<string>();
        set.add(roomTypeId);
        wanted.set(rateTypeId, set);
      }
      const out: RateCalendarEntry[] = [];
      for (const [rateTypeId, roomTypeIds] of wanted) {
        const rows = await thinkGetDailyRates(current, thinkHotelId, rateTypeId, startDate, endDate, {
          deadlineAt: readOpts.deadlineAt,
        });
        for (const r of rows) {
          const roomTypeId = String(r.roomTypeId ?? "");
          // A rate type covers room types we may not price; keep only ours.
          if (!roomTypeIds.has(roomTypeId)) continue;
          // null/undefined is a MISSING rate, and Number(null) is 0 — writing
          // that would hand the engine a $0 base. An explicit 0 is a real comp
          // rate and is kept.
          if (r.price == null) continue;
          const price = Number(r.price);
          if (!Number.isFinite(price)) continue;
          out.push({ stayDate: String(r.date), externalRoomTypeId: roomTypeId, price });
        }
      }
      return out;
    },
  };
}

/**
 * Each room type's base rate type, and nothing else.
 *
 * Think marks a rate type STANDARD or DERIVED and nothing more: a
 * non-refundable rate or a package is STANDARD just like the Best Available
 * Rate (sandbox: BAR 44186 and Non-Refundable 44910, both STANDARD). So the
 * base is chosen once for the whole property: its STANDARD types named Best
 * Available, or, when none is, the single STANDARD type covering the most room
 * types. A room type no base type covers is left out rather than handed the
 * next STANDARD type that happens to cover it, which is how a room's price
 * used to land on the non-refundable or package rate. A tie for broadest is
 * no base at all: guessing between two is how the wrong one gets written.
 *
 * Only an affirmative STANDARD counts. Skipping just DERIVED would make a type
 * with the field missing a push target.
 */
export function chooseThinkBaseRates(rateTypes: Record<string, unknown>[]): {
  targets: RateTargetMap;
  withoutBaseRate: Record<string, number>;
} {
  type Standard = { id: string; isBar: boolean; roomTypeIds: string[] };
  const standard: Standard[] = [];
  for (const rt of rateTypes) {
    if (String(rt.type ?? "").toUpperCase() !== "STANDARD") continue;
    const id = typeof rt.id === "string" ? rt.id : String(rt.id ?? "");
    if (!id) continue;
    const roomTypeIds = Array.isArray(rt.roomTypeIds) ? rt.roomTypeIds.map(String) : [];
    standard.push({ id, isBar: typeof rt.name === "string" && /best\s*available/i.test(rt.name), roomTypeIds });
  }

  let base = standard.filter((rt) => rt.isBar);
  if (base.length === 0 && standard.length > 0) {
    const widest = Math.max(...standard.map((rt) => rt.roomTypeIds.length));
    const broadest = standard.filter((rt) => rt.roomTypeIds.length === widest);
    base = broadest.length === 1 ? broadest : [];
  }

  // Among base types, the broadest covering a room type wins; first listed on a tie.
  const targets: RateTargetMap = {};
  const breadth = new Map<string, number>();
  for (const rt of base) {
    for (const roomTypeId of rt.roomTypeIds) {
      if ((breadth.get(roomTypeId) ?? -1) >= rt.roomTypeIds.length) continue;
      targets[roomTypeId] = rt.id;
      breadth.set(roomTypeId, rt.roomTypeIds.length);
    }
  }

  const withoutBaseRate: Record<string, number> = {};
  for (const rt of standard) {
    for (const roomTypeId of rt.roomTypeIds) {
      if (targets[roomTypeId]) continue;
      // Any type covering a room type left out is, by construction, not a base.
      withoutBaseRate[roomTypeId] = (withoutBaseRate[roomTypeId] ?? 0) + 1;
    }
  }
  return { targets, withoutBaseRate };
}
