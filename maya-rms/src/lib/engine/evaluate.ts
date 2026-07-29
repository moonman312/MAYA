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
import {
  loadLastAuditSignatures,
  purgeOldAuditRows,
  purgeOldRunLogRows,
  recordRunHeartbeat,
  writeAudit,
} from "./audit";
import {
  DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS,
  bookingSpeedAuditSnapshots,
  bookingSpeedMetrics,
  cooldownLookbackDays,
  isWithinCooldown,
  loadBookingSpeedContext,
  observeForStayDate,
  type BookingSpeedContext,
} from "./booking-speed-provider";
import { ruleConditionsMatch } from "./conditions";
import type { LadderPassResult } from "./ladder";
import { evaluateLadderTriple } from "./ladder";
import { computeRuleMetrics } from "./metrics";
import { computeBaselineTs, retireUndonePickupEvents, runPickupPass } from "./pickup";
import { assemblePrice, maybePublish } from "./pricing";
import { ruleScopeMatches } from "./scope";
import { fetchAllRows, purgeOldSnapshots, snapshotCurrentState } from "./snapshots";
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
  const activeRoomTypeIds = new Set(roomTypes.map((rt) => rt.id));

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

  const { data: rulesData, error: rulesErr } = await supabase
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

  // Never proceed on a failed rule load. Discarding this error made the run
  // continue with zero rules, which quietly publishes the base price for
  // every room-night — the hotel's entire pricing strategy silently switched
  // off, and pushed to the PMS, with nothing surfaced anywhere. A missing
  // rule_condition column (the documented fresh-install path) does exactly
  // this.
  if (rulesErr) {
    throw new Error(`Failed to load pricing rules: ${rulesErr.message}`);
  }

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
      // A deactivated room type is never cleaned out of rule_signal_room_type
      // (deactivation is routine — onboarding auto-deactivates duplicates and
      // suspect room types on confirm, long after rules exist). Left
      // unfiltered, a stale signal room type stops accruing snapshots and its
      // permanently-missing baseline reads as pickup_block_reason
      // 'insufficient_snapshot_history' / 'stale_baseline_snapshot' — blocking
      // the WHOLE rule even though its other signals are fine. Filtering here
      // drops only the dead entry, matching what deactivating a room type
      // ought to mean for a rule that also signals on other room types.
      signal_room_type_ids: (r.rule_signal_room_type ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((x: any) => String(x.room_type_id))
        .filter((id: string) => activeRoomTypeIds.has(id)),
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

  // Base prices — batched: one reservations read + one published_price read for
  // the whole horizon, resolved in memory. (Previously this was ~2 queries per
  // (stay_date, room_type) cell — thousands of sequential round-trips.)
  //
  // Order: the most recent reservation's base_rate, else the base price we
  // remembered the last time this cell was priced. NEVER published_price.price
  // — that is this engine's own output, already carrying every active effect,
  // and feeding it back in compounds those effects once per run.
  const firstDate = stayDates[0];
  const lastDate = stayDates[stayDates.length - 1];

  const resRows = await fetchAllRows(() =>
    supabase
      .from("reservations")
      .select("stay_date, room_type_id, base_rate, created_at")
      .eq("hotel_id", hotelId)
      .gte("stay_date", firstDate)
      .lte("stay_date", lastDate)
      .order("id", { ascending: true }),
  );

  const latestResByCell = new Map<string, { base_rate: number | null; created_at: string }>();
  for (const r of resRows ?? []) {
    if (!r.room_type_id) continue;
    const key = `${r.stay_date}|${r.room_type_id}`;
    const createdAt = String(r.created_at ?? "");
    const prev = latestResByCell.get(key);
    if (!prev || createdAt > prev.created_at) {
      latestResByCell.set(key, {
        base_rate: r.base_rate != null ? Number(r.base_rate) : null,
        created_at: createdAt,
      });
    }
  }

  const ppRows = await fetchAllRows(() =>
    supabase
      .from("published_price")
      .select("stay_date, room_type_id, base_price")
      .eq("hotel_id", hotelId)
      .gte("stay_date", firstDate)
      .lte("stay_date", lastDate)
      .order("stay_date", { ascending: true })
      .order("room_type_id", { ascending: true }),
  );

  const rememberedBaseByCell = new Map<string, number>();
  for (const p of ppRows) {
    if (!p.room_type_id || p.base_price == null) continue;
    rememberedBaseByCell.set(`${p.stay_date}|${p.room_type_id}`, Number(p.base_price));
  }

  const basePrices = new Map<string, number>();
  for (const sd of stayDates) {
    for (const rt of roomTypes) {
      const key = `${sd}|${rt.id}`;
      const latest = latestResByCell.get(key);
      // `!= null` rather than truthiness: a genuine 0 base_rate (comp or
      // house-use night) is a real rate, and treating it as missing sent the
      // cell down the fallback path for no reason.
      if (latest && latest.base_rate != null) {
        basePrices.set(key, latest.base_rate);
      } else {
        const remembered = rememberedBaseByCell.get(key);
        if (remembered != null) basePrices.set(key, remembered);
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
    // event-style booking-speed rules. One query, built into a map. See
    // cooldownLookbackDays for why this can't be a fixed 31 days.
    const cooldownHorizon = new Date(
      Date.parse(now) - cooldownLookbackDays(rules) * 86_400_000,
    ).toISOString();
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
  const allPickupWriteFailures: Map<string, PickupCandidate[]> = new Map();

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
    const { winners, losers, idempotent_skips, write_failures } = await runPickupPass(
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
    for (const f of write_failures) {
      const key = `${f.stay_date}|${f.affected_room_type_id}`;
      const list = allPickupWriteFailures.get(key) ?? [];
      list.push(f);
      allPickupWriteFailures.set(key, list);
    }
    if (write_failures.length > 0) {
      console.error(
        JSON.stringify({
          fn: "evaluateHotel",
          step: "pickup_event_insert",
          hotelId,
          runId,
          failed_count: write_failures.length,
          rule_ids: write_failures.map((f) => f.rule.id),
        }),
      );
    }
  }

  // The signature of the last audit row per cell, so writeAudit can skip
  // cells whose price and applied rules haven't moved since last time —
  // see auditSignature's doc comment for why this matters.
  const lastAuditSignatures = await loadLastAuditSignatures(
    supabase,
    hotelId,
    stayDates[0],
    stayDates[stayDates.length - 1],
  );

  let cellsChecked = 0;
  let cellsChanged = 0;

  for (const stayDate of stayDates) {
    for (const rt of roomTypes) {
      const key = `${stayDate}|${rt.id}`;
      const basePrice = basePrices.get(key);
      if (basePrice === undefined) continue;
      cellsChecked++;

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
        basePrice,
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
        pickupWriteFailures: allPickupWriteFailures.get(key) ?? [],
        basePrices,
        bookingSpeedObservations: bsCtx
          ? bookingSpeedAuditSnapshots(bsCtx, stayDate)
          : [],
        previousSignature: lastAuditSignatures.get(key) ?? null,
      };
      if (await writeAudit(supabase, auditInput)) cellsChanged++;
    }
  }

  await supabase
    .from("pickup_event")
    .update({ retired_at: now })
    .eq("hotel_id", hotelId)
    .lt("stay_date", localDate)
    .is("retired_at", null);

  // An event whose bookings have all cancelled is holding a price on
  // evidence that no longer exists. Retire it; if the date still has real
  // momentum the observation engine sees it and the rule fires again.
  await retireUndonePickupEvents(supabase, hotelId, rules, now, now);

  // Bookkeeping only, past this point — the correct prices are already
  // computed and published above. None of it may be allowed to fail the
  // whole run: a missing table, a transient error, or (concretely) the
  // heartbeat migration not having been run yet must degrade to "this run's
  // housekeeping was skipped," never to "this run never returned a result."
  // Discovered the hard way — before this guard, an unmigrated
  // evaluation_run_log took down every evaluation, scheduled and manual,
  // with prices already correctly published and then thrown away.
  try {
    // One tiny row regardless of cellsChanged — this is what keeps a fully
    // quiet run visible in the Change Log even though write-on-change means
    // no evaluation_audit rows exist for it.
    await recordRunHeartbeat(supabase, hotelId, runId, now, cellsChecked, cellsChanged);
    await purgeOldSnapshots(supabase, hotelId, maxPickupWindowDays + 7);
    await purgeOldAuditRows(supabase, hotelId);
    await purgeOldRunLogRows(supabase, hotelId);
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "evaluateHotel",
        step: "post_run_bookkeeping",
        hotelId,
        runId,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }

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
