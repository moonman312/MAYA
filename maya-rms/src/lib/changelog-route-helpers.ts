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
  narrateRevert,
} from "@/lib/changelog-narrative";
import { humanDate } from "@/lib/explain";
import { measuresDifferently } from "@/lib/rule-form";
import { pmsName } from "../../supabase/functions/_shared/pms/push-failure";
import type {
  ChangelogCycle,
  ChangelogItem,
  ChangelogEntry,
  ChangelogQuietChecks,
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
  /**
   * The night's audit row before this one, when the log read it: set on a
   * row that put the night back at its base with nothing on it
   * (isRevertRow), so its entry is told from the price it moved from.
   */
  previous?: PriorAuditRow | null;
};

/** A night's audit row before the one shown, as audit_rows_before returns it. */
export type PriorAuditRow = {
  final_price: number;
  base_price: number;
  application_order: string[];
  /** The price set by hand that row was on, or null. */
  manual: { set_by: string | null; pms: string | null } | null;
};

/** One audit_rows_before row, read loosely like every other audit read. */
export function priorAuditRowFrom(r: Record<string, unknown>): PriorAuditRow {
  const order = Array.isArray(r.application_order)
    ? (r.application_order as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const manual =
    r.base_source === "manual"
      ? manualOverrideFor({ manual_override: r.manual_override } as unknown as EvaluationAuditDetails) ?? {
          set_by: null,
          pms: null,
        }
      : null;
  return {
    final_price: Number(r.final_price),
    base_price: r.base_price != null ? Number(r.base_price) : Number(r.final_price),
    application_order: order,
    manual,
  };
}

export type RuleLookupEntry = {
  name: string;
  action_type: "percent" | "fixed";
  action_direction: "increase" | "decrease";
  action_value: number;
  is_pickup_rule: boolean;
  /** The rule's undo box (pricing_rules.undo_on_cancellation). Absent reads as ticked, like every rule the migration found. */
  undo_on_cancellation?: boolean;
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

/**
 * Pricing runs that changed a price, shown in full, newest first. The quiet
 * runs around them are counted into one line per stretch, not listed.
 */
export const MAX_CHANGED_RUNS = 10;
/**
 * Runs the log reads in full, at most, looking for MAX_CHANGED_RUNS that
 * change something. They are the runs with cells_changed > 0 in the run log,
 * newest first: that counts the audit rows a run wrote. A row put a night
 * back at its base is a change (isRevertRow), but one can also be a night's
 * first row, at its base with nothing before it (a night new to the
 * horizon), so a few runs turn out quiet. Those are counted with the quiet
 * runs around them. Past this many the log stops reading, and says the
 * oldest stretch is the one just before the oldest change it found.
 */
export const MAX_CANDIDATE_RUNS = 3 * MAX_CHANGED_RUNS;
/** Runs shown when there is no run log, and the change log is rebuilt from audit rows alone. */
export const MAX_AUDIT_RUNS = 10;
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
 * Group audit rows by evaluation_run_id and keep the MAX_AUDIT_RUNS most
 * recent runs (by max evaluated_at), newest first.
 */
export function groupAuditRuns(rows: AuditChangeRow[]): AuditRun[] {
  return groupAuditRunsUncapped(rows).slice(0, MAX_AUDIT_RUNS);
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
export function isChangeRow(row: Pick<AuditChangeRow, "base_price" | "final_price" | "details">): boolean {
  // Compare in whole cents to dodge float noise on one-cent moves.
  if (Math.round(Math.abs(row.final_price - row.base_price) * 100) >= 1) return true;
  if ((row.details?.application_order ?? []).length > 0) return true;
  return manualOverrideFor(row.details) !== null;
}

/**
 * A row isChangeRow calls quiet (the night at its base, no rule on it, no
 * price set by hand) that still changed the night. The engine writes an
 * audit row only when a night's price, rules, clamp or typed price change
 * (auditSignature), so such a row nearly always put a price back to base: a
 * fire came off (retired_pickup_effects, which says so on the row itself),
 * or, against the night's row before it, the price was different, a rule
 * was on it, or it was on a price set by hand. With no row before (a night
 * new to the horizon) only a fire coming off counts.
 */
export function isRevertRow(
  row: Pick<AuditChangeRow, "final_price" | "details">,
  prior: PriorAuditRow | null | undefined,
): boolean {
  if ((row.details?.retired_pickup_effects ?? []).length > 0) return true;
  if (!prior) return false;
  if (Math.round(Math.abs(row.final_price - prior.final_price) * 100) >= 1) return true;
  if (prior.application_order.length > 0) return true;
  return prior.manual !== null && manualOverrideFor(row.details) === null;
}

function toNarrativeMetrics(
  metrics: Record<string, unknown> | null | undefined,
): NarrativeApplication["metrics"] {
  if (!metrics) return null;
  const occupancy = metrics.occupancy;
  const dta = metrics.dta;
  const pickup = metrics.net_pickup_units;
  // Set when a pickup count opened at the rule's own last change or a
  // stronger rule's newer one rather than a whole window back; older rows
  // never carry it.
  const pickupSince = metrics.pickup_counted_since;
  const bs = metrics.booking_speed as
    | {
        label?: unknown;
        recent?: unknown;
        expected?: unknown;
        window_days?: unknown;
        counted_from?: unknown;
        counted_since?: unknown;
        counted_through?: unknown;
        expected_over_full_window?: unknown;
        full_window_days?: unknown;
      }
    | null
    | undefined;
  const bookingSpeed =
    bs &&
    typeof bs.label === "string" &&
    typeof bs.recent === "number" &&
    typeof bs.expected === "number"
      ? {
          label: bs.label,
          recent: bs.recent,
          expected: bs.expected,
          // Only a fire that counted from after the newest change by the
          // rule itself or a stronger rule that moves the price the same way
          // says so; every older audit row reads exactly as before.
          // counted_since says the count started at the raise itself, on its
          // day; expected_over_full_window that `expected` is a whole
          // window's (full_window_days), the bar a rule that raises on a
          // fast pace had to beat; counted_through that a rule that cuts
          // counted full days only, up to the day before.
          ...(typeof bs.counted_from === "string" && typeof bs.window_days === "number"
            ? {
                counted_from: bs.counted_from,
                window_days: bs.window_days,
                ...(typeof bs.counted_since === "string" ? { counted_since: bs.counted_since } : {}),
                ...(bs.expected_over_full_window === true && typeof bs.full_window_days === "number"
                  ? { expected_over_full_window: true, full_window_days: bs.full_window_days }
                  : {}),
              }
            : {}),
          ...(typeof bs.counted_through === "string" && typeof bs.window_days === "number"
            ? { counted_through: bs.counted_through, window_days: bs.window_days }
            : {}),
        }
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
    ...(typeof pickupSince === "string" ? { pickup_counted_since: pickupSince } : {}),
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
    ...(e.finding ? { finding: e.finding } : {}),
  }));
}

function clampedByFor(details: EvaluationAuditDetails): "floor" | "ceiling" | null {
  const c = details?.clamped_by;
  return c === "floor" || c === "ceiling" ? c : null;
}

/**
 * The rules applied on the row before that this row no longer applies, each
 * once, in that row's order. A ladder rule the run switched off says why
 * (its deactivate transition on this row); one that came off another way
 * (paused, deleted, out of its dates) is named without a reason. A pickup
 * fire comes off through retired_pickup_effects instead, which the caller
 * words, so those are left out here.
 */
function rulesOff(row: AuditChangeRow, prior: PriorAuditRow, rules: ChangelogLookups["rules"]): NarrativeRetirement[] {
  const still = new Set(row.details?.application_order ?? []);
  const deactivated = new Map(
    (row.details?.matched_ladder_rules ?? []).filter((m) => m.transition === "deactivate").map((m) => [m.rule_id, m]),
  );
  const out: NarrativeRetirement[] = [];
  const seen = new Set<string>();
  for (const step of prior.application_order) {
    if (still.has(step)) continue;
    const [kind, id] = step.split(":");
    if (kind === "pickup" || !id || seen.has(id)) continue;
    seen.add(id);
    const matched = deactivated.get(id);
    const rule = rules.get(id);
    const action = matched?.action ?? (rule ? { kind: rule.action_type, direction: rule.action_direction, value: rule.action_value } : null);
    if (!action) continue;
    const sign = action.direction === "decrease" ? "-" : "+";
    out.push({
      rule_name: rule?.name ?? "Pricing rule",
      delta: action.kind === "percent" ? `${sign}${action.value}%` : `${sign}$${Number(action.value).toFixed(2)}`,
      reason: matched ? "no_longer_met" : null,
    });
  }
  return out;
}

/**
 * A row that put the night back at its base (isRevertRow), told from the
 * price the night had before, which is what moved.
 */
function buildRevertEntry(row: AuditChangeRow, prior: PriorAuditRow, lookups: ChangelogLookups): ChangelogEntry {
  const finalPrice = Number(row.final_price);
  const fromPrice = Number(prior.final_price);
  const roomType = lookups.roomTypeNames.get(row.room_type_id) ?? "Unknown room type";
  const retirements = buildRetirements(row.details, lookups.rules);
  const off = rulesOff(row, prior, lookups.rules);
  const manualCleared = prior.manual !== null && manualOverrideFor(row.details) === null;
  const narrative = narrateRevert({
    from_price: fromPrice,
    final_price: finalPrice,
    retirements,
    rules_off: off,
    manual_cleared: manualCleared ? { pms: prior.manual!.pms == null ? null : pmsOf(prior.manual!) } : null,
    base_from: prior.application_order.length === 0 && prior.manual === null ? Number(prior.base_price) : null,
    currencySymbol: lookups.currencySymbol,
  });
  return {
    room_type: roomType,
    rule_name: retirements[0]?.rule_name ?? off[0]?.rule_name ?? (manualCleared ? "Manual price cleared" : "Price update"),
    original_rate: fromPrice,
    new_rate: finalPrice,
    change_pct: changePctOf({ base_price: fromPrice, final_price: finalPrice }),
    occupancy_pct: 0,
    stay_date: row.stay_date,
    narrative,
    description: narrative.join(" "),
    evaluation_run_id: row.evaluation_run_id,
    room_type_id: row.room_type_id,
    has_booking_speed_details: (row.details?.booking_speed_observations ?? []).length > 0,
  };
}

export function buildEntry(
  row: AuditChangeRow,
  lookups: ChangelogLookups,
): ChangelogEntry {
  if (row.previous && !isChangeRow(row)) return buildRevertEntry(row, row.previous, lookups);
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
  const capped = runs.slice(0, MAX_CHANGED_RUNS);
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
 * before the top-MAX_AUDIT_RUNS cut, so a recent quiet run can't be crowded
 * out by older runs that happened to have changes.
 */
export function buildCyclesFromAudit(
  rows: AuditChangeRow[],
  lookups: ChangelogLookups,
  heartbeats: RunHeartbeat[] = [],
): ChangelogCycle[] {
  const runs = mergeHeartbeats(groupAuditRunsUncapped(rows), heartbeats).slice(0, MAX_AUDIT_RUNS);
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

/* ── Quiet checks between changes ──────────────────────────────── */

/** Narrows a timeline item to a stretch of checks that changed nothing. */
export function isQuietChecks(item: ChangelogItem): item is ChangelogQuietChecks {
  return "kind" in item && item.kind === "quiet_checks";
}

/**
 * The runs between two things the log shows, counted into one line. Runs
 * older than `before` (never at it) and newer than `after` (or at it, when
 * `inclusive`). A null bound is open: up to now, or back to the first run
 * on record. The line counts the runs there that wrote no audit rows, and the
 * runs read in full that showed no change (buildQuietChecks).
 *
 * Where a change bounds the gap its own run is on neither side. Where
 * another item does (a push problem ending, an owner's answer), a run at
 * that same instant goes above it, the way mergeTimeline breaks the tie.
 */
export type QuietGap = {
  before: string | null;
  after: { at: string; inclusive: boolean } | null;
  /** The gap under the oldest change shown, when the log did not read further back. */
  just_before: boolean;
};

/** The runs inside one gap that wrote no audit rows: how many, and the first and last. */
export type QuietGapCount = { checks: number; first_at: string | null; last_at: string | null };

/** Gaps counted at once. The usual log has at most 11, so this only paces a log full of answers. */
export const MAX_PARALLEL_GAP_COUNTS = 12;

/** Newest first, by instant; an unparseable or equal instant falls back to the text. */
function newerFirst(a: string, b: string): number {
  const d = (Date.parse(b) || 0) - (Date.parse(a) || 0);
  return d !== 0 ? d : a < b ? 1 : a > b ? -1 : 0;
}

/** True when a run at `at` belongs to `gap`. The route asks the database the same thing. */
export function inQuietGap(gap: QuietGap, at: string): boolean {
  if (gap.before != null && newerFirst(at, gap.before) <= 0) return false;
  if (gap.after != null) {
    const c = newerFirst(at, gap.after.at);
    if (c > 0 || (c === 0 && !gap.after.inclusive)) return false;
  }
  return true;
}

/**
 * The gaps to count, newest first: above the newest change, between each
 * change and the next, and under the oldest one. `splitAt` are the instants
 * of the other items in the timeline, and each one splits the gap it falls
 * in, so the quiet line above an answer and the one below it stay on their
 * own sides of it. `readBackTo` is the newest run the log did not read (a
 * run that may have changed something): nothing at it or before it is
 * counted, and the gap above it is the stretch just before the oldest
 * change. Null when every older run is known to be quiet.
 */
export function planQuietGaps(input: {
  changes: string[];
  splitAt: string[];
  readBackTo: string | null;
}): QuietGap[] {
  const { readBackTo } = input;
  const bounds = [
    ...input.changes.map((at) => ({ at, change: true })),
    ...[...new Set(input.splitAt)]
      .filter((at) => readBackTo == null || newerFirst(at, readBackTo) < 0)
      .map((at) => ({ at, change: false })),
  ].sort((a, b) => newerFirst(a.at, b.at) || (a.change === b.change ? 0 : a.change ? -1 : 1));

  const gaps: QuietGap[] = [];
  let before: string | null = null;
  for (const bound of bounds) {
    gaps.push({ before, after: { at: bound.at, inclusive: !bound.change }, just_before: false });
    before = bound.at;
  }
  gaps.push({
    before,
    after: readBackTo != null ? { at: readBackTo, inclusive: false } : null,
    just_before: readBackTo != null && input.changes.length > 0,
  });
  // A gap whose two ends meet holds no run: skip it rather than count it.
  return gaps.filter((g) => g.before == null || g.after == null || newerFirst(g.after.at, g.before) > 0);
}

/**
 * One line per gap that holds any quiet runs, newest first. `count` answers
 * for the runs in a gap that wrote no audit rows (cells_changed = 0); the
 * route asks the run log, a test can ask a list. `folded` are the runs that
 * wrote audit rows, were read in full and showed no change: each is added to
 * the gap it falls in. A run that wrote audit rows but was never read (one
 * that landed while the log was being read) is in no line, rather than
 * counted as a check that changed nothing. Gaps are counted
 * MAX_PARALLEL_GAP_COUNTS at a time.
 */
export async function buildQuietChecks(
  gaps: QuietGap[],
  count: (gap: QuietGap) => Promise<QuietGapCount>,
  folded: string[] = [],
): Promise<ChangelogQuietChecks[]> {
  const counted: QuietGapCount[] = [];
  for (let i = 0; i < gaps.length; i += MAX_PARALLEL_GAP_COUNTS) {
    counted.push(...(await Promise.all(gaps.slice(i, i + MAX_PARALLEL_GAP_COUNTS).map(count))));
  }
  const out: ChangelogQuietChecks[] = [];
  gaps.forEach((gap, i) => {
    const found = counted[i];
    const foldedHere = folded.filter((at) => inQuietGap(gap, at));
    const checks = Math.max(0, found.checks) + foldedHere.length;
    // Oldest first: the counted runs' two ends and every folded run.
    const ends = [...foldedHere, ...(found.checks > 0 ? [found.first_at, found.last_at] : [])]
      .filter((at): at is string => !!at)
      .sort((a, b) => newerFirst(b, a));
    if (checks <= 0 || ends.length === 0) return;
    const firstAt = ends[0];
    const lastAt = ends[ends.length - 1];
    out.push({
      kind: "quiet_checks",
      id: `quiet-${firstAt}-${lastAt}`,
      timestamp: lastAt,
      first_at: firstAt,
      checks,
      ...(gap.just_before ? { just_before: true } : {}),
    });
  });
  return out;
}

/**
 * The runs the log shows in full, and where it stopped reading.
 * `candidates` are the runs that wrote audit rows, newest first, as many as
 * MAX_CANDIDATE_RUNS + 1. They are read one at a time until MAX_CHANGED_RUNS
 * show a change or MAX_CANDIDATE_RUNS have been read. A run that reads as no
 * change goes in `folded`, to be counted with the quiet runs around it.
 * `readBackTo` is the first candidate not read, when there is one.
 */
export async function findShownRuns(
  candidates: RunHeartbeat[],
  summarise: (run: RunHeartbeat) => Promise<RunSummary>,
): Promise<{ shown: RunSummary[]; folded: string[]; readBackTo: string | null }> {
  const shown: RunSummary[] = [];
  const folded: string[] = [];
  let read = 0;
  for (const run of candidates.slice(0, MAX_CANDIDATE_RUNS)) {
    if (shown.length >= MAX_CHANGED_RUNS) break;
    const summary = await summarise(run);
    read++;
    if (summary.hasChanges) shown.push(summary);
    else folded.push(run.evaluated_at);
  }
  return { shown, folded, readBackTo: candidates[read]?.evaluated_at ?? null };
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
 * owner took, and rule_repeat_alert_resume_many stamps a resume the same way,
 * one instant over all of a rule's alerts. A resume stamps only the nights
 * still to come, so a night that was already over never reads as one the
 * rule can adjust again.
 * "Stop" says what happens to the changes already made, because that is the
 * question the word leaves open: they stay, and with the rule's undo box
 * ticked one still comes off if cancellations mean the rule is no longer
 * true (pickup.ts cancellationChecks looks at every open change of a
 * ticked rule, stop or no stop), raise or cut alike. A resume says when the
 * rule is free again, and says "can", because whether it adjusts anything
 * is still up to its conditions.
 */
export function buildAlertChoices(
  rows: AlertChoiceRow[],
  lookups: Pick<ChangelogLookups, "rules"> & Partial<Pick<ChangelogLookups, "setterNames">>,
): ChangelogRuleAlertChoice[] {
  // Ticked unless the rule says otherwise; a rule this log can't find any
  // more gets the first half of the stop line only.
  const undoes = (ruleId: string) => {
    const rule = lookups.rules.get(ruleId);
    return rule !== undefined && rule.undo_on_cancellation !== false;
  };
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
            ? undoes(first.rule_id)
              ? `${who} stopped "${ruleName}" on ${where}. What it already changed stays, unless cancellations mean the rule is no longer true.`
              : `${who} stopped "${ruleName}" on ${where}. What it already changed stays.`
            : `${who} told "${ruleName}" to carry on with ${where}.`,
    });
  }
  return out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
}
