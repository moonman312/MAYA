/**
 * Hotel evaluation orchestrator — Implementation Guide
 *
 * Implements the 11-step pipeline. Note: transactional “all-or-nothing”
 * semantics are not fully enforceable via the Supabase JS client alone; a
 * database-side procedure is recommended for hard guarantees.
 */

import type { EngineRule } from "@/types/domain";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuditInput } from "./audit";
import { writeAudit } from "./audit";
import {
  DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS,
  bookingSpeedAuditSnapshots,
  bookingSpeedMetrics,
  isWithinCooldown,
  loadBookingSpeedContext,
  observeForStayDate,
  type BookingSpeedContext,
} from "./booking-speed-provider";
import { ruleConditionsMatch } from "./conditions";
import type { LadderPassResult } from "./ladder";
import { evaluateLadderTriple } from "./ladder";
import { computeRuleMetrics } from "./metrics";
import { computeBaselineTs, runPickupPass } from "./pickup";
import { assemblePrice, maybePublish } from "./pricing";
import { ruleScopeMatches } from "./scope";
import { purgeOldSnapshots, snapshotCurrentState } from "./snapshots";
import { addCalendarDays, evalIsoToHotelDateString } from "./timezone";
import type { PickupCandidate, RoomTypeRow } from "./types";

export type EvaluationResult = {
  run_id: string;
  hotel_id: string;
  stay_dates_evaluated: number;
  prices_published: number;
  ladder_activations: number;
  ladder_deactivations: number;
  pickup_events_created: number;
};

/**
 * Evaluate a hotel: run the full 11-step pipeline.
 */
export async function evaluateHotel(
  supabase: SupabaseClient,
  hotelId: string,
  evalTs?: string,
): Promise<EvaluationResult> {
  const now = evalTs ?? new Date().toISOString();
  const runId = crypto.randomUUID();

  const { data: hotelRow } = await supabase
    .from("hotels")
    .select("timezone")
    .eq("id", hotelId)
    .maybeSingle();
  const hotelTimeZone = hotelRow?.timezone ?? "UTC";
  const localDate = evalIsoToHotelDateString(now, hotelTimeZone);

  const { data: rtData } = await supabase
    .from("room_types")
    .select(
      "id, hotel_id, name, is_active, total_rooms, floor_price, ceiling_price",
    )
    .eq("hotel_id", hotelId)
    .eq("is_active", true);

  const roomTypes: RoomTypeRow[] = (rtData ?? []).map((r) => ({
    id: String(r.id),
    hotel_id: String(r.hotel_id),
    name: r.name,
    is_active: r.is_active,
    total_rooms: Number(r.total_rooms),
    floor_price: Number(r.floor_price),
    ceiling_price: Number(r.ceiling_price),
  }));

  if (roomTypes.length === 0) {
    return {
      run_id: runId,
      hotel_id: hotelId,
      stay_dates_evaluated: 0,
      prices_published: 0,
      ladder_activations: 0,
      ladder_deactivations: 0,
      pickup_events_created: 0,
    };
  }

  const stayDates: string[] = [];
  let cursor = localDate;
  for (let i = 0; i < 365; i++) {
    stayDates.push(cursor);
    cursor = addCalendarDays(cursor, 1);
  }

  await snapshotCurrentState(supabase, hotelId, now, stayDates, roomTypes);

  const { data: rulesData } = await supabase
    .from("pricing_rules")
    .select(
      `
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
      rule_signal_room_type ( room_type_id ),
      rule_affected_room_type ( room_type_id )
    `,
    )
    .eq("hotel_id", hotelId)
    .eq("is_active", true);

  const rules: EngineRule[] = (rulesData ?? []).map((r) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rc: any = Array.isArray(r.rule_condition)
      ? r.rule_condition[0]
      : r.rule_condition;
    return {
      id: String(r.id),
      hotel_id: String(r.hotel_id),
      name: r.name,
      is_active: true,
      version: Number(r.version ?? 1),
      start_date: r.start_date ?? null,
      end_date: r.end_date ?? null,
      is_annual: Boolean(r.is_annual),
      dow_mask: Number(r.dow_mask ?? 127),
      action_type: r.action_type as "percent" | "fixed",
      action_direction: r.action_direction as "increase" | "decrease",
      action_value: Number(r.action_value),
      priority: Number(r.priority),
      is_pickup_rule: Boolean(r.is_pickup_rule),
      condition: {
        occupancy_operator: rc?.occupancy_operator ?? null,
        occupancy_threshold:
          rc?.occupancy_threshold != null
            ? Number(rc.occupancy_threshold)
            : null,
        dta_operator: rc?.dta_operator ?? null,
        dta_threshold_days:
          rc?.dta_threshold_days != null ? Number(rc.dta_threshold_days) : null,
        pickup_operator: rc?.pickup_operator ?? null,
        pickup_threshold:
          rc?.pickup_threshold != null ? Number(rc.pickup_threshold) : null,
        pickup_window_days:
          rc?.pickup_window_days != null
            ? (Number(rc.pickup_window_days) as 1 | 3 | 7)
            : null,
        pickup_metric: rc?.pickup_metric ?? null,
        booking_speed_operator: rc?.booking_speed_operator ?? null,
        booking_speed_level: rc?.booking_speed_level ?? null,
        booking_speed_window_days:
          rc?.booking_speed_window_days != null
            ? (Number(rc.booking_speed_window_days) as 1 | 7 | 30)
            : null,
        booking_speed_cooldown_days:
          rc?.booking_speed_cooldown_days != null
            ? Number(rc.booking_speed_cooldown_days)
            : null,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signal_room_type_ids: (r.rule_signal_room_type ?? []).map((x: any) =>
        String(x.room_type_id),
      ),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      affected_room_type_ids: (r.rule_affected_room_type ?? []).map((x: any) =>
        String(x.room_type_id),
      ),
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  });

  let maxPickupWindowDays = 7;
  for (const r of rules) {
    const w = r.condition.pickup_window_days;
    if (w != null) maxPickupWindowDays = Math.max(maxPickupWindowDays, w);
  }

  const basePrices = new Map<string, number>();
  for (const sd of stayDates) {
    for (const rt of roomTypes) {
      const key = `${sd}|${rt.id}`;
      const { data: res } = await supabase
        .from("reservations")
        .select("base_rate")
        .eq("hotel_id", hotelId)
        .eq("stay_date", sd)
        .eq("room_type_id", rt.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (res?.base_rate) {
        basePrices.set(key, Number(res.base_rate));
      } else {
        const { data: pp } = await supabase
          .from("published_price")
          .select("price")
          .eq("hotel_id", hotelId)
          .eq("stay_date", sd)
          .eq("room_type_id", rt.id)
          .maybeSingle();
        if (pp?.price) {
          basePrices.set(key, Number(pp.price));
        }
      }
    }
  }

  const ladderRules = rules.filter((r) => !r.is_pickup_rule);
  const pickupRules = rules.filter((r) => r.is_pickup_rule);

  // Booking Speed context: loaded once, and only when some active rule
  // actually uses the observation — everyone else pays nothing.
  const usesBookingSpeed = rules.some((r) => r.condition.booking_speed_operator);
  let bsCtx: BookingSpeedContext | null = null;
  let lastBsFire: Map<string, string> | null = null;
  if (usesBookingSpeed) {
    const totalCapacity = roomTypes.reduce((sum, rt) => sum + rt.total_rooms, 0);
    bsCtx = await loadBookingSpeedContext(supabase, hotelId, localDate, totalCapacity);

    // Most recent fire per (rule, stay date), for cooldown throttling of
    // event-style booking-speed rules. One query, built into a map.
    const cooldownHorizon = new Date(Date.parse(now) - 31 * 86_400_000).toISOString();
    const { data: fires } = await supabase
      .from("pickup_event")
      .select("rule_id, stay_date, applied_at")
      .eq("hotel_id", hotelId)
      .gte("applied_at", cooldownHorizon);
    lastBsFire = new Map();
    for (const f of fires ?? []) {
      const key = `${f.rule_id}|${f.stay_date}`;
      const prev = lastBsFire.get(key);
      if (!prev || String(f.applied_at) > prev) lastBsFire.set(key, String(f.applied_at));
    }
  }

  const attachBookingSpeed = (
    rule: EngineRule,
    stayDate: string,
    metrics: Awaited<ReturnType<typeof computeRuleMetrics>>,
  ) => {
    if (!rule.condition.booking_speed_operator) return;
    if (!bsCtx) {
      metrics.booking_speed_block_reason = "insufficient_data";
      return;
    }
    const windowDays = rule.condition.booking_speed_window_days ?? 7;
    const observation = observeForStayDate(bsCtx, stayDate, windowDays);
    if (observation.method === "insufficient_data") {
      metrics.booking_speed_block_reason = "insufficient_data";
      return;
    }
    metrics.booking_speed = bookingSpeedMetrics(observation);
  };

  let ladderActivations = 0;
  let ladderDeactivations = 0;
  let pickupEventsCreated = 0;
  let pricesPublished = 0;

  const allLadderResults: Map<string, LadderPassResult[]> = new Map();

  for (const rule of ladderRules) {
    for (const stayDate of stayDates) {
      if (!ruleScopeMatches(rule, stayDate, now, hotelTimeZone)) continue;

      const metrics = await computeRuleMetrics(
        supabase,
        rule,
        hotelId,
        stayDate,
        now,
        localDate,
        now,
        null,
      );
      attachBookingSpeed(rule, stayDate, metrics);

      for (const rtId of rule.affected_room_type_ids) {
        const result = await evaluateLadderTriple(
          supabase,
          rule,
          hotelId,
          stayDate,
          rtId,
          metrics,
          now,
        );

        const key = `${stayDate}|${rtId}`;
        const list = allLadderResults.get(key) ?? [];
        list.push(result);
        allLadderResults.set(key, list);

        if (result.transition === "activate") ladderActivations++;
        if (result.transition === "deactivate") ladderDeactivations++;
      }
    }
  }

  const allPickupCandidates: PickupCandidate[] = [];
  const allPickupWinners: Map<string, PickupCandidate[]> = new Map();
  const allPickupLosers: Map<string, PickupCandidate[]> = new Map();
  const allPickupIdempotent: Map<string, PickupCandidate[]> = new Map();

  for (const rule of pickupRules) {
    for (const stayDate of stayDates) {
      if (!ruleScopeMatches(rule, stayDate, now, hotelTimeZone)) continue;

      // Event-style booking-speed rules are throttled per stay date: after
      // firing, the rule waits out its cooldown before it may re-fire, so a
      // persistent slow/fast state stacks corrections weekly, not every run.
      if (rule.condition.booking_speed_operator) {
        const cooldownDays =
          rule.condition.booking_speed_cooldown_days ?? DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS;
        if (isWithinCooldown(lastBsFire?.get(`${rule.id}|${stayDate}`), now, cooldownDays)) {
          continue;
        }
      }

      const baselineTs = await computeBaselineTs(supabase, rule, stayDate, now);
      if (!baselineTs) continue;

      const metrics = await computeRuleMetrics(
        supabase,
        rule,
        hotelId,
        stayDate,
        now,
        localDate,
        now,
        baselineTs,
      );
      attachBookingSpeed(rule, stayDate, metrics);

      if (!ruleConditionsMatch(rule, metrics)) continue;

      for (const rtId of rule.affected_room_type_ids) {
        allPickupCandidates.push({
          rule,
          metrics,
          stay_date: stayDate,
          baseline_ts: baselineTs,
          affected_room_type_id: rtId,
          eval_ts: now,
          signal_booked_units_start: metrics.signal_booked_units_baseline ?? 0,
          signal_booked_units_end: metrics.signal_booked_units_now ?? 0,
          signal_booked_revenue_start:
            metrics.signal_booked_revenue_baseline ?? 0,
          signal_booked_revenue_end: metrics.signal_booked_revenue_now ?? 0,
        });
      }
    }
  }

  const pickupInsertedKeys = new Set<string>();
  if (allPickupCandidates.length > 0) {
    const { winners, losers, idempotent_skips } = await runPickupPass(
      supabase,
      allPickupCandidates,
      hotelId,
      pickupInsertedKeys,
      basePrices,
    );
    pickupEventsCreated = winners.length;

    for (const w of winners) {
      const key = `${w.stay_date}|${w.affected_room_type_id}`;
      const list = allPickupWinners.get(key) ?? [];
      list.push(w);
      allPickupWinners.set(key, list);
    }
    for (const l of losers) {
      const key = `${l.stay_date}|${l.affected_room_type_id}`;
      const list = allPickupLosers.get(key) ?? [];
      list.push(l);
      allPickupLosers.set(key, list);
    }
    for (const s of idempotent_skips) {
      const key = `${s.stay_date}|${s.affected_room_type_id}`;
      const list = allPickupIdempotent.get(key) ?? [];
      list.push(s);
      allPickupIdempotent.set(key, list);
    }
  }

  for (const stayDate of stayDates) {
    for (const rt of roomTypes) {
      const key = `${stayDate}|${rt.id}`;
      const basePrice = basePrices.get(key);
      if (basePrice === undefined) continue;

      const assembled = await assemblePrice(
        supabase,
        hotelId,
        stayDate,
        rt,
        basePrice,
      );
      const published = await maybePublish(
        supabase,
        hotelId,
        stayDate,
        rt.id,
        assembled.final_price,
        now,
      );
      if (published) pricesPublished++;

      const auditInput: AuditInput = {
        runId,
        hotelId,
        evalTs: now,
        assembled,
        ladderResults: allLadderResults.get(key) ?? [],
        pickupWinners: allPickupWinners.get(key) ?? [],
        pickupLosers: allPickupLosers.get(key) ?? [],
        pickupIdempotentSkips: allPickupIdempotent.get(key) ?? [],
        basePrices,
        bookingSpeedObservations: bsCtx
          ? bookingSpeedAuditSnapshots(bsCtx, stayDate)
          : [],
      };
      await writeAudit(supabase, auditInput);
    }
  }

  await supabase
    .from("pickup_event")
    .update({ retired_at: now })
    .eq("hotel_id", hotelId)
    .lt("stay_date", localDate)
    .is("retired_at", null);

  await purgeOldSnapshots(supabase, hotelId, maxPickupWindowDays + 7);

  return {
    run_id: runId,
    hotel_id: hotelId,
    stay_dates_evaluated: stayDates.length,
    prices_published: pricesPublished,
    ladder_activations: ladderActivations,
    ladder_deactivations: ladderDeactivations,
    pickup_events_created: pickupEventsCreated,
  };
}
