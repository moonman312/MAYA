/**
 * Shared outbound rate-push orchestrator (PMS-agnostic).
 *
 * After the engine writes prices to `published_price`, this delivers them back
 * to the PMS — but ONLY for hotels in LIVE mode, and ONLY prices that changed
 * since the last successful push (tracked in `public.rate_updates`).
 *
 * Safety:
 *   • Gate 1 — hotel_settings.simulation_mode must be FALSE (Live). Sim hotels
 *     compute + display prices but never write to the PMS.
 *   • Gate 2 — the caller (Edge function) only invokes this when MAYA_PUSH_RATES
 *     is enabled, so deploying the code changes nothing until you opt in.
 *   • Idempotency — a cell is skipped when the ledger already recorded a 'sent'
 *     push at the same price, so we never spam unchanged rates.
 *   • Give-up — a cell the PMS has rejected MAX_PUSH_ATTEMPTS times at the
 *     same price is retired until the engine publishes a different number.
 *   • Target freshness — the cached room-type→rate map is re-resolved whenever a
 *     cell it doesn't cover shows up, and dropped after a push rejection, so a
 *     new room type or a rebuilt rate catalog heals on the next tick.
 *
 * Vendor specifics live behind PmsRatePushAdapter (Cloudbeds today; Mews next).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** external_room_type_id -> external rate identifier (Cloudbeds base rateID, etc.). */
export type RateTargetMap = Record<string, string>;

export type RateCell = {
  stayDate: string;
  roomTypeId: string;
  externalRoomTypeId: string;
  price: number;
};

export type CellPushResult = {
  cell: RateCell;
  ok: boolean;
  jobReference?: string | null;
  error?: string;
};

export interface PmsRatePushAdapter {
  pmsType: "cloudbeds" | "mews";
  /** Resolve external_room_type_id -> external rate id (the base BAR rate to update). */
  resolveRateTargets(): Promise<RateTargetMap>;
  /** Push cells (already carrying their externalRateId); batch internally per vendor limits. */
  pushCells(cells: Array<RateCell & { externalRateId: string }>): Promise<CellPushResult[]>;
}

export type RatePushOptions = {
  /** How many days forward to consider pushing (default 60). */
  pushHorizonDays?: number;
  /** Force re-resolve of the cached rate targets. */
  refreshTargets?: boolean;
};

export type RatePushSummary =
  | { pushed: false; reason: "not_live" | "no_published_prices" | "no_rate_targets" }
  | {
      pushed: true;
      cellsConsidered: number;
      sent: number;
      failed: number;
      skippedUnchanged: number;
      skippedNoTarget: number;
      skippedExhausted: number;
    };

/**
 * Rejected writes stop being retried at this many attempts per price. A rate
 * plan that has refused the same number this often will not take it on the
 * next tick either — without a ceiling every cell it rejects is re-sent every
 * tick, forever. A new engine price starts the count over.
 */
const MAX_PUSH_ATTEMPTS = 10;

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAll(makeQuery: () => any): Promise<any[]> {
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = [];
  let from = 0;
  let guard = 0;
  for (;;) {
    if (++guard > 1000) break;
    const { data, error } = await makeQuery().range(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < 1000) break;
    from += 1000;
  }
  return all;
}

function todayUtcYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export async function pushRatesForHotel(
  supabase: SupabaseClient,
  hotelId: string,
  adapter: PmsRatePushAdapter,
  opts: RatePushOptions = {},
): Promise<RatePushSummary> {
  // ── Gate 1: LIVE mode only ────────────────────────────────────────────────
  const { data: settings } = await supabase
    .from("hotel_settings")
    .select("simulation_mode")
    .eq("hotel_id", hotelId)
    .maybeSingle();
  // Default (missing row) is treated as simulation → do not push.
  if (settings?.simulation_mode !== false) {
    return { pushed: false, reason: "not_live" };
  }

  const horizon = Math.max(1, Math.min(365, opts.pushHorizonDays ?? 60));
  const firstDate = todayUtcYmd();
  const lastDate = addDaysYmd(firstDate, horizon - 1);

  // ── Load engine output for the window ─────────────────────────────────────
  const ppRows = await fetchAll(() =>
    supabase
      .from("published_price")
      .select("stay_date, room_type_id, price")
      .eq("hotel_id", hotelId)
      .gte("stay_date", firstDate)
      .lte("stay_date", lastDate)
      .order("stay_date", { ascending: true })
      .order("room_type_id", { ascending: true }),
  );
  if (ppRows.length === 0) return { pushed: false, reason: "no_published_prices" };

  // room_type_id -> external_room_type_id
  const rtRows = await fetchAll(() =>
    supabase
      .from("room_types")
      .select("id, external_room_type_id")
      .eq("hotel_id", hotelId)
      .order("id", { ascending: true }),
  );
  const extByRoomType = new Map<string, string>();
  for (const r of rtRows) {
    if (r.id && r.external_room_type_id) extByRoomType.set(String(r.id), String(r.external_room_type_id));
  }

  // Ledger: last state per (room_type, stay_date)
  const ledgerRows = await fetchAll(() =>
    supabase
      .from("rate_updates")
      .select("room_type_id, stay_date, price, status, attempts")
      .eq("hotel_id", hotelId)
      .gte("stay_date", firstDate)
      .lte("stay_date", lastDate)
      .order("stay_date", { ascending: true })
      .order("room_type_id", { ascending: true }),
  );
  const lastSent = new Map<string, number>();
  const lastFailed = new Map<string, { price: number; attempts: number }>();
  for (const l of ledgerRows) {
    const key = `${l.stay_date}|${String(l.room_type_id)}`;
    if (l.status === "sent" && l.price != null) {
      lastSent.set(key, Number(l.price));
    } else if (l.status === "failed" && l.price != null) {
      lastFailed.set(key, { price: Number(l.price), attempts: Number(l.attempts) || 1 });
    }
  }

  // ── Which cells changed since the last successful push? ───────────────────
  const changed: RateCell[] = [];
  let skippedExhausted = 0;
  for (const p of ppRows) {
    const roomTypeId = String(p.room_type_id);
    const ext = extByRoomType.get(roomTypeId);
    if (!ext) continue; // no external mapping → can't target it
    const price = Number(p.price);
    const key = `${p.stay_date}|${roomTypeId}`;
    if (lastSent.get(key) === price) continue; // unchanged since last send
    const failed = lastFailed.get(key);
    if (failed && failed.price === price && failed.attempts >= MAX_PUSH_ATTEMPTS) {
      skippedExhausted += 1;
      continue;
    }
    changed.push({ stayDate: String(p.stay_date), roomTypeId, externalRoomTypeId: ext, price });
  }
  const skippedUnchanged = ppRows.length - changed.length - skippedExhausted;
  if (changed.length === 0) {
    return {
      pushed: true,
      cellsConsidered: ppRows.length,
      sent: 0,
      failed: 0,
      skippedUnchanged,
      skippedNoTarget: 0,
      skippedExhausted,
    };
  }

  // ── Resolve rate targets (cached on the connection) ───────────────────────
  let targets: RateTargetMap = {};
  const { data: conn } = await supabase
    .from("pms_connections")
    .select("id, push_rate_targets")
    .eq("hotel_id", hotelId)
    .eq("pms_type", adapter.pmsType)
    .maybeSingle();
  if (!opts.refreshTargets && conn?.push_rate_targets && typeof conn.push_rate_targets === "object") {
    targets = conn.push_rate_targets as RateTargetMap;
  }
  // Coverage, not age, is what tells us the cache is out of date: a room type
  // added in the PMS after the map was written is simply absent from it, and a
  // non-empty map would otherwise never be re-resolved.
  let usingCache = Object.keys(targets).length > 0;
  const uncovered = changed.some((c) => !targets[c.externalRoomTypeId]);
  if (!usingCache || uncovered) {
    // A room type with only derived rate plans can never be covered, so this
    // re-resolve then runs on every tick — a throwing catalog read must not take
    // down the cells the cached map still targets.
    let resolved: RateTargetMap = {};
    try {
      resolved = await adapter.resolveRateTargets();
    } catch (e) {
      if (!usingCache) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `${adapter.pmsType} rate target re-resolve failed for hotel ${hotelId}, keeping cached map: ${msg}`,
      );
    }
    // An empty catalog read is a vendor hiccup far more often than a real
    // teardown — don't let it wipe a map that is still pushing rates.
    if (Object.keys(resolved).length > 0) {
      targets = resolved;
      usingCache = false;
      if (conn?.id) {
        await supabase.from("pms_connections").update({ push_rate_targets: targets }).eq("id", conn.id);
      }
    }
  }
  if (Object.keys(targets).length === 0) {
    return { pushed: false, reason: "no_rate_targets" };
  }

  // Attach rate ids; separate cells with no target
  const withTarget: Array<RateCell & { externalRateId: string }> = [];
  const noTarget: RateCell[] = [];
  for (const c of changed) {
    const rateId = targets[c.externalRoomTypeId];
    if (rateId) withTarget.push({ ...c, externalRateId: rateId });
    else noTarget.push(c);
  }

  // ── Push ──────────────────────────────────────────────────────────────────
  const results = withTarget.length > 0 ? await adapter.pushCells(withTarget) : [];
  const nowIso = new Date().toISOString();

  // ── Record ledger (upsert latest state per cell) ──────────────────────────
  const ledgerUpserts: Record<string, unknown>[] = [];
  for (const r of results) {
    const prior = lastFailed.get(`${r.cell.stayDate}|${r.cell.roomTypeId}`);
    ledgerUpserts.push({
      hotel_id: hotelId,
      pms_type: adapter.pmsType,
      room_type_id: r.cell.roomTypeId,
      external_room_type_id: r.cell.externalRoomTypeId,
      stay_date: r.cell.stayDate,
      price: r.cell.price,
      external_rate_id: (r.cell as RateCell & { externalRateId?: string }).externalRateId ?? null,
      status: r.ok ? "sent" : "failed",
      pms_job_reference: r.jobReference ?? null,
      error: r.ok ? null : (r.error ?? "push failed"),
      // Counted per price, so MAX_PUSH_ATTEMPTS can retire a cell the PMS
      // keeps rejecting without ever giving up on a freshly computed number.
      attempts: r.ok ? 1 : prior && prior.price === r.cell.price ? prior.attempts + 1 : 1,
      pushed_at: nowIso,
    });
  }
  for (const c of noTarget) {
    ledgerUpserts.push({
      hotel_id: hotelId,
      pms_type: adapter.pmsType,
      room_type_id: c.roomTypeId,
      external_room_type_id: c.externalRoomTypeId,
      stay_date: c.stayDate,
      price: c.price,
      external_rate_id: null,
      status: "skipped",
      error: "no rate target for room type",
      attempts: 1,
      pushed_at: nowIso,
    });
  }
  if (ledgerUpserts.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < ledgerUpserts.length; i += CHUNK) {
      await supabase
        .from("rate_updates")
        .upsert(ledgerUpserts.slice(i, i + CHUNK), { onConflict: "hotel_id,room_type_id,stay_date" });
    }
  }

  const sent = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  // Rejections against cached rate ids usually mean the catalog was rebuilt and
  // those ids are gone. Failed cells stay "changed" (only sends land in the
  // ledger's lastSent), so dropping the cache is enough for the next tick to
  // re-resolve and retry them instead of hammering dead ids forever.
  if (failed > 0 && usingCache && conn?.id) {
    await supabase.from("pms_connections").update({ push_rate_targets: null }).eq("id", conn.id);
  }

  return {
    pushed: true,
    cellsConsidered: ppRows.length,
    sent,
    failed,
    skippedUnchanged,
    skippedNoTarget: noTarget.length,
    skippedExhausted,
  };
}
