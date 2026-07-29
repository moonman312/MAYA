/**
 * Evaluation audit — Implementation Guide §3.10, §14.
 *
 * Writes one evaluation_audit row per (run, stay_date, room_type) with full
 * JSONB details for debuggability.
 */

import type { EvaluationAuditDetails } from "@/types/domain";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LadderPassResult } from "./ladder";
import { basePriceKey, pickupTieBreakTrace } from "./pickup";
import type { AssembledPrice } from "./pricing";
import type { PickupCandidate } from "./types";

export type AuditInput = {
  runId: string;
  hotelId: string;
  evalTs: string;
  assembled: AssembledPrice;
  ladderResults: LadderPassResult[];
  pickupWinners: PickupCandidate[];
  pickupLosers: PickupCandidate[];
  pickupIdempotentSkips: PickupCandidate[];
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
): string {
  return `${finalPrice.toFixed(2)}|${applicationOrder.join(",")}|${clampedBy}`;
}

/**
 * Write a single evaluation_audit row for one (stay_date, room_type), unless
 * its signature matches input.previousSignature. Returns whether a row was
 * written.
 */
export async function writeAudit(supabase: SupabaseClient, input: AuditInput): Promise<boolean> {
  const { assembled, basePrices } = input;

  const ladderDelta =
    assembled.pre_clamp_price - assembled.base_price - computePickupDelta(assembled);

  const pickupDelta = computePickupDelta(assembled);

  const winnerForRoom = input.pickupWinners[0];

  const details: EvaluationAuditDetails = {
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
    ...(input.bookingSpeedObservations && input.bookingSpeedObservations.length > 0
      ? { booking_speed_observations: input.bookingSpeedObservations }
      : {}),
  };

  const signature = auditSignature(
    assembled.final_price,
    details.application_order,
    details.clamped_by,
  );
  if (input.previousSignature != null && input.previousSignature === signature) {
    return false;
  }

  await supabase.from("evaluation_audit").insert({
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
  });
  return true;
}

/**
 * Batched lookup of the most recent audit signature per (stay_date,
 * room_type) across the whole horizon — one query instead of one per cell.
 * Paged and ordered newest-first, keeping only the first (most recent) row
 * seen per cell; since every cell historically got a row on every run, the
 * first page already covers every cell in practice.
 */
export async function loadLastAuditSignatures(
  supabase: SupabaseClient,
  hotelId: string,
  firstDate: string,
  lastDate: string,
): Promise<Map<string, string>> {
  const PAGE = 1000;
  const signatures = new Map<string, string>();
  const seenKeys = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("evaluation_audit")
      .select("stay_date, room_type_id, final_price, details")
      .eq("hotel_id", hotelId)
      .gte("stay_date", firstDate)
      .lte("stay_date", lastDate)
      .order("evaluated_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Failed to load prior audit signatures: ${error.message}`);
    const rows = data ?? [];
    for (const r of rows) {
      const key = `${r.stay_date}|${r.room_type_id}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const d = (r.details ?? {}) as EvaluationAuditDetails;
      signatures.set(
        key,
        auditSignature(Number(r.final_price), d.application_order ?? [], d.clamped_by ?? "none"),
      );
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
