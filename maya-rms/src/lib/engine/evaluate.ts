/**
 * Hotel evaluation orchestrator — Implementation Guide
 *
 * Implements the 11-step pipeline. Note: transactional “all-or-nothing”
 * semantics are not fully enforceable via the Supabase JS client alone; a
 * database-side procedure is recommended for hard guarantees.
 */

import type { EngineRule } from "@/types/domain";
import type { SupabaseClient } from "@supabase/supabase-js";
import { countFromInWindow, lastCountedDay, windowDaysFrom } from "@/lib/observations/expected-bookings";
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
  countsCompleteDays,
  loadBookingSpeedContext,
  loadSplitWindows,
  keepsWholeWindowBar,
  loadNightBookingRows,
  observeForStayDate,
  signalSetKey,
  usesMomentum,
  type BookingSpeedContext,
  type HistoryLoad,
  type SplitNeed,
} from "./booking-speed-provider";
import type { BaseSource } from "./base-price";
import { pricesOnBase, resolveBase } from "./base-price";
import { ruleConditionsMatch } from "./conditions";
import type { LadderOp, LadderPassResult, OverrideProbe } from "./ladder";
import { applyLadderOps, createLadderPassBatch, evaluateLadderTriple, probeSuppressionSupport, skipMarkerOf } from "./ladder";
import { computeOccupancy, computeRuleMetrics } from "./metrics";
import {
  arrivalReads,
  baselineTsFrom,
  bookingSpeedCountFrom,
  basePriceKey,
  cancellablePartsHold,
  cancellationChecks,
  cancellationReads,
  comparePickupRules,
  countFromFireAt,
  countPickupSinceChange,
  countPickupToDayStart,
  pickupCountsCompleteDays,
  pickupFireDayStart,
  pickupJudgesShortStretch,
  pickupWindowOpensAt,
  candidateFor,
  fireHeadKey,
  firesCancelled,
  firesToReset,
  isWaiting,
  loadOpenPickupFires,
  loadPausedEventRules,
  loadPickupFireHeads,
  loadSkipHolds,
  openFireHeads,
  skipHoldStep,
  writeSkipHolds,
  versionRanksOf,
  pickupEffectsFromFires,
  recordArrivals,
  recordWindowKeys,
  recountReads,
  restateFire,
  retireFires,
  retirePassedNights,
  ruleWaitDays,
  runPickupPass,
  somethingCancelled,
  waitAnchor,
  windowKeyNights,
  type BookingSpeedCountFrom,
  type CancellationFinding,
  type FireHead,
  type OpenPickupFire,
  type PickupRetireReason,
  type PickupWin,
  type RetiredPickupFire,
  type SkipHold,
  type WaitingHolder,
} from "./pickup";
import {
  assemblePriceFrom,
  clearUnpricedCells,
  compNightBlocks,
  firingMovesPrice,
  limitAllowsFire,
  keepOwnRuleEffects,
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
  RUN_GAP_STALE_MS,
  createSnapshotLookup,
  fetchAllRows,
  filterNights,
  isContiguousNights,
  isMissingColumnError,
  isMissingRelationError,
  isSchemaGapError,
  readErrorText,
  bookedBeforeKey,
  loadBookedBefore,
  loadRatesReturnedThrough,
  loadReservationCells,
  loadRunGaps,
  purgeOldSnapshots,
  snapshotCurrentState,
  type NightSet,
  type RunGap,
} from "./snapshots";
import { MAX_PRICING_HORIZON_DAYS, pricingHorizonDays } from "@/lib/pms/pricing-window";
import { addCalendarDays, evalIsoToHotelDateString, hotelDayStartIso } from "./timezone";
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
 * of dates and signal types in one call; rarer ones stay per cell. A count
 * that opens at a fire (`atFire`) has a baseline of its own per night, the
 * fire's applied_at, which that fire's run wrote a snapshot at: those are
 * all read by their exact instants together (preloadAt), however few cells
 * each covers, rather than one read per night and room type. Such a count
 * is then taken from when each booking was first seen instead
 * (countPickupSinceChange), and the snapshot stands only when that read
 * fails.
 */
async function preloadSharedBaselines(
  snapshots: ReturnType<typeof createSnapshotLookup>,
  cells: { rule: EngineRule; stayDate: string; baselineTs: string; atFire: boolean }[],
): Promise<void> {
  const atFires = cells.filter((c) => c.atFire);
  if (atFires.length > 0) {
    await snapshots.preloadAt(
      atFires.map((c) => ({ stayDate: c.stayDate, roomTypeIds: c.rule.signal_room_type_ids, ts: c.baselineTs })),
    );
  }
  const byTs = new Map<string, { count: number; first: string; last: string; types: Set<string> }>();
  for (const c of cells) {
    if (c.atFire) continue;
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

/** What a run tells the pricing cadence (see pricing-plan.ts) about the nights it priced. */
export type CadenceReport = {
  /** The nights priced, sorted. */
  nights: string[];
  /**
   * Nights not fully written: a price, a rule's change or its record that
   * failed to save. Priced again next tick rather than left as they are
   * until the daily pass.
   */
  failedNights: string[];
  /** Priced nights whose Booking Speed reading leans on nearby nights (usesMomentum). */
  momentumNights: string[];
  /**
   * Nights where this run changed what the next run reads: a rule's change
   * made, taken off or restated, a ladder rule switched on, off or moved to
   * a new version. The next run can decide differently on them (a weaker
   * rule that lost to one that fired now may fire once that one waits), as
   * it would when every night is priced every tick, so they are priced
   * again next tick, until a run changes nothing.
   */
  changedNights: string[];
  /** Wall time of the run, ms. */
  engineMs: number;
};

export type EvaluateOptions = {
  /**
   * Price only these nights (YYYY-MM-DD) of the window instead of every night
   * from the hotel's today. Nights outside the window are ignored.
   */
  nights?: readonly string[];
  /** Recorded on the run's log row; left off, the row is written as before. */
  runKind?: "window" | "nights" | "save";
  /** Filled in for the pricing cadence. */
  report?: CadenceReport;
  /** A trial run that writes nothing (see DryRun). */
  dryRun?: DryRun;
  /**
   * The booking history booking speed compares with (HistoryLoad in
   * booking-speed-provider.ts): shared by the runs handed one HistoryReuse
   * (one popup request's), and read from the hotel day's store, and with
   * "write" saved to it. A dry run only ever reads it. Left out, it is read
   * afresh.
   */
  history?: HistoryLoad;
};

/**
 * A trial run: the engine as the scheduled sync runs it, over the hotel's
 * data as it is, with every write left out. What the run would have written
 * is served back to itself in memory where a later step reads it (the
 * snapshot, the ladder rows it switches, the fires it makes), so the prices
 * it arrives at are the ones a real run at the same instant would publish.
 * Used to show the owner which nights a rule is about to change before it
 * is switched on or saved (src/lib/rule-preview.ts).
 */
export type DryRun = {
  /**
   * A rule as the owner is about to save it, in the shape the run reads
   * rules in (pricing_rules with rule_condition and the two room type
   * sets): it replaces the stored rule with the same id, or joins the run as
   * a new one, and is on.
   */
  rule?: Record<string, unknown>;
  /**
   * Several new rules at once, the same way (rules imported together, which
   * one popup covers): each joins the run, on.
   */
  rules?: Record<string, unknown>[];
  /**
   * Floors and ceilings the owner is about to set, by room type: the run
   * clamps to these instead of the stored ones.
   */
  roomTypeLimits?: Record<string, { floor_price?: number; ceiling_price?: number }>;
  /** The rule (or rules) whose part in the run is recorded in the capture. */
  watch?: string | readonly string[];
  /** Run only the watched rules' ladder part and stop (their decisions are all the capture holds). */
  ladderOnly?: boolean;
  capture: DryRunCapture;
};

export type DryRunCapture = {
  /** `stay_date|room_type_id`: the price the run would publish, for every cell it prices. */
  prices: Map<string, number>;
  /** Cells whose published price the run would take away. */
  unpriced: Set<string>;
  /**
   * Nights a watched rule had a part in: a change of it already on the
   * night (a ladder row that is on, a fire still on the price, any version),
   * a ladder decision it made, or its condition met there (a fire, a hold).
   * Anywhere else it can move no price.
   */
  touched: Set<string>;
  /** The watched rules' ladder decisions, in order. */
  ladderOps: LadderOp[];
};

/** A new, empty capture. */
export function dryRunCapture(): DryRunCapture {
  return { prices: new Map(), unpriced: new Set(), touched: new Set(), ladderOps: [] };
}

/**
 * Which of `ids` are this hotel's room types. A rule's changed room types are
 * the hotel's own: the app only offers those, but a row written straight
 * through the database's API could name another hotel's, and the engine
 * would then write changes on that hotel's room type that its own run
 * applies (audit A24; the database refuses such rows since
 * 99_supabase_migration_pricing_records_v1.sql). `active` are the hotel's
 * active room types, read already; any other id is looked up once, so a
 * room type of this hotel that is switched off stays on the rule's list, as
 * it always has. Throws on a failed read, as the room types' own read does.
 */
async function ownRoomTypeIds(
  supabase: SupabaseClient,
  hotelId: string,
  active: ReadonlySet<string>,
  ids: readonly string[],
): Promise<Set<string>> {
  const own = new Set(active);
  const unknown = [...new Set(ids)].filter((id) => !active.has(id));
  for (let i = 0; i < unknown.length; i += 100) {
    const { data, error } = await supabase
      .from("room_types")
      .select("id")
      .eq("hotel_id", hotelId)
      .in("id", unknown.slice(i, i + 100));
    if (error) throw new Error(`Failed to load the rules' room types: ${error.message}`);
    for (const r of (data ?? []) as { id: unknown }[]) own.add(String(r.id));
  }
  return own;
}

/**
 * Evaluate a hotel: run the full 11-step pipeline.
 *
 * `horizonDays` is the window: tonight and the nights after it, 396 by
 * default (pricingHorizonDays), never more than MAX_PRICING_HORIZON_DAYS.
 * Reads and writes are paged across the nights priced rather than made per
 * cell, so a year on a 500-room, 20-type property is a few hundred round
 * trips.
 *
 * `opts.nights` prices only those nights of the window: what the scheduled
 * tick's cadence picked (pricing-plan.ts), the nights whose inputs changed
 * and a chunk of the once-a-day pass. Every read keyed by a range of nights
 * then asks for those nights only where that is cheaper, and nothing about
 * any other night is read, judged or written, apart from the hotel-wide
 * tidying every run does (nights that have passed). `opts.report` is filled
 * with what the cadence needs back: the nights priced, those not fully
 * written, those whose rule state the run changed, and which lean on nearby
 * nights' bookings. Nothing in a price moves with the clock during a hotel
 * day (pickup windows and waits count whole hotel days, booking speed cuts
 * read complete days), so a night nothing changed on keeps its price until
 * the next day's pass.
 */
export async function evaluateHotel(
  supabase: SupabaseClient,
  hotelId: string,
  evalTs?: string,
  horizonDays: number = pricingHorizonDays(),
  opts: EvaluateOptions = {},
): Promise<EvaluationResult> {
  const startedMs = Date.now();
  const now = evalTs ?? new Date().toISOString();
  const runId = crypto.randomUUID();
  const report = opts.report;
  const dry = opts.dryRun;
  // The rules whose part the capture records: none, one, or several.
  const watched = new Set<string>(dry?.watch == null ? [] : typeof dry.watch === "string" ? [dry.watch] : dry.watch);
  const watch = watched.size > 0;
  // The dry run's own rules (the owner's draft, or rules imported together).
  const drafts = dry ? [...(dry.rule ? [dry.rule] : []), ...(dry.rules ?? [])] : [];
  const draftIds = new Set(drafts.map((r) => String(r.id)));

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
  // Never a hotel with no room types: that run priced nothing, reported
  // every night as priced, and the day's pass moved on without them.
  if (rtRes.error) throw new Error(`Failed to load room types: ${rtRes.error.message}`);

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
  // A dry run for limits about to be set clamps to those.
  for (const rt of roomTypes) {
    const limits = dry?.roomTypeLimits?.[rt.id];
    if (!limits) continue;
    if (limits.floor_price !== undefined && Number.isFinite(limits.floor_price)) rt.floor_price = Number(limits.floor_price);
    if (limits.ceiling_price !== undefined && Number.isFinite(limits.ceiling_price)) rt.ceiling_price = Number(limits.ceiling_price);
  }
  const activeRoomTypeIds = new Set(roomTypes.map((rt) => rt.id));

  // The room-count denominator, everywhere: only types that count as rooms
  // get snapshots, feed occupancy, or add to Booking Speed capacity. A court
  // stays in `roomTypes` because a rule that lists it as AFFECTED still
  // prices it; it just never measures anything.
  const countingRoomTypes = roomTypes.filter(countsAsRoom);
  const countingIds = new Set(countingRoomTypes.map((rt) => rt.id));
  const roomTypeNameById = new Map(roomTypes.map((rt) => [rt.id, rt.name]));

  const horizon = Math.max(1, Math.min(MAX_PRICING_HORIZON_DAYS, Math.floor(horizonDays)));
  const windowLast = addCalendarDays(localDate, horizon - 1);
  let stayDates: string[] = [];
  if (opts.nights) {
    // A set of nights (the cadence's touched nights and a chunk of the daily
    // pass): those inside the window, in order.
    stayDates = [...new Set(opts.nights)].filter((d) => d >= localDate && d <= windowLast).sort();
  } else {
    let cursor = localDate;
    for (let i = 0; i < horizon; i++) {
      stayDates.push(cursor);
      cursor = addCalendarDays(cursor, 1);
    }
  }
  if (report) {
    report.nights = [...stayDates];
    report.failedNights = [];
    report.momentumNights = [];
    report.changedNights = [];
    report.engineMs = 0;
  }

  if (roomTypes.length === 0 || stayDates.length === 0) {
    if (report) report.engineMs = Date.now() - startedMs;
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
  const stayDateSet = new Set(stayDates);
  // Nights whose writes did not all land (CadenceReport.failedNights).
  const failedNights = new Set<string>();
  // Nights whose engine state this run changed (CadenceReport.changedNights).
  const changedNights = new Set<string>();
  // Where today began at the property: pickup counts of complete days end
  // there (pickupCountEndsAt).
  const todayStart = hotelDayStartIso(localDate, hotelTimeZone);
  // Handed to every read keyed by a range of nights, so a run over a few
  // nights reads a few nights (see NightSet). Undefined for a window.
  const runNights: NightSet | undefined = opts.nights ? stayDates : undefined;

  // The horizon's reservations grouped per cell, once, for both the snapshot
  // and the base rates below. Null before the migration: each reads rows.
  const reservationCells = await loadReservationCells(
    supabase,
    hotelId,
    stayDates[0],
    stayDates[stayDates.length - 1],
    runNights,
  );
  const writtenSnapshots = await snapshotCurrentState(
    supabase,
    hotelId,
    now,
    stayDates,
    countingRoomTypes,
    reservationCells?.booked,
    { dryRun: !!dry },
  );
  // Once per run: can ladder_rule_state carry suppressed_at? See
  // probeSuppressionSupport. The answer is threaded to every ladder write
  // and every effects read below.
  const supportsSuppression = await probeSuppressionSupport(supabase, hotelId);

  const ruleSelect = (cols: { pickupWait: boolean; undo: boolean; skip: boolean }) => `
      id, hotel_id, name, is_active, version, priority,
      start_date, end_date, is_annual, dow_mask,
      action_type, action_direction, action_value,
      is_pickup_rule, created_at, updated_at,${cols.undo ? " undo_on_cancellation," : ""}${cols.skip ? " skip_at, version_ranks," : ""}
      rule_condition (
        occupancy_operator, occupancy_threshold,
        dta_operator, dta_threshold_days,
        pickup_operator, pickup_threshold, pickup_window_days, pickup_metric,${cols.pickupWait ? " pickup_cooldown_days," : ""}
        booking_speed_operator, booking_speed_level,
        booking_speed_window_days, booking_speed_cooldown_days
      ),
      rule_signal_room_type ( room_type_id ),
      rule_affected_room_type ( room_type_id )
    `;
  const readRules = (cols: { pickupWait: boolean; undo: boolean; skip: boolean }) =>
    supabase.from("pricing_rules").select(ruleSelect(cols)).eq("hotel_id", hotelId).eq("is_active", true);
  // Columns that arrive in migrations. Against an older schema the select
  // fails naming the column, and each is read without it the way the hotel
  // was priced before it existed, said once per run:
  // pickup_cooldown_days: no pickup rule has a wait of its own, so each
  // waits its lookback window. undo_on_cancellation: every rule is ticked,
  // which is what the migration sets on every rule.
  const ruleCols = { pickupWait: true, undo: true, skip: true };
  const optionalRuleColumns = [
    { key: "skip" as const, column: "skip_at", table: "pricing_rules", migration: MIGRATIONS.ruleActivation, then: "no rule has a Skip" },
    { key: "undo" as const, column: "undo_on_cancellation", table: "pricing_rules", migration: MIGRATIONS.undoOnCancellation, then: "every rule undoes a change when cancellations mean it is no longer true" },
    { key: "pickupWait" as const, column: "pickup_cooldown_days", table: "rule_condition", migration: MIGRATIONS.pickupWait, then: "every pickup count rule waits its lookback window" },
  ];
  // Typed loosely because the select string is built.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rulesRes: { data: any[] | null; error: { code?: string; message: string } | null } = await readRules(ruleCols);
  for (let tries = 0; tries < optionalRuleColumns.length && rulesRes.error && isMissingColumnError(rulesRes.error); tries++) {
    const message = rulesRes.error.message;
    const gap =
      optionalRuleColumns.find((o) => ruleCols[o.key] && message.includes(o.column)) ??
      optionalRuleColumns.find((o) => ruleCols[o.key]);
    if (!gap) break;
    ruleCols[gap.key] = false;
    console.error(
      JSON.stringify({
        fn: "evaluateHotel",
        step: "pricing_rules",
        hotelId,
        schema: "pre-migration",
        message: `${gap.table}.${gap.column} does not exist yet; ${gap.then} this run. Run ${gap.migration}.`,
        migration: gap.migration,
        error: message,
      }),
    );
    rulesRes = await readRules(ruleCols);
  }
  const { error: rulesErr } = rulesRes;

  // Never proceed on a failed rule load. Discarding this error made the run
  // continue with zero rules, which quietly publishes the base price for
  // every room-night — the hotel's entire pricing strategy silently switched
  // off, and pushed to the PMS, with nothing surfaced anywhere. A missing
  // rule_condition column (the documented fresh-install path) does exactly
  // this.
  if (rulesErr) {
    throw new Error(`Failed to load pricing rules: ${rulesErr.message}`);
  }

  // A dry run's rule, as the owner is about to save it: in place of the
  // stored one, or joining the run, and on. A ladder-only dry run keeps just
  // that rule.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rulesData: any[] = rulesRes.data ?? [];
  if (drafts.length > 0) {
    rulesData = [...rulesData.filter((r) => !draftIds.has(String(r.id))), ...drafts.map((d) => ({ ...d, is_active: true }))];
  }
  if (dry?.ladderOnly) rulesData = rulesData.filter((r) => watched.has(String(r.id)));

  // Each rule's changed room types, kept to this hotel's own (ownRoomTypeIds).
  const ownAffected = await ownRoomTypeIds(
    supabase,
    hotelId,
    activeRoomTypeIds,
    rulesData.flatMap((r) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (r.rule_affected_room_type ?? []).map((x: any) => String(x.room_type_id)),
    ),
  );
  const rules: EngineRule[] = rulesData.map((r) => {
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
        pickup_cooldown_days:
          rc?.pickup_cooldown_days != null ? Number(rc.pickup_cooldown_days) : null,
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
      affected_room_type_ids: (r.rule_affected_room_type ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((x: any) => String(x.room_type_id))
        .filter((id: string) => {
          if (ownAffected.has(id)) return true;
          console.error(
            JSON.stringify({
              fn: "evaluateHotel",
              step: "rule_room_types",
              hotelId,
              ruleId: String(r.id),
              message: "the rule names a room type that is not this hotel's; it is left out of the rule",
              roomTypeId: id,
            }),
          );
          return false;
        }),
      created_at: r.created_at,
      updated_at: r.updated_at,
      // Ticked unless the rule says otherwise (and before the column exists).
      undo_on_cancellation: r.undo_on_cancellation !== false,
      // The owner's last Skip (see pickup.ts and ladder.ts): none before the column exists.
      skip_at: r.skip_at != null ? String(r.skip_at) : null,
      // How its earlier versions ranked, for their changes still on the price (rankedAsMade).
      version_ranks: versionRanksOf(r.version_ranks),
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
  for (const r of rulesData) {
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
  // When pricing ran, for a pickup count's staleness guard (baselineIsStale):
  // only when a rule counts pickup, over the oldest baseline any can read
  // (the start of the hotel day the longest window counts back to) and the
  // 12 hours before it. The read starts an hour before that: its first end
  // counts as a run, and must lie before any stretch a baseline asks about.
  let runGaps: RunGap[] | null = null;
  if (rules.some((r) => r.condition.pickup_operator)) {
    const oldestBaseline = hotelDayStartIso(addCalendarDays(localDate, -Math.max(1, maxPickupWindowDays)), hotelTimeZone);
    runGaps = await loadRunGaps(
      supabase,
      hotelId,
      new Date(Date.parse(oldestBaseline) - RUN_GAP_STALE_MS - 3_600_000).toISOString(),
      now,
    );
  }

  // Every snapshot read below goes through this: the rows just written are
  // answered from memory, older ones are read once per (cell, timestamp).
  const snapshots = createSnapshotLookup(supabase, hotelId, now, writtenSnapshots, runGaps);

  // Base prices, batched: one published_price read and one base_rate_calendar
  // read for the run's nights, resolved in memory.
  //
  // Order (see resolveBase): a manual price someone typed for the cell, else
  // the property's own base_rate_calendar rate, else nothing: the cell is not
  // priced. NEVER a booking's rate (what the guest paid, which after MAYA's
  // first send is MAYA's own price coming back), NEVER the base remembered
  // from an earlier run (that same number kept), and NEVER
  // published_price.price, this engine's own output. Decided 2026-09-29
  // (audit A6).
  const firstDate = stayDates[0];
  const lastDate = stayDates[stayDates.length - 1];

  // A ladder-only dry run decides the watched rule's ladder part and stops:
  // it prices nothing, so it reads nothing prices are made from.
  const prices = !dry?.ladderOnly;

  const ppRows = !prices
    ? []
    : await fetchAllRows(() =>
        filterNights(
          supabase.from("published_price").select("stay_date, room_type_id, base_price").eq("hotel_id", hotelId),
          runNights,
          firstDate,
          lastDate,
        )
          .order("stay_date", { ascending: true })
          .order("room_type_id", { ascending: true }),
      );

  const publishedCells = new Set<string>();
  for (const p of ppRows) {
    if (!p.room_type_id) continue;
    publishedCells.add(`${p.stay_date}|${p.room_type_id}`);
  }

  // The property's own rate, read from the PMS and never written by us.
  //
  // Empty instead of throwing only when the table is not there yet: it
  // arrives in a migration, and an engine that dies on every hotel because
  // the deploy landed before the SQL is a far worse failure than pricing
  // nothing. A missing calendar prices only the nights someone typed a price
  // for. Any other failure stops the run: read as empty, every night would
  // go unpriced and every never-sent published row would be removed as if
  // the hotel had no rates, in a run that counted as good.
  const calendarBaseByCell = new Map<string, number>();
  // Nights whose rate the PMS removed after MAYA sent to them, on a property
  // that keeps changes made there (pms-edits.ts), and when. Not a rate on
  // record while it lasts, and a price typed before it waits too: the night
  // is left unpriced until a read returns a rate, or someone types a price.
  // Before 99_supabase_migration_pms_rate_changes_v1.sql no night is.
  const removedInPmsAt = new Map<string, number>();
  if (prices) try {
    const readCalendar = (columns: string) =>
      fetchAllRows(() =>
        filterNights(
          supabase.from("base_rate_calendar").select(columns).eq("hotel_id", hotelId),
          runNights,
          firstDate,
          lastDate,
        )
          .order("stay_date", { ascending: true })
          .order("room_type_id", { ascending: true }),
      );
    let calRows: Record<string, unknown>[];
    try {
      calRows = await readCalendar("stay_date, room_type_id, price, pms_removed_at");
    } catch (e) {
      if (!isMissingColumnError(e)) throw e;
      calRows = await readCalendar("stay_date, room_type_id, price");
    }
    for (const c of calRows) {
      if (!c.room_type_id || c.price == null) continue;
      const key = `${c.stay_date}|${c.room_type_id}`;
      calendarBaseByCell.set(key, Number(c.price));
      if (c.pms_removed_at != null) removedInPmsAt.set(key, Date.parse(String(c.pms_removed_at)));
    }
  } catch (e) {
    if (!isMissingRelationError(e)) throw new Error(`Failed to load the hotel's own rates: ${readErrorText(e)}`);
    console.error(
      JSON.stringify({
        fn: "evaluateHotel",
        step: "base_rate_calendar",
        hotelId,
        error: e instanceof Error ? e.message : String(e),
        degradedToEmpty: true,
        schema: "pre-migration",
        message: `base_rate_calendar does not exist yet; only nights with a typed price are priced this run. Run ${MIGRATIONS.baseRateCalendar}.`,
        migration: MIGRATIONS.baseRateCalendar,
      }),
    );
  }

  // The last night the PMS returned a rate for on its last read
  // (base-rate-calendar.ts). A calendar row past it is a rate the PMS no
  // longer quotes, and the night is not priced on it. Null when no read has
  // recorded one yet, or the column's migration has not run: then every row
  // counts, as it did before.
  const ratesReturnedThrough = prices ? await loadRatesReturnedThrough(supabase, hotelId) : null;

  // A number a human typed for the cell, or changed in the PMS on a night
  // MAYA had sent (source 'pms'). Open rows only — clearing an override
  // stamps cleared_at and the cell falls back to the calendar.
  // Same stance as the calendar: this table also arrives in a migration, and
  // before it no price was ever typed. Any other failure stops the run: read
  // as empty, a night the owner typed a price for was priced from the rate
  // under it and sent.
  // Where a price came from arrives in a later migration; without it every
  // row reads as typed in MAYA.
  const manualByCell = new Map<
    string,
    { price: number; set_by: string | null; set_at: string; source: "maya" | "pms"; pms_type: string | null }
  >();
  try {
    const readManual = (columns: string) =>
      fetchAllRows(() =>
        filterNights(
          supabase.from("manual_price").select(columns).eq("hotel_id", hotelId),
          runNights,
          firstDate,
          lastDate,
        )
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
    if (!isMissingRelationError(e)) throw new Error(`Failed to load typed prices: ${readErrorText(e)}`);
    console.error(
      JSON.stringify({
        fn: "evaluateHotel",
        step: "manual_price",
        hotelId,
        error: e instanceof Error ? e.message : String(e),
        degradedToEmpty: true,
        schema: "pre-migration",
        message: `manual_price does not exist yet; no manual price overrides apply this run. Run ${MIGRATIONS.manualPrice}.`,
        migration: MIGRATIONS.manualPrice,
      }),
    );
  }

  const basePrices = new Map<string, number>();
  const baseSourceByCell = new Map<string, BaseSource>();
  // Cells with a published row this run will not price: see clearUnpricedCells.
  const unpricedPublished: string[] = [];
  // Nights with no rate on record (no calendar row the last read still
  // stands behind) and no typed price: not priced, and reported.
  let cellsWithoutRate = 0;
  for (const sd of stayDates) {
    for (const rt of roomTypes) {
      const key = `${sd}|${rt.id}`;
      // See resolveBase: a typed price wins outright; below it only the
      // property's own rate, and only as far as the PMS last returned it.
      // A night whose rate the PMS removed has neither, but for a price
      // typed after the removal (see removedInPmsAt).
      const removedAt = removedInPmsAt.get(key);
      const manual = manualByCell.get(key);
      const calendar =
        removedAt !== undefined || (ratesReturnedThrough != null && sd > ratesReturnedThrough) ? undefined : calendarBaseByCell.get(key);
      const manualCounts = manual !== undefined && (removedAt === undefined || Date.parse(manual.set_at) > removedAt);
      const base = resolveBase({
        manual: manualCounts ? manual.price : undefined,
        calendar,
      });
      // A night the hotel has at 0 is left alone unless someone typed a
      // price for it (pricesOnBase).
      if (base !== undefined && pricesOnBase(base)) {
        basePrices.set(key, base.price);
        baseSourceByCell.set(key, base.source);
      } else {
        if (base === undefined) cellsWithoutRate++;
        if (publishedCells.has(key)) unpricedPublished.push(key);
      }
    }
  }
  if (cellsWithoutRate > 0) {
    console.log(
      JSON.stringify({
        fn: "evaluateHotel",
        step: "no_rate_on_record",
        hotelId,
        cells: cellsWithoutRate,
        ratesReturnedThrough,
        message: "room-nights with no rate on record from the PMS and no typed price: not priced, not sent",
      }),
    );
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
      runNights,
      {
        reuse: opts.history?.reuse ?? null,
        store: dry && opts.history?.store === "write" ? "read" : (opts.history?.store ?? null),
      },
    );
  }

  // `countFrom`: where the rule starts counting on the cell, from its own
  // last fire there (bookingSpeedCountFrom: a raise's day split at the
  // raise, or the day after a cut). null counts its whole window. A rule
  // that cuts reads complete days only, ending yesterday (countsCompleteDays).
  const attachBookingSpeed = (
    rule: EngineRule,
    stayDate: string,
    metrics: Awaited<ReturnType<typeof computeRuleMetrics>>,
    countFrom: BookingSpeedCountFrom | null = null,
  ) => {
    if (!rule.condition.booking_speed_operator) return;
    // A rule whose signal types all stopped counting as rooms measures
    // nothing, so it cannot call a pace, not even the hotel's.
    if (!bsCtx || rule.signal_room_type_ids.length === 0) {
      metrics.booking_speed_block_reason = "insufficient_data";
      return;
    }
    const windowDays = rule.condition.booking_speed_window_days ?? 7;
    // No complete day since its cut yet (a cut rule reads none of today),
    // or a fire dated after this run's day by a run whose clock was ahead:
    // nothing to judge until the day comes round.
    const last = lastCountedDay(localDate, countsCompleteDays(rule.action_direction));
    if (windowDaysFrom(windowDays, last, countFrom?.from) < 1) {
      metrics.booking_speed_block_reason = "since_last_fire";
      return;
    }
    const observation = observeForStayDate(
      bsCtx,
      stayDate,
      windowDays,
      rule.signal_room_type_ids,
      countFrom?.from,
      rule.action_direction,
      countFrom?.since,
      keepsWholeWindowBar(rule.action_direction, rule.condition.booking_speed_operator),
    );
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
  // Every active rule's rows, not only the ladder rules': a rule edited from
  // a ladder rule into an event rule leaves rows of its old version behind.
  const ladderBatch = await createLadderPassBatch(
    supabase,
    rules.map((r) => r.id),
    firstDate,
    lastDate,
    runNights,
    { supportsSuppression, dryRun: !!dry },
  );
  const touched = dry?.capture.touched;
  if (touched && watch) {
    for (const id of watched) for (const row of ladderBatch.activeRows(id)) if (stayDateSet.has(row.stayDate)) touched.add(row.stayDate);
  }

  // The owner's Skip holds on this run's nights (rule_skip_hold, see SKIP in
  // pickup.ts): a booking speed or pickup rule's, per day and room type, and
  // any rule's booking speed or pickup changes of a version before an edit
  // made it a standard rule. What the run finds on them is written once the
  // event rules are judged (writeSkipHolds); a dry run writes nothing.
  const skipHolds = await loadSkipHolds(supabase, rules, firstDate, lastDate, runNights);
  const holdsByRuleNight = new Map<string, SkipHold[]>();
  for (const h of skipHolds.values()) pushTo(holdsByRuleNight, `${h.ruleId}|${h.stayDate}`, h);
  const holdsJudged: SkipHold[] = [];
  const holdsEnded: SkipHold[] = [];
  /** One judgment of a hold (skipHoldStep): true when the hold ends now. */
  const judgeHold = (hold: SkipHold, isTrue: boolean): boolean => {
    const step = skipHoldStep(hold.wasTrue, isTrue);
    if (step.release) {
      skipHolds.delete(fireHeadKey(hold.ruleId, hold.stayDate, hold.roomTypeId));
      holdsEnded.push(hold);
      return true;
    }
    if (step.wasTrue !== hold.wasTrue) {
      hold.wasTrue = step.wasTrue;
      holdsJudged.push(hold);
    }
    return false;
  };
  const isHeld = (ruleId: string, stayDate: string, roomTypeId: string) =>
    skipHolds.has(fireHeadKey(ruleId, stayDate, roomTypeId));

  const noteLeftoverDeactivation = (rule: EngineRule, stayDate: string, roomTypeId: string, metrics: RuleMetrics) => {
    const key = `${stayDate}|${roomTypeId}`;
    const list = allLadderResults.get(key) ?? [];
    list.push({
      rule_id: rule.id,
      rule_version: rule.version,
      stay_date: stayDate,
      room_type_id: roomTypeId,
      transition: "deactivate",
      metrics,
      action_kind: rule.action_type,
      action_direction: rule.action_direction,
      action_value: rule.action_value,
    });
    allLadderResults.set(key, list);
    ladderDeactivations++;
    changedNights.add(stayDate);
  };

  // A rule's change the pass no longer reaches, because the rule was edited
  // since it was made (a room type taken off its list, nights it no longer
  // covers, or the rule turned into an event rule), comes off: an edit
  // applied judges every change the rule has on the price. So does one kept
  // by an older Skip (applied since). A row of the current version the pass
  // doesn't reach stays as it is, as it always has (a paused room type).
  // The owner's current Skip holds such a change as it is until the rule
  // stops being true that night and then becomes true again (ladder.ts
  // SKIP), and then it comes off; an event rule's hold on it is judged with
  // the event rules (below).
  const retireLeftoverRows = async (rule: EngineRule, visited: ReadonlySet<string>) => {
    for (const row of ladderBatch.activeRows(rule.id)) {
      if (!stayDateSet.has(row.stayDate) || visited.has(`${row.stayDate}|${row.roomTypeId}`)) continue;
      if (isHeld(rule.id, row.stayDate, row.roomTypeId)) continue;
      const marker = skipMarkerOf(row.state, rule);
      const fromBeforeEdit = row.state.rule_version != null && Number(row.state.rule_version) !== rule.version;
      if (!fromBeforeEdit && !marker) continue;
      const metrics = await computeRuleMetrics(supabase, rule, hotelId, row.stayDate, now, localDate, now, null, snapshots);
      noteExcludedSignals(rule, metrics);
      if (marker?.current) {
        // Judged on whether the rule is really true, whatever the undo box
        // says: the box keeps a change on the price, not a Skip's hold.
        const isTrue = ruleConditionsMatch(rule, metrics);
        if (marker.kind === "carried") {
          if (!isTrue) ladderBatch.markKept(rule, row.stayDate, row.roomTypeId);
          continue;
        }
        const ends = marker.kind === "kept" ? isTrue : !isTrue;
        if (!ends) continue;
        ladderBatch.deactivate(rule, hotelId, row.stayDate, row.roomTypeId, metrics, now, supportsSuppression, {
          clearSkip: true,
          ...(marker.kind === "held" ? { hadEffect: false } : {}),
        });
        noteLeftoverDeactivation(rule, row.stayDate, row.roomTypeId, metrics);
        continue;
      }
      ladderBatch.deactivate(rule, hotelId, row.stayDate, row.roomTypeId, metrics, now, supportsSuppression, {
        clearSkip: !!marker,
        holds: ruleConditionsMatch(rule, metrics),
      });
      noteLeftoverDeactivation(rule, row.stayDate, row.roomTypeId, metrics);
    }
  };

  for (const rule of ladderRules) {
    const scopeOpts = { requireSignals: !emptiedByRoomFlag.has(rule.id) };
    // The cells this pass judges the rule on, for the rows it no longer reaches (below).
    const visited = new Set<string>();
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

      // Booking speed or pickup changes of its own from before an edit made
      // it a standard rule, where the owner's Skip holds them: judged on the
      // rule as it is now. When a hold ends they come off (firesToReset).
      for (const hold of holdsByRuleNight.get(`${rule.id}|${stayDate}`) ?? []) {
        if (isHeld(rule.id, stayDate, hold.roomTypeId)) judgeHold(hold, ruleConditionsMatch(rule, metrics));
      }

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

        const prior = ladderBatch.state(rule.id, stayDate, rtId);
        visited.add(`${stayDate}|${rtId}`);
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
        // Switched, or kept and moved onto the edited rule (the prior row was
        // on for an older version): the next run reads a different row.
        if (result.transition !== "noop" || (prior?.is_active && prior.rule_version != null && Number(prior.rule_version) !== rule.version)) {
          changedNights.add(stayDate);
        }
      }
    }
    await retireLeftoverRows(rule, visited);
  }
  // An event rule has no ladder part: any row of it that is on is from
  // before an edit made it one.
  for (const rule of pickupRules) await retireLeftoverRows(rule, new Set());

  await ladderBatch.flush();
  if (dry && watch) {
    for (const op of ladderBatch.ops()) {
      if (!watched.has(op.rule.id)) continue;
      dry.capture.ladderOps.push(op);
      touched?.add(op.stayDate);
    }
  }
  if (dry?.ladderOnly) {
    if (report) report.engineMs = Date.now() - startedMs;
    return {
      run_id: runId,
      hotel_id: hotelId,
      stay_dates_evaluated: stayDates.length,
      prices_published: 0,
      ladder_activations: ladderActivations,
      ladder_deactivations: ladderDeactivations,
      pickup_events_created: 0,
    };
  }

  // ── Event rules (see pickup.ts for what fires, waits and comes off) ──

  const roomTypeIds = roomTypes.map((rt) => rt.id);
  const roomTypeById = new Map(roomTypes.map((rt) => [rt.id, rt]));

  // A night that is over keeps no fire open. Past nights are never priced.
  if (!dry) await retirePassedNights(supabase, hotelId, localDate, now);

  // Every open fire on the horizon, read once: the fires this run prices,
  // heals and checks for cancellations. Before anything fires, so a fire
  // taken off here is already out of the prices this run publishes, and one
  // this run makes can never be taken off by the run that made it.
  // Only the nights this run prices: a fire on another night is checked,
  // counted and priced when that night is.
  const openFires = (await loadOpenPickupFires(supabase, hotelId, roomTypeIds, firstDate, lastDate, runNights)).filter(
    (f) => stayDateSet.has(f.stay_date),
  );
  const rulesById = new Map(rules.map((r) => [r.id, r]));
  if (touched && watch) {
    for (const fire of openFires) if (watched.has(fire.rule_id)) touched.add(fire.stay_date);
  }
  // Taking fires off: a dry run takes off every one it would.
  const retire = (reasons: ReadonlyMap<string, PickupRetireReason>) =>
    dry ? Promise.resolve(new Set(reasons.keys())) : retireFires(supabase, hotelId, reasons, now);
  // The days and room types the owner's Skip still holds (see SKIP in
  // pickup.ts), after the standard rules' holds were judged above.
  const heldKeys = new Set(skipHolds.keys());
  // Fires a typed price or an edit takes off go first.
  const resetReasons = firesToReset(openFires, {
    rules: rulesById,
    manualSetAtByCell: new Map([...manualByCell].map(([key, m]) => [key, m.set_at])),
    now,
    held: heldKeys,
  });
  const resetIds = resetReasons.size > 0 ? await retire(resetReasons) : new Set<string>();
  const noteUnretired = (asked: ReadonlyMap<string, unknown>, done: ReadonlySet<string>) => {
    for (const fire of openFires) if (asked.has(fire.id) && !done.has(fire.id)) failedNights.add(fire.stay_date);
  };
  noteUnretired(resetReasons, resetIds);

  // Paused event rules never run, but pausing leaves their fires on the
  // price, so each one still covers the weaker rules that adjust the same
  // way (countFromFireAt). Only needed when some active event rule counts.
  // A dry run's rule is on, whatever the table says. Any other rule with
  // changes on the price joins them: one an edit made a standard rule keeps
  // the changes it made as a booking speed or pickup rule when the edit was
  // saved with Skip, and they cover as they ranked then (rankedAsMade).
  const firedRuleIds = new Set(openFires.map((f) => f.rule_id));
  const pausedEventRules =
    pickupRules.length > 0
      ? (await loadPausedEventRules(supabase, hotelId, firedRuleIds)).filter((r) => !draftIds.has(r.id))
      : [];
  // Every rule that can move where an event rule counts from.
  const rankedEventRules = [
    ...pickupRules,
    ...pausedEventRules,
    ...(pickupRules.length > 0 ? rules.filter((r) => !r.is_pickup_rule && firedRuleIds.has(r.id)) : []),
  ];
  // The rules whose fires may move where each one counts from: each change
  // on the price covers the rules its way it outranks (countFromFireAt), and
  // one of an earlier version its way as it was made, which may be the other
  // way from its rule now.
  const versionOf = new Map(rankedEventRules.map((r) => [r.id, r.version]));
  const keptOtherWay = new Set(
    openFires.filter((f) => versionOf.has(f.rule_id) && versionOf.get(f.rule_id) !== f.rule_version).map((f) => f.rule_id),
  );
  const othersOf = new Map(
    pickupRules.map((rule) => [
      rule.id,
      rankedEventRules.filter((o) => o.id !== rule.id && (o.action_direction === rule.action_direction || keptOtherWay.has(o.id))),
    ]),
  );

  // What came in during each count, and which bookings a booking speed
  // window counted, recorded on the fires this run is about to write (the
  // winners runPickupPass hands over, never a candidate that loses or is
  // held) or on a change whose check numbers are taken again, so a later
  // cancellation check can tell those bookings from the others
  // (recordArrivals, recordWindowKeys): one read of those nights at the
  // counts' instants, and one of those nights' bookings. Left unrecorded
  // only where what the read asks for does not exist yet, which a later
  // check reads as the most it can keep. Any other failed read stops the
  // run, before the change it would have been recorded on is made.
  const recordCounts = async (candidates: PickupCandidate[]) => {
    if (candidates.length === 0) return;
    const arrivalPairs = arrivalReads(candidates);
    if (arrivalPairs.length > 0) {
      try {
        const booked = await loadBookedBefore(supabase, hotelId, arrivalPairs);
        for (const c of candidates) recordArrivals(c, booked);
      } catch (e) {
        if (!isSchemaGapError(e)) throw e;
        console.error(
          JSON.stringify({ fn: "evaluateHotel", step: "pickup_arrivals", hotelId, error: e instanceof Error ? e.message : String(e) }),
        );
      }
    }
    const keyNights = bsCtx ? windowKeyNights(candidates) : [];
    if (bsCtx && keyNights.length > 0) {
      try {
        const rows = await loadNightBookingRows(supabase, hotelId, keyNights);
        for (const c of candidates) recordWindowKeys(c, bsCtx, rows);
      } catch (e) {
        if (!isSchemaGapError(e)) throw e;
        console.error(
          JSON.stringify({ fn: "evaluateHotel", step: "window_keys", hotelId, error: e instanceof Error ? e.message : String(e) }),
        );
      }
    }
  };

  // A pickup count that opens at a change counts the room nights first seen
  // after it that are still booked (countPickupSinceChange), from the night
  // as first seen by that change's instant: read for every such count at
  // once, before it is measured, and kept for the run. Where what the read
  // asks for does not exist yet, those counts stay net from the snapshot at
  // the change (logged). Any other failed read stops the run.
  const bookedAtChange = new Map<string, Map<string, { units: number; revenue: number }>>();
  const loadBookedAtChange = async (pairs: { stayDate: string; at: string }[]) => {
    const missing = pairs.filter((p) => !bookedAtChange.has(bookedBeforeKey(p.stayDate, p.at)));
    if (missing.length === 0) return;
    try {
      for (const [key, cell] of await loadBookedBefore(supabase, hotelId, missing)) bookedAtChange.set(key, cell);
    } catch (e) {
      if (!isSchemaGapError(e)) throw e;
      console.error(
        JSON.stringify({ fn: "evaluateHotel", step: "pickup_since_change", hotelId, error: e instanceof Error ? e.message : String(e) }),
      );
    }
  };

  // Then cancellations, on the open fires of ticked rules with a condition
  // they can make false (cancellationChecks), in two halves. First, what
  // each fire counted is recounted less what has cancelled since
  // (cancellationFinding): one read of the nights at each fire's instants
  // (loadBookedBefore), and only for the fires something they saw has
  // cancelled on (somethingCancelled), one read of those nights' bookings
  // (loadNightBookingRows) or of a window's bookings first seen after the
  // fire (loadSplitWindows). Second, a fire whose count fell short comes
  // off only if its rule is not true either counted the way it would count
  // once that fire is off (cancellablePartsHold): from the newest other
  // fire still on the night by itself or a stronger rule its way, else its
  // whole window, so the bookings made since count. The condition that led
  // to it is then still met, and it stays, the numbers its check recounts
  // taken again from that count (restateFire), so the window moving on
  // never takes it off. The rules still count from when it was made: the
  // price did not change (Jake, 2026-09-27). All before where anyone counts
  // from is worked out below: a change that comes off here covers nothing
  // this very run.
  const cancelChecks = cancellationChecks(
    openFires.filter((f) => !resetReasons.has(f.id)),
    rulesById,
    now,
    heldKeys,
  );
  let cancelFindings = new Map<string, CancellationFinding>();
  if (cancelChecks.length > 0) {
    const snapshotByCell = new Map(writtenSnapshots.map((sn) => [`${sn.stay_date}|${sn.room_type_id}`, sn]));
    const occupancyNow = (stayDate: string, ids: readonly string[]) => {
      const cells = new Map<string, { booked_units: number; sellable_units: number }>();
      for (const id of ids) {
        const sn = snapshotByCell.get(`${stayDate}|${id}`);
        if (sn) cells.set(id, sn);
      }
      return computeOccupancy(cells, [...ids]);
    };
    // A failed read stops the run: a change checked on numbers the run
    // doesn't have could come off with all its bookings still there, and
    // one left unchecked stays on a night the run then reports as priced.
    // Only where what the check reads does not exist yet is every change
    // left where it is (logged), as before that migration.
    try {
      const booked = await loadBookedBefore(supabase, hotelId, cancellationReads(cancelChecks));
      const gated = cancelChecks.filter(({ fire, rule }) => somethingCancelled(fire, rule, booked));
      if (gated.length > 0) {
        const reads = recountReads(gated);
        const nightRows = bsCtx && reads.nights.length > 0 ? await loadNightBookingRows(supabase, hotelId, reads.nights) : null;
        if (bsCtx && reads.splits.length > 0) await loadSplitWindows(supabase, hotelId, bsCtx, reads.splits);
        cancelFindings = firesCancelled(
          gated.map((c) => c.fire),
          { rules: rulesById, now, booked, bsCtx, nightRows, occupancyNow },
        );
      }
    } catch (e) {
      if (!isSchemaGapError(e)) throw e;
      cancelFindings = new Map();
      console.error(
        JSON.stringify({
          fn: "evaluateHotel",
          step: "cancellation_check",
          hotelId,
          error: e instanceof Error ? e.message : String(e),
          skipped: cancelChecks.length,
        }),
      );
    }
  }

  // The second half, cell by cell, the strongest rule first and a rule's
  // newer fire before its older one, so each is judged without the fires
  // already coming off and with those already kept still on.
  const keptFires: { fire: OpenPickupFire; candidate: PickupCandidate }[] = [];
  if (cancelFindings.size > 0) {
    const off = new Set(resetIds);
    const byCell = new Map<string, OpenPickupFire[]>();
    for (const fire of openFires) {
      if (cancelFindings.has(fire.id)) pushTo(byCell, `${fire.stay_date}|${fire.affected_room_type_id}`, fire);
    }
    for (const [key, fires] of byCell) {
      const base = basePrices.get(key) ?? 100;
      fires.sort(
        (a, b) =>
          comparePickupRules(rulesById.get(a.rule_id)!, rulesById.get(b.rule_id)!, base, base) ||
          Date.parse(b.applied_at) - Date.parse(a.applied_at),
      );
      for (const fire of fires) {
        const rule = rulesById.get(fire.rule_id)!;
        const stayDate = fire.stay_date;
        const rtId = fire.affected_room_type_id;
        try {
          const fireAt = countFromFireAt(
            rule,
            othersOf.get(rule.id) ?? [],
            openFireHeads(rankedEventRules, openFires, new Set([...off, fire.id])),
            stayDate,
            rtId,
            base,
          );
          const manual = manualByCell.get(key);
          const baselineTs = baselineTsFrom(rule, localDate, hotelTimeZone);
          const countBaselineTs = pickupWindowOpensAt(
            baselineTs,
            baselineTs === null ? null : fireAt,
            manual,
            pickupFireDayStart(rule, fireAt, hotelTimeZone),
          );
          // A pickup count that can't be judged on a stretch shorter than
          // its window has nothing to judge yet: not true.
          if (countBaselineTs !== baselineTs && !pickupJudgesShortStretch(rule)) {
            off.add(fire.id);
            continue;
          }
          const countFrom = bookingSpeedCountFrom(rule, fireAt, manual, hotelTimeZone);
          if (
            bsCtx &&
            countFrom?.since &&
            rule.condition.booking_speed_operator &&
            rule.signal_room_type_ids.length > 0 &&
            countFromInWindow(rule.condition.booking_speed_window_days ?? 7, localDate, countFrom.from)
          ) {
            await loadSplitWindows(supabase, hotelId, bsCtx, [
              { since: countFrom.since, stayDate, signalIds: rule.signal_room_type_ids },
            ]);
          }
          const metrics = await computeRuleMetrics(
            supabase,
            rule,
            hotelId,
            stayDate,
            now,
            localDate,
            now,
            countBaselineTs,
            snapshots,
          );
          attachBookingSpeed(rule, stayDate, metrics, countFrom);
          noteExcludedSignals(rule, metrics);
          if (countBaselineTs && countBaselineTs !== baselineTs) {
            metrics.pickup_counted_since = countBaselineTs;
            await loadBookedAtChange([{ stayDate, at: countBaselineTs }]);
            countPickupSinceChange(metrics, rule, stayDate, countBaselineTs, bookedAtChange);
          } else if (pickupCountsCompleteDays(rule)) {
            await loadBookedAtChange([{ stayDate, at: todayStart }]);
            countPickupToDayStart(metrics, rule, stayDate, todayStart, bookedAtChange);
          }
          if (!cancellablePartsHold(rule, metrics)) {
            off.add(fire.id);
            continue;
          }
          cancelFindings.delete(fire.id);
          keptFires.push({
            fire,
            candidate: candidateFor({
              rule,
              metrics,
              stayDate,
              roomTypeId: rtId,
              now,
              localDate,
              baselineTs: countBaselineTs,
              head: undefined,
            }),
          });
        } catch (e) {
          // A failed read stops the run. Only where what the recount reads
          // does not exist yet is the change not judged, and stays as it is.
          if (!isSchemaGapError(e)) throw e;
          cancelFindings.delete(fire.id);
          console.error(
            JSON.stringify({
              fn: "evaluateHotel",
              step: "cancellation_recount",
              hotelId,
              fireId: fire.id,
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      }
    }
  }
  if (keptFires.length > 0) {
    await recordCounts(keptFires.map((k) => k.candidate));
    for (const { fire, candidate } of keptFires) {
      if (!dry && !(await restateFire(supabase, hotelId, fire.id, candidate))) failedNights.add(fire.stay_date);
    }
  }

  const cancelReasons = new Map([...cancelFindings.keys()].map((id) => [id, "bookings_cancelled" as const]));
  const cancelledIds =
    cancelReasons.size > 0 ? await retire(cancelReasons) : new Set<string>();
  noteUnretired(cancelReasons, cancelledIds);
  const retireReasons = new Map<string, PickupRetireReason>([...resetReasons, ...cancelReasons]);
  const retiredIds = new Set([...resetIds, ...cancelledIds]);
  const retiredByCell = new Map<string, RetiredPickupFire[]>();
  for (const fire of openFires) {
    if (!retiredIds.has(fire.id)) continue;
    const finding = cancelFindings.get(fire.id);
    pushTo(retiredByCell, `${fire.stay_date}|${fire.affected_room_type_id}`, {
      fire,
      reason: retireReasons.get(fire.id)!,
      ...(finding ? { finding } : {}),
    });
  }

  // The fires still on each night, per rule and room type, after this run's
  // retirements (openFireHeads): where every rule counts from, and what the
  // three-changes alert counts. A change that came off covers nothing.
  const openHeads = openFireHeads(rankedEventRules, openFires, retiredIds);

  // Each event rule's fire history on each cell (its highest fire number and
  // where its wait runs from, a fire that came off for cancellations
  // included), paused rules' too, with the counts of the fires still on the
  // night; and the owner's answers to repeat alerts on these nights.
  const fireHeads = new Map<string, FireHead>();
  if (pickupRules.length > 0) {
    for (const [key, head] of await loadPickupFireHeads(supabase, hotelId, rankedEventRules, firstDate, lastDate, runNights)) {
      if (!stayDateSet.has(key.split("|")[1])) continue;
      const open = openHeads.get(key);
      fireHeads.set(key, { ...head, counted: open?.counted ?? 0, lastCountedAt: open?.lastCountedAt ?? null });
    }
  }
  const alertNights =
    pickupRules.length > 0
      ? new Map(
          [
            ...(await loadRepeatAlertNights(supabase, hotelId, pickupRules.map((r) => r.id), firstDate, lastDate, runNights)),
          ].filter(([key]) => stayDateSet.has(key.split("|")[1])),
        )
      : new Map<string, RepeatAlertNight[]>();

  // Per (rule, night) in scope, first each room type's wait and where its
  // Booking Speed condition counts from. A night the owner stopped the rule
  // on is left out entirely. Each cell counts only the bookings that reached
  // MAYA after the fire it counts from (countFromFireAt over openHeads: the
  // rule's own newest fire still on the night, or a newer one by a stronger
  // rule that adjusts the same way, paused or not), for a Booking Speed
  // condition from that fire's day (bookingSpeedCountFrom), for a pickup
  // condition from that fire's instant (see ruleNights).
  //
  // A cell the owner's Skip holds (see SKIP in pickup.ts) is measured the
  // same way, to judge the hold, and the rule does nothing else there. It
  // counts from where Apply would have it count from: without its own
  // changes from before an edit, which Apply takes off. A held room type
  // the rule no longer changes (one with a change of it from before an
  // edit) is judged too, so its hold can end and that change come off.
  type ScopedCell = {
    rtId: string;
    manual: { set_at: string } | undefined;
    waits: boolean;
    fireAt: string | null;
    countFrom: BookingSpeedCountFrom | null;
    /** The owner's Skip holds the rule here: judged, not acted on. */
    hold?: SkipHold;
    /** One of the room types the rule changes. */
    affected: boolean;
  };
  type ScopedNight = { rule: EngineRule; stayDate: string; cells: ScopedCell[] };
  const scopedNights: ScopedNight[] = [];
  const heldOlderFires = new Set(
    openFires
      .filter((f) => {
        if (retiredIds.has(f.id) || !heldKeys.has(fireHeadKey(f.rule_id, f.stay_date, f.affected_room_type_id))) return false;
        const rule = rulesById.get(f.rule_id);
        return rule !== undefined && f.rule_version < rule.version;
      })
      .map((f) => f.id),
  );
  const heldHeads =
    heldOlderFires.size > 0 ? openFireHeads(rankedEventRules, openFires, new Set([...retiredIds, ...heldOlderFires])) : openHeads;
  for (const rule of pickupRules) {
    const waitDays = ruleWaitDays(rule);
    const others = othersOf.get(rule.id)!;
    const affected = new Set(rule.affected_room_type_ids);
    for (const stayDate of stayDates) {
      if (!ruleScopeMatches(rule, stayDate, now, hotelTimeZone)) continue;
      if (isStoppedOnNight(alertNights, rule, stayDate)) continue;
      const heldElsewhere = (holdsByRuleNight.get(`${rule.id}|${stayDate}`) ?? [])
        .map((h) => h.roomTypeId)
        .filter((rtId) => !affected.has(rtId) && isHeld(rule.id, stayDate, rtId));
      const cells = [...rule.affected_room_type_ids, ...heldElsewhere].map((rtId): ScopedCell => {
        const head = fireHeads.get(fireHeadKey(rule.id, stayDate, rtId));
        const manual = manualByCell.get(`${stayDate}|${rtId}`);
        const hold = skipHolds.get(fireHeadKey(rule.id, stayDate, rtId));
        const fireAt = countFromFireAt(
          rule,
          others,
          hold ? heldHeads : openHeads,
          stayDate,
          rtId,
          basePrices.get(basePriceKey(stayDate, rtId)) ?? 100,
        );
        return {
          rtId,
          manual,
          // Whole hotel days: a wait ends when a day begins.
          waits: isWaiting(waitAnchor(rule, head, manual), localDate, waitDays, hotelTimeZone),
          fireAt,
          countFrom: bookingSpeedCountFrom(rule, fireAt, manual, hotelTimeZone),
          ...(hold ? { hold } : {}),
          affected: affected.has(rtId),
        };
      });
      scopedNights.push({ rule, stayDate, cells });
    }
  }

  // The day of each raise a reading counts from, split at the raise: the
  // bookings on the night first seen after it, over the room types
  // measured, where the rule's window reaches that day (an older raise cuts
  // nothing). All of it in one read per set of room types (loadSplitWindows).
  if (bsCtx) {
    const needs: SplitNeed[] = [];
    for (const { rule, stayDate, cells } of scopedNights) {
      if (!rule.condition.booking_speed_operator || rule.signal_room_type_ids.length === 0) continue;
      const windowDays = rule.condition.booking_speed_window_days ?? 7;
      const splits = new Set<string>();
      for (const { countFrom } of cells) {
        if (!countFrom?.since || splits.has(countFrom.since)) continue;
        if (!countFromInWindow(windowDays, localDate, countFrom.from)) continue;
        splits.add(countFrom.since);
        needs.push({ since: countFrom.since, stayDate, signalIds: rule.signal_room_type_ids });
      }
    }
    if (needs.length > 0) await loadSplitWindows(supabase, hotelId, bsCtx, needs);
  }

  // Which of its room types each (rule, night) may fire on now, and which it
  // is still waiting on. A pickup condition's window opens at the fire it
  // counts from (pickupWindowOpensAt), the same newest fire still on the
  // night. Cells are measured together when they count from the same place,
  // so a (rule, night) can come out as more than one entry. A pickup
  // condition that can't be judged on a stretch shorter than its window
  // (pickupJudgesShortStretch) leaves out a cell whose window such a fire
  // cut short: nothing to judge there yet. A cell the rule waits on is
  // measured both ways, for holding it (runPickupPass): from where it counts
  // itself against weaker rules that move the price its way (waitingOwn),
  // and over its whole window against rules that move it the other way
  // (waiting).
  type RuleNight = {
    rule: EngineRule;
    stayDate: string;
    baselineTs: string | null;
    countFrom: BookingSpeedCountFrom | null;
    /** Where baselineTs opened at a fire rather than a whole window back (pickup_counted_since). */
    pickupSince: string | null;
    /** Room types it may fire on now. */
    open: string[];
    /** Room types it waits on, where this is its whole window: it holds them against the other way. */
    waiting: string[];
    /** Room types it waits on, where this is what it counts itself: it holds them against weaker rules its way. */
    waitingOwn: string[];
    /** Cells the owner's Skip holds, judged on this entry's count (see SKIP in pickup.ts). */
    held: HeldCell[];
    metrics?: RuleMetrics;
    matched?: boolean;
  };
  /** A held cell, and where it goes when its hold ends this run. */
  type HeldCell = { rtId: string; hold: SkipHold; waits: boolean; affected: boolean; windowEntry: RuleNight | null };
  const ruleNights: RuleNight[] = [];
  // Held cells with nothing to judge yet (a pickup count cut short, as
  // below): not true.
  const heldUnjudged: SkipHold[] = [];
  for (const { rule, stayDate, cells } of scopedNights) {
    const baselineTs = baselineTsFrom(rule, localDate, hotelTimeZone);
    const shortStretch = pickupJudgesShortStretch(rule);
    const byFrom = new Map<string, RuleNight>();
    const entryFor = (countFrom: BookingSpeedCountFrom | null, cellBaselineTs: string | null) => {
      const key = `${countFrom ? `${countFrom.from}|${countFrom.since ?? ""}` : ""}|${cellBaselineTs ?? ""}`;
      let entry = byFrom.get(key);
      if (!entry) {
        entry = {
          rule,
          stayDate,
          countFrom,
          baselineTs: cellBaselineTs,
          pickupSince: cellBaselineTs !== baselineTs ? cellBaselineTs : null,
          open: [],
          waiting: [],
          waitingOwn: [],
          held: [],
        };
        byFrom.set(key, entry);
      }
      return entry;
    };
    for (const { rtId, manual, waits, fireAt, countFrom, hold, affected } of cells) {
      if (hold) {
        const cellBaselineTs = pickupWindowOpensAt(
          baselineTs,
          baselineTs === null ? null : fireAt,
          manual,
          pickupFireDayStart(rule, fireAt, hotelTimeZone),
        );
        if (cellBaselineTs !== baselineTs && !shortStretch) {
          heldUnjudged.push(hold);
          continue;
        }
        const windowEntry = affected && waits ? entryFor(null, baselineTs) : null;
        entryFor(countFrom, cellBaselineTs).held.push({ rtId, hold, waits, affected, windowEntry });
        continue;
      }
      if (waits) entryFor(null, baselineTs).waiting.push(rtId);
      const cellBaselineTs = pickupWindowOpensAt(
        baselineTs,
        baselineTs === null ? null : fireAt,
        manual,
        pickupFireDayStart(rule, fireAt, hotelTimeZone),
      );
      if (cellBaselineTs !== baselineTs && !shortStretch) continue;
      const entry = entryFor(countFrom, cellBaselineTs);
      (waits ? entry.waitingOwn : entry.open).push(rtId);
    }
    ruleNights.push(...byFrom.values());
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
    attachBookingSpeed(rn.rule, rn.stayDate, metrics, rn.countFrom);
    noteExcludedSignals(rn.rule, metrics);
    if (rn.pickupSince) {
      metrics.pickup_counted_since = rn.pickupSince;
      countPickupSinceChange(metrics, rn.rule, rn.stayDate, rn.pickupSince, bookedAtChange);
    } else if (pickupCountsCompleteDays(rn.rule)) {
      countPickupToDayStart(metrics, rn.rule, rn.stayDate, todayStart, bookedAtChange);
    }
    rn.metrics = metrics;
    rn.matched = ruleConditionsMatch(rn.rule, metrics);
  };
  // What each count reads by first-seen time: where a count from a change
  // opened, or where a count of complete days ended (the start of today).
  const sinceChangePairs = (list: RuleNight[]) =>
    list.flatMap((rn) =>
      rn.metrics
        ? []
        : rn.pickupSince
          ? [{ stayDate: rn.stayDate, at: rn.pickupSince }]
          : pickupCountsCompleteDays(rn.rule)
            ? [{ stayDate: rn.stayDate, at: todayStart }]
            : [],
    );
  const withBaseline = (list: RuleNight[]) =>
    list.flatMap((rn) =>
      rn.baselineTs
        ? [{ rule: rn.rule, stayDate: rn.stayDate, baselineTs: rn.baselineTs, atFire: rn.pickupSince != null }]
        : [],
    );
  // The owner's Skip holds (see SKIP in pickup.ts), each judged on what the
  // rule counts there. The first time the rule is true after being not
  // true, the hold ends: its changes there from before an edit come off, as
  // Apply takes them off (and a standard rule's, from before an edit made it
  // a booking speed or pickup rule), and it acts there in this very run.
  const heldEntries = ruleNights.filter((rn) => rn.held.length > 0);
  const released: (HeldCell & { rn: RuleNight })[] = [];
  if (heldEntries.length > 0) {
    await preloadSharedBaselines(snapshots, withBaseline(heldEntries));
    await loadBookedAtChange(sinceChangePairs(heldEntries));
    for (const rn of heldEntries) {
      await measure(rn);
      for (const cell of rn.held) if (judgeHold(cell.hold, rn.matched === true)) released.push({ ...cell, rn });
    }
  }
  for (const hold of heldUnjudged) judgeHold(hold, false);
  if (released.length > 0) {
    const releasedKeys = new Set(released.map(({ rn, rtId }) => fireHeadKey(rn.rule.id, rn.stayDate, rtId)));
    const olderReasons = new Map<string, PickupRetireReason>();
    for (const fire of openFires) {
      if (retiredIds.has(fire.id) || Date.parse(fire.applied_at) >= Date.parse(now)) continue;
      if (!releasedKeys.has(fireHeadKey(fire.rule_id, fire.stay_date, fire.affected_room_type_id))) continue;
      const rule = rulesById.get(fire.rule_id);
      if (rule && fire.rule_version < rule.version) olderReasons.set(fire.id, "rule_edited");
    }
    if (olderReasons.size > 0) {
      const done = await retire(olderReasons);
      noteUnretired(olderReasons, done);
      for (const fire of openFires) {
        if (!done.has(fire.id)) continue;
        retiredIds.add(fire.id);
        retireReasons.set(fire.id, "rule_edited");
        pushTo(retiredByCell, `${fire.stay_date}|${fire.affected_room_type_id}`, { fire, reason: "rule_edited" });
      }
    }
    let ladderMoved = false;
    for (const { rn, rtId } of released) {
      const state = ladderBatch.state(rn.rule.id, rn.stayDate, rtId);
      if (!state?.is_active) continue;
      ladderBatch.deactivate(rn.rule, hotelId, rn.stayDate, rtId, rn.metrics!, now, supportsSuppression, {
        clearSkip: !!state.skip_state,
      });
      noteLeftoverDeactivation(rn.rule, rn.stayDate, rtId, rn.metrics!);
      ladderMoved = true;
    }
    if (ladderMoved) await ladderBatch.flush();
    for (const { rn, rtId, waits, affected, windowEntry } of released) {
      if (!affected) continue;
      (waits ? rn.waitingOwn : rn.open).push(rtId);
      windowEntry?.waiting.push(rtId);
    }
  }
  if (!dry && (holdsJudged.length > 0 || holdsEnded.length > 0)) {
    const failed = await writeSkipHolds(supabase, holdsJudged, holdsEnded);
    for (const d of failed) failedNights.add(d);
    if (failed.length > 0) {
      console.error(JSON.stringify({ fn: "evaluateHotel", step: "skip_holds", hotelId, failed_nights: failed.length }));
    }
  }

  const pickupEffectsByCell = pickupEffectsFromFires(openFires, retiredIds);
  // Ladder writes are flushed: these are the rows the pass left active.
  const ladderEffectsByCell = await loadActiveLadderEffectsForRange(
    supabase,
    roomTypeIds,
    firstDate,
    lastDate,
    supportsSuppression,
    runNights,
    ladderBatch.supportsSkip,
  );
  // Only this hotel's rules move its prices (keepOwnRuleEffects).
  const foreignRules = await keepOwnRuleEffects(supabase, hotelId, ladderEffectsByCell, new Set(rules.map((r) => r.id)));
  if (foreignRules.length > 0) {
    console.error(
      JSON.stringify({
        fn: "evaluateHotel",
        step: "ladder_effects",
        hotelId,
        message: "changes by rules of another hotel on this hotel's room types were left out",
        ruleIds: foreignRules,
      }),
    );
  }
  // A dry run wrote nothing: its own decisions go over what the table holds.
  if (dry) applyLadderOps(ladderEffectsByCell, ladderBatch.ops());

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
  await loadBookedAtChange(sinceChangePairs(measured));
  for (const rn of measured) await measure(rn);

  // The price each cell would publish before anything fires, for the guards
  // below: a cut already at the floor or a raise already at the ceiling can't
  // move the price, so it doesn't fire and starts no wait, and neither does
  // an adjustment that leaves the price where it is whatever the limits say
  // (a percent on a price of 0). A raise on a night the owner gave away at 0
  // is refused outright. A cell this run leaves unpriced (no base, a closed
  // night, an inactive room type) gets no fire at all.
  const currentByCell = new Map<string, { price: AssembledPrice; bounds: { floor: number; ceiling: number } } | null>();
  const currentPrice = (stayDate: string, rtId: string) => {
    const key = `${stayDate}|${rtId}`;
    if (!currentByCell.has(key)) {
      const rt = roomTypeById.get(rtId);
      const base = basePrices.get(key);
      if (!rt || base === undefined) {
        currentByCell.set(key, null);
      } else {
        const source = baseSourceByCell.get(key) ?? "calendar";
        const assembled = assemblePriceFrom(
          stayDate,
          rt,
          base,
          source,
          ladderEffectsByCell.get(key) ?? [],
          pickupEffectsByCell.get(key) ?? [],
        );
        currentByCell.set(key, {
          price: assembled,
          bounds: priceBounds(rt.floor_price, rt.ceiling_price, base, source),
        });
      }
    }
    return currentByCell.get(key)!;
  };

  const allPickupCandidates: PickupCandidate[] = [];
  const allPickupNoPriceChange = new Map<string, PickupCandidate[]>();
  const allPickupCompNight = new Map<string, PickupCandidate[]>();
  for (const rn of measured) {
    if (!rn.matched) continue;
    for (const rtId of rn.open) {
      const current = currentPrice(rn.stayDate, rtId);
      if (!current) continue;
      const c = candidate(rn, rtId);
      const adjustment = {
        rule_id: rn.rule.id,
        action_kind: rn.rule.action_type,
        action_direction: rn.rule.action_direction,
        action_value: rn.rule.action_value,
      };
      // A night given away at 0 is the owner's number, and no rule raises it
      // (pricing.ts isCompNight). Its own outcome, because it is not the
      // limits holding the price: a fixed raise would move it every time.
      if (compNightBlocks(current.price.base_price, current.price.base_source, rn.rule.action_direction)) {
        pushTo(allPickupCompNight, `${rn.stayDate}|${rtId}`, c);
        continue;
      }
      if (
        !limitAllowsFire(current.price.final_price, current.bounds, rn.rule.action_direction) ||
        !firingMovesPrice(
          current.price.base_price,
          current.price.ladder_effects,
          current.price.pickup_effects,
          adjustment,
        )
      ) {
        pushTo(allPickupNoPriceChange, `${rn.stayDate}|${rtId}`, c);
        continue;
      }
      allPickupCandidates.push(c);
    }
  }

  // Rules still waiting on a cell that has a live candidate hold it when
  // their conditions still match (runPickupPass): against weaker rules that
  // move the price their way on what they would count themselves, against
  // the other way on their whole window.
  const liveCells = new Set(allPickupCandidates.map((c) => `${c.stay_date}|${c.affected_room_type_id}`));
  const holders: WaitingHolder[] = [];
  if (liveCells.size > 0) {
    const live = (rn: RuleNight, list: string[]) => list.filter((rtId) => liveCells.has(`${rn.stayDate}|${rtId}`));
    const holding = ruleNights.filter((rn) => live(rn, rn.waiting).length > 0 || live(rn, rn.waitingOwn).length > 0);
    await preloadSharedBaselines(snapshots, withBaseline(holding.filter((rn) => !rn.metrics)));
    await loadBookedAtChange(sinceChangePairs(holding));
    for (const rn of holding) {
      await measure(rn);
      if (!rn.matched) continue;
      for (const rtId of live(rn, rn.waiting)) holders.push({ candidate: candidate(rn, rtId), against: "other_way" });
      for (const rtId of live(rn, rn.waitingOwn)) holders.push({ candidate: candidate(rn, rtId), against: "same_way" });
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
    // What each winner counted is recorded on it just before it is written
    // (recordCounts): one read for every night that gets a fire.
    // A dry run records nothing on its fires.
    const pass = await runPickupPass(
      supabase,
      allPickupCandidates,
      hotelId,
      basePrices,
      holders,
      dry ? undefined : recordCounts,
      !!dry,
    );
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
    for (const f of pass.write_failures) {
      pushTo(allPickupWriteFailures, cellOf(f), f);
      failedNights.add(f.stay_date);
    }
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

  // The nights the watched rule's condition was met on, fire or hold.
  if (touched && watch) {
    for (const rn of ruleNights) if (watched.has(rn.rule.id) && rn.matched) touched.add(rn.stayDate);
  }

  // The signature of the last audit row per cell, so writeAudit can skip
  // cells whose price and applied rules haven't moved since last time —
  // see auditSignature's doc comment for why this matters.
  const lastAuditSignatures = dry
    ? new Map<string, string>()
    : await loadLastAuditSignatures(supabase, hotelId, stayDates[0], stayDates[stayDates.length - 1], runNights);

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
        baseSourceByCell.get(key) ?? "calendar",
        ladderEffectsByCell.get(key) ?? [],
        pickupEffectsByCell.get(key) ?? [],
      );
      assembledCells.push({ key, basePrice, assembled });
    }
  }

  const failedCells = new Set<string>();
  if (dry) {
    for (const c of assembledCells) dry.capture.prices.set(c.key, c.assembled.final_price);
    for (const key of unpricedPublished) dry.capture.unpriced.add(key);
    if (report) {
      report.momentumNights = bsCtx ? stayDates.filter((d) => usesMomentum(bsCtx!, d)) : [];
      report.engineMs = Date.now() - startedMs;
    }
    return {
      run_id: runId,
      hotel_id: hotelId,
      stay_dates_evaluated: stayDates.length,
      prices_published: 0,
      ladder_activations: ladderActivations,
      ladder_deactivations: ladderDeactivations,
      pickup_events_created: pickupEventsCreated,
    };
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
    failedCells,
  );
  for (const key of failedCells) failedNights.add(key.split("|")[0]);
  pricesPublished = publishedKeys.size;
  // Whatever an earlier run published for a night this run left unpriced is
  // no longer MAYA's price, and must neither show as one nor be pushed.
  if (unpricedPublished.length > 0) {
    await clearUnpricedCells(supabase, hotelId, unpricedPublished, {
      removedInPms: new Set(unpricedPublished.filter((key) => removedInPmsAt.has(key))),
    });
  }

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
      pickupCompNight: allPickupCompNight.get(key) ?? [],
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
  for (const row of await insertAuditRows(supabase, auditRows)) {
    if (typeof row.stay_date === "string") failedNights.add(row.stay_date);
  }

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
        recordRunHeartbeat(
          supabase,
          hotelId,
          runId,
          now,
          cellsChecked,
          cellsChanged,
          // A set of nights with gaps names no range: nothing may read it as
          // having priced the nights in between.
          !opts.nights || isContiguousNights(stayDates)
            ? { first: stayDates[0], last: stayDates[stayDates.length - 1] }
            : null,
          opts.runKind || opts.nights
            ? {
                runKind: opts.runKind ?? "nights",
                nightsPriced: stayDates.length,
                list: opts.nights && !isContiguousNights(stayDates) ? stayDates : null,
              }
            : undefined,
        ),
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
              cancelledNights: new Set(
                openFires
                  .filter((f) => cancelledIds.has(f.id))
                  .map((f) => `${f.rule_id}|${f.stay_date}`),
              ),
              roomTypes,
              finalPriceByCell: new Map(assembledCells.map((c) => [c.key, c.assembled.final_price])),
              hotelTimeZone,
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

  if (report) {
    report.failedNights = [...failedNights].filter((d) => stayDateSet.has(d)).sort();
    report.momentumNights = bsCtx ? stayDates.filter((d) => usesMomentum(bsCtx!, d)) : [];
    for (const fire of openFires) if (retiredIds.has(fire.id)) changedNights.add(fire.stay_date);
    for (const { fire } of keptFires) changedNights.add(fire.stay_date);
    for (const wins of allPickupWinners.values()) for (const w of wins) changedNights.add(w.candidate.stay_date);
    report.changedNights = [...changedNights].filter((d) => stayDateSet.has(d)).sort();
    report.engineMs = Date.now() - startedMs;
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
