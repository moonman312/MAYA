/**
 * The server's half of an import from PIE: the request's rules and limits
 * checked the way the rule builder's are, and planned as new rules (the same
 * planRuleChange the builder's save and the activation popup's dry runs
 * use), so the rules previewed together are the rules saved together.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LimitOverrides } from "@/lib/rule-preview";
import { RuleSaveError, isUuid, parseDraft, planRuleChange, type RulePlan } from "@/lib/rule-save";

/** The most active rules a property may have (enforce_rule_limit, 99_supabase_migration_limits_and_scale_v1.sql). */
export const ACTIVE_RULE_CAP = 40;

/** The most rules one import may create. */
export const IMPORT_RULE_LIMIT = 80;

/**
 * A rule of the import, planned as a new rule; or `existing` when a rule
 * with its id is already on this property (an earlier try of the same
 * import saved it before stopping), which is left as it is.
 */
export type ImportedRule = { id: string; on: boolean } & ({ existing: false; plan: RulePlan } | { existing: true; plan: null });

export type LimitInput = { roomTypeId: string; floor: number; ceiling: number };

/** What the popup's calendar and the save both read from a request. */
export type ImportRequest = { rules: ImportedRule[]; limits: LimitInput[] };

/** The words for an import that would go past the cap. */
export function capMessage(active: number, adding: number): string {
  const over = active + adding - ACTIVE_RULE_CAP;
  return `That makes ${active + adding} rules on, and a property can have ${ACTIVE_RULE_CAP}. Untick ${over} to fit.`;
}

/**
 * A request's rules (`rules`: the builder's draft with its `id` and `on`)
 * and limits (`limits`: room type, floor, ceiling), checked and planned.
 * Throws RuleSaveError (400) for anything the builder would refuse.
 */
export async function planImportRequest(
  admin: SupabaseClient,
  hotelId: string,
  body: Record<string, unknown>,
  at: string,
): Promise<ImportRequest> {
  const raw = Array.isArray(body.rules) ? (body.rules as unknown[]) : null;
  if (!raw || raw.length > IMPORT_RULE_LIMIT) throw new RuleSaveError(400, "Invalid payload.");
  const ids = new Set<string>();
  const rules: ImportedRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") throw new RuleSaveError(400, "Invalid payload.");
    const r = item as Record<string, unknown>;
    if (!isUuid(r.id) || ids.has(String(r.id).toLowerCase())) throw new RuleSaveError(400, "Invalid payload.");
    const ruleId = String(r.id).toLowerCase();
    ids.add(ruleId);
    const draft = parseDraft(r);
    const { data: there, error } = await admin.from("pricing_rules").select("id, hotel_id, is_active").eq("id", ruleId).maybeSingle();
    if (error) throw new Error(`Could not check the rule: ${error.message}`);
    if (there && String(there.hotel_id) !== hotelId) throw new RuleSaveError(409, "Try again.", "rule_exists");
    if (there) {
      rules.push({ id: ruleId, on: Boolean(there.is_active), existing: true, plan: null });
      continue;
    }
    const plan = await planRuleChange(admin, hotelId, { intent: "create", ruleId, draft, at });
    rules.push({ id: ruleId, on: r.on === true, existing: false, plan });
  }
  const limits = await parseLimits(admin, hotelId, body.limits);
  if (rules.length === 0 && limits.length === 0) throw new RuleSaveError(400, "Pick at least one rule or limit.");
  return { rules, limits };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The limits in a request: this property's room types, a floor above 0, a ceiling at or above it. */
async function parseLimits(admin: SupabaseClient, hotelId: string, value: unknown): Promise<LimitInput[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 200) throw new RuleSaveError(400, "Invalid payload.");
  const out: LimitInput[] = [];
  for (const item of value) {
    const l = (item ?? {}) as Record<string, unknown>;
    const floor = Number(l.floor);
    const ceiling = Number(l.ceiling);
    if (!isUuid(l.roomTypeId) || !Number.isFinite(floor) || !Number.isFinite(ceiling)) throw new RuleSaveError(400, "Invalid payload.");
    if (!(round2(floor) > 0)) throw new RuleSaveError(400, "A floor has to be above 0.");
    if (round2(ceiling) < round2(floor)) throw new RuleSaveError(400, "A ceiling can't be under its floor.");
    if (ceiling > 99_999_999) throw new RuleSaveError(400, "That ceiling is too high.");
    if (out.some((o) => o.roomTypeId === l.roomTypeId)) throw new RuleSaveError(400, "Invalid payload.");
    out.push({ roomTypeId: String(l.roomTypeId), floor: round2(floor), ceiling: round2(ceiling) });
  }
  if (out.length === 0) return out;
  const { data, error } = await admin.from("room_types").select("id").eq("hotel_id", hotelId).in(
    "id",
    out.map((l) => l.roomTypeId),
  );
  if (error) throw new Error(`Could not check room types: ${error.message}`);
  const own = new Set((data ?? []).map((r) => String(r.id)));
  if (out.some((l) => !own.has(l.roomTypeId))) throw new RuleSaveError(400, "Pick a room type on this property.");
  return out;
}

/** The limits as the dry runs take them. */
export function limitOverrides(limits: readonly LimitInput[]): LimitOverrides | undefined {
  if (limits.length === 0) return undefined;
  return Object.fromEntries(limits.map((l) => [l.roomTypeId, { floor_price: l.floor, ceiling_price: l.ceiling }]));
}

/** How many rules are on now. */
export async function activeRuleCount(admin: SupabaseClient, hotelId: string): Promise<number> {
  const { count, error } = await admin
    .from("pricing_rules")
    .select("id", { count: "exact", head: true })
    .eq("hotel_id", hotelId)
    .eq("is_active", true);
  if (error) throw new Error(`Could not count rules: ${error.message}`);
  return count ?? 0;
}

/** Refuses an import that would go past the cap (409 "cap"), before anything is saved. */
export async function checkCap(admin: SupabaseClient, hotelId: string, adding: number): Promise<void> {
  if (adding === 0) return;
  const active = await activeRuleCount(admin, hotelId);
  if (active + adding > ACTIVE_RULE_CAP) throw new RuleSaveError(409, capMessage(active, adding), "cap");
}
