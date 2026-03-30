/**
 * Rules CRUD — Supabase-backed or in-memory fallback.
 *
 * Every function accepts an optional SupabaseClient.  When present,
 * it reads/writes the `rules` table (scoped by RLS).  When absent,
 * it operates on a process-scoped in-memory array seeded from demo data.
 */

import { INITIAL_RULES } from "@/lib/demo-data";
import type { RuleAction, RuleConfig } from "@/types/domain";
import type { SupabaseClient } from "@supabase/supabase-js";

/* ── In-memory store (reset on server restart) ────────────────── */

let memoryRules: RuleConfig[] = INITIAL_RULES.map((r) => ({ ...r }));
let nextId = 100;

/** @internal Reset in-memory state — for tests only. */
export function _resetForTesting(): void {
  memoryRules = INITIAL_RULES.map((r) => ({ ...r }));
  nextId = 100;
}

/* ── List ─────────────────────────────────────────────────────── */

export async function listRules(supabase?: SupabaseClient): Promise<RuleConfig[]> {
  if (!supabase) return memoryRules;

  const { data, error } = await supabase
    .from("rules")
    .select("id, rule_name, conditions, action, room_types, enabled")
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []).map(rowToRule);
}

/* ── Create ───────────────────────────────────────────────────── */

type CreateInput = Pick<RuleConfig, "rule_name" | "conditions" | "action" | "room_types">;

export async function createRule(input: CreateInput, supabase?: SupabaseClient): Promise<RuleConfig> {
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

  const { data, error } = await supabase
    .from("rules")
    .insert({
      rule_name: input.rule_name,
      conditions: input.conditions,
      action: input.action,
      room_types: input.room_types,
      enabled: true,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return rowToRule(data);
}

/* ── Toggle ───────────────────────────────────────────────────── */

export async function toggleRule(id: string, supabase?: SupabaseClient): Promise<boolean> {
  if (!supabase) {
    const rule = memoryRules.find((r) => r.id === id);
    if (!rule) return false;
    rule.enabled = !rule.enabled;
    return true;
  }

  // Fetch current state
  const { data: existing, error: fetchErr } = await supabase
    .from("rules")
    .select("enabled")
    .eq("id", id)
    .single();

  if (fetchErr || !existing) return false;

  const { error } = await supabase
    .from("rules")
    .update({ enabled: !existing.enabled })
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

  const { error } = await supabase.from("rules").delete().eq("id", id);
  return !error;
}

/* ── Helpers ──────────────────────────────────────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToRule(row: any): RuleConfig {
  return {
    id: String(row.id),
    rule_name: row.rule_name,
    conditions: row.conditions as RuleConfig["conditions"],
    action: row.action as RuleAction,
    room_types: (row.room_types ?? []) as string[],
    enabled: Boolean(row.enabled),
  };
}
