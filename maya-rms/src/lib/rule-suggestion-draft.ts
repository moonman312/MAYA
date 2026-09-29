/**
 * The rule suggestion cards ("Add this rule", and the tune card's "Make that
 * change") as the rule they save, in the rule builder's shape: the activation
 * popup previews exactly this, and the findings route saves exactly this.
 * Both sides build it here, so the rule previewed is the rule saved.
 */

import type { RuleAction, RuleCondition } from "@/types/domain";

export type SuggestionDraft = {
  rule_name: string;
  condition: RuleCondition;
  action: RuleAction;
  signal_room_type_ids: string[];
  affected_room_type_ids: string[];
  undo_on_cancellation: boolean;
  priority?: number;
};

function signed(kind: unknown, direction: unknown, value: unknown): RuleAction {
  const v = Math.abs(Number(value));
  const n = direction === "decrease" ? -v : v;
  return kind === "fixed" ? { adjust_rate_dollars: n } : { adjust_rate_percent: n };
}

/** "Add this rule": the suggested rule, on the room types the suggestion names (or `fallback` when it names none). */
export function suggestionDraft(payload: Record<string, unknown>, fallback: string[] = []): SuggestionDraft | null {
  const spec = payload.spec as
    | {
        name?: unknown;
        priority?: unknown;
        condition?: Record<string, unknown>;
        action?: { action_type?: unknown; action_direction?: unknown; action_value?: unknown };
      }
    | undefined;
  if (!spec?.name || !spec.condition || !spec.action) return null;
  const ids = Array.isArray(payload.room_type_ids) && payload.room_type_ids.length > 0 ? payload.room_type_ids.map(String) : fallback;
  return {
    rule_name: String(spec.name),
    condition: spec.condition as RuleCondition,
    action: signed(spec.action.action_type, spec.action.action_direction, spec.action.action_value),
    signal_room_type_ids: ids,
    affected_room_type_ids: ids,
    // A suggestion the owner accepts is ticked, like every new rule.
    undo_on_cancellation: true,
    ...(Number.isInteger(Number(spec.priority)) ? { priority: Number(spec.priority) } : {}),
  };
}

/** A saved rule, in the engine's shape, as far as tuning needs it. */
export type TunableRule = {
  name: string;
  condition: RuleCondition;
  action_type: string;
  action_direction: string;
  action_value: number;
  signal_room_type_ids: string[];
  affected_room_type_ids: string[];
  undo_on_cancellation?: boolean;
};

/** "Make that change": the rule as saved, with its occupancy bar moved to `threshold` (a fraction). */
export function tunedDraft(rule: TunableRule, threshold: number): SuggestionDraft {
  return {
    rule_name: rule.name,
    condition: { ...rule.condition, occupancy_threshold: threshold },
    action: signed(rule.action_type, rule.action_direction, rule.action_value),
    signal_room_type_ids: [...rule.signal_room_type_ids],
    affected_room_type_ids: [...rule.affected_room_type_ids],
    undo_on_cancellation: rule.undo_on_cancellation !== false,
  };
}
