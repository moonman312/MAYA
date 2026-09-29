/**
 * Saving a rule from the rule builder, the rules list's switch, or the
 * activation popup: one plan used both to preview the change (the dry run in
 * rule-preview.ts) and to save it, so the rule that is previewed is the rule
 * that is saved, and one save (save_rule, 99_supabase_migration_rule_activation_v1.sql)
 * that writes the rule, whether it is on, the owner's Apply or Skip and the
 * nights to price first in one transaction.
 *
 * When the popup is needed (needsActivation): a new rule (the builder saves
 * it on), switching a rule on, and an edit saved to a rule that is on that
 * can move a price (its settings, or the undo box). A new name moves no
 * price, and an edit to a rule that is off moves none until it is switched
 * on (through the popup).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingColumnError, isMissingFunctionError } from "@/lib/engine/snapshots";
import { ENGINE_RULE_COLUMNS, skipPlanForRule, type EngineRuleRow, type SkipPlan } from "@/lib/rule-preview";
import {
  RATE_AMOUNT_MISSING,
  RULE_CHANGE_FORBIDDEN,
  isRuleActionEmpty,
  isRuleConditionEmpty,
  roomTypeIdListError,
  ruleActionError,
  ruleConditionForInsert,
  ruleConditionToLegacyConditions,
  undoOnCancellationError,
} from "@/lib/rule-form";
import { createRule, legacyConditionRows, uiActionToDb, updateRule } from "@/lib/rules-store";
import { isDowMask } from "@/lib/rule-suggestion-draft";
import type { RuleAction, RuleCondition } from "@/types/domain";

export type RuleIntent = "create" | "edit" | "enable";
export type ActivationChoice = "apply" | "skip";

/** What the rule builder sends for a rule, new or edited. */
export type RuleDraft = {
  rule_name: string;
  condition: RuleCondition;
  action: RuleAction;
  signal_room_type_ids: string[];
  affected_room_type_ids: string[];
  undo_on_cancellation: boolean;
  /** A suggestion's own priority (rule-suggestion-draft.ts); the builder leaves it out (100). */
  priority?: number;
  /**
   * A suggestion's own days (a rule copied from the owner's weekend or
   * weekday moves), for a new rule only; the builder leaves it out (every
   * day) and an edit keeps the rule's days.
   */
  dow_mask?: number;
};

/** A refused save or preview, with the status and the words to show. */
export class RuleSaveError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "RuleSaveError";
  }
}

export const RULE_CHANGED_ELSEWHERE = "This rule changed in another tab. Reload it to edit.";
export const NEEDS_DATABASE_UPDATE = "This needs a database update first.";
export const DAYS_CHANGED = "Your bookings changed while this was open, so the days were checked again.";

export type RulePlan = {
  hotelId: string;
  ruleId: string;
  intent: RuleIntent;
  /** save_rule's p_fields: the rule as saved, or null when only switching it on. */
  fields: Record<string, unknown> | null;
  /** The rule as it will be after Apply, in the engine's shape (for the dry run). */
  after: EngineRuleRow;
  /** The rule as stored (null for a new one). */
  stored: EngineRuleRow | null;
  /** What changes: "behaviour" bumps the version; "undo" is the box alone; "name" moves no price. */
  change: "new" | "enable" | "behaviour" | "undo" | "name" | "none";
  versionBefore: number | null;
  versionAfter: number;
  /** Whether the rule is on now, before the save. */
  isActive: boolean;
  /** Whether saving it needs the owner's Apply or Skip (the popup). */
  needsActivation: boolean;
  /** The draft, for the save when save_rule is not there yet. */
  draft: RuleDraft | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/** The builder's body, checked the way POST /api/rules checks it. Throws RuleSaveError (400). */
export function parseDraft(body: Record<string, unknown>): RuleDraft {
  const name = typeof body.rule_name === "string" ? body.rule_name.trim() : "";
  if (!name) throw new RuleSaveError(400, "Give the rule a name.");
  const condition = body.condition && typeof body.condition === "object" ? ruleConditionForInsert(body.condition as RuleCondition) : null;
  if (!condition || isRuleConditionEmpty(condition)) {
    throw new RuleSaveError(400, "Add at least one condition with a valid operator and threshold.");
  }
  const action = (body.action ?? null) as RuleAction | null;
  const amountError = ruleActionError(action);
  if (amountError) throw new RuleSaveError(400, amountError);
  if (isRuleActionEmpty(action)) throw new RuleSaveError(400, RATE_AMOUNT_MISSING);
  const value = action!.adjust_rate_percent ?? action!.adjust_rate_dollars ?? 0;
  if (!Number.isFinite(value) || value === 0) throw new RuleSaveError(400, RATE_AMOUNT_MISSING);
  const setError =
    roomTypeIdListError(body.signal_room_type_ids ?? [], "measure") ??
    roomTypeIdListError(body.affected_room_type_ids ?? [], "change") ??
    undoOnCancellationError(body.undo_on_cancellation);
  if (setError) throw new RuleSaveError(400, setError);
  // Rounded to what the database keeps (numeric(8,4), numeric(10,2),
  // numeric(10,4)), so the rule previewed is the rule saved.
  const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;
  if (condition.occupancy_threshold != null) condition.occupancy_threshold = round(Number(condition.occupancy_threshold), 4);
  if (condition.pickup_threshold != null) condition.pickup_threshold = round(Number(condition.pickup_threshold), 2);
  const rounded: RuleAction =
    action!.adjust_rate_percent !== undefined
      ? { adjust_rate_percent: round(action!.adjust_rate_percent, 4) }
      : { adjust_rate_dollars: round(action!.adjust_rate_dollars!, 4) };
  const priority = Number(body.priority);
  return {
    ...(body.priority !== undefined && Number.isInteger(priority) && priority >= 0 && priority <= 10_000 ? { priority } : {}),
    ...(isDowMask(body.dow_mask) ? { dow_mask: body.dow_mask } : {}),
    rule_name: name,
    condition,
    action: rounded,
    signal_room_type_ids: [...new Set(body.signal_room_type_ids as string[])],
    affected_room_type_ids: [...new Set(body.affected_room_type_ids as string[])],
    undo_on_cancellation: body.undo_on_cancellation !== false,
  };
}

/** A rule as stored, in the engine's shape; null when there is none on this hotel. */
export async function loadEngineRuleRow(client: SupabaseClient, hotelId: string, ruleId: string): Promise<EngineRuleRow | null> {
  const read = (columns: string) =>
    client.from("pricing_rules").select(columns).eq("id", ruleId).eq("hotel_id", hotelId).maybeSingle();
  let { data, error } = await read(ENGINE_RULE_COLUMNS);
  // Before 99_supabase_migration_rule_activation_v1.sql: no rule was ever skipped.
  if (error && isMissingColumnError(error)) ({ data, error } = await read(ENGINE_RULE_COLUMNS.replace(" skip_at, version_ranks,", "")));
  if (error) throw new Error(`Could not read the rule: ${error.message}`);
  return (data as unknown as EngineRuleRow | null) ?? null;
}

/** The room types among `ids` that are this hotel's. */
async function ownRoomTypes(client: SupabaseClient, hotelId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { data, error } = await client.from("room_types").select("id").eq("hotel_id", hotelId).in("id", ids);
  if (error) throw new Error(`Could not check room types: ${error.message}`);
  const own = new Set((data ?? []).map((r) => String(r.id)));
  return ids.filter((id) => own.has(id));
}

function one<T>(v: unknown): T | undefined {
  return (Array.isArray(v) ? v[0] : v) as T | undefined;
}

const CONDITION_KEYS = [
  "occupancy_operator",
  "occupancy_threshold",
  "dta_operator",
  "dta_threshold_days",
  "pickup_operator",
  "pickup_threshold",
  "pickup_window_days",
  "pickup_metric",
  "pickup_cooldown_days",
  "booking_speed_operator",
  "booking_speed_level",
  "booking_speed_window_days",
  "booking_speed_cooldown_days",
] as const;

/** A condition with every column named, numbers as numbers, for comparing and for the engine's row. */
export function fullCondition(c: Record<string, unknown> | null | undefined): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const k of CONDITION_KEYS) {
    const v = c?.[k];
    out[k] = v == null ? null : typeof v === "number" || /threshold|days/.test(k) ? Number(v) : String(v);
  }
  if (out.occupancy_threshold != null) out.occupancy_threshold = Math.round(Number(out.occupancy_threshold) * 1e4) / 1e4;
  if (out.pickup_threshold != null) out.pickup_threshold = Math.round(Number(out.pickup_threshold) * 100) / 100;
  return out;
}

/**
 * The same condition as the engine reads it, for telling an edit from none:
 * a booking speed window or wait left empty is the week the engine uses.
 */
function conditionKey(c: Record<string, string | number | null>): string {
  const k = { ...c };
  if (k.booking_speed_operator) {
    k.booking_speed_window_days ??= 7;
    k.booking_speed_cooldown_days ??= 7;
  }
  return JSON.stringify(k);
}

const sameSet = (a: readonly string[], b: readonly string[]) => [...new Set(a)].sort().join(",") === [...new Set(b)].sort().join(",");

/**
 * Work out what a save is: the rule after it, what changes, whether it needs
 * the popup. `client` reads the stored rule and room types (the route's
 * service-role client, after its gate). `at` stamps a new rule's
 * created_at in the preview.
 */
export async function planRuleChange(
  client: SupabaseClient,
  hotelId: string,
  input: { intent: RuleIntent; ruleId?: unknown; draft?: RuleDraft | null; at: string },
): Promise<RulePlan> {
  if (!isUuid(input.ruleId)) throw new RuleSaveError(400, "That rule could not be found.");
  const ruleId = input.ruleId.toLowerCase();

  if (input.intent === "create") {
    const draft = input.draft;
    if (!draft) throw new RuleSaveError(400, "Invalid payload.");
    const signal = await ownRoomTypes(client, hotelId, draft.signal_room_type_ids);
    if (signal.length === 0) throw new RuleSaveError(400, "Pick at least one room type to measure.");
    const affected = await ownRoomTypes(client, hotelId, draft.affected_room_type_ids);
    if (affected.length === 0) throw new RuleSaveError(400, "Pick at least one room type to change.");
    const { data: clash } = await client.from("pricing_rules").select("id").eq("id", ruleId).maybeSingle();
    if (clash) throw new RuleSaveError(409, "Try again.", "rule_exists");
    const action = uiActionToDb(draft.action);
    const condition = fullCondition(draft.condition as Record<string, unknown>);
    const isPickup = !!draft.condition.pickup_operator || !!draft.condition.booking_speed_operator;
    const priority = draft.priority ?? 100;
    const dowMask = draft.dow_mask ?? 127;
    const fields = {
      name: draft.rule_name,
      priority,
      start_date: null,
      end_date: null,
      is_annual: false,
      dow_mask: dowMask,
      ...action,
      is_pickup_rule: isPickup,
      undo_on_cancellation: draft.undo_on_cancellation,
      version: 1,
      condition: draft.condition,
      signal,
      affected,
      legacy_conditions: legacyConditionRows(ruleConditionToLegacyConditions(draft.condition)),
    };
    return {
      hotelId,
      ruleId,
      intent: "create",
      fields,
      after: {
        id: ruleId,
        hotel_id: hotelId,
        name: draft.rule_name,
        is_active: true,
        version: 1,
        priority,
        start_date: null,
        end_date: null,
        is_annual: false,
        dow_mask: dowMask,
        ...action,
        is_pickup_rule: isPickup,
        created_at: input.at,
        updated_at: input.at,
        undo_on_cancellation: draft.undo_on_cancellation,
        skip_at: null,
        rule_condition: [condition],
        rule_signal_room_type: signal.map((room_type_id) => ({ room_type_id })),
        rule_affected_room_type: affected.map((room_type_id) => ({ room_type_id })),
      },
      stored: null,
      change: "new",
      versionBefore: null,
      versionAfter: 1,
      isActive: false,
      needsActivation: true,
      draft,
    };
  }

  const stored = await loadEngineRuleRow(client, hotelId, ruleId);
  if (!stored) throw new RuleSaveError(404, "That rule could not be found.");
  const versionBefore = Number(stored.version ?? 1);
  const isActive = Boolean(stored.is_active);

  if (input.intent === "enable") {
    return {
      hotelId,
      ruleId,
      intent: "enable",
      fields: null,
      after: { ...stored, is_active: true, skip_at: null },
      stored,
      change: "enable",
      versionBefore,
      versionAfter: versionBefore,
      isActive,
      needsActivation: !isActive,
      draft: null,
    };
  }

  const draft = input.draft;
  if (!draft) throw new RuleSaveError(400, "Invalid payload.");
  const signal = await ownRoomTypes(client, hotelId, draft.signal_room_type_ids);
  if (signal.length === 0) throw new RuleSaveError(400, "Pick at least one room type to measure.");
  const affected = await ownRoomTypes(client, hotelId, draft.affected_room_type_ids);
  if (affected.length === 0) throw new RuleSaveError(400, "Pick at least one room type to change.");
  const action = uiActionToDb(draft.action);
  const condition = fullCondition(draft.condition as Record<string, unknown>);
  const storedCondition = fullCondition(one<Record<string, unknown>>(stored.rule_condition));
  const storedIds = (v: unknown) =>
    Array.isArray(v) ? v.map((x) => String((x as { room_type_id: unknown }).room_type_id)) : [];
  // The builder lists only active room types: a rule's lists are compared
  // on those, so opening a rule that names a room type since switched off
  // and saving it as it is changes nothing.
  const { data: activeRows, error: activeError } = await client
    .from("room_types")
    .select("id")
    .eq("hotel_id", hotelId)
    .eq("is_active", true);
  if (activeError) throw new Error(`Could not check room types: ${activeError.message}`);
  const active = new Set((activeRows ?? []).map((r) => String(r.id)));
  const onActive = (list: string[]) => list.filter((id) => active.has(id));
  const setsChanged =
    !sameSet(onActive(signal), onActive(storedIds(stored.rule_signal_room_type))) ||
    !sameSet(onActive(affected), onActive(storedIds(stored.rule_affected_room_type)));
  const behaviour =
    conditionKey(condition) !== conditionKey(storedCondition) ||
    action.action_type !== stored.action_type ||
    action.action_direction !== stored.action_direction ||
    Number(action.action_value) !== Number(stored.action_value) ||
    setsChanged;
  const undoChanged = draft.undo_on_cancellation !== (stored.undo_on_cancellation !== false);
  const nameChanged = draft.rule_name !== String(stored.name ?? "");
  const change: RulePlan["change"] = behaviour ? "behaviour" : undoChanged ? "undo" : nameChanged ? "name" : "none";
  const versionAfter = behaviour ? versionBefore + 1 : versionBefore;
  const isPickup = !!draft.condition.pickup_operator || !!draft.condition.booking_speed_operator;
  const fields: Record<string, unknown> = {
    name: draft.rule_name,
    undo_on_cancellation: draft.undo_on_cancellation,
    version: versionAfter,
    ...(behaviour ? { ...action, is_pickup_rule: isPickup, condition: draft.condition } : {}),
    ...(setsChanged ? { signal, affected } : {}),
  };
  return {
    hotelId,
    ruleId,
    intent: "edit",
    fields,
    after: {
      ...stored,
      name: draft.rule_name,
      is_active: true,
      version: versionAfter,
      ...(behaviour ? { ...action, is_pickup_rule: isPickup } : {}),
      undo_on_cancellation: draft.undo_on_cancellation,
      skip_at: null,
      ...(behaviour ? { rule_condition: [condition] } : {}),
      ...(setsChanged
        ? {
            rule_signal_room_type: signal.map((room_type_id) => ({ room_type_id })),
            rule_affected_room_type: affected.map((room_type_id) => ({ room_type_id })),
          }
        : {}),
    },
    stored,
    change,
    versionBefore,
    versionAfter,
    isActive,
    needsActivation: isActive && (change === "behaviour" || change === "undo"),
    draft,
  };
}

export type CommitResult = {
  id: string;
  version: number;
  is_active: boolean;
  skip_at: string | null;
  /** A Skip's marks on a standard rule's rows, and the days it holds. */
  marks: number;
  heldDays: number;
};

/** The nights a request may ask to be priced first: dates, at most the longest window. */
export function cleanTouched(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort().slice(0, 800);
}

/**
 * Save the plan. `choice` is the owner's Apply or Skip where the plan needs
 * one (needsActivation); otherwise the rule stays on or off as it is.
 * `userClient` is the signed-in session (save_rule checks its role, and the
 * product events it writes are theirs); `admin` works out the Skip's holds.
 * `held` is what a Skip holds: the days the popup showed, or "all" (every
 * day the rule could act on) when the popup could not work them out.
 */
export async function commitRuleChange(
  userClient: SupabaseClient,
  admin: SupabaseClient,
  plan: RulePlan,
  choice: ActivationChoice | null,
  opts: { at: string; horizonDays: number; touched: string[]; held?: readonly string[] | "all" },
): Promise<CommitResult> {
  if (plan.needsActivation && !choice) {
    throw new RuleSaveError(409, "Choose whether to apply the price adjustments.", "activation_required");
  }
  const activation = plan.needsActivation ? choice! : plan.intent === "create" ? "apply" : "keep";
  let skip: SkipPlan = { marks: [], holdNights: [] };
  if (activation === "skip") {
    skip = await skipPlanForRule(
      admin,
      { hotelId: plan.hotelId, after: plan.after, at: opts.at, horizonDays: opts.horizonDays },
      opts.held ?? "all",
    );
  }
  const { data, error } = await userClient.rpc("save_rule", {
    p_hotel_id: plan.hotelId,
    p_rule_id: plan.ruleId,
    p_is_new: plan.intent === "create",
    p_expected_version: plan.versionBefore,
    p_fields: plan.fields,
    p_activation: activation,
    p_at: opts.at,
    p_touched: opts.touched,
    p_skip_marks: skip.marks,
    p_hold_nights: skip.holdNights,
  });
  if (error) {
    if (isMissingFunctionError(error)) {
      // Deployed ahead of 99_supabase_migration_rule_activation_v1.sql. Apply
      // saves the way the rules store always has; Skip can't be recorded.
      if (activation === "skip") throw new RuleSaveError(503, NEEDS_DATABASE_UPDATE, "needs_migration");
      return legacyCommit(userClient, admin, plan, activation, opts);
    }
    throw saveError(error);
  }
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id ?? plan.ruleId),
    version: Number(row.version ?? plan.versionAfter),
    is_active: Boolean(row.is_active),
    skip_at: row.skip_at != null ? String(row.skip_at) : null,
    marks: skip.marks.length,
    heldDays: skip.holdNights.length,
  };
}

/** A save_rule refusal, in the words the owner sees. */
function saveError(error: { code?: string | null; message?: string | null }): RuleSaveError {
  const message = String(error.message ?? "");
  if (error.code === "40001" || message.includes("rule_changed")) return new RuleSaveError(409, RULE_CHANGED_ELSEWHERE, "rule_changed");
  if (error.code === "23505" || message.includes("rule_exists")) return new RuleSaveError(409, "Try again.", "rule_exists");
  if (error.code === "42501") return new RuleSaveError(403, RULE_CHANGE_FORBIDDEN, "forbidden");
  if (error.code === "P0002" || message.includes("rule_not_found")) return new RuleSaveError(404, "That rule could not be found.");
  // The 40-rule cap (enforce_rule_limit) and the room type checks speak for themselves.
  if (error.code === "23514" || error.code === "22023" || /active rules|room type/i.test(message)) {
    return new RuleSaveError(409, message || "That can't be saved.", "refused");
  }
  return new RuleSaveError(500, "Could not save the rule. Try again in a moment.");
}

/** The save as it was before save_rule: the rules store's writes, then the switch. Apply only. */
async function legacyCommit(
  userClient: SupabaseClient,
  admin: SupabaseClient,
  plan: RulePlan,
  activation: "apply" | "keep" | "off",
  opts: { touched: string[] },
): Promise<CommitResult> {
  const on = activation === "apply" ? true : activation === "off" ? false : undefined;
  if (plan.intent === "create" && plan.draft) {
    const d = plan.draft;
    const created = await createRule(
      {
        id: plan.ruleId,
        rule_name: d.rule_name,
        conditions: ruleConditionToLegacyConditions(d.condition),
        condition: d.condition,
        action: d.action,
        room_types: [],
        signal_room_type_ids: d.signal_room_type_ids,
        affected_room_type_ids: d.affected_room_type_ids,
        undo_on_cancellation: d.undo_on_cancellation,
        is_active: on !== false,
        ...(d.priority !== undefined ? { priority: d.priority } : {}),
        ...(d.dow_mask !== undefined ? { dow_mask: d.dow_mask } : {}),
      },
      userClient,
      plan.hotelId,
    );
    await markNights(admin, plan.hotelId, opts.touched);
    return { id: created.id, version: 1, is_active: on !== false, skip_at: null, marks: 0, heldDays: 0 };
  }
  if (plan.intent === "edit" && plan.draft) {
    const d = plan.draft;
    const behaviour = plan.change === "behaviour";
    const ok = await updateRule(
      plan.ruleId,
      {
        name: d.rule_name,
        undo_on_cancellation: d.undo_on_cancellation,
        ...(behaviour
          ? {
              action: d.action,
              condition: d.condition,
              signal_room_type_ids: d.signal_room_type_ids,
              affected_room_type_ids: d.affected_room_type_ids,
            }
          : {}),
        ...(on !== undefined ? { is_active: on } : {}),
      },
      userClient,
    );
    if (!ok) throw new RuleSaveError(404, "That rule could not be found.");
  } else {
    const { data, error } = await userClient
      .from("pricing_rules")
      .update({ is_active: on ?? true, updated_at: new Date().toISOString() })
      .eq("id", plan.ruleId)
      .eq("hotel_id", plan.hotelId)
      .select("id");
    if (error) throw saveError(error);
    if ((data ?? []).length === 0) throw new RuleSaveError(403, RULE_CHANGE_FORBIDDEN, "forbidden");
  }
  await markNights(admin, plan.hotelId, opts.touched);
  return { id: plan.ruleId, version: plan.versionAfter, is_active: on ?? plan.isActive, skip_at: null, marks: 0, heldDays: 0 };
}

async function markNights(admin: SupabaseClient, hotelId: string, nights: string[]): Promise<void> {
  if (nights.length === 0) return;
  const { error } = await admin.rpc("pricing_mark_many", {
    p_hotels: nights.map(() => hotelId),
    p_dates: nights,
    p_reason: "rule",
  });
  if (error) console.error(JSON.stringify({ fn: "rule-save", step: "mark_nights", hotelId, error: error.message }));
}
