/**
 * Evaluation audit — Implementation Guide §3.10, §14.
 * Deno-portable copy of src/lib/engine/audit.ts (import paths only differ).
 */

import type { EvaluationAuditDetails } from "./domain.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LadderPassResult } from "./ladder.ts";
import { basePriceKey, pickupTieBreakTrace } from "./pickup.ts";
import type { AssembledPrice } from "./pricing.ts";
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
  basePrices: Map<string, number>;
  /** Layer 1 Booking Speed observations consulted for this stay date this run. */
  bookingSpeedObservations?: Record<string, unknown>[];
};

/** Write a single evaluation_audit row for one (stay_date, room_type). */
export async function writeAudit(supabase: SupabaseClient, input: AuditInput): Promise<void> {
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
