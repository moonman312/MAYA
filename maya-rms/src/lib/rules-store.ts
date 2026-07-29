/**
 * Rules CRUD — Supabase (`pricing_rules` + related tables) or in-memory fallback.
 *
 * Aligned with Rules Engine Implementation Guide v1:
 *   - Single-row `rule_condition` (column-family model)
 *   - Separate `rule_signal_room_type` / `rule_affected_room_type`
 *   - Version bumping on behavioral edits
 *   - Pickup event retirement on rule edit
 *
 * Legacy `pricing_rule_conditions` and `pricing_rule_room_types` are written
 * alongside the new tables for backward compatibility with existing UI code.
 */

import { INITIAL_RULES } from "@/lib/demo-data";
import { bookingSpeedLabel, isBookingSpeed } from "@/lib/observations/booking-speed";
import {
  isRuleConditionEmpty,
  ruleConditionForInsert,
  ruleConditionToLegacyConditions,
} from "@/lib/rule-form";
import type {
  ActionDirection,
  ActionKind,
  EngineRule,
  PickupMetric,
  RuleAction,
  RuleCondition,
  RuleConditionValue,
  RuleConfig,
} from "@/types/domain";
import type { SupabaseClient } from "@supabase/supabase-js";

/* ── In-memory store (reset on server restart) ────────────────── */

let memoryRules: RuleConfig[] = INITIAL_RULES.map((r) => ({ ...r }));
let nextId = 100;

/** @internal Reset in-memory state — for tests only. */
export function _resetForTesting(): void {
  memoryRules = INITIAL_RULES.map((r) => ({ ...r }));
  nextId = 100;
}

/* ── Conversion helpers ───────────────────────────────────────── */

type RuleOperator = "gt" | "lt" | "eq" | "gte" | "lte" | "neq";
type RuleMetric = "occupancy_percentage" | "pickup_rate" | "booking_window_days" | "room_type";

const SYM_TO_OP: Record<string, RuleOperator> = {
  ">": "gt",
  "<": "lt",
  "=": "eq",
  ">=": "gte",
  "<=": "lte",
  "!=": "neq",
};

const OP_TO_SYM: Record<RuleOperator, string> = {
  gt: ">",
  lt: "<",
  eq: "=",
  gte: ">=",
  lte: "<=",
  neq: "!=",
};

function parseConditionString(raw: string): { op: RuleOperator; num: number } | null {
  const t = raw.trim();
  const prefixes = [">=", "<=", "!=", ">", "<", "="] as const;
  for (const p of prefixes) {
    if (t.startsWith(p)) {
      const rest = t.slice(p.length).trim();
      const num = Number(rest);
      if (!Number.isFinite(num)) return null;
      const op = SYM_TO_OP[p];
      if (!op) return null;
      return { op, num };
    }
  }
  return null;
}

/**
 * Same as parseConditionString, but only accepts gt/lt — the only operators
 * rule_condition's CHECK constraints allow for occupancy/dta/pickup
 * (02_supabase_schema.sql). A legacy value like ">=80" parses fine under
 * parseConditionString but would fail the insert AFTER pricing_rules
 * already has a live row, leaving an orphaned active rule with no
 * conditions. Rejecting it here, before anything is written, is the only
 * point where that's still cheap to do.
 */
function parseLegacyConditionForDb(raw: string): { op: "gt" | "lt"; num: number } | null {
  const parsed = parseConditionString(raw);
  if (!parsed || (parsed.op !== "gt" && parsed.op !== "lt")) return null;
  return { op: parsed.op, num: parsed.num };
}

const LEGACY_NUMERIC_KEYS = new Set(["occupancy_percentage", "booking_window", "pickup_rate"]);

/** True when the legacy conditions map has at least one key the engine can actually act on. */
function legacyConditionsHaveUsableFamily(conditions: Record<string, RuleConditionValue>): boolean {
  for (const [key, val] of Object.entries(conditions)) {
    if (!LEGACY_NUMERIC_KEYS.has(key)) continue;
    if (parseLegacyConditionForDb(String(val))) return true;
  }
  return false;
}

function uiMetricToDb(key: string): RuleMetric | null {
  if (key === "booking_window") return "booking_window_days";
  if (key === "occupancy_percentage") return "occupancy_percentage";
  if (key === "pickup_rate") return "pickup_rate";
  if (key === "room_type") return "room_type";
  return null;
}

function dbMetricToUi(metric: string): string {
  return metric === "booking_window_days" ? "booking_window" : metric;
}

function dbActionToUi(actionType: string, direction: string, value: number): RuleAction {
  const v = Number(value);
  if (actionType === "percent") {
    if (direction === "decrease") return { adjust_rate_percent: -Math.abs(v) };
    return { adjust_rate_percent: Math.abs(v) };
  }
  if (actionType === "fixed") {
    if (direction === "decrease") return { adjust_rate_dollars: -Math.abs(v) };
    return { adjust_rate_dollars: Math.abs(v) };
  }
  return { adjust_rate_percent: 0 };
}

function uiActionToDb(action: RuleAction): {
  action_type: ActionKind;
  action_direction: ActionDirection;
  action_value: number;
} {
  if (action.adjust_rate_percent !== undefined) {
    const p = action.adjust_rate_percent;
    if (p >= 0) {
      return { action_type: "percent", action_direction: "increase", action_value: p };
    }
    return { action_type: "percent", action_direction: "decrease", action_value: Math.abs(p) };
  }
  if (action.adjust_rate_dollars !== undefined) {
    const d = action.adjust_rate_dollars;
    if (d >= 0) {
      return { action_type: "fixed", action_direction: "increase", action_value: d };
    }
    return { action_type: "fixed", action_direction: "decrease", action_value: Math.abs(d) };
  }
  return { action_type: "percent", action_direction: "increase", action_value: 0 };
}

/* ── DB row converters ─────────────────────────────────────────── */

/** "at least Much Faster Than Normal (past week)" — the rules-table summary text. */
function formatBookingSpeedCondition(operator: string, levelKey: string, windowDays: number): string {
  const label = isBookingSpeed(levelKey) ? bookingSpeedLabel(levelKey) : levelKey;
  const opWords =
    operator === "at_least" ? "at least " : operator === "at_most" ? "at most " : "";
  const windowWords =
    windowDays === 1 ? "past day" : windowDays === 30 ? "past month" : "past week";
  return `${opWords}${label} (${windowWords})`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function embedRoomTypeName(rt: any): string | undefined {
  const r = rt?.room_types;
  if (!r) return undefined;
  if (Array.isArray(r)) return r[0]?.name;
  return r.name;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dbRowToRuleConfig(row: any): RuleConfig {
  const conditions: Record<string, RuleConditionValue> = {};

  // Prefer new rule_condition if present; fall back to legacy pricing_rule_conditions.
  const rc = Array.isArray(row.rule_condition) ? row.rule_condition[0] : row.rule_condition;
  if (rc) {
    if (rc.occupancy_operator && rc.occupancy_threshold != null) {
      const sym = OP_TO_SYM[rc.occupancy_operator as RuleOperator] ?? ">";
      // Rounded to match ruleConditionToLegacyConditions (rule-form.ts) —
      // an unrounded *100 on a numeric(8,4) fraction shows float noise like
      // "56.99999999999999%" for a perfectly ordinary "above 57%" rule.
      const pct = Math.round(Number(rc.occupancy_threshold) * 10_000) / 100;
      conditions.occupancy_percentage = `${sym}${pct}`;
    }
    if (rc.dta_operator && rc.dta_threshold_days != null) {
      const sym = OP_TO_SYM[rc.dta_operator as RuleOperator] ?? "<";
      conditions.booking_window = `${sym}${rc.dta_threshold_days}`;
    }
    if (rc.pickup_operator && rc.pickup_threshold != null) {
      const sym = OP_TO_SYM[rc.pickup_operator as RuleOperator] ?? ">";
      conditions.pickup_rate = `${sym}${rc.pickup_threshold}`;
    }
    if (rc.booking_speed_operator && rc.booking_speed_level) {
      conditions.booking_speed = formatBookingSpeedCondition(
        String(rc.booking_speed_operator),
        String(rc.booking_speed_level),
        rc.booking_speed_window_days != null ? Number(rc.booking_speed_window_days) : 7,
      );
    }
  } else {
    for (const c of row.pricing_rule_conditions ?? []) {
      const key = dbMetricToUi(String(c.metric));
      if (c.metric === "room_type" && c.text_value != null) {
        conditions[key] = String(c.text_value);
      } else if (c.numeric_value != null && c.operator) {
        const sym = OP_TO_SYM[c.operator as RuleOperator] ?? ">";
        conditions[key] = `${sym}${c.numeric_value}`;
      }
    }
  }

  // Prefer affected room types; fall back to legacy pricing_rule_room_types.
  const room_types: string[] = [];
  const affected = row.rule_affected_room_type ?? [];
  if (affected.length > 0) {
    for (const rt of affected) {
      const n = embedRoomTypeName(rt);
      if (n) room_types.push(n);
    }
  } else {
    for (const rt of row.pricing_rule_room_types ?? []) {
      const n = embedRoomTypeName(rt);
      if (n) room_types.push(n);
    }
  }

  return {
    id: String(row.id),
    rule_name: row.name,
    conditions,
    action: dbActionToUi(row.action_type, row.action_direction, Number(row.action_value)),
    room_types,
    enabled: Boolean(row.is_active),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dbRowToEngineRule(row: any): EngineRule {
  const rc = Array.isArray(row.rule_condition) ? row.rule_condition[0] : row.rule_condition;
  const condition: RuleCondition = {};
  if (rc) {
    condition.occupancy_operator = rc.occupancy_operator ?? null;
    condition.occupancy_threshold = rc.occupancy_threshold != null ? Number(rc.occupancy_threshold) : null;
    condition.dta_operator = rc.dta_operator ?? null;
    condition.dta_threshold_days = rc.dta_threshold_days != null ? Number(rc.dta_threshold_days) : null;
    condition.pickup_operator = rc.pickup_operator ?? null;
    condition.pickup_threshold = rc.pickup_threshold != null ? Number(rc.pickup_threshold) : null;
    condition.pickup_window_days = rc.pickup_window_days != null ? (Number(rc.pickup_window_days) as 1 | 3 | 7) : null;
    condition.pickup_metric = (rc.pickup_metric as PickupMetric) ?? null;
    condition.booking_speed_operator = rc.booking_speed_operator ?? null;
    condition.booking_speed_level = rc.booking_speed_level ?? null;
    condition.booking_speed_window_days =
      rc.booking_speed_window_days != null ? (Number(rc.booking_speed_window_days) as 1 | 7 | 30) : null;
    condition.booking_speed_cooldown_days =
      rc.booking_speed_cooldown_days != null ? Number(rc.booking_speed_cooldown_days) : null;
  }

  const signal_ids: string[] = (row.rule_signal_room_type ?? []).map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r: any) => String(r.room_type_id),
  );
  const affected_ids: string[] = (row.rule_affected_room_type ?? []).map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r: any) => String(r.room_type_id),
  );

  return {
    id: String(row.id),
    hotel_id: String(row.hotel_id),
    name: row.name,
    is_active: Boolean(row.is_active),
    version: Number(row.version ?? 1),
    start_date: row.start_date ?? null,
    end_date: row.end_date ?? null,
    is_annual: Boolean(row.is_annual),
    dow_mask: Number(row.dow_mask ?? 127),
    action_type: row.action_type as ActionKind,
    action_direction: row.action_direction as ActionDirection,
    action_value: Number(row.action_value),
    priority: Number(row.priority),
    is_pickup_rule: Boolean(row.is_pickup_rule),
    condition,
    signal_room_type_ids: signal_ids,
    affected_room_type_ids: affected_ids,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/* ── Supabase select shapes ───────────────────────────────────── */

const RULE_SELECT = `
  id, hotel_id, name, is_active, version, priority,
  start_date, end_date, is_annual, dow_mask,
  action_type, action_direction, action_value,
  is_pickup_rule, created_at, updated_at,
  rule_condition (
    occupancy_operator, occupancy_threshold,
    dta_operator, dta_threshold_days,
    pickup_operator, pickup_threshold, pickup_window_days, pickup_metric,
    booking_speed_operator, booking_speed_level,
    booking_speed_window_days, booking_speed_cooldown_days
  ),
  rule_signal_room_type ( room_type_id, room_types ( name ) ),
  rule_affected_room_type ( room_type_id, room_types ( name ) ),
  pricing_rule_conditions ( metric, operator, numeric_value, text_value ),
  pricing_rule_room_types ( room_type_id, room_types ( name ) )
`;

/* ── List ─────────────────────────────────────────────────────── */

export async function listRules(
  supabase?: SupabaseClient,
  hotelId?: string | null,
): Promise<RuleConfig[]> {
  if (!supabase) return memoryRules;
  if (!hotelId) return [];

  const { data, error } = await supabase
    .from("pricing_rules")
    .select(RULE_SELECT)
    .eq("hotel_id", hotelId)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []).map(dbRowToRuleConfig);
}

/**
 * Load rules in the full EngineRule shape for engine evaluation.
 */
export async function listEngineRules(
  supabase: SupabaseClient,
  hotelId: string,
): Promise<EngineRule[]> {
  const { data, error } = await supabase
    .from("pricing_rules")
    .select(RULE_SELECT)
    .eq("hotel_id", hotelId)
    .eq("is_active", true)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []).map(dbRowToEngineRule);
}

/* ── Create ───────────────────────────────────────────────────── */

export type CreateRuleInput = {
  rule_name: string;
  conditions: Record<string, RuleConditionValue>;
  action: RuleAction;
  room_types: string[];
  start_date?: string | null;
  end_date?: string | null;
  is_annual?: boolean;
  dow_mask?: number;
  priority?: number;
  signal_room_type_ids?: string[];
  affected_room_type_ids?: string[];
  condition?: RuleCondition;
};

export async function createRule(
  input: CreateRuleInput,
  supabase?: SupabaseClient,
  hotelId?: string | null,
): Promise<RuleConfig> {
  if (!supabase) {
    const conditionsFromMap =
      input.conditions && Object.keys(input.conditions).length > 0
        ? input.conditions
        : ruleConditionToLegacyConditions(
            ruleConditionForInsert(input.condition ?? {}),
          );
    const rule: RuleConfig = {
      id: String(nextId++),
      rule_name: input.rule_name,
      conditions: conditionsFromMap,
      action: input.action,
      room_types: input.room_types,
      enabled: true,
    };
    memoryRules.push(rule);
    return rule;
  }

  if (!hotelId) {
    throw new Error("No hotel context for creating rules.");
  }

  const dbAction = uiActionToDb(input.action);
  const structuredCondition = input.condition
    ? ruleConditionForInsert(input.condition)
    : null;
  if (structuredCondition && isRuleConditionEmpty(structuredCondition)) {
    throw new Error("Rule must include at least one valid condition.");
  }
  // When no structured condition is given, the legacy map is the only
  // source of truth. Validate it BEFORE inserting pricing_rules — a map
  // whose values don't parse (missing operator prefix, a bare number, an
  // unrecognized key, or an operator like ">=" that rule_condition's CHECK
  // constraint doesn't allow) used to create a live, active rule with zero
  // condition rows, which the engine then treats as "always matches" for
  // every stay date in scope.
  if (!structuredCondition && !legacyConditionsHaveUsableFamily(input.conditions)) {
    throw new Error("Rule must include at least one valid condition.");
  }

  // Booking-speed rules run event-style (fire once, effect persists, then a
  // per-stay-date cooldown before re-firing) — same machinery as pickup
  // rules. A continuously-held effect would whipsaw: the price change
  // itself shifts the classification back toward Normal, deactivating the
  // very adjustment that caused it.
  let hasPickup =
    !!structuredCondition?.pickup_operator || !!structuredCondition?.booking_speed_operator;
  if (!structuredCondition) {
    for (const [key, val] of Object.entries(input.conditions)) {
      if (key !== "pickup_rate") continue;
      if (!parseLegacyConditionForDb(String(val))) continue;
      hasPickup = true;
      break;
    }
  }

  const { data: ruleRow, error: insErr } = await supabase
    .from("pricing_rules")
    .insert({
      hotel_id: hotelId,
      name: input.rule_name,
      priority: input.priority ?? 100,
      is_active: true,
      version: 1,
      start_date: input.start_date ?? null,
      end_date: input.end_date ?? null,
      is_annual: input.is_annual ?? false,
      dow_mask: input.dow_mask ?? 127,
      action_type: dbAction.action_type,
      action_direction: dbAction.action_direction,
      action_value: dbAction.action_value,
      is_pickup_rule: hasPickup,
    })
    .select("id")
    .single();

  if (insErr || !ruleRow) {
    throw new Error(insErr?.message ?? "Failed to create rule.");
  }

  const ruleId = String(ruleRow.id);

  // Write new rule_condition (single-row model).
  if (structuredCondition) {
    const { error: condErr } = await supabase.from("rule_condition").insert({
      rule_id: ruleId,
      ...structuredCondition,
    });
    if (condErr) throw new Error(condErr.message);
  } else {
    // Build from legacy conditions map. Uses the gt/lt-only parser — see
    // parseLegacyConditionForDb — so an operator the CHECK constraint
    // would reject (>=, <=, =, !=) is dropped here rather than reaching
    // the insert and throwing after pricing_rules already has a live row.
    const cond: Record<string, unknown> = { rule_id: ruleId };
    let hasAnyCond = false;
    for (const [key, val] of Object.entries(input.conditions)) {
      const parsed = parseLegacyConditionForDb(String(val));
      if (!parsed) continue;
      if (key === "occupancy_percentage") {
        cond.occupancy_operator = parsed.op;
        cond.occupancy_threshold = parsed.num / 100;
        hasAnyCond = true;
      } else if (key === "booking_window") {
        cond.dta_operator = parsed.op;
        cond.dta_threshold_days = parsed.num;
        hasAnyCond = true;
      } else if (key === "pickup_rate") {
        cond.pickup_operator = parsed.op;
        cond.pickup_threshold = parsed.num;
        cond.pickup_window_days = 3;
        cond.pickup_metric = "room_nights";
        hasAnyCond = true;
      }
    }
    if (hasAnyCond) {
      const { error: condErr } = await supabase.from("rule_condition").insert(cond);
      if (condErr) throw new Error(condErr.message);
    }
  }

  // Write legacy pricing_rule_conditions for backward compatibility.
  const legacyCondRows: {
    rule_id: string;
    metric: RuleMetric;
    operator: RuleOperator;
    numeric_value?: number;
    text_value?: string;
  }[] = [];
  for (const [key, val] of Object.entries(input.conditions)) {
    const metric = uiMetricToDb(key);
    if (!metric) continue;
    if (metric === "room_type") {
      legacyCondRows.push({ rule_id: ruleId, metric, operator: "eq", text_value: String(val) });
      continue;
    }
    const parsed = parseConditionString(String(val));
    if (!parsed) continue;
    legacyCondRows.push({ rule_id: ruleId, metric, operator: parsed.op, numeric_value: parsed.num });
  }
  if (legacyCondRows.length > 0) {
    await supabase.from("pricing_rule_conditions").insert(legacyCondRows);
  }

  // Resolve room type IDs.
  const roomTypeIds: string[] = [];
  if (input.affected_room_type_ids && input.affected_room_type_ids.length > 0) {
    roomTypeIds.push(...input.affected_room_type_ids);
  } else {
    for (const rtName of input.room_types) {
      const { data: rt } = await supabase
        .from("room_types")
        .select("id")
        .eq("hotel_id", hotelId)
        .eq("name", rtName)
        .maybeSingle();
      if (rt?.id) roomTypeIds.push(String(rt.id));
    }
  }

  const signalIds = input.signal_room_type_ids ?? roomTypeIds;

  // Write new signal / affected mapping tables.
  if (signalIds.length > 0) {
    await supabase.from("rule_signal_room_type").insert(
      signalIds.map((rtId) => ({ rule_id: ruleId, room_type_id: rtId })),
    );
  }
  if (roomTypeIds.length > 0) {
    await supabase.from("rule_affected_room_type").insert(
      roomTypeIds.map((rtId) => ({ rule_id: ruleId, room_type_id: rtId })),
    );
  }

  // Write legacy pricing_rule_room_types.
  for (const rtId of roomTypeIds) {
    await supabase.from("pricing_rule_room_types").insert({
      rule_id: ruleId,
      room_type_id: rtId,
    });
  }

  const { data: full, error: fetchErr } = await supabase
    .from("pricing_rules")
    .select(RULE_SELECT)
    .eq("id", ruleId)
    .single();

  if (fetchErr || !full) {
    throw new Error(fetchErr?.message ?? "Failed to load new rule.");
  }
  return dbRowToRuleConfig(full);
}

/* ── Update (with version bumping) ───────────────────────────── */

export type UpdateRuleInput = {
  name?: string;
  priority?: number;
  is_active?: boolean;
  start_date?: string | null;
  end_date?: string | null;
  is_annual?: boolean;
  dow_mask?: number;
  action?: RuleAction;
  condition?: RuleCondition;
  signal_room_type_ids?: string[];
  affected_room_type_ids?: string[];
};

/**
 * Update a rule. If conditions, action, scope, or room-type sets change,
 * bump version and retire active pickup events per §7.4.
 */
export async function updateRule(
  id: string,
  input: UpdateRuleInput,
  supabase: SupabaseClient,
): Promise<boolean> {
  // Validate the new condition BEFORE any mutation. This used to run after
  // the pricing_rules row was already updated, the version bumped, and any
  // active pickup events retired — a rejected edit still left all of that
  // applied to the rule while reporting "failed" to the caller, which is
  // worse than doing nothing: it silently changes the rule's action/scope
  // and destroys its pickup history for an edit that never actually landed.
  let cleanCondition: RuleCondition | null = null;
  if (input.condition) {
    cleanCondition = ruleConditionForInsert(input.condition);
    if (isRuleConditionEmpty(cleanCondition)) return false;
  }

  const isBehavioralEdit = !!(
    input.action ||
    input.condition ||
    input.signal_room_type_ids ||
    input.affected_room_type_ids ||
    input.start_date !== undefined ||
    input.end_date !== undefined ||
    input.is_annual !== undefined ||
    input.dow_mask !== undefined
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.priority !== undefined) updates.priority = input.priority;
  if (input.is_active !== undefined) updates.is_active = input.is_active;
  if (input.start_date !== undefined) updates.start_date = input.start_date;
  if (input.end_date !== undefined) updates.end_date = input.end_date;
  if (input.is_annual !== undefined) updates.is_annual = input.is_annual;
  if (input.dow_mask !== undefined) updates.dow_mask = input.dow_mask;

  if (input.action) {
    const dbAction = uiActionToDb(input.action);
    updates.action_type = dbAction.action_type;
    updates.action_direction = dbAction.action_direction;
    updates.action_value = dbAction.action_value;
  }

  if (input.condition) {
    // Event-class covers BOTH trigger families — dropping booking_speed
    // here silently demoted an edited booking-speed rule to the ladder
    // path, which ignores its cooldown entirely.
    updates.is_pickup_rule =
      !!input.condition.pickup_operator || !!input.condition.booking_speed_operator;
  }

  if (isBehavioralEdit) {
    const { data: current } = await supabase
      .from("pricing_rules")
      .select("version")
      .eq("id", id)
      .single();
    updates.version = (current?.version ?? 0) + 1;

    // Retire all active pickup events for this rule (§7.4).
    await supabase
      .from("pickup_event")
      .update({ retired_at: new Date().toISOString() })
      .eq("rule_id", id)
      .is("retired_at", null);
  }

  const { error } = await supabase
    .from("pricing_rules")
    .update(updates)
    .eq("id", id);

  if (error) return false;

  // Update condition row. The old row is fetched first so a failed insert
  // can be repaired rather than leaving the rule with zero conditions —
  // which the engine reads as "always matches every stay date," not as
  // "this edit didn't happen."
  if (cleanCondition) {
    const { data: previous } = await supabase
      .from("rule_condition")
      .select("*")
      .eq("rule_id", id)
      .maybeSingle();

    const { error: delErr } = await supabase.from("rule_condition").delete().eq("rule_id", id);
    if (delErr) return false;

    const { error: insErr } = await supabase
      .from("rule_condition")
      .insert({ rule_id: id, ...cleanCondition });
    if (insErr) {
      if (previous) await supabase.from("rule_condition").insert(previous);
      return false;
    }
  }

  // Update room-type mappings.
  if (input.signal_room_type_ids) {
    await supabase.from("rule_signal_room_type").delete().eq("rule_id", id);
    if (input.signal_room_type_ids.length > 0) {
      await supabase.from("rule_signal_room_type").insert(
        input.signal_room_type_ids.map((rtId) => ({ rule_id: id, room_type_id: rtId })),
      );
    }
  }

  if (input.affected_room_type_ids) {
    await supabase.from("rule_affected_room_type").delete().eq("rule_id", id);
    if (input.affected_room_type_ids.length > 0) {
      await supabase.from("rule_affected_room_type").insert(
        input.affected_room_type_ids.map((rtId) => ({ rule_id: id, room_type_id: rtId })),
      );
    }
  }

  return true;
}

/* ── Toggle ───────────────────────────────────────────────────── */

export async function toggleRule(id: string, supabase?: SupabaseClient): Promise<boolean> {
  if (!supabase) {
    const rule = memoryRules.find((r) => r.id === id);
    if (!rule) return false;
    rule.enabled = !rule.enabled;
    return true;
  }

  const { data: existing, error: fetchErr } = await supabase
    .from("pricing_rules")
    .select("is_active")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr || !existing) return false;

  const { error } = await supabase
    .from("pricing_rules")
    .update({ is_active: !existing.is_active, updated_at: new Date().toISOString() })
    .eq("id", id);

  return !error;
}

/* ── Delete ───────────────────────────────────────────────────── */

export async function deleteRule(id: string, supabase?: SupabaseClient): Promise<boolean> {
  if (!supabase) {
    const idx = memoryRules.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    memoryRules.splice(idx, 1);
    return true;
  }

  // Deleting a rule reverts its effects — the price goes back to what it
  // would be without this rule ever having fired. Switching a rule OFF is
  // the opposite and deliberately leaves its effects in place; the two are
  // offered side by side in the UI so the choice is explicit.
  //
  // Both effect ledgers must be cleared, and pickup_event must go first
  // regardless: it references the rule with no cascade, so leaving its rows
  // behind hits a foreign-key wall and silently breaks deletion for any rule
  // that had ever fired.
  const { error: eventErr } = await supabase.from("pickup_event").delete().eq("rule_id", id);
  if (eventErr) return false;
  // ladder_rule_state has no cascade to pricing_rules either, and its rows
  // keep being applied by loadActiveLadderEffects for as long as they are
  // active — a deleted rule would otherwise go on adjusting prices with
  // nothing left to explain it in the change log.
  const { error: ladderErr } = await supabase
    .from("ladder_rule_state")
    .delete()
    .eq("rule_id", id);
  if (ladderErr) return false;
  const { error } = await supabase.from("pricing_rules").delete().eq("id", id);
  return !error;
}
