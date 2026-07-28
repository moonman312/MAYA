/**
 * Pure grouping/mapping helpers for GET /api/changelog.
 *
 * Turns raw evaluation_audit rows into ChangelogCycle[] with human-readable
 * narration (see changelog-narrative.ts). Kept free of Supabase so the
 * transformation is unit-testable.
 */

import {
  type NarrativeApplication,
  narrateChange,
} from "@/lib/changelog-narrative";
import type {
  ChangelogCycle,
  ChangelogEntry,
  EvaluationAuditDetails,
  RuleCondition,
} from "@/types/domain";

export type AuditChangeRow = {
  evaluation_run_id: string;
  stay_date: string;
  room_type_id: string;
  evaluated_at: string;
  base_price: number;
  final_price: number;
  pre_clamp_price: number;
  floor_price: number;
  ceiling_price: number;
  details: EvaluationAuditDetails;
};

export type RuleLookupEntry = {
  name: string;
  action_type: "percent" | "fixed";
  action_direction: "increase" | "decrease";
  action_value: number;
  is_pickup_rule: boolean;
};

export type ChangelogLookups = {
  roomTypeNames: Map<string, string>;
  rules: Map<string, RuleLookupEntry>;
  conditions: Map<string, RuleCondition>;
  currencySymbol: string;
};

const MAX_RUNS = 10;
const MAX_ENTRIES_PER_CYCLE = 40;

export function currencySymbolFor(code: string | null | undefined): string {
  switch (code) {
    case "USD":
      return "$";
    case "EUR":
      return "€";
    case "GBP":
      return "£";
    default:
      return code ? `${code} ` : "$";
  }
}

export type AuditRun = {
  evaluation_run_id: string;
  /** Max evaluated_at across the run's rows. */
  timestamp: string;
  rows: AuditChangeRow[];
};

/**
 * Group audit rows by evaluation_run_id and keep the MAX_RUNS most recent
 * runs (by max evaluated_at), newest first.
 */
export function groupAuditRuns(rows: AuditChangeRow[]): AuditRun[] {
  const byRun = new Map<string, AuditRun>();
  for (const row of rows) {
    const existing = byRun.get(row.evaluation_run_id);
    if (!existing) {
      byRun.set(row.evaluation_run_id, {
        evaluation_run_id: row.evaluation_run_id,
        timestamp: row.evaluated_at,
        rows: [row],
      });
    } else {
      existing.rows.push(row);
      if (row.evaluated_at > existing.timestamp) {
        existing.timestamp = row.evaluated_at;
      }
    }
  }
  return [...byRun.values()]
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
    .slice(0, MAX_RUNS);
}

/** A row counts as a change when the price moved at least a cent or any rule applied. */
export function isChangeRow(row: AuditChangeRow): boolean {
  // Compare in whole cents to dodge float noise on one-cent moves.
  if (Math.round(Math.abs(row.final_price - row.base_price) * 100) >= 1) return true;
  return (row.details?.application_order ?? []).length > 0;
}

function toNarrativeMetrics(
  metrics: Record<string, unknown> | null | undefined,
): NarrativeApplication["metrics"] {
  if (!metrics) return null;
  const occupancy = metrics.occupancy;
  const dta = metrics.dta;
  const pickup = metrics.net_pickup_units;
  const bs = metrics.booking_speed as
    | { label?: unknown; recent?: unknown; expected?: unknown }
    | null
    | undefined;
  const bookingSpeed =
    bs &&
    typeof bs.label === "string" &&
    typeof bs.recent === "number" &&
    typeof bs.expected === "number"
      ? { label: bs.label, recent: bs.recent, expected: bs.expected }
      : null;
  return {
    occupancy: typeof occupancy === "number" ? occupancy : null,
    dta: typeof dta === "number" ? dta : null,
    pickup_units: typeof pickup === "number" ? pickup : null,
    booking_speed: bookingSpeed,
  };
}

/**
 * Rebuild the applied-rule chain for one audit row, in application order.
 *
 * Prefers matched_ladder_rules for action + observed metrics; falls back to
 * the pricing_rules lookup (metrics null) for effects carried over from
 * earlier runs. Pickup entries are keyed by event id and mapped back to their
 * rule via active_pickup_effects.
 */
export function buildApplications(
  details: EvaluationAuditDetails,
  lookups: Pick<ChangelogLookups, "rules" | "conditions">,
): NarrativeApplication[] {
  const applications: NarrativeApplication[] = [];
  const matchedByRule = new Map(
    (details.matched_ladder_rules ?? []).map((m) => [m.rule_id, m]),
  );
  const pickupRuleByEvent = new Map(
    (details.active_pickup_effects ?? []).map((e) => [e.event_id, e.rule_id]),
  );
  const wonPickupByRule = new Map(
    (details.pickup_candidates ?? [])
      .filter((c) => c.outcome === "won")
      .map((c) => [c.rule_id, c]),
  );

  for (const step of details.application_order ?? []) {
    const [kind, id] = step.split(":");
    if (!id) continue;
    const isPickup = kind === "pickup";
    const ruleId = isPickup ? pickupRuleByEvent.get(id) : id;
    if (!ruleId) continue;

    const rule = lookups.rules.get(ruleId);
    const matched = matchedByRule.get(ruleId);

    let action: NarrativeApplication["action"] | null = null;
    let metrics: NarrativeApplication["metrics"] = null;
    if (matched) {
      action = matched.action;
      metrics = toNarrativeMetrics(matched.metrics);
    } else if (rule) {
      action = {
        kind: rule.action_type,
        direction: rule.action_direction,
        value: Number(rule.action_value),
      };
    }
    if (!action) continue;
    if (isPickup && !metrics) {
      metrics = toNarrativeMetrics(wonPickupByRule.get(ruleId)?.metrics ?? null);
    }

    applications.push({
      rule_name: rule?.name ?? "Pricing rule",
      condition: lookups.conditions.get(ruleId) ?? null,
      action,
      metrics,
      is_pickup: isPickup,
    });
  }

  return applications;
}

function clampedByFor(details: EvaluationAuditDetails): "floor" | "ceiling" | null {
  const c = details?.clamped_by;
  return c === "floor" || c === "ceiling" ? c : null;
}

export function buildEntry(
  row: AuditChangeRow,
  lookups: ChangelogLookups,
): ChangelogEntry {
  const basePrice = Number(row.base_price);
  const finalPrice = Number(row.final_price);
  const roomType =
    lookups.roomTypeNames.get(row.room_type_id) ?? "Unknown room type";
  const applications = buildApplications(row.details, lookups);
  const firstOccupancy = applications[0]?.metrics?.occupancy;

  const narrative = narrateChange({
    room_type: roomType,
    base_price: basePrice,
    final_price: finalPrice,
    applications,
    floor_price: Number(row.floor_price),
    ceiling_price: Number(row.ceiling_price),
    clamped_by: clampedByFor(row.details),
    currencySymbol: lookups.currencySymbol,
  });

  return {
    room_type: roomType,
    rule_name: applications[0]?.rule_name ?? "Price update",
    original_rate: basePrice,
    new_rate: finalPrice,
    change_pct:
      basePrice > 0
        ? Math.round(((finalPrice - basePrice) / basePrice) * 1000) / 10
        : 0,
    occupancy_pct: firstOccupancy != null ? Math.round(firstOccupancy * 100) : 0,
    stay_date: row.stay_date,
    narrative,
    description: narrative.join(" "),
  };
}

/**
 * Full transformation: audit rows -> ChangelogCycle[] (newest run first,
 * newest run gets the highest cycle number).
 */
export function buildCyclesFromAudit(
  rows: AuditChangeRow[],
  lookups: ChangelogLookups,
): ChangelogCycle[] {
  const runs = groupAuditRuns(rows);
  return runs.map((run, index) => {
    const changeRows = run.rows.filter(isChangeRow);
    const changes = changeRows
      .map((row) => buildEntry(row, lookups))
      .sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct))
      .slice(0, MAX_ENTRIES_PER_CYCLE);
    return {
      cycle: runs.length - index,
      timestamp: run.timestamp,
      has_changes: changeRows.length > 0,
      changes,
    };
  });
}
