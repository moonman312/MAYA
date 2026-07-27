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
    };

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
      .select("room_type_id, stay_date, price, status")
      .eq("hotel_id", hotelId)
      .gte("stay_date", firstDate)
      .lte("stay_date", lastDate)
      .order("stay_date", { ascending: true })
      .order("room_type_id", { ascending: true }),
  );
  const lastSent = new Map<string, number>();
  for (const l of ledgerRows) {
    if (l.status === "sent" && l.price != null) {
      lastSent.set(`${l.stay_date}|${String(l.room_type_id)}`, Number(l.price));
    }
  }

  // ── Which cells changed since the last successful push? ───────────────────
  const changed: RateCell[] = [];
  for (const p of ppRows) {
    const roomTypeId = String(p.room_type_id);
    const ext = extByRoomType.get(roomTypeId);
    if (!ext) continue; // no external mapping → can't target it
    const price = Number(p.price);
    const key = `${p.stay_date}|${roomTypeId}`;
    if (lastSent.get(key) === price) continue; // unchanged since last send
    changed.push({ stayDate: String(p.stay_date), roomTypeId, externalRoomTypeId: ext, price });
  }
  const skippedUnchanged = ppRows.length - changed.length;
  if (changed.length === 0) {
    return {
      pushed: true,
      cellsConsidered: ppRows.length,
      sent: 0,
      failed: 0,
      skippedUnchanged,
      skippedNoTarget: 0,
    };
  }

  // ── Resolve rate targets (cached on the connection; resolve+cache if absent) ─
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
  if (Object.keys(targets).length === 0) {
    targets = await adapter.resolveRateTargets();
    if (conn?.id && Object.keys(targets).length > 0) {
      await supabase.from("pms_connections").update({ push_rate_targets: targets }).eq("id", conn.id);
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
  return {
    pushed: true,
    cellsConsidered: ppRows.length,
    sent,
    failed,
    skippedUnchanged,
    skippedNoTarget: noTarget.length,
  };
}
