/**
 * PIE's rules and price limits as MAYA rules, floors and ceilings.
 *
 * How the two compare (src/lib/engine/pricing.ts applyAdjustments, and
 * stacking-equivalence.test.ts, which runs the real engine on a grid of
 * occupancies and days against a small PIE simulator):
 *
 *   - PIE applies every triggered rule to the current rate, one on top of
 *     the other: a percent multiplies, an amount adds. MAYA's standard
 *     (occupancy and days-before-arrival) rules do exactly the same: every
 *     rule that is true is on, percents compound and amounts add, and the
 *     floor and ceiling hold the result once, at the end. So each PIE rule
 *     becomes one MAYA rule with the same condition and amount, and the
 *     prices match for every occupancy and day.
 *   - The one order question: a percent and an amount on the same night give
 *     a different price depending on which goes first. MAYA applies its
 *     standard rules in id order, and the ids here follow the screenshot's
 *     order; PIE applies them in the order they were triggered, which the
 *     list does not show. Such rules are flagged.
 *   - MAYA's comparisons are strict ("more than", "less than"), like PIE's
 *     "greater than" and "lower than". "or equal to" is matched to within
 *     0.01%, and "equal to" can't be matched.
 *   - "booking A-B days in advance" is days before arrival from A to B, both
 *     included, "today" being 0. MAYA's rule has one days-before-arrival
 *     condition, so a window bounded at both ends (A above 0, B inside the
 *     pricing window) becomes two rules: one from A days, and one that takes
 *     the change back off beyond B days (a percent's exact inverse, to 4
 *     places; an amount's opposite).
 *   - PIE's rounding is in each rule's detail, not the list, so it is not
 *     read or imported.
 */

import { defaultSignalIds, ruleConditionToLegacyConditions } from "@/lib/rule-form";
import type { RuleAction, RuleCondition, RuleConditionValue } from "@/types/domain";
import type { PieDescription } from "./description";
import type { MergedRead, PieRule } from "./merge";
import { nameKey, parsePieDate } from "./text";

/**
 * MAYA's pricing window, in nights (DEFAULT_PRICING_HORIZON_DAYS in
 * supabase/functions/_shared/pms/pricing-window.ts; map.test.ts holds the
 * two together). A booking window reaching its last night has no upper
 * bound in MAYA.
 */
export const PRICING_WINDOW_NIGHTS = 396;

export type MayaRoomType = {
  id: string;
  name: string;
  counts_as_room?: boolean | null;
  floor_price?: number | null;
  ceiling_price?: number | null;
};

/**
 * A MAYA rule the import makes: the body POST /api/rules takes from the rule
 * builder, with the id it is saved under and, for a PIE rule with dates, the
 * nights it covers.
 */
export type ImportDraft = {
  id: string;
  rule_name: string;
  condition: RuleCondition;
  conditions: Record<string, RuleConditionValue>;
  action: RuleAction;
  room_types: string[];
  signal_room_type_ids: string[];
  affected_room_type_ids: string[];
  undo_on_cancellation: boolean;
  start_date: string | null;
  end_date: string | null;
};

export type ImportItem = {
  key: string;
  pie: {
    name: string;
    description: string;
    active: boolean | null;
    mode: "auto" | "manual" | null;
    typeText: string;
    startDate: string;
    endDate: string;
  };
  /**
   * ready: can be created as it is. needs_edit: open it in the rule builder
   * first (cut off, or room types to pick). not_imported: MAYA has no rule
   * like it, or it could not be read.
   */
  status: "ready" | "needs_edit" | "not_imported";
  /** Why it is not imported, or what to fix: one short line. */
  reason: string | null;
  /** Worth knowing before creating it. */
  notes: string[];
  /** The MAYA rules it becomes (none when not imported). */
  drafts: ImportDraft[];
  /** Created on, as its switch in PIE was. */
  on: boolean;
  /** Ticked when the review opens. */
  ticked: boolean;
};

export type LimitChange = {
  roomTypeId: string;
  name: string;
  floor: number;
  ceiling: number;
  current: { floor: number | null; ceiling: number | null };
  /** Its own row in PIE's table, or PIE's minimum and maximum for every type without one. */
  from: "own" | "master";
  /** Why it can't be set as read, or null. */
  problem: string | null;
};

export type LimitsPlan = { changes: LimitChange[]; unmatched: string[] };

export type ImportPlan = { items: ImportItem[]; limits: LimitsPlan };

/* ── Copy ─────────────────────────────────────────────────────── */

export const PIE_COPY = {
  manual: "Manual in PIE, so it only suggested prices. In MAYA it changes them (nothing is sent while your property is in simulation).",
  restriction: "Not imported: MAYA doesn't set restrictions.",
  compset: "Not imported: MAYA doesn't price from competitors' rates.",
  otherType: "Not imported: MAYA has no rule like it.",
  unreadable: "Couldn't read its description. Add it yourself in the rule builder.",
  equalTo: "Not imported: MAYA can't match one exact occupancy.",
  cutOff: "Cut off at the bottom of the screenshot. Add a screenshot that shows it whole, or finish it in the rule builder.",
  switchUnknown: "Its switch couldn't be seen, so it's added off.",
  orEqual: (op: "more" | "less", n: string) => `PIE's "or equal to" becomes ${op} than ${n}%.`,
  split: (to: number, percent: boolean) =>
    `A MAYA rule has one booking window, so a second rule takes the change back off beyond ${to} days.${percent ? " A price can come out a cent different from PIE's." : ""}`,
  mixed: "With a % rule on the same night the price can differ a little from PIE's, which applies them in the order they were triggered.",
  scopeUnknown: "PIE reads only some room types' occupancy here. Pick them in the rule builder.",
  scopeUnmatched: (names: string[]) => `No room type called ${names.map((n) => `"${n}"`).join(", ")}. Pick them in the rule builder.`,
  datesUnreadable: "Its dates couldn't be read. Add it yourself in the rule builder.",
  datesAmbiguous: "Its dates were read month first. Check them before ticking it.",
  datesPassed: "Its dates have passed.",
  rounding: "PIE's rounding isn't shown in the list, so it isn't imported.",
} as const;

/* ── Rule ids ─────────────────────────────────────────────────── */

/**
 * Ids for the drafts of one import, in the order given: MAYA applies its
 * standard rules in id order (the ids' bytes), so these sort the way the
 * screenshot lists the rules. Random apart from the order.
 */
export function orderedIds(count: number, random: () => string = () => crypto.randomUUID()): string[] {
  const base = random().toLowerCase();
  if (count > 256) return Array.from({ length: count }, () => random().toLowerCase());
  return Array.from({ length: count }, (_, i) => `${base.slice(0, 6)}${i.toString(16).padStart(2, "0")}${base.slice(8)}`);
}

/* ── Amounts and conditions ───────────────────────────────────── */

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** A PIE amount as the rule builder's action: signed by its direction. */
export function actionOf(kind: "percent" | "fixed", direction: "raise" | "lower", amount: number): RuleAction {
  const signed = round4(direction === "raise" ? amount : -amount);
  return kind === "percent" ? { adjust_rate_percent: signed } : { adjust_rate_dollars: signed };
}

/**
 * The adjustment that takes `amount` back off: an amount's opposite, or the
 * percent that returns a raised (or lowered) price to where it was, to 4
 * places. null for a 100% cut, which nothing undoes.
 */
export function inverseOf(kind: "percent" | "fixed", direction: "raise" | "lower", amount: number): { direction: "raise" | "lower"; amount: number } | null {
  if (kind === "fixed") return { direction: direction === "raise" ? "lower" : "raise", amount };
  if (direction === "raise") return { direction: "lower", amount: round4((100 * amount) / (100 + amount)) };
  if (amount >= 100) return null;
  return { direction: "raise", amount: round4((100 * amount) / (100 - amount)) };
}

const pct = (n: number) => String(Math.round(n * 100) / 100);

/** PIE's occupancy compare as MAYA's: a fraction with 4 places, and a note when it is not exact. */
function occupancyOf(rule: PieDescription): { op: "gt" | "lt"; threshold: number; note: string | null } | null {
  switch (rule.occupancyOp) {
    case "gt":
      return { op: "gt", threshold: round4(rule.threshold / 100), note: null };
    case "lt":
      return { op: "lt", threshold: round4(rule.threshold / 100), note: null };
    case "gte": {
      const t = Math.max(0, rule.threshold - 0.01);
      return { op: "gt", threshold: round4(t / 100), note: PIE_COPY.orEqual("more", pct(t)) };
    }
    case "lte": {
      const t = Math.min(100, rule.threshold + 0.01);
      return { op: "lt", threshold: round4(t / 100), note: PIE_COPY.orEqual("less", pct(t)) };
    }
    case "eq":
      return null;
  }
}

/**
 * The days-before-arrival conditions a window becomes: none, one, or two
 * (the second taking the change back off beyond `to`).
 */
export function windowConditions(
  window: PieDescription["window"],
  nights: number = PRICING_WINDOW_NIGHTS,
): { first: Pick<RuleCondition, "dta_operator" | "dta_threshold_days"> | null; undoBeyond: number | null } {
  if (!window) return { first: null, undoBeyond: null };
  const lower = window.from > 0;
  // The last night MAYA prices is nights - 1 days away.
  const upper = window.to < nights - 1;
  if (lower && upper) return { first: { dta_operator: "gt", dta_threshold_days: window.from - 1 }, undoBeyond: window.to };
  if (lower) return { first: { dta_operator: "gt", dta_threshold_days: window.from - 1 }, undoBeyond: null };
  if (upper) return { first: { dta_operator: "lt", dta_threshold_days: window.to + 1 }, undoBeyond: null };
  return { first: null, undoBeyond: null };
}

/* ── Room types ───────────────────────────────────────────────── */

const counting = (rt: MayaRoomType) => rt.counts_as_room !== false;

type Sets = { signal: string[]; affected: string[] };

/**
 * The room type sets a rule reads and changes: the property's rooms for
 * PIE's overall occupancy (what the rule builder starts on), the named
 * types together for combined, each named type on its own for individual.
 */
function roomTypeSets(rule: PieDescription, roomTypes: readonly MayaRoomType[]): { sets: Sets[] } | { unmatched: string[] } | { unknown: true } {
  const isCounting = (id: string) => counting(roomTypes.find((r) => r.id === id) ?? { id, name: "" });
  if (rule.scope.kind === "overall") {
    const rooms = roomTypes.filter(counting).map((r) => r.id);
    const affected = rooms.length > 0 ? rooms : roomTypes.map((r) => r.id);
    return { sets: [{ signal: defaultSignalIds(affected, isCounting), affected }] };
  }
  if (rule.scope.names.length === 0) return { unknown: true };
  const byName = new Map(roomTypes.map((r) => [nameKey(r.name), r]));
  const found = rule.scope.names.map((n) => byName.get(nameKey(n)));
  const unmatched = rule.scope.names.filter((_, i) => !found[i]);
  if (unmatched.length > 0) return { unmatched };
  const ids = (found as MayaRoomType[]).map((r) => r.id);
  if (rule.scope.kind === "individual") return { sets: ids.map((id) => ({ signal: [id], affected: [id] })) };
  return { sets: [{ signal: defaultSignalIds(ids, isCounting), affected: ids }] };
}

/* ── One rule ─────────────────────────────────────────────────── */

type Built = Omit<ImportItem, "drafts"> & { drafts: Omit<ImportDraft, "id">[] };

function draftOf(
  name: string,
  condition: RuleCondition,
  action: RuleAction,
  sets: Sets,
  roomTypes: readonly MayaRoomType[],
  dates: { start: string | null; end: string | null },
): Omit<ImportDraft, "id"> {
  return {
    rule_name: name,
    condition,
    conditions: ruleConditionToLegacyConditions(condition),
    action,
    room_types: roomTypes.filter((r) => sets.affected.includes(r.id)).map((r) => r.name),
    signal_room_type_ids: sets.signal,
    affected_room_type_ids: sets.affected,
    undo_on_cancellation: true,
    start_date: dates.start,
    end_date: dates.end,
  };
}

function buildItem(rule: PieRule, roomTypes: readonly MayaRoomType[], today: string, index: number): Built {
  const name = rule.name.trim() || `PIE rule ${index + 1}`;
  const base: Built = {
    key: rule.key,
    pie: {
      name,
      description: rule.description,
      active: rule.active,
      mode: rule.mode,
      typeText: rule.typeText,
      startDate: rule.startDate,
      endDate: rule.endDate,
    },
    status: "not_imported",
    reason: null,
    notes: [],
    drafts: [],
    on: rule.active === true,
    ticked: false,
  };

  // A rate rule's description says what it is even when TYPE was misread.
  const isRateRule = rule.parsed.ok || rule.parsed.reason !== "not_rate";
  if (rule.type === "restriction") return { ...base, reason: PIE_COPY.restriction };
  if (rule.type === "compset") return { ...base, reason: PIE_COPY.compset };
  if (rule.type === "other" && !isRateRule) return { ...base, reason: PIE_COPY.otherType };
  if (!rule.parsed.ok) {
    if (rule.cutOff) return { ...base, status: "needs_edit", reason: PIE_COPY.cutOff };
    return { ...base, reason: rule.parsed.reason === "not_rate" ? PIE_COPY.otherType : PIE_COPY.unreadable };
  }

  const pie = rule.parsed.rule;
  const occ = occupancyOf(pie);
  if (!occ) return { ...base, reason: PIE_COPY.equalTo };
  const notes: string[] = [];
  if (rule.mode === "manual") notes.push(PIE_COPY.manual);
  if (rule.active === null) notes.push(PIE_COPY.switchUnknown);
  if (occ.note) notes.push(occ.note);

  // Dates.
  const start = parsePieDate(rule.startDate);
  const end = parsePieDate(rule.endDate);
  if (start.kind === "unreadable" || end.kind === "unreadable") {
    return { ...base, notes, reason: PIE_COPY.datesUnreadable };
  }
  const dates = { start: start.kind === "date" ? start.date : null, end: end.kind === "date" ? end.date : null };
  let datesOk = true;
  if ((start.kind === "date" && start.ambiguous) || (end.kind === "date" && end.ambiguous)) {
    notes.push(PIE_COPY.datesAmbiguous);
    datesOk = false;
  }
  if (dates.start && dates.end && dates.start > dates.end) {
    return { ...base, notes, reason: PIE_COPY.datesUnreadable };
  }
  if (dates.end && dates.end < today) {
    notes.push(PIE_COPY.datesPassed);
    datesOk = false;
  }

  // Room types.
  const scope = roomTypeSets(pie, roomTypes);
  let sets: Sets[];
  let reason: string | null = null;
  if ("sets" in scope) sets = scope.sets;
  else {
    // Built on the whole property, for the owner to narrow in the builder.
    sets = (roomTypeSets({ ...pie, scope: { kind: "overall" } }, roomTypes) as { sets: Sets[] }).sets;
    reason = "unknown" in scope ? PIE_COPY.scopeUnknown : PIE_COPY.scopeUnmatched(scope.unmatched);
  }

  // Window and amount.
  const win = windowConditions(pie.window);
  const condition: RuleCondition = {
    occupancy_operator: occ.op,
    occupancy_threshold: occ.threshold,
    ...(win.first ?? {}),
  };
  const drafts: Omit<ImportDraft, "id">[] = [];
  const undo = win.undoBeyond !== null ? inverseOf(pie.kind, pie.direction, pie.amount) : null;
  if (win.undoBeyond !== null && !undo) return { ...base, notes, reason: PIE_COPY.unreadable };
  for (const set of sets) {
    const suffix = sets.length > 1 ? ` (${roomTypes.find((r) => r.id === set.affected[0])?.name ?? ""})` : "";
    drafts.push(draftOf(`${name}${suffix}`, condition, actionOf(pie.kind, pie.direction, pie.amount), set, roomTypes, dates));
    if (win.undoBeyond !== null && undo) {
      drafts.push(
        draftOf(
          `${name}${suffix}, beyond ${win.undoBeyond} days`,
          { occupancy_operator: occ.op, occupancy_threshold: occ.threshold, dta_operator: "gt", dta_threshold_days: win.undoBeyond },
          actionOf(pie.kind, undo.direction, undo.amount),
          set,
          roomTypes,
          dates,
        ),
      );
    }
  }
  if (win.undoBeyond !== null) notes.push(PIE_COPY.split(win.undoBeyond, pie.kind === "percent"));

  if (rule.cutOff) return { ...base, notes, drafts, status: "needs_edit", reason: PIE_COPY.cutOff };
  if (!rule.parsed.complete) return { ...base, notes, drafts, status: "needs_edit", reason: PIE_COPY.cutOff };
  if (reason) return { ...base, notes, drafts, status: "needs_edit", reason };
  return { ...base, notes, drafts, status: "ready", ticked: datesOk };
}

/* ── Mixed percents and amounts ───────────────────────────────── */

type Span = { lo: number; hi: number };
const overlaps = (a: Span, b: Span) => a.lo < b.hi && b.lo < a.hi;

/** The occupancies (0 to 1) and days a draft's condition holds on, as open spans. */
function spans(d: Pick<ImportDraft, "condition">): { occ: Span; days: Span } {
  const c = d.condition;
  const occ =
    c.occupancy_operator === "gt"
      ? { lo: Number(c.occupancy_threshold), hi: 1.0001 }
      : c.occupancy_operator === "lt"
        ? { lo: -0.0001, hi: Number(c.occupancy_threshold) }
        : { lo: -0.0001, hi: 1.0001 };
  const days =
    c.dta_operator === "gt"
      ? { lo: Number(c.dta_threshold_days) + 0.5, hi: Infinity }
      : c.dta_operator === "lt"
        ? { lo: -1, hi: Number(c.dta_threshold_days) - 0.5 }
        : { lo: -1, hi: Infinity };
  return { occ, days };
}

function datesOverlap(a: Pick<ImportDraft, "start_date" | "end_date">, b: Pick<ImportDraft, "start_date" | "end_date">): boolean {
  const aStart = a.start_date ?? "0000-01-01";
  const aEnd = a.end_date ?? "9999-12-31";
  const bStart = b.start_date ?? "0000-01-01";
  const bEnd = b.end_date ?? "9999-12-31";
  return aStart <= bEnd && bStart <= aEnd;
}

/** Whether two drafts can both be on for the same night and room type. */
export function canApplyTogether(a: Omit<ImportDraft, "id">, b: Omit<ImportDraft, "id">): boolean {
  const sa = spans(a);
  const sb = spans(b);
  return (
    overlaps(sa.occ, sb.occ) &&
    overlaps(sa.days, sb.days) &&
    datesOverlap(a, b) &&
    a.affected_room_type_ids.some((id) => b.affected_room_type_ids.includes(id))
  );
}

const isPercent = (d: Pick<ImportDraft, "action">) => d.action.adjust_rate_percent !== undefined;

/* ── The whole import ─────────────────────────────────────────── */

/**
 * Every PIE rule as MAYA rules, in the screenshot's order, and the price
 * limits as floors and ceilings. `today` is the property's date (for dates
 * that have passed); `random` makes ids (tests pass their own).
 */
export function planImport(
  merged: MergedRead,
  roomTypes: readonly MayaRoomType[],
  opts: { today: string; random?: () => string },
): ImportPlan {
  const built = merged.rules.map((rule, i) => buildItem(rule, roomTypes, opts.today, i));

  // A percent and an amount that can be on together: PIE's order decides.
  for (const item of built) {
    if (item.drafts.length === 0) continue;
    const mixed = built.some(
      (other) =>
        other !== item &&
        item.drafts.some((d) => other.drafts.some((o) => isPercent(d) !== isPercent(o) && canApplyTogether(d, o))),
    );
    if (mixed) item.notes.push(PIE_COPY.mixed);
  }

  const ids = orderedIds(
    built.reduce((n, b) => n + b.drafts.length, 0),
    opts.random,
  );
  let next = 0;
  const items: ImportItem[] = built.map((b) => ({ ...b, drafts: b.drafts.map((d) => ({ ...d, id: ids[next++] })) }));
  return { items, limits: planLimits(merged, roomTypes) };
}

/**
 * PIE's limits as each room type's floor and ceiling: its own row in the
 * PRICE LIMITS BY ACCOMMODATION TYPE table (matched by name, case and spaces
 * aside), or else PIE's Minimum and Maximum Price. Only changes are listed.
 */
export function planLimits(merged: Pick<MergedRead, "limits" | "master">, roomTypes: readonly MayaRoomType[]): LimitsPlan {
  const own = new Map(merged.limits.map((l) => [nameKey(l.name), l]));
  const known = new Set(roomTypes.map((r) => nameKey(r.name)));
  const unmatched = merged.limits.filter((l) => !known.has(nameKey(l.name))).map((l) => l.name);
  const changes: LimitChange[] = [];
  for (const rt of roomTypes) {
    const row = own.get(nameKey(rt.name));
    const source = row ?? merged.master;
    if (!source) continue;
    const current = { floor: rt.floor_price ?? null, ceiling: rt.ceiling_price ?? null };
    const floor = source.min ?? current.floor;
    const ceiling = source.max ?? current.ceiling;
    if (floor === null || ceiling === null) continue;
    if (floor === current.floor && ceiling === current.ceiling) continue;
    const problem =
      !(floor > 0) ? "A floor has to be above 0." : ceiling < floor ? "Its minimum is above its maximum." : null;
    changes.push({ roomTypeId: rt.id, name: rt.name, floor, ceiling, current, from: row ? "own" : "master", problem });
  }
  return { changes, unmatched };
}
