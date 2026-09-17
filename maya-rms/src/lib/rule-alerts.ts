/**
 * The owner's side of "this rule keeps adjusting the same night".
 *
 * The engine files a night under a rule's alert once that rule's current
 * version has 3 or more counted fires on one of its room types
 * (_shared/engine/repeat-alerts.ts, and section 6 of
 * 99_supabase_migration_pickup_event_stacking_v1.sql). The rule keeps firing;
 * the alert is the owner's chance to say otherwise. This module turns those
 * rows into what the banner shows, and holds every sentence it says.
 *
 * House rules for the prose, same as the change log: the owner's rule is the
 * subject, outcome first, no math symbols, and nothing claimed that the code
 * does not do. A simulating hotel reads the same story in the conditional,
 * because nothing it decided reached the PMS.
 */

import { humanDate } from "@/lib/explain";

/** The default floor and ceiling in the schema: nobody has set a real one. */
export const DEFAULT_FLOOR_PRICE = 1;
export const DEFAULT_CEILING_PRICE = 99999.99;

export type RuleAlertChoice = "keep_adjusting" | "stop";

/** One room type the rule has fired on that night, as the night row stores it. */
export type AlertNightRoomType = {
  room_type_id: string;
  fires: number;
  /** The floor for a cut, the ceiling for a raise. null for a room type the run did not load. */
  limit: number | null;
  limit_is_default: boolean | null;
  price: number | null;
};

/** A rule_repeat_alert_nights row, as the route reads it. */
export type AlertNightRow = {
  alert_id: string;
  rule_id: string;
  stay_date: string;
  fire_count: number;
  last_fire_at: string;
  window_days: number | null;
  window_bookings: number | null;
  window_expected: number | null;
  pickup_metric: string | null;
  pickup_threshold: number | null;
  pickup_window_days: number | null;
  pickup_net: number | null;
  room_types: AlertNightRoomType[];
};

/** A rule_repeat_alerts row, as the route reads it. */
export type AlertRow = {
  id: string;
  rule_id: string;
  rule_version: number;
  action_direction: "increase" | "decrease";
  opened_at: string;
};

export type RuleAlertNight = {
  stay_date: string;
  /** "Fri, Nov 14 2026". */
  label: string;
  /** Fires on the busiest room type that night, which is what filed it. */
  fires: number;
  /** Names of the room types it has fired on that night, in the order given. */
  room_types: string[];
  /** What the rule saw at its latest fire, in plain words. */
  why: string[];
  /** Where the price can end up if it carries on, or null when no limit is known. */
  limit_line: string | null;
  /** True when the limit in the rule's direction is still MAYA's default. */
  limit_is_default: boolean;
};

export type RuleAlert = {
  id: string;
  rule_id: string;
  rule_name: string;
  direction: "increase" | "decrease";
  /** One line naming the rule, what it did and how often. */
  headline: string;
  /** One line on what happens if nobody answers. */
  consequence: string;
  nights: RuleAlertNight[];
};

export type RuleAlertsView = {
  alerts: RuleAlert[];
  /** The symbol every price in these sentences is written with. */
  currency_symbol: string;
  /** The caller may answer; below Revenue Manager the banner is read-only. */
  can_manage: boolean;
  /** The hotel is still simulating, so every sentence is in the conditional. */
  simulation: boolean;
};

function money(value: number, symbol: string): string {
  return `${symbol}${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dayWord(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

function nightWord(n: number): string {
  return n === 1 ? "1 night" : `${n} nights`;
}

function listWords(items: string[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "cut" / "raised", in the tense a simulating hotel can believe. */
export function alertVerb(direction: "increase" | "decrease", simulation: boolean): string {
  if (simulation) return direction === "increase" ? "would have raised" : "would have cut";
  return direction === "increase" ? "has raised" : "has cut";
}

/**
 * "\"Slow-date rescue\" has cut 4 nights, 3 times each." One night names the
 * night; several say how far the range goes, because that is the number the
 * owner is being asked about.
 */
export function alertHeadline(input: {
  ruleName: string;
  direction: "increase" | "decrease";
  nights: { label: string; fires: number }[];
  simulation: boolean;
}): string {
  const verb = alertVerb(input.direction, input.simulation);
  const counts = input.nights.map((n) => n.fires);
  const low = Math.min(...counts);
  const high = Math.max(...counts);
  if (input.nights.length === 1) {
    return `"${input.ruleName}" ${verb} ${input.nights[0].label} ${low} times.`;
  }
  const howOften = low === high ? `${low} times each` : `${low} to ${high} times each`;
  return `"${input.ruleName}" ${verb} ${nightWord(input.nights.length)}, ${howOften}.`;
}

/** What happens while nobody answers: the rule carries on. */
export function alertConsequence(direction: "increase" | "decrease", simulation: boolean): string {
  const verb = direction === "increase" ? "raising" : "cutting";
  return simulation
    ? `It would keep ${verb} these nights until you stop it.`
    : `It keeps ${verb} these nights until you stop it.`;
}

function bookingsPhrase(n: number): string {
  if (n < 0) return "more bookings cancelled than came in";
  if (n === 0) return "no bookings came in";
  return n === 1 ? "1 booking came in" : `${n} bookings came in`;
}

function expectedPhrase(n: number): string {
  return n < 1 ? "almost none" : `about ${Math.round(n)}`;
}

function unitsPhrase(n: number): string {
  return Math.abs(n) === 1 ? `${n} room night` : `${n} room nights`;
}

/**
 * What the rule was looking at when it last fired, one short sentence per
 * signal. A booking speed rule names the bookings it measured against the
 * pace similar nights set; a pickup rule names the pickup against the mark
 * the owner typed. A rule with both says both.
 */
export function nightWhy(night: AlertNightRow, currencySymbol: string): string[] {
  const out: string[] = [];
  if (night.window_days != null && night.window_bookings != null) {
    const measured = `In the ${dayWord(night.window_days)} it measured, ${bookingsPhrase(night.window_bookings)}.`;
    out.push(
      night.window_expected != null
        ? `${measured} A night like this usually has ${expectedPhrase(night.window_expected)} by then.`
        : measured,
    );
  }
  if (night.pickup_threshold != null && night.pickup_window_days != null && night.pickup_net != null) {
    const revenue = night.pickup_metric === "revenue";
    const got = revenue ? money(night.pickup_net, currencySymbol) : unitsPhrase(night.pickup_net);
    const mark = revenue ? money(night.pickup_threshold, currencySymbol) : String(night.pickup_threshold);
    out.push(
      `Pickup over the last ${dayWord(night.pickup_window_days)} came to ${got}, against the ${mark} you set.`,
    );
  }
  return out;
}

/** The limit a night's price is heading for, and whether it is still the default. */
export function nightLimit(
  night: AlertNightRow,
  direction: "increase" | "decrease",
  roomTypeNames: Map<string, string>,
): { limit: number; names: string[]; isDefault: boolean } | null {
  const known = night.room_types.filter((rt) => rt.limit != null);
  if (known.length === 0) return null;
  const cut = direction === "decrease";
  // A cut heads for the lowest floor of the room types it is on; a raise for
  // the highest ceiling. That is as far as this night's price can travel.
  const limit = cut
    ? Math.min(...known.map((rt) => rt.limit as number))
    : Math.max(...known.map((rt) => rt.limit as number));
  const at = known.filter((rt) => rt.limit === limit);
  const names = at.map((rt) => roomTypeNames.get(rt.room_type_id) ?? "this room type");
  const isDefault = at.some((rt) =>
    rt.limit_is_default != null
      ? rt.limit_is_default
      : cut
        ? rt.limit === DEFAULT_FLOOR_PRICE
        : rt.limit === DEFAULT_CEILING_PRICE,
  );
  return { limit, names, isDefault };
}

/** "If it keeps cutting, the price can fall to your $80.00 floor for Standard." */
export function nightLimitLine(
  limit: { limit: number; names: string[]; isDefault: boolean },
  direction: "increase" | "decrease",
  currencySymbol: string,
): string {
  const cut = direction === "decrease";
  const word = cut ? "floor" : "ceiling";
  const names = listWords(limit.names);
  const amount = money(limit.limit, currencySymbol);
  if (limit.isDefault) {
    return cut
      ? `Your ${word} for ${names} is still MAYA's ${amount} default, so the price can fall that far.`
      : `Your ${word} for ${names} is still MAYA's ${amount} default, so the price can climb that far.`;
  }
  return cut
    ? `If it keeps cutting, the price can fall to your ${amount} ${word} for ${names}.`
    : `If it keeps raising, the price can climb to your ${amount} ${word} for ${names}.`;
}

/** Behind the "?" beside the two answers. */
export const ALERT_CHOICE_HELP: { label: string; title: string; lines: string[] } = {
  label: "What each answer does",
  title: "Your two answers",
  lines: [
    "Keep adjusting: the rule carries on as it is, and MAYA stops asking about that night.",
    "Stop for this night: the rule makes no more changes on that night. What it already changed stays.",
    "Either way, your other rules keep working on these nights, and an edit to this rule starts it fresh.",
  ],
};

/** Behind the "?" on a limit that is still MAYA's default. */
export function alertLimitHelp(currencySymbol: string): { label: string; title: string; lines: string[] } {
  return {
    label: "About this limit",
    title: "Floors and ceilings",
    lines: [
      "A floor is the lowest price MAYA will publish for a room type, and a ceiling is the highest.",
      `MAYA starts every room type at ${money(DEFAULT_FLOOR_PRICE, currencySymbol)} and ${money(DEFAULT_CEILING_PRICE, currencySymbol)}, which stop nothing in practice.`,
      "Ask MAYA for help on the Rules tab: it can suggest a floor and a ceiling from your own rates, and you accept or change each one.",
    ],
  };
}

/** The button offered beside a default limit. */
export function limitActionLabel(direction: "increase" | "decrease"): string {
  return direction === "increase" ? "Ask MAYA for a ceiling" : "Ask MAYA for a floor";
}

/**
 * Every open alert as the banner shows it: one card per rule, its nights
 * oldest first. Nights whose rule is unknown, or that the owner has already
 * answered, are left out by the caller's read.
 */
export function buildRuleAlerts(input: {
  alerts: AlertRow[];
  nights: AlertNightRow[];
  ruleNames: Map<string, string>;
  roomTypeNames: Map<string, string>;
  currencySymbol: string;
  simulation: boolean;
}): RuleAlert[] {
  const byAlert = new Map<string, AlertNightRow[]>();
  for (const night of input.nights) {
    const list = byAlert.get(night.alert_id) ?? [];
    list.push(night);
    byAlert.set(night.alert_id, list);
  }

  const out: RuleAlert[] = [];
  for (const alert of input.alerts) {
    const rows = (byAlert.get(alert.id) ?? [])
      .slice()
      .sort((a, b) => (a.stay_date < b.stay_date ? -1 : a.stay_date > b.stay_date ? 1 : 0));
    // An alert with no night left to answer is bookkeeping the next run will
    // resolve; there is nothing to put in front of anyone.
    if (rows.length === 0) continue;
    const ruleName = input.ruleNames.get(alert.rule_id);
    if (!ruleName) continue;

    const nights: RuleAlertNight[] = rows.map((night) => {
      const limit = nightLimit(night, alert.action_direction, input.roomTypeNames);
      return {
        stay_date: night.stay_date,
        label: humanDate(night.stay_date),
        fires: night.fire_count,
        room_types: night.room_types
          .map((rt) => input.roomTypeNames.get(rt.room_type_id))
          .filter((n): n is string => !!n),
        why: nightWhy(night, input.currencySymbol),
        limit_line: limit ? nightLimitLine(limit, alert.action_direction, input.currencySymbol) : null,
        limit_is_default: limit?.isDefault ?? false,
      };
    });

    out.push({
      id: alert.id,
      rule_id: alert.rule_id,
      rule_name: ruleName,
      direction: alert.action_direction,
      headline: alertHeadline({
        ruleName,
        direction: alert.action_direction,
        nights,
        simulation: input.simulation,
      }),
      consequence: alertConsequence(alert.action_direction, input.simulation),
      nights,
    });
  }
  return out.sort((a, b) => a.rule_name.localeCompare(b.rule_name));
}
