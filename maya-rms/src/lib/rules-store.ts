/**
 * Rules CRUD — Supabase (`pricing_rules` + related tables) or in-memory fallback.
 *
 * Supabase shape matches `supabase_schema.sql` (normalized rule engine).
 */

import { INITIAL_RULES } from "@/lib/demo-data";
import type { RuleAction, RuleConditionValue, RuleConfig } from "@/types/domain";
import type { SupabaseClient } from "@supabase/supabase-js";

/* ── In-memory store (reset on server restart) ────────────────── */

let memoryRules: RuleConfig[] = INITIAL_RULES.map((r) => ({ ...r }));
let nextId = 100;

/** @internal Reset in-memory state — for tests only. */
export function _resetForTesting(): void {
  memoryRules = INITIAL_RULES.map((r) => ({ ...r }));
  nextId = 100;
}

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

function dbActionToUi(
  actionType: string,
  direction: string,
  value: number,
): RuleAction {
  const v = Number(value);
  if (actionType === "percent") {
    if (direction === "decrease") return { adjust_rate_percent: -Math.abs(v) };
    return { adjust_rate_percent: Math.abs(v) };
  }
  if (actionType === "fixed") {
    if (direction === "decrease") return { adjust_rate_dollars: -Math.abs(v) };
    return { adjust_rate_dollars: Math.abs(v) };
  }
  if (actionType === "set_rate" && direction === "absolute") {
    return { adjust_rate_dollars: v };
  }
  return { adjust_rate_percent: 0 };
}

function uiActionToDb(action: RuleAction): {
  action_type: "percent" | "fixed" | "set_rate";
  action_direction: "increase" | "decrease" | "absolute";
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
  for (const c of row.pricing_rule_conditions ?? []) {
    const key = dbMetricToUi(String(c.metric));
    if (c.metric === "room_type" && c.text_value != null) {
      conditions[key] = String(c.text_value);
    } else if (c.numeric_value != null && c.operator) {
      const sym = OP_TO_SYM[c.operator as RuleOperator] ?? ">";
      conditions[key] = `${sym}${c.numeric_value}`;
    }
  }

  const room_types: string[] = [];
  for (const rt of row.pricing_rule_room_types ?? []) {
    const n = embedRoomTypeName(rt);
    if (n) room_types.push(n);
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

const RULE_SELECT = `
  id,
  name,
  is_active,
  priority,
  action_type,
  action_direction,
  action_value,
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

/* ── Create ───────────────────────────────────────────────────── */

type CreateInput = Pick<RuleConfig, "rule_name" | "conditions" | "action" | "room_types">;

export async function createRule(
  input: CreateInput,
  supabase?: SupabaseClient,
  hotelId?: string | null,
): Promise<RuleConfig> {
  if (!supabase) {
    const rule: RuleConfig = {
      id: String(nextId++),
      rule_name: input.rule_name,
      conditions: input.conditions,
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

  const { data: ruleRow, error: insErr } = await supabase
    .from("pricing_rules")
    .insert({
      hotel_id: hotelId,
      name: input.rule_name,
      priority: 100,
      is_active: true,
      scope_type: "hotel",
      action_type: dbAction.action_type,
      action_direction: dbAction.action_direction,
      action_value: dbAction.action_value,
    })
    .select("id")
    .single();

  if (insErr || !ruleRow) {
    throw new Error(insErr?.message ?? "Failed to create rule.");
  }

  const ruleId = String(ruleRow.id);

  const conditionRows: {
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
      conditionRows.push({
        rule_id: ruleId,
        metric,
        operator: "eq",
        text_value: String(val),
      });
      continue;
    }
    const parsed = parseConditionString(String(val));
    if (!parsed) continue;
    conditionRows.push({
      rule_id: ruleId,
      metric,
      operator: parsed.op,
      numeric_value: parsed.num,
    });
  }

  if (conditionRows.length > 0) {
    const { error: condErr } = await supabase.from("pricing_rule_conditions").insert(conditionRows);
    if (condErr) throw new Error(condErr.message);
  }

  for (const rtName of input.room_types) {
    const { data: rt } = await supabase
      .from("room_types")
      .select("id")
      .eq("hotel_id", hotelId)
      .eq("name", rtName)
      .maybeSingle();
    if (rt?.id) {
      const { error: linkErr } = await supabase.from("pricing_rule_room_types").insert({
        rule_id: ruleId,
        room_type_id: rt.id,
      });
      if (linkErr) throw new Error(linkErr.message);
    }
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

  const { error } = await supabase.from("pricing_rules").delete().eq("id", id);
  return !error;
}
