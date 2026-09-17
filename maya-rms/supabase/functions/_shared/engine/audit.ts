/**
 * Evaluation audit — Implementation Guide §3.10, §14.
 * Deno-portable copy of src/lib/engine/audit.ts (import paths only differ).
 */

import type { EvaluationAuditDetails } from "./domain.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BaseSource } from "./base-price.ts";
import type { LadderPassResult } from "./ladder.ts";
import { basePriceKey, pickupTieBreakTrace } from "./pickup.ts";
import type { AssembledPrice } from "./pricing.ts";
import { MIGRATIONS, isMissingFunctionError } from "./snapshots.ts";
import type { PickupCandidate } from "./types.ts";

export type AuditInput = {
  runId: string;
  hotelId: string;
  evalTs: string;
  assembled: AssembledPrice;
  ladderResults: LadderPassResult[];
  pickupWinners: PickupCandidate[];
  pickupLosers: PickupCandidate[];
  pickupIdempotentSkips: PickupCandidate[];
  /** A rule fired and lost its price effect to a write error — must read distinctly from an idempotency skip. */
  pickupWriteFailures: PickupCandidate[];
  basePrices: Map<string, number>;
  /** Layer 1 Booking Speed observations consulted for this stay date this run. */
  bookingSpeedObservations?: Record<string, unknown>[];
  /**
   * The signature (see auditSignature) of the last audit row written for
   * this exact (stay_date, room_type) cell, if any. When the new row's
   * signature is identical, writeAudit skips the insert entirely — a cell
   * whose price and applied rules haven't moved has nothing new to record.
   *
   * Without this, the engine wrote a row for every priced cell on every
   * five-minute run whether or not anything changed: a small property with
   * ~60 priced cells produced ~200,000 rows in six days, almost all of them
   * identical to the row before. A real property with a year-long horizon
   * and five room types would produce on the order of half a million rows a
   * day, forever, since nothing ever purged this table.
   */
  previousSignature?: string | null;
  /** The open manual_price row for this cell, when one exists. */
  manualOverride?: { set_by: string | null; set_at: string } | null;
};

/**
 * Where the base came from, and who set it when it was typed by hand. Lives
 * beside the guide's details shape so the change log can attribute a manual
 * price to a person instead of narrating it as an anonymous rate move.
 */
export type AuditBaseDetails = {
  base_source: BaseSource;
  manual_override?: { set_by: string | null; set_at: string };
};

/**
 * A cheap fingerprint of "what this run decided" for one cell: the final
 * price, which effects are currently applying and in what order, and
 * whether a floor/ceiling clamp is in force. Two runs with the same
 * signature produced the same outcome — a persistently active rule stays
 * active with the same rule_id in application_order every run, so this
 * does not flag "nothing changed" merely because a rule is still in effect.
 */
export function auditSignature(
  finalPrice: number,
  applicationOrder: string[],
  clampedBy: string,
  baseKey: string = "",
): string {
  return `${finalPrice.toFixed(2)}|${applicationOrder.join(",")}|${clampedBy}|${baseKey}`;
}

/**
 * The part of the signature that says a human typed the base. A manual price
 * equal to what MAYA was already publishing changes nothing about the number
 * yet is exactly the change the manager will look for in the change log, so
 * setting and clearing one each earn a row. Only the manual case is keyed:
 * MAYA's own tiers swapping at the same price stay silent, as before.
 */
export function auditBaseKey(details: {
  base_source?: string;
  manual_override?: { set_at: string } | null;
}): string {
  return details.base_source === "manual" && details.manual_override
    ? `manual:${details.manual_override.set_at}`
    : "";
}

/**
 * Write a single evaluation_audit row for one (stay_date, room_type), unless
 * its signature matches input.previousSignature. Returns whether a row was
 * written.
 */
export async function writeAudit(supabase: SupabaseClient, input: AuditInput): Promise<boolean> {
  const row = buildAuditRow(input);
  if (!row) return false;
  await supabase.from("evaluation_audit").insert(row);
  return true;
}

/**
 * The evaluation_audit row writeAudit would insert, or null when the cell's
 * signature matches input.previousSignature and nothing is written.
 */
export function buildAuditRow(input: AuditInput): Record<string, unknown> | null {
  const { assembled, basePrices } = input;

  const ladderDelta =
    assembled.pre_clamp_price - assembled.base_price - computePickupDelta(assembled);

  const pickupDelta = computePickupDelta(assembled);

  const winnerForRoom = input.pickupWinners[0];

  const details: EvaluationAuditDetails & AuditBaseDetails = {
    matched_ladder_rules: input.ladderResults.map((lr) => ({
      rule_id: lr.rule_id,
      rule_version: lr.rule_version,
      transition: lr.transition === "activate" || lr.transition === "deactivate" ? lr.transition : "noop",
      action: {
        kind: lr.action_kind as "percent" | "fixed",
        direction: lr.action_direction as "increase" | "decrease",
        value: lr.action_value,
      },
      metrics: lr.metrics as unknown as Record<string, unknown>,
    })),
    pickup_candidates: [
      ...input.pickupWinners.map((c) => ({
        rule_id: c.rule.id,
        outcome: "won" as const,
        metrics: enrichPickupMetrics(c, basePrices),
        tie_break_trace: ["winner"],
      })),
      ...input.pickupLosers.map((c) => ({
        rule_id: c.rule.id,
        outcome: "lost_competition" as const,
        metrics: enrichPickupMetrics(c, basePrices),
        tie_break_trace:
          winnerForRoom != null ? pickupTieBreakTrace(winnerForRoom, c, basePrices) : [`priority=${c.rule.priority}`],
      })),
      ...input.pickupIdempotentSkips.map((c) => ({
        rule_id: c.rule.id,
        outcome: "idempotency_skip" as const,
        metrics: enrichPickupMetrics(c, basePrices),
        tie_break_trace: ["idempotency_guard_same_run"],
      })),
      ...input.pickupWriteFailures.map((c) => ({
        rule_id: c.rule.id,
        outcome: "write_failed" as const,
        metrics: enrichPickupMetrics(c, basePrices),
        tie_break_trace: ["pickup_event_insert_failed"],
      })),
    ],
    active_ladder_effects: assembled.ladder_effects.map((e) => ({
      rule_id: e.rule_id,
      delta: formatDelta(e.action_kind, e.action_direction, e.action_value),
    })),
    active_pickup_effects: assembled.pickup_effects.map((e) => ({
      event_id: e.event_id,
      rule_id: e.rule_id,
      delta: formatDelta(e.action_kind, e.action_direction, e.action_value),
    })),
    application_order: [
      ...assembled.ladder_effects.map((e) => `ladder:${e.rule_id}`),
      ...assembled.pickup_effects.map((e) => `pickup:${e.event_id}`),
    ],
    pre_clamp_price: assembled.pre_clamp_price.toFixed(2),
    clamped_by: assembled.clamped_by,
    base_source: assembled.base_source,
    ...(assembled.base_source === "manual" && input.manualOverride
      ? {
          manual_override: {
            set_by: input.manualOverride.set_by,
            set_at: input.manualOverride.set_at,
          },
        }
      : {}),
    ...(input.bookingSpeedObservations && input.bookingSpeedObservations.length > 0
      ? { booking_speed_observations: input.bookingSpeedObservations }
      : {}),
  };

  const signature = auditSignature(
    assembled.final_price,
    details.application_order,
    details.clamped_by,
    auditBaseKey(details),
  );
  if (input.previousSignature != null && input.previousSignature === signature) {
    return null;
  }

  return {
    evaluation_run_id: input.runId,
    hotel_id: input.hotelId,
    stay_date: assembled.stay_date,
    room_type_id: assembled.room_type_id,
    evaluated_at: input.evalTs,
    base_price: assembled.base_price,
    floor_price: assembled.floor_price,
    ceiling_price: assembled.ceiling_price,
    ladder_subtotal_delta: Math.round(ladderDelta * 100) / 100,
    pickup_subtotal_delta: Math.round(pickupDelta * 100) / 100,
    pre_clamp_price: assembled.pre_clamp_price,
    final_price: assembled.final_price,
    details,
  };
}

/** Rows per audit insert, and a rough cap on one request's body. */
const AUDIT_CHUNK_ROWS = 200;
const AUDIT_CHUNK_BYTES = 1_000_000;

/**
 * Insert built audit rows in chunks instead of one request per cell. A chunk
 * that fails is retried row by row so a bad row costs only itself. Insert
 * errors go unreported, as they always have: the audit trail is bookkeeping
 * and must never fail a run whose prices are already published.
 */
export async function insertAuditRows(supabase: SupabaseClient, rows: Record<string, unknown>[]): Promise<void> {
  let chunk: Record<string, unknown>[] = [];
  let bytes = 0;
  const send = async () => {
    if (chunk.length === 0) return;
    const { error } = await supabase.from("evaluation_audit").insert(chunk);
    if (error && chunk.length > 1) {
      for (const row of chunk) await supabase.from("evaluation_audit").insert([row]);
    }
    chunk = [];
    bytes = 0;
  };
  for (const row of rows) {
    const size = JSON.stringify(row).length;
    if (chunk.length > 0 && (chunk.length >= AUDIT_CHUNK_ROWS || bytes + size > AUDIT_CHUNK_BYTES)) await send();
    chunk.push(row);
    bytes += size;
  }
  await send();
}

/** The details fields a signature is built from, and nothing else. */
const SIGNATURE_COLUMNS =
  "stay_date, room_type_id, final_price, " +
  "application_order:details->application_order, clamped_by:details->>clamped_by, " +
  "base_source:details->>base_source, manual_override:details->manual_override";

let loggedAuditSignaturesMissing = false;

/** Test hook: forget that the pre-migration line was already logged. */
export function resetAuditSignaturesLogOnce(): void {
  loggedAuditSignaturesMissing = false;
}

function signatureOf(r: Record<string, unknown>): string {
  return auditSignature(
    Number(r.final_price),
    Array.isArray(r.application_order) ? (r.application_order as string[]) : [],
    r.clamped_by != null ? String(r.clamped_by) : "none",
    auditBaseKey({
      base_source: r.base_source != null ? String(r.base_source) : undefined,
      manual_override: (r.manual_override ?? null) as { set_at: string } | null,
    }),
  );
}

/**
 * Batched lookup of the most recent audit signature per (stay_date,
 * room_type) across the whole horizon — one query instead of one per cell.
 *
 * With the large property migration, audit_last_signatures picks the newest
 * row per cell in the database. Before it, rows are paged newest first
 * (ties broken by id, so a page boundary inside one run cannot skip a row)
 * and only the fields a signature reads come back, never the full details.
 */
export async function loadLastAuditSignatures(
  supabase: SupabaseClient,
  hotelId: string,
  firstDate: string,
  lastDate: string,
): Promise<Map<string, string>> {
  const PAGE = 1000;
  const signatures = new Map<string, string>();

  let rpcAvailable = true;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .rpc("audit_last_signatures", { p_hotel_id: hotelId, p_from: firstDate, p_to: lastDate })
      .order("stay_date", { ascending: true })
      .order("room_type_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      if (!isMissingFunctionError(error)) {
        throw new Error(`Failed to load prior audit signatures: ${error.message}`);
      }
      if (!loggedAuditSignaturesMissing) {
        loggedAuditSignaturesMissing = true;
        console.error(
          JSON.stringify({
            fn: "loadLastAuditSignatures",
            hotelId,
            schema: "pre-migration",
            message: `audit_last_signatures does not exist yet; paging the audit rows instead. Run ${MIGRATIONS.largePropertyScale}.`,
            migration: MIGRATIONS.largePropertyScale,
            error: error.message,
          }),
        );
      }
      rpcAvailable = false;
      signatures.clear();
      break;
    }
    const rows = (data ?? []) as Record<string, unknown>[];
    for (const r of rows) signatures.set(`${r.stay_date}|${r.room_type_id}`, signatureOf(r));
    if (rows.length < PAGE) break;
  }
  if (rpcAvailable) return signatures;

  const seenKeys = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("evaluation_audit")
      .select(SIGNATURE_COLUMNS)
      .eq("hotel_id", hotelId)
      .gte("stay_date", firstDate)
      .lte("stay_date", lastDate)
      .order("evaluated_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Failed to load prior audit signatures: ${error.message}`);
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    for (const r of rows) {
      const key = `${r.stay_date}|${r.room_type_id}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      signatures.set(key, signatureOf(r));
    }
    if (rows.length < PAGE) break;
  }
  return signatures;
}

/**
 * Delete evaluation_audit rows older than the retention window. Cheap now
 * that a stable cell only gets one row per actual change instead of one per
 * run — this exists so that stays true indefinitely rather than relying on
 * the write-side fix alone.
 */
export async function purgeOldAuditRows(
  supabase: SupabaseClient,
  hotelId: string,
  retentionDays: number = 90,
): Promise<void> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const { error } = await supabase
    .from("evaluation_audit")
    .delete()
    .eq("hotel_id", hotelId)
    .lt("evaluated_at", cutoff.toISOString());

  if (error) throw new Error(`Audit purge failed: ${error.message}`);
}

/**
 * Record that a run happened, regardless of whether anything changed.
 *
 * One tiny row per run — a timestamp and two counts, no JSONB, no per-cell
 * detail — so the Change Log can still show "checked at 4:32, nothing
 * needed to change" for a fully quiet run even though write-on-change means
 * no evaluation_audit rows exist for it. The narrative text itself is never
 * stored here either; it's rendered from cellsChecked/cellsChanged at read
 * time, same as every other changelog entry.
 */
export async function recordRunHeartbeat(
  supabase: SupabaseClient,
  hotelId: string,
  runId: string,
  evalTs: string,
  cellsChecked: number,
  cellsChanged: number,
): Promise<void> {
  const { error } = await supabase.from("evaluation_run_log").upsert(
    {
      hotel_id: hotelId,
      evaluation_run_id: runId,
      evaluated_at: evalTs,
      cells_checked: cellsChecked,
      cells_changed: cellsChanged,
    },
    { onConflict: "hotel_id,evaluation_run_id" },
  );
  if (error) throw new Error(`Run heartbeat failed: ${error.message}`);
}

/** Delete evaluation_run_log rows older than the retention window. */
export async function purgeOldRunLogRows(
  supabase: SupabaseClient,
  hotelId: string,
  retentionDays: number = 90,
): Promise<void> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const { error } = await supabase
    .from("evaluation_run_log")
    .delete()
    .eq("hotel_id", hotelId)
    .lt("evaluated_at", cutoff.toISOString());

  if (error) throw new Error(`Run log purge failed: ${error.message}`);
}

function enrichPickupMetrics(c: PickupCandidate, basePrices: Map<string, number>): Record<string, unknown> {
  return {
    ...c.metrics,
    baseline_ts: c.baseline_ts,
    stay_date: c.stay_date,
    base_price_for_tie_break: basePrices.get(basePriceKey(c.stay_date, c.affected_room_type_id)) ?? null,
  };
}

function computePickupDelta(assembled: AssembledPrice): number {
  let p = assembled.base_price;
  for (const adj of assembled.ladder_effects) {
    if (adj.action_kind === "percent" && adj.action_direction === "increase") p *= 1 + adj.action_value / 100;
    else if (adj.action_kind === "percent" && adj.action_direction === "decrease") p *= 1 - adj.action_value / 100;
    else if (adj.action_kind === "fixed" && adj.action_direction === "increase") p += adj.action_value;
    else if (adj.action_kind === "fixed" && adj.action_direction === "decrease") p -= adj.action_value;
  }
  return assembled.pre_clamp_price - p;
}

function formatDelta(kind: string, direction: string, value: number): string {
  const sign = direction === "decrease" ? "-" : "+";
  if (kind === "percent") return `${sign}${value}%`;
  return `${sign}$${value.toFixed(2)}`;
}
