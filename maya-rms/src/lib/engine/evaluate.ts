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
  buildAuditRow,
  insertAuditRows,
  loadLastAuditSignatures,
  purgeOldAuditRows,
  purgeOldRunLogRows,
  recordRunHeartbeat,
} from "./audit";
import {
  bookingSpeedAuditSnapshots,
  bookingSpeedMetrics,
  loadBookingSpeedContext,
  observeForStayDate,
  signalSetKey,
  type BookingSpeedContext,
} from "./booking-speed-provider";
import type { BaseSource } from "./base-price";
import { pricesOnBase, resolveBase } from "./base-price";
import { ruleConditionsMatch } from "./conditions";
import type { LadderPassResult, OverrideProbe } from "./ladder";
import { createLadderPassBatch, evaluateLadderTriple, probeSuppressionSupport } from "./ladder";
import { computeRuleMetrics } from "./metrics";
import {
  baselineTsFrom,
  candidateFor,
  fireHeadKey,
  firesToRetire,
  isWaiting,
  loadOpenPickupFires,
  loadPickupFireHeads,
  pickupEffectsFromFires,
  retireFires,
  retirePassedNights,
  ruleWaitDays,
  runPickupPass,
  waitAnchor,
  type FireHead,
  type PickupWin,
  type RetiredPickupFire,
} from "./pickup";
import {
  assemblePriceFrom,
  clearUnpricedCells,
  limitAllowsFire,
  loadActiveLadderEffectsForRange,
  loadActivePickupEffects,
  priceBounds,
  publishPrices,
  type AssembledPrice,
} from "./pricing";
import {
  isStoppedOnNight,
  loadRepeatAlertNights,
  updateRepeatAlerts,
  type RepeatAlertNight,
} from "./repeat-alerts";
import { ruleScopeMatches } from "./scope";
import {
  MIGRATIONS,
  createSnapshotLookup,
  fetchAllRows,
  isMissingColumnError,
  isMissingRelationError,
  loadReservationCells,
  purgeOldSnapshots,
  snapshotCurrentState,
} from "./snapshots";
import { addCalendarDays, evalIsoToHotelDateString } from "./timezone";
import type { PickupCandidate, RoomTypeRow, RuleMetrics } from "./types";
import { countsAsRoom } from "./types";


/** Cells sharing one baseline timestamp before a single read serves them all. */
const SHARED_BASELINE_MIN_CELLS = 40;

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Most pickup cells share a handful of baselines (now minus the rule's
 * window). Each baseline used by enough cells is fetched for the whole block
 * of dates and signal types in one call; rarer ones stay per cell.
 */
async function preloadSharedBaselines(
  snapshots: ReturnType<typeof createSnapshotLookup>,
  cells: { rule: EngineRule; stayDate: string; baselineTs: string }[],
): Promise<void> {
  const byTs = new Map<string, { count: number; first: string; last: string; types: Set<string> }>();
  for (const c of cells) {
    let g = byTs.get(c.baselineTs);
    if (!g) {
      g = { count: 0, first: c.stayDate, last: c.stayDate, types: new Set() };
      byTs.set(c.baselineTs, g);
    }
    g.count += c.rule.signal_room_type_ids.length;
    if (c.stayDate < g.first) g.first = c.stayDate;
    if (c.stayDate > g.last) g.last = c.stayDate;
    for (const t of c.rule.signal_room_type_ids) g.types.add(t);
  }
  for (const [ts, g] of byTs) {
    if (g.count < SHARED_BASELINE_MIN_CELLS) continue;
    await snapshots.preload(ts, g.first, g.last, [...g.types].sort());
  }
}

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
 *
 * `horizonDays` bounds how many days forward are priced in this run. Reads and
 * writes are paged across the whole horizon rather than made per cell, so a
 * 365-day run on a 500-room, 20-type property is a few hundred round trips.
 */
export async function evaluateHotel(
  supabase: SupabaseClient,
  hotelId: string,
  evalTs?: string,
  horizonDays: number = 365,
): Promise<EvaluationResult> {
  const now = evalTs ?? new Date().toISOString();
  const runId = crypto.randomUUID();

  const { data: hotelRow, error: hotelErr } = await supabase
    .from("hotels")
    .select("timezone")
    .eq("id", hotelId)
    .maybeSingle();
  // A failed read must not quietly price on UTC's date: the scheduled tick
  // reads the same timezone for its push window (readHotelClock), and the
  // two disagreeing is how tonight got pushed on an old price while the
  // engine priced a night the push never sent.
  if (hotelErr) throw new Error(`Failed to read hotel timezone: ${hotelErr.message}`);
  const hotelTimeZone = hotelRow?.timezone ?? "UTC";
  const localDate = evalIsoToHotelDateString(now, hotelTimeZone);

  const RT_COLUMNS = "id, hotel_id, name, is_active, total_rooms, floor_price, ceiling_price";
  // Typed loosely because the fallback select below returns a narrower row.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rtRes: { data: any[] | null; error: { code?: string; message: string } | null } =
    await supabase
      .from("room_types")
      .select(`${RT_COLUMNS}, counts_as_room`)
      .eq("hotel_id", hotelId)
      .eq("is_active", true);
  // counts_as_room arrives in a migration. Against the old schema the select
  // above fails, and the pre-flag behaviour (every active type is a room) is
  // what the hotel was priced on yesterday, so re-read without the column and
  // say so once. Same stance for every other schema gap in this run.
  if (rtRes.error && isMissingColumnError(rtRes.error)) {
    console.error(
      JSON.stringify({
        fn: "evaluateHotel",
        step: "room_types",
        hotelId,
        schema: "pre-migration",
        message: `room_types.counts_as_room does not exist yet; every active room type counts as a room this run. Run ${MIGRATIONS.countsAsRoom}.`,
        migration: MIGRATIONS.countsAsRoom,
        error: rtRes.error.message,
      }),
    );
    rtRes = await supabase
      .from("room_types")
      .select(RT_COLUMNS)
      .eq("hotel_id", hotelId)
      .eq("is_active", true);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const roomTypes: RoomTypeRow[] = ((rtRes.data ?? []) as any[]).map((r) => ({
    id: String(r.id),
    hotel_id: String(r.hotel_id),
    name: r.name,
    is_active: r.is_active,
    total_rooms: Number(r.total_rooms),
    floor_price: Number(r.floor_price),
    ceiling_price: Number(r.ceiling_price),
    counts_as_room: typeof r.counts_as_room === "boolean" ? r.counts_as_room : null,
  }));
  const activeRoomTypeIds = new Set(roomTypes.map((rt) => rt.id));

  // The room-count denominator, everywhere: only types that count as rooms
  // get snapshots, feed occupancy, or add to Booking Speed capacity. A court
  // stays in `roomTypes` because a rule that lists it as AFFECTED still
  // prices it; it just never measures anything.
  const countingRoomTypes = roomTypes.filter(countsAsRoom);
  const countingIds = new Set(countingRoomTypes.map((rt) => rt.id));
  const roomTypeNameById = new Map(roomTypes.map((rt) => [rt.id, rt.name]));

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

  const horizon = Math.max(1, Math.min(365, Math.floor(horizonDays)));
  const stayDates: string[] = [];
  let cursor = localDate;
  for (let i = 0; i < horizon; i++) {
    stayDates.push(cursor);
    cursor = addCalendarDays(cursor, 1);
  }

  // The horizon's reservations grouped per cell, once, for both the snapshot
  // and the base rates below. Null before the migration: each reads rows.
  const reservationCells = await loadReservationCells(
    supabase,
    hotelId,
    stayDates[0],
    stayDates[stayDates.length - 1],
  );
  const writtenSnapshots = await snapshotCurrentState(
    supabase,
    hotelId,
    now,
    stayDates,
    countingRoomTypes,
    reservationCells?.booked,
  );
  // Every snapshot read below goes through this: the rows just written are
  // answered from memory, older ones are read once per (cell, timestamp).
  const snapshots = createSnapshotLookup(supabase, hotelId, now, writtenSnapshots);

  // Once per run: can ladder_rule_state carry suppressed_at? See
  // probeSuppressionSupport. The answer is threaded to every ladder write
  // and every effects read below.
  const supportsSuppression = await probeSuppressionSupport(supabase, hotelId);

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
      //
      // The same filter drops signal types that do not count as rooms. The
      // rule row is left alone (the court stays in its saved sets and keeps
      // being priced as an AFFECTED type); it simply stops being measured.
      // A rule whose signals were all courts ends up with an empty set. It
      // is NOT dropped from scope the way an all-deactivated rule is (see
      // emptiedByRoomFlag below): its metrics come back blocked, so its
      // conditions fail and any ladder effect it holds on real rooms is
      // deactivated on the normal path instead of frozen forever. What was
      // dropped is named on the metrics (see noteExcludedSignals) so the
      // change log can explain the number.
      signal_room_type_ids: (r.rule_signal_room_type ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((x: any) => String(x.room_type_id))
        .filter((id: string) => activeRoomTypeIds.has(id) && countingIds.has(id)),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      affected_room_type_ids: (r.rule_affected_room_type ?? []).map((x: any) =>
        String(x.room_type_id),
      ),
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  });

  // Per rule, the names of active signal types that were dropped for not
  // counting as rooms. Recorded on every metrics object the rule produces so
  // audit rows and transition events carry the reason for the denominator.
  const excludedSignalNames = new Map<string, string[]>();
  // Rules whose ACTIVE signal set was non-empty and the room flag alone
  // emptied it. They stay in scope: nobody paused them, and their affected
  // rooms are still being priced, so a held ladder effect has to be able to
  // let go when the (now unmeasurable) condition can no longer be met.
  const emptiedByRoomFlag = new Set<string>();
  for (const r of rulesData ?? []) {
    const activeSignals = (r.rule_signal_room_type ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((x: any) => String(x.room_type_id))
      .filter((id: string) => activeRoomTypeIds.has(id));
    const dropped = activeSignals.filter((id: string) => !countingIds.has(id));
    if (dropped.length > 0) {
      excludedSignalNames.set(
        String(r.id),
        dropped.map((id: string) => roomTypeNameById.get(id) ?? id),
      );
    }
    if (activeSignals.length > 0 && dropped.length === activeSignals.length) {
      emptiedByRoomFlag.add(String(r.id));
    }
  }
  const noteExcludedSignals = (rule: EngineRule, metrics: RuleMetrics) => {
    const names = excludedSignalNames.get(rule.id);
    if (names) metrics.excluded_from_occupancy = names;
  };

  let maxPickupWindowDays = 7;
  for (const r of rules) {
    const w = r.condition.pickup_window_days;
    if (w != null) maxPickupWindowDays = Math.max(maxPickupWindowDays, w);
  }

  // Base prices — batched: one reservations read + one published_price read for
  // the whole horizon, resolved in memory. (Previously this was ~2 queries per
  // (stay_date, room_type) cell — thousands of sequential round-trips.)
  //
  // Order (see resolveBase): a manual price someone typed for the cell, else
  // the property's own base_rate_calendar rate, else the most recent
  // reservation's base_rate, else the base price we remembered the last time
  // this cell was priced. NEVER published_price.price — that is this engine's
  // own output, already carrying every active effect, and feeding it back in
  // compounds those effects once per run.
  const firstDate = stayDates[0];
  const lastDate = stayDates[stayDates.length - 1];

  let latestResByCell: ReadonlyMap<string, { base_rate: number | null; created_at: string }>;
  if (reservationCells) {
    latestResByCell = reservationCells.latestBase;
  } else {
    const resRows = await fetchAllRows(() =>
      supabase
        .from("reservations")
        .select("stay_date, room_type_id, base_rate, created_at")
        .eq("hotel_id", hotelId)
        .gte("stay_date", firstDate)
        .lte("stay_date", lastDate)
        .order("id", { ascending: true }),
    );

    const fromRows = new Map<string, { base_rate: number | null; created_at: string }>();
    for (const r of resRows ?? []) {
      if (!r.room_type_id) continue;
      const key = `${r.stay_date}|${r.room_type_id}`;
      const createdAt = String(r.created_at ?? "");
      const prev = fromRows.get(key);
      if (!prev || createdAt > prev.created_at) {
        fromRows.set(key, {
          base_rate: r.base_rate != null ? Number(r.base_rate) : null,
          created_at: createdAt,
        });
      }
    }
    latestResByCell = fromRows;
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
  const publishedCells = new Set<string>();
  for (const p of ppRows) {
    if (!p.room_type_id) continue;
    publishedCells.add(`${p.stay_date}|${p.room_type_id}`);
    if (p.base_price == null) continue;
    rememberedBaseByCell.set(`${p.stay_date}|${p.room_type_id}`, Number(p.base_price));
  }

  // The property's own rate, read from the PMS and never written by us.
  //
  // Degrades to empty instead of throwing: this table arrives in a migration,
  // and an engine that dies on every hotel because the deploy landed before
  // the SQL is a far worse failure than pricing the way we did last week. A
  // missing calendar simply falls through to the older base sources.
  const calendarBaseByCell = new Map<string, number>();
  try {
    const calRows = await fetchAllRows(() =>
      supabase
        .from("base_rate_calendar")
        .select("stay_date, room_type_id, price")
        .eq("hotel_id", hotelId)
        .gte("stay_date", firstDate)
        .lte("stay_date", lastDate)
        .order("stay_date", { ascending: true })
        .order("room_type_id", { ascending: true }),
    );
    for (const c of calRows) {
      if (!c.room_type_id || c.price == null) continue;
      calendarBaseByCell.set(`${c.stay_date}|${c.room_type_id}`, Number(c.price));
    }
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "evaluateHotel",
        step: "base_rate_calendar",
        hotelId,
        error: e instanceof Error ? e.message : String(e),
        degradedToEmpty: true,
      }),
    );
  }

  // A number a human typed for the cell, or changed in the PMS on a night
  // MAYA had sent (source 'pms'). Open rows only — clearing an override
  // stamps cleared_at and the cell falls back to the tiers above.
  // Same degrade-to-empty stance as the calendar: this table also arrives in
  // a migration, and pricing without overrides beats not pricing at all.
  // Where a price came from arrives in a later migration; without it every
  // row reads as typed in MAYA.
  const manualByCell = new Map<
    string,
    { price: number; set_by: string | null; set_at: string; source: "maya" | "pms"; pms_type: string | null }
  >();
  try {
    const readManual = (columns: string) =>
      fetchAllRows(() =>
        supabase
          .from("manual_price")
          .select(columns)
          .eq("hotel_id", hotelId)
          .gte("stay_date", firstDate)
          .lte("stay_date", lastDate)
          .is("cleared_at", null)
          .order("stay_date", { ascending: true })
          .order("room_type_id", { ascending: true }),
      );
    let manualRows;
    try {
      manualRows = await readManual("stay_date, room_type_id, price, set_by, set_at, source, pms_type");
    } catch (e) {
      if (!isMissingColumnError(e)) throw e;
      manualRows = await readManual("stay_date, room_type_id, price, set_by, set_at");
    }
    for (const m of manualRows) {
      if (!m.room_type_id || m.price == null) continue;
      manualByCell.set(`${m.stay_date}|${m.room_type_id}`, {
        price: Number(m.price),
        set_by: m.set_by != null ? String(m.set_by) : null,
        set_at: String(m.set_at),
        source: m.source === "pms" ? "pms" : "maya",
        pms_type: m.source === "pms" && m.pms_type != null ? String(m.pms_type) : null,
      });
    }
  } catch (e) {
    const missing = isMissingRelationError(e);
    console.error(
      JSON.stringify({
        fn: "evaluateHotel",
        step: "manual_price",
        hotelId,
        error: e instanceof Error ? e.message : String(e),
        degradedToEmpty: true,
        ...(missing
          ? {
              schema: "pre-migration",
              message: `manual_price does not exist yet; no manual price overrides apply this run. Run ${MIGRATIONS.manualPrice}.`,
              migration: MIGRATIONS.manualPrice,
            }
          : {}),
      }),
    );
  }

  const basePrices = new Map<string, number>();
  const baseSourceByCell = new Map<string, BaseSource>();
  // Cells with a published row this run will not price: see clearUnpricedCells.
  const unpricedPublished: string[] = [];
  for (const sd of stayDates) {
    for (const rt of roomTypes) {
      const key = `${sd}|${rt.id}`;
      // See resolveBase: a typed price wins outright; below it the property's
      // own rate outranks anything derived from a booking, because a booking
      // can be one of our own prices.
      const base = resolveBase({
        manual: manualByCell.get(key)?.price,
        calendar: calendarBaseByCell.get(key),
        reservation: latestResByCell.get(key)?.base_rate,
        remembered: rememberedBaseByCell.get(key),
      });
      // A night the hotel has at 0 is left alone unless someone typed a
      // price for it (pricesOnBase).
      if (base !== undefined && pricesOnBase(base)) {
        basePrices.set(key, base.price);
        baseSourceByCell.set(key, base.source);
      } else if (publishedCells.has(key)) {
        unpricedPublished.push(key);
      }
    }
  }

  const ladderRules = rules.filter((r) => !r.is_pickup_rule);
  const pickupRules = rules.filter((r) => r.is_pickup_rule);

  // Booking Speed context: loaded once, and only when some active rule
  // actually uses the observation — everyone else pays nothing.
  const usesBookingSpeed = rules.some((r) => r.condition.booking_speed_operator);
  let bsCtx: BookingSpeedContext | null = null;
  if (usesBookingSpeed) {
    // Capacity and history over the same set: the court's slots are out of
    // both, or pace reads as the hotel filling on court traffic.
    const totalCapacity = countingRoomTypes.reduce((sum, rt) => sum + rt.total_rooms, 0);
    const nonRoomIds = new Set(roomTypes.filter((rt) => !countingIds.has(rt.id)).map((rt) => rt.id));
    // Each rule counts bookings on its own signal room types. Comparable
    // dates stay hotel-wide; rules measuring every counting type (the
    // default) read exactly the history they always did.
    bsCtx = await loadBookingSpeedContext(
      supabase,
      hotelId,
      localDate,
      totalCapacity,
      nonRoomIds,
      lastDate,
      [...countingIds],
      rules.filter((r) => r.condition.booking_speed_operator).map((r) => r.signal_room_type_ids),
    );
  }

  const attachBookingSpeed = (
    rule: EngineRule,
    stayDate: string,
    metrics: Awaited<ReturnType<typeof computeRuleMetrics>>,
  ) => {
    if (!rule.condition.booking_speed_operator) return;
    // A rule whose signal types all stopped counting as rooms measures
    // nothing, so it cannot call a pace, not even the hotel's.
    if (!bsCtx || rule.signal_room_type_ids.length === 0) {
      metrics.booking_speed_block_reason = "insufficient_data";
      return;
    }
    const windowDays = rule.condition.booking_speed_window_days ?? 7;
    const observation = observeForStayDate(bsCtx, stayDate, windowDays, rule.signal_room_type_ids);
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

  // Prior state for every ladder rule across the horizon in one paged read;
  // the pass's writes are queued and flushed once it is done.
  const ladderBatch = await createLadderPassBatch(
    supabase,
    ladderRules.map((r) => r.id),
    firstDate,
    lastDate,
  );

  for (const rule of ladderRules) {
    const scopeOpts = { requireSignals: !emptiedByRoomFlag.has(rule.id) };
    for (const stayDate of stayDates) {
      if (!ruleScopeMatches(rule, stayDate, now, hotelTimeZone, scopeOpts)) continue;

      const metrics = await computeRuleMetrics(
        supabase,
        rule,
        hotelId,
        stayDate,
        now,
        localDate,
        now,
        null,
        snapshots,
      );
      attachBookingSpeed(rule, stayDate, metrics);
      noteExcludedSignals(rule, metrics);

      // Whether this rule already held when a manual price was typed on one
      // of its cells, for a cell that has no state row yet (see OverrideProbe
      // in ladder.ts). Read against the snapshot the override's own republish
      // wrote at set_at; one read per (rule, stay date, override time), and
      // only when a first activation asks. Booking speed is today's reading:
      // exact in the republish run itself, the nearest available after.
      const heldAt = new Map<string, Promise<boolean>>();
      const heldAtOverride = (setAt: string): Promise<boolean> => {
        let probe = heldAt.get(setAt);
        if (!probe) {
          probe = (async () => {
            const then = await computeRuleMetrics(
              supabase,
              rule,
              hotelId,
              stayDate,
              setAt,
              evalIsoToHotelDateString(setAt, hotelTimeZone),
              setAt,
              null,
              snapshots,
            );
            attachBookingSpeed(rule, stayDate, then);
            return ruleConditionsMatch(rule, then);
          })();
          heldAt.set(setAt, probe);
        }
        return probe;
      };

      for (const rtId of rule.affected_room_type_ids) {
        // A rule created after the price was typed cannot have been part of
        // what the typed number reset; its first fire is a fresh trigger.
        const override = manualByCell.get(`${stayDate}|${rtId}`);
        const probe: OverrideProbe | undefined =
          override && Date.parse(rule.created_at) <= Date.parse(override.set_at)
            ? { set_at: override.set_at, heldAtOverride: () => heldAtOverride(override.set_at) }
            : undefined;

        const result = await evaluateLadderTriple(
          supabase,
          rule,
          hotelId,
          stayDate,
          rtId,
          metrics,
          now,
          probe,
          supportsSuppression,
          ladderBatch,
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

  await ladderBatch.flush();

  // ── Event rules (see pickup.ts for what fires, waits and comes off) ──

  const roomTypeIds = roomTypes.map((rt) => rt.id);
  const roomTypeById = new Map(roomTypes.map((rt) => [rt.id, rt]));

  // A night that is over keeps no fire open. Past nights are never priced.
  await retirePassedNights(supabase, hotelId, localDate, now);

  // Every open fire on the horizon, read once: the fires this run prices,
  // heals and tests for cancellations. Before anything fires, so a fire taken
  // off here is already out of the prices this run publishes, and one this
  // run makes can never be taken off by the run that made it.
  const openFires = await loadOpenPickupFires(supabase, hotelId, roomTypeIds, firstDate, lastDate);
  const retireReasons = firesToRetire(openFires, {
    rules: new Map(rules.map((r) => [r.id, r])),
    manualSetAtByCell: new Map([...manualByCell].map(([key, m]) => [key, m.set_at])),
    bookedByCell: new Map(writtenSnapshots.map((s) => [`${s.stay_date}|${s.room_type_id}`, s.booked_units])),
    bsCtx,
    now,
  });
  const retiredIds = retireReasons.size > 0 ? await retireFires(supabase, hotelId, retireReasons, now) : new Set<string>();
  const retiredByCell = new Map<string, RetiredPickupFire[]>();
  for (const fire of openFires) {
    if (!retiredIds.has(fire.id)) continue;
    pushTo(retiredByCell, `${fire.stay_date}|${fire.affected_room_type_id}`, { fire, reason: retireReasons.get(fire.id)! });
  }
  const pickupEffectsByCell = pickupEffectsFromFires(openFires, retiredIds);
  // Ladder writes are flushed: these are the rows the pass left active.
  const ladderEffectsByCell = await loadActiveLadderEffectsForRange(
    supabase,
    roomTypeIds,
    firstDate,
    lastDate,
    supportsSuppression,
  );

  // Each event rule's fire history on each cell, after the retirements
  // above, and the owner's answers to repeat alerts on these nights.
  const fireHeads =
    pickupRules.length > 0
      ? await loadPickupFireHeads(supabase, hotelId, pickupRules, firstDate, lastDate)
      : new Map<string, FireHead>();
  const alertNights =
    pickupRules.length > 0
      ? await loadRepeatAlertNights(supabase, hotelId, pickupRules.map((r) => r.id), firstDate, lastDate)
      : new Map<string, RepeatAlertNight[]>();

  // Per (rule, night) in scope: which of its room types it may fire on now,
  // and which it is still waiting on. A night the owner stopped the rule on
  // is left out entirely.
  type RuleNight = {
    rule: EngineRule;
    stayDate: string;
    baselineTs: string | null;
    open: string[];
    waiting: string[];
    metrics?: RuleMetrics;
    matched?: boolean;
  };
  const ruleNights: RuleNight[] = [];
  for (const rule of pickupRules) {
    const waitDays = ruleWaitDays(rule);
    const baselineTs = baselineTsFrom(rule, now);
    for (const stayDate of stayDates) {
      if (!ruleScopeMatches(rule, stayDate, now, hotelTimeZone)) continue;
      if (isStoppedOnNight(alertNights, rule, stayDate)) continue;
      const open: string[] = [];
      const waiting: string[] = [];
      for (const rtId of rule.affected_room_type_ids) {
        const anchor = waitAnchor(
          rule,
          fireHeads.get(fireHeadKey(rule.id, stayDate, rtId)),
          manualByCell.get(`${stayDate}|${rtId}`),
        );
        (isWaiting(anchor, now, waitDays) ? waiting : open).push(rtId);
      }
      ruleNights.push({ rule, stayDate, baselineTs, open, waiting });
    }
  }

  const measure = async (rn: RuleNight) => {
    if (rn.metrics) return;
    const metrics = await computeRuleMetrics(
      supabase,
      rn.rule,
      hotelId,
      rn.stayDate,
      now,
      localDate,
      now,
      rn.baselineTs,
      snapshots,
    );
    attachBookingSpeed(rn.rule, rn.stayDate, metrics);
    noteExcludedSignals(rn.rule, metrics);
    rn.metrics = metrics;
    rn.matched = ruleConditionsMatch(rn.rule, metrics);
  };
  const withBaseline = (list: RuleNight[]) =>
    list.flatMap((rn) => (rn.baselineTs ? [{ rule: rn.rule, stayDate: rn.stayDate, baselineTs: rn.baselineTs }] : []));
  const candidate = (rn: RuleNight, rtId: string) =>
    candidateFor({
      rule: rn.rule,
      metrics: rn.metrics!,
      stayDate: rn.stayDate,
      roomTypeId: rtId,
      now,
      localDate,
      baselineTs: rn.baselineTs,
      head: fireHeads.get(fireHeadKey(rn.rule.id, rn.stayDate, rtId)),
    });

  // Metrics only where a rule may fire: baselines shared by many cells are
  // fetched in one call first.
  const measured = ruleNights.filter((rn) => rn.open.length > 0);
  await preloadSharedBaselines(snapshots, withBaseline(measured));
  for (const rn of measured) await measure(rn);

  // The price each cell would publish before anything fires, for the limit
  // guard: a cut already at the floor or a raise already at the ceiling
  // can't move the price, so it doesn't fire and starts no wait. A cell this
  // run leaves unpriced (no base, a closed night, an inactive room type)
  // gets no fire at all.
  const currentByCell = new Map<string, { final: number; bounds: { floor: number; ceiling: number } } | null>();
  const currentPrice = (stayDate: string, rtId: string) => {
    const key = `${stayDate}|${rtId}`;
    if (!currentByCell.has(key)) {
      const rt = roomTypeById.get(rtId);
      const base = basePrices.get(key);
      if (!rt || base === undefined) {
        currentByCell.set(key, null);
      } else {
        const source = baseSourceByCell.get(key) ?? "remembered";
        const assembled = assemblePriceFrom(
          stayDate,
          rt,
          base,
          source,
          ladderEffectsByCell.get(key) ?? [],
          pickupEffectsByCell.get(key) ?? [],
        );
        currentByCell.set(key, {
          final: assembled.final_price,
          bounds: priceBounds(rt.floor_price, rt.ceiling_price, base, source),
        });
      }
    }
    return currentByCell.get(key)!;
  };

  const allPickupCandidates: PickupCandidate[] = [];
  const allPickupNoPriceChange = new Map<string, PickupCandidate[]>();
  for (const rn of measured) {
    if (!rn.matched) continue;
    for (const rtId of rn.open) {
      const current = currentPrice(rn.stayDate, rtId);
      if (!current) continue;
      const c = candidate(rn, rtId);
      if (!limitAllowsFire(current.final, current.bounds, rn.rule.action_direction)) {
        pushTo(allPickupNoPriceChange, `${rn.stayDate}|${rtId}`, c);
        continue;
      }
      allPickupCandidates.push(c);
    }
  }

  // Rules still waiting on a cell that has a live candidate stay in its
  // competition when their conditions still match: a stronger rule that
  // fired recently holds the cell, and a weaker one can't fire under it.
  const liveCells = new Set(allPickupCandidates.map((c) => `${c.stay_date}|${c.affected_room_type_id}`));
  const holders: PickupCandidate[] = [];
  if (liveCells.size > 0) {
    const holding = ruleNights.filter((rn) => rn.waiting.some((rtId) => liveCells.has(`${rn.stayDate}|${rtId}`)));
    await preloadSharedBaselines(snapshots, withBaseline(holding.filter((rn) => !rn.metrics)));
    for (const rn of holding) {
      await measure(rn);
      if (!rn.matched) continue;
      for (const rtId of rn.waiting) {
        if (liveCells.has(`${rn.stayDate}|${rtId}`)) holders.push(candidate(rn, rtId));
      }
    }
  }

  const allPickupWinners: Map<string, PickupWin[]> = new Map();
  const allPickupLosers: Map<string, PickupCandidate[]> = new Map();
  const allPickupHeld: Map<string, { candidate: PickupCandidate; holder: PickupCandidate }[]> = new Map();
  const allPickupHolding: Map<string, PickupCandidate[]> = new Map();
  const allPickupConcurrent: Map<string, PickupCandidate[]> = new Map();
  const allPickupWriteFailures: Map<string, PickupCandidate[]> = new Map();
  const cellOf = (c: PickupCandidate) => `${c.stay_date}|${c.affected_room_type_id}`;

  if (allPickupCandidates.length > 0) {
    const pass = await runPickupPass(supabase, allPickupCandidates, hotelId, basePrices, holders);
    pickupEventsCreated = pass.winners.length;

    for (const w of pass.winners) {
      pushTo(allPickupWinners, cellOf(w.candidate), w);
      // The fire applies after every earlier one on the cell, as the table
      // orders them (applied_at is this run's now).
      pushTo(pickupEffectsByCell, cellOf(w.candidate), w.effect);
    }
    for (const l of pass.losers) pushTo(allPickupLosers, cellOf(l), l);
    for (const h of pass.held) pushTo(allPickupHeld, cellOf(h.candidate), h);
    for (const h of pass.holding) pushTo(allPickupHolding, cellOf(h), h);
    for (const s of pass.concurrent_skips) {
      pushTo(allPickupConcurrent, cellOf(s), s);
      // Another run recorded this fire: price the cell with it.
      pickupEffectsByCell.set(
        cellOf(s),
        await loadActivePickupEffects(supabase, hotelId, s.stay_date, s.affected_room_type_id),
      );
    }
    for (const f of pass.write_failures) pushTo(allPickupWriteFailures, cellOf(f), f);
    if (pass.write_failures.length > 0) {
      console.error(
        JSON.stringify({
          fn: "evaluateHotel",
          step: "pickup_event_insert",
          hotelId,
          runId,
          failed_count: pass.write_failures.length,
          rule_ids: pass.write_failures.map((f) => f.rule.id),
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

  const assembledCells: { key: string; basePrice: number; assembled: AssembledPrice }[] = [];
  for (const stayDate of stayDates) {
    for (const rt of roomTypes) {
      const key = `${stayDate}|${rt.id}`;
      const basePrice = basePrices.get(key);
      if (basePrice === undefined) continue;
      cellsChecked++;
      const assembled = assemblePriceFrom(
        stayDate,
        rt,
        basePrice,
        // Every priced cell has a source: the two maps are filled together.
        baseSourceByCell.get(key) ?? "remembered",
        ladderEffectsByCell.get(key) ?? [],
        pickupEffectsByCell.get(key) ?? [],
      );
      assembledCells.push({ key, basePrice, assembled });
    }
  }

  const publishedKeys = await publishPrices(
    supabase,
    hotelId,
    assembledCells.map((c) => ({
      stayDate: c.assembled.stay_date,
      roomTypeId: c.assembled.room_type_id,
      finalPrice: c.assembled.final_price,
      basePrice: c.basePrice,
    })),
    now,
  );
  pricesPublished = publishedKeys.size;
  // Whatever an earlier run published for a night this run left unpriced is
  // no longer MAYA's price, and must neither show as one nor be pushed.
  if (unpricedPublished.length > 0) await clearUnpricedCells(supabase, hotelId, unpricedPublished);

  // A Booking Speed rule measuring part of the hotel records its observation
  // on the cells it changes, and only there. Hotel-wide observations go on
  // every cell, as they always have.
  const hotelSetKey = signalSetKey([...countingIds]);
  const setKeysByRoomType = new Map<string, Set<string>>();
  for (const rule of rules) {
    if (!rule.condition.booking_speed_operator || rule.signal_room_type_ids.length === 0) continue;
    const setKey = signalSetKey(rule.signal_room_type_ids);
    if (setKey === hotelSetKey) continue;
    for (const id of rule.affected_room_type_ids) {
      const keys = setKeysByRoomType.get(id) ?? new Set<string>();
      keys.add(setKey);
      setKeysByRoomType.set(id, keys);
    }
  }

  const auditRows: Record<string, unknown>[] = [];
  for (const { key, assembled } of assembledCells) {
    const stayDate = assembled.stay_date;
    const auditInput: AuditInput = {
      runId,
      hotelId,
      evalTs: now,
      assembled,
      ladderResults: allLadderResults.get(key) ?? [],
      pickupWinners: allPickupWinners.get(key) ?? [],
      pickupLosers: allPickupLosers.get(key) ?? [],
      pickupHeld: allPickupHeld.get(key) ?? [],
      pickupHolding: allPickupHolding.get(key) ?? [],
      pickupConcurrentSkips: allPickupConcurrent.get(key) ?? [],
      pickupWriteFailures: allPickupWriteFailures.get(key) ?? [],
      pickupNoPriceChange: allPickupNoPriceChange.get(key) ?? [],
      retiredPickupEffects: retiredByCell.get(key) ?? [],
      basePrices,
      bookingSpeedObservations: bsCtx
        ? bookingSpeedAuditSnapshots(bsCtx, stayDate, setKeysByRoomType.get(assembled.room_type_id))
        : [],
      previousSignature: lastAuditSignatures.get(key) ?? null,
      manualOverride: manualByCell.get(key) ?? null,
    };
    const row = buildAuditRow(auditInput);
    if (row) {
      auditRows.push(row);
      cellsChanged++;
    }
  }
  await insertAuditRows(supabase, auditRows);

  // Bookkeeping only, past this point — the correct prices are already
  // computed and published above. None of it may be allowed to fail the
  // whole run: a missing table, a transient error, or (concretely) the
  // heartbeat migration not having been run yet must degrade to "this run's
  // housekeeping was skipped," never to "this run never returned a result."
  // Discovered the hard way — before this guard, an unmigrated
  // evaluation_run_log took down every evaluation, scheduled and manual,
  // with prices already correctly published and then thrown away.
  //
  // Each task gets its own guard: a snapshot purge that times out on a
  // backlog must not stop the audit and run-log purges behind it.
  const bookkeeping: [string, () => Promise<unknown>][] = [
    // One tiny row regardless of cellsChanged — this is what keeps a fully
    // quiet run visible in the Change Log even though write-on-change means
    // no evaluation_audit rows exist for it.
    [
      "heartbeat",
      () =>
        recordRunHeartbeat(supabase, hotelId, runId, now, cellsChecked, cellsChanged, {
          first: stayDates[0],
          last: stayDates[stayDates.length - 1],
        }),
    ],
    // Nights a rule has adjusted 3 times, for the owner to answer.
    [
      "repeat_alerts",
      () =>
        pickupRules.length > 0
          ? updateRepeatAlerts(supabase, {
              hotelId,
              now,
              localDate,
              eventRules: pickupRules,
              allRules: rules,
              heads: fireHeads,
              wins: [...allPickupWinners.values()].flat().map((w) => ({
                rule_id: w.candidate.rule.id,
                stay_date: w.candidate.stay_date,
                affected_room_type_id: w.candidate.affected_room_type_id,
              })),
              nights: alertNights,
              roomTypes,
              finalPriceByCell: new Map(assembledCells.map((c) => [c.key, c.assembled.final_price])),
            })
          : Promise.resolve(),
    ],
    ["purge_snapshots", () => purgeOldSnapshots(supabase, hotelId, maxPickupWindowDays + 7)],
    ["purge_audit", () => purgeOldAuditRows(supabase, hotelId)],
    ["purge_run_log", () => purgeOldRunLogRows(supabase, hotelId)],
  ];
  for (const [task, run] of bookkeeping) {
    try {
      await run();
    } catch (e) {
      console.error(
        JSON.stringify({
          fn: "evaluateHotel",
          step: "post_run_bookkeeping",
          task,
          hotelId,
          runId,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
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
