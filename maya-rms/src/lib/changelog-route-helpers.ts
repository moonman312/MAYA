/**
 * Pure grouping/mapping helpers for GET /api/changelog.
 *
 * Turns raw evaluation_audit rows into ChangelogCycle[] with human-readable
 * narration (see changelog-narrative.ts). Kept free of Supabase so the
 * transformation is unit-testable.
 */

import {
  type NarrativeApplication,
  type NarrativeRetirement,
  narrateChange,
} from "@/lib/changelog-narrative";
import { humanDate } from "@/lib/explain";
import { measuresDifferently } from "@/lib/rule-form";
import { pmsName } from "../../supabase/functions/_shared/pms/push-failure";
import type {
  ChangelogCycle,
  ChangelogItem,
  ChangelogEntry,
  ChangelogRuleAlertChoice,
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
  /** user id -> display name, for attributing a manual price to whoever typed it. */
  setterNames?: Map<string, string>;
  /** rule id -> the room types it measures and the ones it changes. */
  ruleRoomSets?: Map<string, { signal: string[]; affected: string[] }>;
  /** Room types that count as rooms; unset means every room type does. */
  countingRoomTypeIds?: Set<string>;
};

/**
 * Names of what a rule measures, when that is not what it changes. null for
 * the ordinary rule, so its sentences stay exactly as they were.
 */
export function measuredRoomTypeNames(
  ruleId: string,
  lookups: Partial<Pick<ChangelogLookups, "ruleRoomSets" | "countingRoomTypeIds" | "roomTypeNames">>,
): string[] | null {
  const sets = lookups.ruleRoomSets?.get(ruleId);
  if (!sets) return null;
  const counting = lookups.countingRoomTypeIds;
  const isCounting = (id: string) => !counting || counting.has(id);
  if (!measuresDifferently(sets.signal, sets.affected, isCounting)) return null;
  const names = sets.signal
    .filter(isCounting)
    .map((id) => lookups.roomTypeNames?.get(id))
    .filter((n): n is string => !!n);
  return names.length > 0 ? names : null;
}

/**
 * The manual_override the engine stamps into details when a typed price was
 * the base for this row. Read loosely: the audit table holds every shape the
 * engine has ever written, and a row without it is simply MAYA's own pricing.
 * `pms` names the PMS when the price was changed there on a night MAYA had
 * sent, rather than typed in MAYA; null otherwise.
 */
export function manualOverrideFor(
  details: EvaluationAuditDetails,
): { set_by: string | null; pms: string | null } | null {
  const mo = (details as { manual_override?: unknown } | null)?.manual_override;
  if (!mo || typeof mo !== "object") return null;
  const { set_by: setBy, source, pms_type: pmsType } = mo as { set_by?: unknown; source?: unknown; pms_type?: unknown };
  return {
    set_by: typeof setBy === "string" && setBy ? setBy : null,
    pms: source === "pms" ? (typeof pmsType === "string" && pmsType ? pmsType : "") : null,
  };
}

/** Where a manual price changed in the PMS was changed: "Cloudbeds", or "the PMS" when the row doesn't say. */
function pmsOf(override: { pms: string | null }): string {
  return override.pms ? pmsName(override.pms) : "the PMS";
}

/** How a manual price is named in the change log: "Manual price", or where the hotel changed it. */
export function manualPriceTitle(override: { pms: string | null }): string {
  return override.pms == null ? "Manual price" : `Changed in ${pmsOf(override)}`;
}

export const MAX_RUNS = 10;
export const MAX_ENTRIES_PER_CYCLE = 40;

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

/** One heartbeat row from evaluation_run_log — a run happened, nothing more. */
export type RunHeartbeat = {
  evaluation_run_id: string;
  evaluated_at: string;
};

function groupAuditRunsUncapped(rows: AuditChangeRow[]): AuditRun[] {
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
  return [...byRun.values()].sort((a, b) =>
    a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0,
  );
}

/**
 * Group audit rows by evaluation_run_id and keep the MAX_RUNS most recent
 * runs (by max evaluated_at), newest first.
 */
export function groupAuditRuns(rows: AuditChangeRow[]): AuditRun[] {
  return groupAuditRunsUncapped(rows).slice(0, MAX_RUNS);
}

/**
 * Fold in heartbeat-only runs — ones where write-on-change left no
 * evaluation_audit rows because nothing changed anywhere. A run that
 * already has audit rows is left alone; only run ids missing from
 * `auditRuns` gain a synthetic zero-change entry, dated from the
 * heartbeat's own timestamp.
 */
function mergeHeartbeats(auditRuns: AuditRun[], heartbeats: RunHeartbeat[]): AuditRun[] {
  const seen = new Set(auditRuns.map((r) => r.evaluation_run_id));
  const extra: AuditRun[] = [];
  for (const h of heartbeats) {
    if (seen.has(h.evaluation_run_id)) continue;
    seen.add(h.evaluation_run_id);
    extra.push({ evaluation_run_id: h.evaluation_run_id, timestamp: h.evaluated_at, rows: [] });
  }
  return [...auditRuns, ...extra].sort((a, b) =>
    a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0,
  );
}

/**
 * A row counts as a change when the price moved at least a cent, any rule
 * applied, or a person set the base by hand. The last one matters: a manual
 * price with nothing stacked on it has base == final, and without this the
 * one change the manager made themselves would be the one they can't find.
 */
export function isChangeRow(row: AuditChangeRow): boolean {
  // Compare in whole cents to dodge float noise on one-cent moves.
  if (Math.round(Math.abs(row.final_price - row.base_price) * 100) >= 1) return true;
  if ((row.details?.application_order ?? []).length > 0) return true;
  return manualOverrideFor(row.details) !== null;
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
  const excludedRaw = metrics.excluded_from_occupancy;
  const excluded = Array.isArray(excludedRaw)
    ? excludedRaw.filter((n): n is string => typeof n === "string" && n.length > 0)
    : [];
  return {
    occupancy: typeof occupancy === "number" ? occupancy : null,
    ...(excluded.length ? { excluded_from_occupancy: excluded } : {}),
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
 *
 * An event rule can hold several fires on one night. Only the fire this run
 * made carries this run's metrics, which is why the winner is matched on its
 * event id; the older fires it stacked on were judged on their own runs. The
 * second and later step of one rule is marked as a repeat so the sentence
 * says the rule fired again rather than naming it twice.
 */
export function buildApplications(
  details: EvaluationAuditDetails,
  lookups: Pick<ChangelogLookups, "rules" | "conditions"> &
    Partial<Pick<ChangelogLookups, "ruleRoomSets" | "countingRoomTypeIds" | "roomTypeNames">>,
): NarrativeApplication[] {
  const applications: NarrativeApplication[] = [];
  const matchedByRule = new Map(
    (details.matched_ladder_rules ?? []).map((m) => [m.rule_id, m]),
  );
  const pickupRuleByEvent = new Map(
    (details.active_pickup_effects ?? []).map((e) => [e.event_id, e.rule_id]),
  );
  const wonPickup = (details.pickup_candidates ?? []).filter((c) => c.outcome === "won");
  const wonPickupByEvent = new Map(
    wonPickup.filter((c) => c.event_id != null).map((c) => [c.event_id as string, c]),
  );
  // Rows written before stacking name no event, and could only ever have one
  // fire per rule, so the rule id still identifies the winner there.
  const wonPickupByRule = new Map(
    wonPickup.filter((c) => c.event_id == null).map((c) => [c.rule_id, c]),
  );
  const timesApplied = new Map<string, number>();

  for (const step of details.application_order ?? []) {
    const [kind, id] = step.split(":");
    if (!id) continue;
    const isPickup = kind === "pickup";
    const ruleId = isPickup ? pickupRuleByEvent.get(id) : id;
    if (!ruleId) continue;
    const seen = timesApplied.get(ruleId) ?? 0;
    timesApplied.set(ruleId, seen + 1);

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
      const won = wonPickupByEvent.get(id) ?? wonPickupByRule.get(ruleId);
      metrics = toNarrativeMetrics(won?.metrics ?? null);
    }

    const measured = measuredRoomTypeNames(ruleId, lookups);
    applications.push({
      rule_name: rule?.name ?? "Pricing rule",
      condition: lookups.conditions.get(ruleId) ?? null,
      action,
      metrics,
      is_pickup: isPickup,
      ...(measured ? { measured_room_types: measured } : {}),
      ...(seen > 0 ? { repeat: true } : {}),
    });
  }

  return applications;
}

/**
 * The fires this run took off the night, in the audit's order. A rule that
 * has since been deleted still has its name read from the audit's own
 * fallback, so the sentence never says "undefined".
 */
export function buildRetirements(
  details: EvaluationAuditDetails,
  rules: ChangelogLookups["rules"],
): NarrativeRetirement[] {
  return (details.retired_pickup_effects ?? []).map((e) => ({
    rule_name: rules.get(e.rule_id)?.name ?? "Pricing rule",
    delta: e.delta,
    reason: e.reason,
  }));
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
  const clampedBy = clampedByFor(row.details);
  const override = manualOverrideFor(row.details);

  const retirements = buildRetirements(row.details, lookups.rules);
  let narrative = narrateChange({
    room_type: roomType,
    base_price: basePrice,
    final_price: finalPrice,
    applications,
    retirements,
    floor_price: Number(row.floor_price),
    ceiling_price: Number(row.ceiling_price),
    clamped_by: clampedBy,
    currencySymbol: lookups.currencySymbol,
  });

  if (override) {
    const setter =
      (override.set_by ? lookups.setterNames?.get(override.set_by) : null) ?? "A manager";
    const amount = `${lookups.currencySymbol}${basePrice.toFixed(2)}`;
    // A rate the hotel changed in its PMS names no person: nobody typed it in MAYA.
    const lead =
      override.pms != null
        ? `The base rate was changed in ${pmsOf(override)} to ${amount}.`
        : `${setter} set the base rate to ${amount}.`;
    // With nothing stacked on the typed number, narrateChange's only sentence
    // is the "moved from X to X" fallback, which the lead already says better.
    narrative =
      applications.length === 0 && !clampedBy && retirements.length === 0
        ? [lead]
        : [lead, ...narrative];
  }

  return {
    room_type: roomType,
    rule_name:
      applications[0]?.rule_name ??
      (override ? manualPriceTitle(override) : retirements[0]?.rule_name ?? "Price update"),
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
    evaluation_run_id: row.evaluation_run_id,
    room_type_id: row.room_type_id,
    has_booking_speed_details:
      (row.details?.booking_speed_observations ?? []).length > 0,
  };
}

/** The ordering key buildEntry reports as change_pct, from the two prices alone. */
export function changePctOf(row: { base_price: number; final_price: number }): number {
  const basePrice = Number(row.base_price);
  const finalPrice = Number(row.final_price);
  return basePrice > 0 ? Math.round(((finalPrice - basePrice) / basePrice) * 1000) / 10 : 0;
}

/**
 * The rows one run's entries are built from, chosen from its change rows the
 * way buildCyclesFromAudit chooses them: largest move first, stable on the
 * given order, at most MAX_ENTRIES_PER_CYCLE.
 */
export function topChangeRows<T extends { base_price: number; final_price: number }>(changeRows: T[]): T[] {
  return changeRows
    .map((row, i) => ({ row, i, pct: Math.abs(changePctOf(row)) }))
    .sort((a, b) => b.pct - a.pct || a.i - b.i)
    .slice(0, MAX_ENTRIES_PER_CYCLE)
    .map((x) => x.row);
}

/** One run as the per-run read assembles it. */
export type RunSummary = {
  evaluation_run_id: string;
  timestamp: string;
  hasChanges: boolean;
  /** The run's top change rows with full details, in topChangeRows order. */
  topRows: AuditChangeRow[];
};

/** buildCyclesFromAudit for runs that were each read on their own (newest first). */
export function buildCyclesFromRuns(runs: RunSummary[], lookups: ChangelogLookups): ChangelogCycle[] {
  const capped = runs.slice(0, MAX_RUNS);
  return capped.map((run, index) => ({
    cycle: capped.length - index,
    timestamp: run.timestamp,
    has_changes: run.hasChanges,
    changes: run.topRows
      .map((row) => buildEntry(row, lookups))
      .sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct)),
  }));
}

/**
 * Full transformation: audit rows -> ChangelogCycle[] (newest run first,
 * newest run gets the highest cycle number). Heartbeat-only runs (nothing
 * changed anywhere, so write-on-change left no audit rows) are merged in
 * before the top-MAX_RUNS cut, so a recent quiet run can't be crowded out
 * by older runs that happened to have changes.
 */
export function buildCyclesFromAudit(
  rows: AuditChangeRow[],
  lookups: ChangelogLookups,
  heartbeats: RunHeartbeat[] = [],
): ChangelogCycle[] {
  const runs = mergeHeartbeats(groupAuditRunsUncapped(rows), heartbeats).slice(0, MAX_RUNS);
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

/* ── Answers to a rule that kept adjusting ─────────────────────── */

/** Narrows a timeline item to one of the owner's answers. */
export function isRuleAlertChoice(item: ChangelogItem): item is ChangelogRuleAlertChoice {
  return "kind" in item && item.kind === "rule_alert_choice";
}

/**
 * One night the owner settled, as the change log reads it. `resume` is the
 * answer taken back again (rule_repeat_alert_resume), which the night keeps
 * in resumed_at and resumed_by rather than in choice.
 */
export type AlertChoiceRow = {
  rule_id: string;
  stay_date: string;
  choice: "keep_adjusting" | "stop" | "resume";
  /** When they did it: chosen_at for an answer, resumed_at for taking one back. */
  at: string;
  /** Who did it, where the row names them. */
  by: string | null;
};

/** Answers shown at most, newest first. */
export const MAX_ALERT_CHOICES = 20;

function nightsWord(n: number): string {
  return n === 1 ? "1 night" : `${n} nights`;
}

/**
 * One answer covers every night it settled: rule_repeat_alert_choose stamps
 * them all with one instant, so (rule, choice, instant) is the action the
 * owner took, and rule_repeat_alert_resume stamps a resume the same way.
 * "Stop" says what happens to the changes already made, because that is the
 * question the word leaves open, and it says it by direction: a cut is never
 * undone on MAYA's own account, while a raise still comes off if enough of
 * the bookings behind it cancel (pickup.ts firesToRetire runs on every open
 * raise, stop or no stop). A resume says when the rule is free again, and
 * says "can", because whether it adjusts anything is still up to its
 * conditions.
 */
export function buildAlertChoices(
  rows: AlertChoiceRow[],
  lookups: Pick<ChangelogLookups, "rules"> & Partial<Pick<ChangelogLookups, "setterNames">>,
): ChangelogRuleAlertChoice[] {
  const groups = new Map<string, AlertChoiceRow[]>();
  for (const row of rows) {
    const key = `${row.rule_id}|${row.choice}|${row.at}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const out: ChangelogRuleAlertChoice[] = [];
  for (const [key, list] of groups) {
    const first = list[0];
    const dates = list.map((r) => r.stay_date).sort();
    const ruleName = lookups.rules.get(first.rule_id)?.name ?? "A rule";
    const who = (first.by ? lookups.setterNames?.get(first.by) : null) ?? "A manager";
    const where = list.length === 1 ? humanDate(dates[0]) : nightsWord(list.length);
    out.push({
      kind: "rule_alert_choice",
      id: key,
      timestamp: first.at,
      rule_name: ruleName,
      choice: first.choice,
      nights: list.length,
      first_night: dates[0],
      last_night: dates[dates.length - 1],
      title:
        first.choice === "resume"
          ? `${who} let "${ruleName}" run again on ${where}. It can start adjusting again from the next pricing run.`
          : first.choice === "stop"
            ? lookups.rules.get(first.rule_id)?.action_direction === "increase"
              ? `${who} stopped "${ruleName}" on ${where}. The raises it already made stay, unless enough of the bookings behind them cancel.`
              : `${who} stopped "${ruleName}" on ${where}. What it already cut stays.`
            : `${who} told "${ruleName}" to carry on with ${where}.`,
    });
  }
  return out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
}
