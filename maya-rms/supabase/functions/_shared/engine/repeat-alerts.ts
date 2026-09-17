/**
 * Owner alerts when an event rule keeps adjusting the same night.
 *
 * Deno-portable copy of src/lib/engine/repeat-alerts.ts (import paths only differ).
 *
 * Tables and their meaning: 99_supabase_migration_pickup_event_stacking_v1.sql
 * section 6. In short: once a rule's current version has 3 or more counted
 * fires on one of its room types on a night (open, or taken off for
 * cancellations), the night is filed under the rule's open alert with the
 * numbers behind its latest fire, and the rule keeps firing. The owner
 * answers per night: keep_adjusting (no more alerts for that rule and night)
 * or stop (no more fires from that rule on that night). Both answers belong
 * to the rule version they were given on: an edit starts the rule fresh.
 *
 * The engine reads the answers before it fires (isStoppedOnNight) and, after
 * prices are published, files and updates nights and closes the ones that no
 * longer need an answer (updateRepeatAlerts). A night closed because a price
 * someone set took its fires off opens again if the rule stacks its way back
 * to three; only a passed night or an edit ends one for good. The alert
 * tables take writes
 * from the service role only, so a run under a signed-in session (the
 * evaluate button) logs its alert writes as refused and the next scheduled
 * run makes them: filing works from the fire history, not from what one run
 * fired.
 */

import type { EngineRule } from "./domain.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeDta } from "./metrics.ts";
import { fireHeadKey, type FireHead } from "./pickup.ts";
import { fetchAllRows } from "./snapshots.ts";
import type { RoomTypeRow } from "./types.ts";

/** Counted fires on one room type that put a night in front of the owner. */
export const REPEAT_ALERT_FIRES = 3;

/** Room type limits nobody has set: the schema's defaults. */
export const DEFAULT_FLOOR_PRICE = 1;
export const DEFAULT_CEILING_PRICE = 99999.99;

export type RepeatAlertChoice = "keep_adjusting" | "stop";

export type RepeatAlertNight = {
  alert_id: string;
  rule_id: string;
  rule_version: number;
  stay_date: string;
  fire_count: number;
  last_fire_at: string;
  choice: RepeatAlertChoice | null;
  closed_at: string | null;
  closed_reason: RepeatAlertClosedReason | null;
};

/** Why an unanswered night stopped needing an answer. */
export type RepeatAlertClosedReason = "night_passed" | "rule_edited" | "price_set";

function closedReasonOf(value: unknown): RepeatAlertClosedReason | null {
  return value === "night_passed" || value === "rule_edited" || value === "price_set" ? value : null;
}

/**
 * Every filed night of the given rules over a range of nights, any version,
 * keyed `rule_id|stay_date`. Throws on a failed read: a night the owner
 * stopped must never be fired on because the answer could not be read.
 */
export async function loadRepeatAlertNights(
  supabase: SupabaseClient,
  hotelId: string,
  ruleIds: string[],
  firstDate: string,
  lastDate: string,
): Promise<Map<string, RepeatAlertNight[]>> {
  const out = new Map<string, RepeatAlertNight[]>();
  if (ruleIds.length === 0) return out;
  let rows: Record<string, unknown>[];
  try {
    rows = await fetchAllRows(() =>
      supabase
        .from("rule_repeat_alert_nights")
        .select("alert_id, rule_id, rule_version, stay_date, fire_count, last_fire_at, choice, closed_at, closed_reason")
        .eq("hotel_id", hotelId)
        .in("rule_id", ruleIds)
        .gte("stay_date", firstDate)
        .lte("stay_date", lastDate)
        .order("stay_date", { ascending: true })
        .order("rule_id", { ascending: true })
        .order("rule_version", { ascending: true }),
    );
  } catch (e) {
    throw new Error(`Failed to load rule alert answers: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const r of rows) {
    const night: RepeatAlertNight = {
      alert_id: String(r.alert_id),
      rule_id: String(r.rule_id),
      rule_version: Number(r.rule_version),
      stay_date: String(r.stay_date).slice(0, 10),
      fire_count: Number(r.fire_count),
      last_fire_at: String(r.last_fire_at),
      choice: r.choice === "stop" || r.choice === "keep_adjusting" ? r.choice : null,
      closed_at: r.closed_at != null ? String(r.closed_at) : null,
      closed_reason: closedReasonOf(r.closed_reason),
    };
    const key = `${night.rule_id}|${night.stay_date}`;
    const list = out.get(key) ?? [];
    list.push(night);
    out.set(key, list);
  }
  return out;
}

/** The rule's current version's filed night, if any. */
export function currentNight(
  nights: ReadonlyMap<string, RepeatAlertNight[]>,
  rule: EngineRule,
  stayDate: string,
): RepeatAlertNight | undefined {
  return nights.get(`${rule.id}|${stayDate}`)?.find((n) => n.rule_version === rule.version);
}

/** The owner told this rule version to stop adjusting this night. */
export function isStoppedOnNight(
  nights: ReadonlyMap<string, RepeatAlertNight[]>,
  rule: EngineRule,
  stayDate: string,
): boolean {
  return currentNight(nights, rule, stayDate)?.choice === "stop";
}

export type RepeatAlertInput = {
  hotelId: string;
  now: string;
  /** The hotel's date: nights before it are over. */
  localDate: string;
  /** The event rules this run loaded (active ones). */
  eventRules: EngineRule[];
  /** Every rule this run loaded, for noticing an edit on an alert's rule. */
  allRules: EngineRule[];
  /** The fire history read before this run fired (loadPickupFireHeads). */
  heads: ReadonlyMap<string, FireHead>;
  /** The fires this run inserted. */
  wins: { rule_id: string; stay_date: string; affected_room_type_id: string }[];
  /** The filed nights read before this run fired (loadRepeatAlertNights). */
  nights: ReadonlyMap<string, RepeatAlertNight[]>;
  roomTypes: RoomTypeRow[];
  /** What this run published, per `stay_date|room_type_id`. */
  finalPriceByCell: ReadonlyMap<string, number>;
};

export type RepeatAlertResult = { opened: number; filed: number; updated: number; closed: number; resolved: number };

type NightCount = { rule: EngineRule; stayDate: string; count: number; lastAt: string | null };

/**
 * Counted fires per rule and night after this run: the most on any one room
 * type, from the history read before the run plus this run's fires.
 */
export function repeatCounts(
  eventRules: EngineRule[],
  heads: ReadonlyMap<string, FireHead>,
  wins: RepeatAlertInput["wins"],
  now: string,
): Map<string, NightCount> {
  const rulesById = new Map(eventRules.map((r) => [r.id, r]));
  const perCell = new Map<string, { count: number; lastAt: string | null }>();
  for (const [key, head] of heads) {
    if (head.counted > 0) perCell.set(key, { count: head.counted, lastAt: head.lastCountedAt });
  }
  for (const w of wins) {
    const key = fireHeadKey(w.rule_id, w.stay_date, w.affected_room_type_id);
    const cell = perCell.get(key) ?? { count: 0, lastAt: null };
    perCell.set(key, { count: cell.count + 1, lastAt: now });
  }
  const out = new Map<string, NightCount>();
  for (const [key, cell] of perCell) {
    const [ruleId, stayDate] = key.split("|");
    const rule = rulesById.get(ruleId);
    if (!rule) continue;
    const nightKey = `${ruleId}|${stayDate}`;
    const prev = out.get(nightKey);
    const lastAt =
      prev?.lastAt && (!cell.lastAt || Date.parse(prev.lastAt) > Date.parse(cell.lastAt)) ? prev.lastAt : cell.lastAt;
    out.set(nightKey, { rule, stayDate, count: Math.max(prev?.count ?? 0, cell.count), lastAt });
  }
  return out;
}

function logAlertError(hotelId: string, step: string, message: string): void {
  console.error(JSON.stringify({ fn: "updateRepeatAlerts", step, hotelId, error: message }));
}

/**
 * Bookkeeping after prices are published: close nights that no longer need
 * an answer, resolve alerts with nothing left to answer, then file nights
 * that reached REPEAT_ALERT_FIRES and update unanswered ones the rule fired
 * on again. Never throws for a refused or failed write; it logs and the next
 * run catches up.
 */
export async function updateRepeatAlerts(
  supabase: SupabaseClient,
  input: RepeatAlertInput,
): Promise<RepeatAlertResult> {
  const { hotelId, now } = input;
  const result: RepeatAlertResult = { opened: 0, filed: 0, updated: 0, closed: 0, resolved: 0 };
  const counts = repeatCounts(input.eventRules, input.heads, input.wins, now);

  // Nights that are over.
  {
    const { data, error } = await supabase
      .from("rule_repeat_alert_nights")
      .update({ closed_at: now, closed_reason: "night_passed", updated_at: now })
      .eq("hotel_id", hotelId)
      .lt("stay_date", input.localDate)
      .is("choice", null)
      .is("closed_at", null)
      .select("alert_id");
    if (error) logAlertError(hotelId, "close_passed_nights", error.message);
    else result.closed += (data ?? []).length;
  }

  const { data: openRows, error: openError } = await supabase
    .from("rule_repeat_alerts")
    .select("id, rule_id, rule_version")
    .eq("hotel_id", hotelId)
    .is("resolved_at", null);
  if (openError) {
    logAlertError(hotelId, "open_alerts", openError.message);
    return result;
  }
  const openAlerts = new Map<string, { id: string; rule_version: number }>();
  for (const a of (openRows ?? []) as Record<string, unknown>[]) {
    openAlerts.set(String(a.rule_id), { id: String(a.id), rule_version: Number(a.rule_version) });
  }

  const loaded = new Map(input.allRules.map((r) => [r.id, r]));
  const eventRulesById = new Map(input.eventRules.map((r) => [r.id, r]));

  // A night closed because a price someone set took its fires off is not done
  // with: once the wait from that price has passed, the rule stacks on the new
  // price just the same, and at 3 counted fires again the owner is asked
  // again. Only a passed night or an edit ends a night for good.
  const toReopen: RepeatAlertNight[] = [];
  for (const [key, list] of input.nights) {
    const rule = eventRulesById.get(key.split("|")[0]);
    if (!rule || (counts.get(key)?.count ?? 0) < REPEAT_ALERT_FIRES) continue;
    if (key.split("|")[1] < input.localDate) continue;
    for (const n of list) {
      if (n.rule_version === rule.version && n.choice === null && n.closed_reason === "price_set") toReopen.push(n);
    }
  }

  // A night filed as another run or the owner resolved its alert is still
  // waiting on an answer: open its alert again.
  const orphaned = new Map<string, string>();
  const openIds = new Set([...openAlerts.values()].map((a) => a.id));
  for (const [key, list] of input.nights) {
    const rule = eventRulesById.get(key.split("|")[0]);
    if (!rule) continue;
    for (const n of list) {
      if (n.rule_version === rule.version && n.choice === null && n.closed_at === null && !openIds.has(n.alert_id)) {
        orphaned.set(n.alert_id, n.rule_id);
      }
    }
  }
  // A reopened night needs an alert too. Its own is reopened only when the
  // rule has no other open one, which would fail uq_rule_repeat_alerts_open;
  // otherwise the night moves onto the rule's open alert below.
  for (const n of toReopen) {
    if (!openIds.has(n.alert_id) && !openAlerts.has(n.rule_id)) orphaned.set(n.alert_id, n.rule_id);
  }
  /**
   * Open resolved alerts again, and count them as their rule's open one. One
   * per rule: uq_rule_repeat_alerts_open allows no more, and a rule whose
   * nights were filed across several episodes can offer two. The rest keep
   * their rows and a later run, once the open one has resolved, reopens them.
   */
  const reopenAlerts = async (ids: ReadonlyMap<string, string>) => {
    for (const [id, ruleId] of ids) {
      if (openAlerts.has(ruleId)) continue;
      const { data, error } = await supabase
        .from("rule_repeat_alerts")
        .update({ resolved_at: null, resolution: null, updated_at: now })
        .eq("id", id)
        .not("resolved_at", "is", null)
        .select("id, rule_id, rule_version");
      if (error) {
        logAlertError(hotelId, "reopen_alert", error.message);
        continue;
      }
      for (const a of (data ?? []) as Record<string, unknown>[]) {
        openAlerts.set(String(a.rule_id), { id: String(a.id), rule_version: Number(a.rule_version) });
      }
    }
  };
  await reopenAlerts(orphaned);

  // An alert whose rule has been edited since: its unanswered nights close.
  const edited = [...openAlerts].filter(([ruleId, a]) => {
    const rule = loaded.get(ruleId);
    return rule !== undefined && rule.version > a.rule_version;
  });
  if (edited.length > 0) {
    const { data, error } = await supabase
      .from("rule_repeat_alert_nights")
      .update({ closed_at: now, closed_reason: "rule_edited", updated_at: now })
      .in("alert_id", edited.map(([, a]) => a.id))
      .is("choice", null)
      .is("closed_at", null)
      .select("alert_id");
    if (error) logAlertError(hotelId, "close_edited_nights", error.message);
    else result.closed += (data ?? []).length;
  }

  // Unanswered nights of the current version whose count fell under the bar:
  // only a price someone set takes counted fires off.
  const settled = new Map<string, string[]>();
  for (const [key, list] of input.nights) {
    const [ruleId, stayDate] = key.split("|");
    const rule = eventRulesById.get(ruleId);
    if (!rule || stayDate < input.localDate) continue;
    const night = list.find((n) => n.rule_version === rule.version && n.choice === null && n.closed_at === null);
    if (!night) continue;
    if ((counts.get(key)?.count ?? 0) >= REPEAT_ALERT_FIRES) continue;
    const nights = settled.get(night.alert_id) ?? [];
    nights.push(night.stay_date);
    settled.set(night.alert_id, nights);
  }
  for (const [alertId, nights] of settled) {
    const { data, error } = await supabase
      .from("rule_repeat_alert_nights")
      .update({ closed_at: now, closed_reason: "price_set", updated_at: now })
      .eq("alert_id", alertId)
      .in("stay_date", nights)
      .is("choice", null)
      .is("closed_at", null)
      .select("alert_id");
    if (error) logAlertError(hotelId, "close_price_set_nights", error.message);
    else result.closed += (data ?? []).length;
  }

  // Nights back at the bar after a price closed them: open the row again, on
  // the rule's open alert when it has one. This runs before alerts are
  // resolved, so the run that reopens a night can't resolve its alert in the
  // same breath. The numbers on the row are refreshed by the update below.
  const reopened = new Map<string, string>();
  for (const night of toReopen) {
    const open = openAlerts.get(night.rule_id);
    const alertId = open && open.rule_version === night.rule_version ? open.id : night.alert_id;
    const { error } = await supabase
      .from("rule_repeat_alert_nights")
      .update({ alert_id: alertId, closed_at: null, closed_reason: null, reached_at: now, updated_at: now })
      .eq("alert_id", night.alert_id)
      .eq("stay_date", night.stay_date)
      .is("choice", null);
    if (error) {
      logAlertError(hotelId, "reopen_night", error.message);
      continue;
    }
    reopened.set(`${night.rule_id}|${night.stay_date}`, alertId);
  }

  // Resolve open alerts with nothing left to answer.
  if (openAlerts.size > 0) {
    const ids = [...openAlerts.values()].map((a) => a.id);
    const { data: nightRows, error } = await supabase
      .from("rule_repeat_alert_nights")
      .select("alert_id, choice, closed_at")
      .in("alert_id", ids);
    if (error) {
      logAlertError(hotelId, "alert_nights", error.message);
      return result;
    }
    const state = new Map<string, { pending: boolean; closed: boolean }>();
    for (const n of (nightRows ?? []) as Record<string, unknown>[]) {
      const s = state.get(String(n.alert_id)) ?? { pending: false, closed: false };
      if (n.choice == null && n.closed_at == null) s.pending = true;
      if (n.closed_at != null) s.closed = true;
      state.set(String(n.alert_id), s);
    }
    for (const [ruleId, a] of [...openAlerts]) {
      const s = state.get(a.id);
      // No night yet: another run may be filing them. Left open unless its
      // rule has moved on to another version.
      const rule = loaded.get(ruleId);
      if (!s && !(rule !== undefined && rule.version > a.rule_version)) continue;
      if (s?.pending) continue;
      const { error: resolveError } = await supabase
        .from("rule_repeat_alerts")
        .update({ resolved_at: now, resolution: !s || s.closed ? "closed" : "chosen", updated_at: now })
        .eq("id", a.id)
        .is("resolved_at", null);
      if (resolveError) {
        logAlertError(hotelId, "resolve_alert", resolveError.message);
        continue;
      }
      openAlerts.delete(ruleId);
      result.resolved++;
    }
  }

  // A night reopened onto its own alert, because the rule's open one belonged
  // to another version, is waiting on an answer under an alert nobody can
  // see: the banner reads open alerts. That other alert is usually an older
  // version's, whose unanswered nights closed above and which resolved just
  // now, so its rule is free again and the night's own alert can be opened
  // without two open alerts for one rule (uq_rule_repeat_alerts_open). When
  // the rule still has one, the night keeps its row and the orphan pass on
  // the next run picks it up, once that alert is gone.
  const stillClosed = new Map<string, string>();
  for (const night of toReopen) {
    const alertId = reopened.get(`${night.rule_id}|${night.stay_date}`);
    if (alertId === undefined || openAlerts.has(night.rule_id)) continue;
    stillClosed.set(alertId, night.rule_id);
  }
  await reopenAlerts(stillClosed);

  // Nights to file, and unanswered ones fired on again.
  const toFile: NightCount[] = [];
  const toUpdate: { night: RepeatAlertNight; count: NightCount }[] = [];
  for (const [key, c] of counts) {
    if (c.count < REPEAT_ALERT_FIRES || c.stayDate < input.localDate) continue;
    const night = input.nights.get(key)?.find((n) => n.rule_version === c.rule.version);
    if (!night) {
      toFile.push(c);
      continue;
    }
    const reopenedAlert = reopened.get(key);
    if (reopenedAlert !== undefined) {
      toUpdate.push({ night: { ...night, alert_id: reopenedAlert, closed_at: null, closed_reason: null }, count: c });
    } else if (
      night.choice === null &&
      night.closed_at === null &&
      c.lastAt !== null &&
      Date.parse(night.last_fire_at) < Date.parse(c.lastAt)
    ) {
      toUpdate.push({ night, count: c });
    }
  }
  if (toFile.length === 0 && toUpdate.length === 0) return result;

  const details = await nightDetails(supabase, input, [...toFile, ...toUpdate.map((u) => u.count)]);
  if (!details) return result;

  const touchedAlerts = new Set<string>();
  const byRule = new Map<string, NightCount[]>();
  for (const c of toFile) {
    const list = byRule.get(c.rule.id) ?? [];
    list.push(c);
    byRule.set(c.rule.id, list);
  }
  for (const [ruleId, list] of byRule) {
    const rule = list[0].rule;
    const rows = list
      .map((c) => details.get(`${ruleId}|${c.stayDate}`))
      .filter((d): d is NightDetail => d !== undefined && d.fire_count >= REPEAT_ALERT_FIRES);
    if (rows.length === 0) continue;

    let alert = openAlerts.get(ruleId);
    if (alert && alert.rule_version !== rule.version) continue;
    if (!alert) {
      const { data, error } = await supabase
        .from("rule_repeat_alerts")
        .insert({
          hotel_id: hotelId,
          rule_id: ruleId,
          rule_version: rule.version,
          action_direction: rule.action_direction,
          opened_at: now,
          updated_at: now,
          resolved_at: null,
          resolution: null,
        })
        .select("id, rule_version")
        .single();
      if (!error && data) {
        alert = { id: String(data.id), rule_version: Number(data.rule_version) };
        result.opened++;
      } else if (error?.code === "23505") {
        // Another run opened it first.
        const { data: existing } = await supabase
          .from("rule_repeat_alerts")
          .select("id, rule_version")
          .eq("rule_id", ruleId)
          .is("resolved_at", null)
          .maybeSingle();
        if (existing && Number(existing.rule_version) === rule.version) {
          alert = { id: String(existing.id), rule_version: Number(existing.rule_version) };
        }
      } else if (error) {
        logAlertError(hotelId, "open_alert", error.message);
      }
      if (!alert) continue;
      openAlerts.set(ruleId, alert);
    }

    const alertId = alert.id;
    const payload = rows.map((d) => ({
      ...d,
      alert_id: alertId,
      hotel_id: hotelId,
      rule_id: ruleId,
      rule_version: rule.version,
      reached_at: now,
      updated_at: now,
      choice: null,
      chosen_at: null,
      chosen_by: null,
      closed_at: null,
      closed_reason: null,
    }));
    const { error } = await supabase.from("rule_repeat_alert_nights").insert(payload);
    if (!error) {
      result.filed += payload.length;
      touchedAlerts.add(alertId);
      continue;
    }
    // One night filed by another run fails the whole insert: file one by one.
    for (const row of payload) {
      const { error: rowError } = await supabase.from("rule_repeat_alert_nights").insert(row);
      if (!rowError) {
        result.filed++;
        touchedAlerts.add(alertId);
      } else if (rowError.code !== "23505") {
        logAlertError(hotelId, "file_night", rowError.message);
      }
    }
  }

  for (const { night, count } of toUpdate) {
    const d = details.get(`${count.rule.id}|${count.stayDate}`);
    if (!d) continue;
    const { error } = await supabase
      .from("rule_repeat_alert_nights")
      .update({ ...d, updated_at: now })
      .eq("alert_id", night.alert_id)
      .eq("stay_date", night.stay_date)
      .is("choice", null)
      .is("closed_at", null);
    if (error) {
      logAlertError(hotelId, "update_night", error.message);
      continue;
    }
    result.updated++;
    touchedAlerts.add(night.alert_id);
  }

  if (touchedAlerts.size > 0) {
    const { error } = await supabase
      .from("rule_repeat_alerts")
      .update({ updated_at: now })
      .in("id", [...touchedAlerts]);
    if (error) logAlertError(hotelId, "touch_alerts", error.message);
  }
  return result;
}

/** What a filed night records about its fires (the columns the engine writes). */
export type NightDetail = {
  stay_date: string;
  fire_count: number;
  last_fire_at: string;
  last_event_id: string;
  window_days: number | null;
  window_bookings: number | null;
  window_expected: number | null;
  pickup_metric: string | null;
  pickup_threshold: number | null;
  pickup_window_days: number | null;
  pickup_net: number | null;
  room_types: {
    room_type_id: string;
    fires: number;
    /** The floor for a cut, the ceiling for a raise. null for a room type this run did not load (inactive). */
    limit: number | null;
    limit_is_default: boolean | null;
    price: number | null;
  }[];
};

/**
 * The counted fires behind each night, read in one paged query, as the
 * columns a filed night keeps. null when the read fails (logged).
 */
async function nightDetails(
  supabase: SupabaseClient,
  input: RepeatAlertInput,
  nights: NightCount[],
): Promise<Map<string, NightDetail> | null> {
  const ruleIds = [...new Set(nights.map((n) => n.rule.id))];
  const dates = nights.map((n) => n.stayDate).sort();
  let rows: Record<string, unknown>[];
  try {
    rows = await fetchAllRows(() =>
      supabase
        .from("pickup_event")
        .select(
          "id, rule_id, rule_version, stay_date, affected_room_type_id, applied_at, fire_seq, " +
            "signal_booked_units_start, signal_booked_units_end, signal_booked_revenue_start, signal_booked_revenue_end, " +
            "window_from, window_to, window_bookings_at_fire, window_expected_at_fire",
        )
        .eq("hotel_id", input.hotelId)
        .in("rule_id", ruleIds)
        .gte("stay_date", dates[0])
        .lte("stay_date", dates[dates.length - 1])
        .or("retired_at.is.null,retired_reason.eq.bookings_cancelled")
        .order("id", { ascending: true }),
    );
  } catch (e) {
    logAlertError(input.hotelId, "fires", e instanceof Error ? e.message : String(e));
    return null;
  }

  const wanted = new Map(nights.map((n) => [`${n.rule.id}|${n.stayDate}`, n.rule]));
  const byNight = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const key = `${r.rule_id}|${String(r.stay_date).slice(0, 10)}`;
    const rule = wanted.get(key);
    if (!rule || Number(r.rule_version) !== rule.version) continue;
    const list = byNight.get(key) ?? [];
    list.push(r);
    byNight.set(key, list);
  }

  const roomTypeById = new Map(input.roomTypes.map((rt) => [rt.id, rt]));
  const out = new Map<string, NightDetail>();
  for (const [key, fires] of byNight) {
    const rule = wanted.get(key)!;
    const stayDate = key.split("|")[1];
    const perRoomType = new Map<string, number>();
    for (const f of fires) {
      const rt = String(f.affected_room_type_id);
      perRoomType.set(rt, (perRoomType.get(rt) ?? 0) + 1);
    }
    const latest = fires.reduce((a, b) => {
      const d = Date.parse(String(b.applied_at)) - Date.parse(String(a.applied_at));
      return d > 0 || (d === 0 && Number(b.fire_seq) > Number(a.fire_seq)) ? b : a;
    });
    const cut = rule.action_direction === "decrease";
    const c = rule.condition;
    const hasWindow = latest.window_from != null && latest.window_to != null;
    const net = c.pickup_operator
      ? c.pickup_metric === "revenue"
        ? Math.round((Number(latest.signal_booked_revenue_end) - Number(latest.signal_booked_revenue_start)) * 100) / 100
        : Number(latest.signal_booked_units_end) - Number(latest.signal_booked_units_start)
      : null;
    out.set(key, {
      stay_date: stayDate,
      fire_count: Math.max(...perRoomType.values()),
      last_fire_at: String(latest.applied_at),
      last_event_id: String(latest.id),
      window_days: hasWindow
        ? computeDta(String(latest.window_to).slice(0, 10), String(latest.window_from).slice(0, 10)) + 1
        : null,
      window_bookings: hasWindow && latest.window_bookings_at_fire != null ? Number(latest.window_bookings_at_fire) : null,
      window_expected: hasWindow && latest.window_expected_at_fire != null ? Number(latest.window_expected_at_fire) : null,
      pickup_metric: c.pickup_operator ? (c.pickup_metric ?? null) : null,
      pickup_threshold: c.pickup_operator ? (c.pickup_threshold ?? null) : null,
      pickup_window_days: c.pickup_operator ? (c.pickup_window_days ?? null) : null,
      pickup_net: net,
      room_types: rule.affected_room_type_ids
        .filter((id) => perRoomType.has(id))
        .map((id) => {
          const rt = roomTypeById.get(id);
          const limit = rt ? (cut ? rt.floor_price : rt.ceiling_price) : null;
          return {
            room_type_id: id,
            fires: perRoomType.get(id)!,
            limit,
            limit_is_default:
              limit === null ? null : cut ? limit === DEFAULT_FLOOR_PRICE : limit === DEFAULT_CEILING_PRICE,
            price: input.finalPriceByCell.get(`${stayDate}|${id}`) ?? null,
          };
        }),
    });
  }
  return out;
}
