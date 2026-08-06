/**
 * Think rate-push adapter. Implements the shared PmsRatePushAdapter:
 *   • resolveRateTargets — map each room type to the STANDARD rate type MAYA
 *     should write, preferring the property's Best Available Rate. DERIVED
 *     rate types reprice themselves off their parent, so writing the parent
 *     is the whole job.
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
  thinkGetRateTypes,
  thinkPutDailyRates,
  type ThinkDailyRateRow,
} from "./client.ts";
import type { ThinkCredentials } from "./types.ts";
import type {
  CellPushResult,
  PmsRatePushAdapter,
  RateCell,
  RateTargetMap,
} from "../pms/rate-push.ts";

const MAX_ROWS_PER_CALL = 500;

export function createThinkRateAdapter(
  creds: ThinkCredentials,
  thinkHotelId: string,
): PmsRatePushAdapter {
  return {
    pmsType: "think",

    async resolveRateTargets(): Promise<RateTargetMap> {
      const rateTypes = await thinkGetRateTypes(creds, thinkHotelId);
      // Per room type, pick a STANDARD rate: Best Available Rate by name if
      // one exists, else the STANDARD type covering the most room types (the
      // property's broadest base rate).
      type Candidate = { id: string; isBar: boolean; breadth: number };
      const chosen = new Map<string, Candidate>();
      for (const rt of rateTypes) {
        if (rt.type === "DERIVED") continue;
        const id = typeof rt.id === "string" ? rt.id : String(rt.id ?? "");
        if (!id) continue;
        const roomTypeIds = Array.isArray(rt.roomTypeIds)
          ? rt.roomTypeIds.map(String)
          : [];
        const isBar =
          typeof rt.name === "string" && /best\s*available/i.test(rt.name);
        for (const roomTypeId of roomTypeIds) {
          const prev = chosen.get(roomTypeId);
          const next: Candidate = { id, isBar, breadth: roomTypeIds.length };
          if (
            !prev ||
            (isBar && !prev.isBar) ||
            (isBar === prev.isBar && next.breadth > prev.breadth)
          ) {
            chosen.set(roomTypeId, next);
          }
        }
      }
      const map: RateTargetMap = {};
      for (const [roomTypeId, v] of chosen) map[roomTypeId] = v.id;
      return map;
    },

    async pushCells(
      cells: Array<RateCell & { externalRateId: string }>,
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
          const rows: ThinkDailyRateRow[] = chunk.map((c) => ({
            roomTypeId: c.externalRoomTypeId,
            rateTypeId,
            date: c.stayDate,
            price: c.price,
          }));
          try {
            const res = await thinkPutDailyRates(creds, thinkHotelId, rateTypeId, rows);
            for (const c of chunk) {
              results.push({ cell: c, ok: true, jobReference: `accepted:${res.status}` });
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : "push failed";
            for (const c of chunk) results.push({ cell: c, ok: false, error: msg });
          }
        }
      }
      return results;
    },
  };
}
