/**
 * What the owner's own past year of bookings shows about how they move their
 * rates, and the starter rules each answer to the last onboarding question
 * calls for (G24, Jake 2026-09-28):
 *
 *   no answer          the booking speed ladder, as always
 *   automate_current   rules that copy the raises and cuts the owner already
 *                      makes, sized like theirs ("My pricing works, automate it")
 *   find_upside        the ladder, with bigger raises where nights filled
 *                      early, plus a raise on nearly full nights where their
 *                      rates stayed flat ("Find money I'm leaving on the table")
 *
 * Every comparison is made WITHIN one night and room type. The owner's rate
 * plan already holds their weekday, weekend and season differences, and that
 * rate is the base a rule starts from, so a rule that copied them would apply
 * them twice. What a rule can add is the move the owner makes on top of it as
 * a night fills up or gets close, and a within-night comparison sees only that:
 * each booking's rate is read against the night's early rate, what guests paid
 * booking it a week or more ahead while it was under 40% booked.
 *
 * "How full the night already was" counts the rooms booked for that night on
 * earlier days among the bookings still on record, over the rooms of the room
 * types that count as rooms, the same set the starter rules measure.
 *
 * Pure except for loadRateHistory. The numbers each rule's explanation quotes
 * are the ones its condition and size came from.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeStarterRules,
  LADDER_RAISES,
  type LadderRaises,
  type StarterRuleSpec,
} from "./generate-rules.ts";

export type PricingConfidence = "automate_current" | "find_upside";

/** hotel_settings.pricing_confidence as stored, or null for no answer. */
export function pricingConfidenceOf(value: unknown): PricingConfidence | null {
  return value === "automate_current" || value === "find_upside" ? value : null;
}

/** One booking-night: the night, when it was booked, its room type and rate. */
export type RateHistoryRow = {
  stay_date: string;
  booking_date: string;
  room_type_id: string;
  rate: number;
};

/** How far back the reading goes: the owner's current habits, not old ones. */
export const RATE_MOVES_DAYS = 365;

/** The early rate: bookings made while the night was under this share booked... */
export const EARLY_UNDER_FULL = 0.4;
/** ...and at least this many days ahead. */
export const EARLY_MIN_DAYS_AHEAD = 7;
/** A move smaller than this is noise, not a move the owner makes. */
export const MIN_MOVE_PCT = 5;
/** A band of bookings is read only with at least this many in it. */
export const BAND_MIN_BOOKINGS = 8;
/** A copied rule needs at least this many bookings behind it... */
export const MIN_BOOKINGS = 20;
/** ...spread over at least this many nights. */
export const MIN_NIGHTS = 10;
/** Bigger gaps than these read more like a different rate plan than a move. */
export const MAX_RAISE_PCT = 50;
export const MAX_CUT_PCT = 40;
/** Weekend and weekday moves this close are one move, and get one rule. */
export const SAME_SIZE_PTS = 3;
/** Lower edges of the "how full" bands, in percent; each is 10 points wide, the top one open. */
export const FILL_BANDS = [40, 50, 60, 70, 80, 90] as const;
/** Late bookings are read only on nights still under this share booked. */
export const LATE_UNDER_FULL = 0.5;

/** find_upside: nights this full... */
export const FILLED_EARLY_FULL = 0.9;
/** ...this many days before arrival... */
export const FILLED_EARLY_DAYS = 14;
/** ...on at least this many nights and this share of the nights read, earn bigger raises. */
export const FILLED_EARLY_MIN_NIGHTS = 10;
export const FILLED_EARLY_MIN_SHARE = 0.1;
/** The bigger raises. */
export const UPSIDE_RAISES: LadderRaises = { warm: 15, hotWeek: 30, spike: 30 };
/** find_upside: "nearly full" is more than this share booked... */
export const NEARLY_FULL = 0.8;
/** ...and rates within this many percent of the early rate there count as flat. */
export const FLAT_WITHIN_PCT = 2;
/** The raise offered on nearly full nights. */
export const NEARLY_FULL_RAISE_PCT = 10;

export type NightGroup = "all" | "weekend" | "weekday";

/** pricing_rules.dow_mask for each group: Fri=16 and Sat=32 are the weekend. */
export const GROUP_DOW_MASK: Record<NightGroup, number> = { all: 127, weekend: 48, weekday: 79 };

export type FillMove = {
  group: NightGroup;
  /** The raise starts once the night is MORE than this percent booked. */
  thresholdPct: number;
  changePct: number;
  nights: number;
  bookings: number;
};

export type LateMove = {
  group: NightGroup;
  /** Bookings made fewer than this many days ahead. */
  withinDays: 3 | 7;
  /** Negative for a cut. */
  changePct: number;
  nights: number;
  bookings: number;
};

export type RateMoves = {
  /** Past nights in the window with at least one booking. */
  nightsRead: number;
  fill: FillMove[];
  late: LateMove[];
  /** Bookings on nearly full nights paid about the early rate. */
  flatWhenNearlyFull: { changePct: number; nights: number; bookings: number } | null;
  /** Nights already FILLED_EARLY_FULL booked FILLED_EARLY_DAYS or more days out. */
  filledEarly: { nights: number; share: number };
};

type Obs = {
  night: string;
  group: "weekend" | "weekday";
  /** Share of rooms booked on earlier days. */
  full: number;
  daysAhead: number;
  /** This booking's rate over the night's early rate for its room type. */
  ratio: number;
};

const DAY_MS = 86_400_000;

function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / DAY_MS);
}

function groupOf(ymd: string): "weekend" | "weekday" {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return dow === 5 || dow === 6 ? "weekend" : "weekday";
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The median move of a set of bookings over their early rates, in whole percent. */
function movePct(list: Obs[]): number {
  return Math.round((median(list.map((o) => o.ratio)) - 1) * 100);
}

function summarize(list: Obs[]): { changePct: number; nights: number; bookings: number } {
  return {
    changePct: list.length ? movePct(list) : 0,
    nights: new Set(list.map((o) => o.night)).size,
    bookings: list.length,
  };
}

const enough = (s: { nights: number; bookings: number }) => s.bookings >= MIN_BOOKINGS && s.nights >= MIN_NIGHTS;

/**
 * The raise as a night fills, for one group of nights. Walking the bands from
 * the top down, each band with enough bookings that shows a raise moves the
 * start down to it; the first one that does not stops the walk. So the raise
 * starts at the lowest band that shows one with none above it failing to, and
 * is sized at the middle of every booking above that point.
 */
function fillFor(obs: Obs[], fixedThresholdPct?: number): Omit<FillMove, "group"> | null {
  const inBand = (o: Obs, b: number) => o.full > b / 100 && (b === 90 || o.full <= (b + 10) / 100);
  let start: number | null = fixedThresholdPct ?? null;
  if (start == null) {
    for (let i = FILL_BANDS.length - 1; i >= 0; i -= 1) {
      const b = FILL_BANDS[i];
      const band = obs.filter((o) => inBand(o, b));
      if (band.length < BAND_MIN_BOOKINGS) continue;
      if (movePct(band) >= MIN_MOVE_PCT) start = b;
      else break;
    }
  }
  if (start == null) return null;
  const threshold = start;
  const s = summarize(obs.filter((o) => o.full > threshold / 100));
  if (!enough(s) || s.changePct < MIN_MOVE_PCT || s.changePct > MAX_RAISE_PCT) return null;
  return { thresholdPct: threshold, ...s };
}

/**
 * The move on bookings made close to arrival while the night was still under
 * half booked, for one group of nights: 0 to 2 days ahead, and 3 to 6. Both
 * showing the same move makes it a 7-day window, the nearest alone a 3-day one.
 */
function lateFor(obs: Obs[], fixedWithinDays?: 3 | 7): Omit<LateMove, "group"> | null {
  const late = obs.filter((o) => o.full < LATE_UNDER_FULL && o.daysAhead < 7);
  const near = late.filter((o) => o.daysAhead < 3);
  const mid = late.filter((o) => o.daysAhead >= 3);
  let within: 3 | 7 | null = fixedWithinDays ?? null;
  if (within == null) {
    const shows = (l: Obs[]) => {
      if (l.length < BAND_MIN_BOOKINGS) return 0;
      const m = movePct(l);
      return Math.abs(m) >= MIN_MOVE_PCT ? Math.sign(m) : 0;
    };
    const sNear = shows(near);
    const sMid = shows(mid);
    if (sMid !== 0 && (near.length < BAND_MIN_BOOKINGS || sNear === sMid)) within = 7;
    else if (sNear !== 0) within = 3;
  }
  if (within == null) return null;
  const s = summarize(within === 7 ? late : near);
  if (!enough(s) || Math.abs(s.changePct) < MIN_MOVE_PCT) return null;
  if (s.changePct > MAX_RAISE_PCT || s.changePct < -MAX_CUT_PCT) return null;
  return { withinDays: within, ...s };
}

/**
 * Read a move on Friday and Saturday nights and on the other nights. Both
 * showing the same move gives one rule for every night, sized on all of them;
 * different moves give one rule per group; neither alone having enough, all
 * nights together can still show one.
 */
function byGroup<T extends { changePct: number }, K extends number>(
  obs: Obs[],
  read: (list: Obs[], fixed?: K) => T | null,
  keyOf: (t: T) => K,
): Array<T & { group: NightGroup }> {
  const weekend = read(obs.filter((o) => o.group === "weekend"));
  const weekday = read(obs.filter((o) => o.group === "weekday"));
  if (weekend && weekday) {
    const same =
      keyOf(weekend) === keyOf(weekday) &&
      Math.sign(weekend.changePct) === Math.sign(weekday.changePct) &&
      Math.abs(weekend.changePct - weekday.changePct) <= SAME_SIZE_PTS;
    if (same) {
      const all = read(obs, keyOf(weekend));
      if (all) return [{ ...all, group: "all" }];
    }
    return [
      { ...weekend, group: "weekend" },
      { ...weekday, group: "weekday" },
    ];
  }
  if (weekend) return [{ ...weekend, group: "weekend" }];
  if (weekday) return [{ ...weekday, group: "weekday" }];
  const all = read(obs);
  return all ? [{ ...all, group: "all" }] : [];
}

/**
 * The owner's moves, from their past nights' bookings. `rooms` is how many
 * rooms the room types in `rows` hold between them.
 */
export function readRateMoves(rows: RateHistoryRow[], rooms: number): RateMoves {
  const byNight = new Map<string, RateHistoryRow[]>();
  for (const r of rows) {
    if (!(r.rate > 0) || !r.booking_date || r.booking_date > r.stay_date) continue;
    const list = byNight.get(r.stay_date);
    if (list) list.push(r);
    else byNight.set(r.stay_date, [r]);
  }
  const nightsRead = byNight.size;
  if (rooms <= 0 || nightsRead === 0) {
    return { nightsRead, fill: [], late: [], flatWhenNearlyFull: null, filledEarly: { nights: 0, share: 0 } };
  }

  const obs: Obs[] = [];
  let filledEarlyNights = 0;
  for (const [night, list] of byNight) {
    const group = groupOf(night);
    const sorted = [...list].sort((a, b) => (a.booking_date < b.booking_date ? -1 : a.booking_date > b.booking_date ? 1 : 0));
    // Rooms booked on earlier days, for each booking.
    const fullAt = new Map<RateHistoryRow, number>();
    let booked = 0;
    for (let i = 0; i < sorted.length; ) {
      let j = i;
      while (j < sorted.length && sorted[j].booking_date === sorted[i].booking_date) j += 1;
      for (let k = i; k < j; k += 1) fullAt.set(sorted[k], booked / rooms);
      booked += j - i;
      i = j;
    }
    const bookedEarly = sorted.filter((r) => daysBetween(r.booking_date, night) >= FILLED_EARLY_DAYS).length;
    if (bookedEarly / rooms >= FILLED_EARLY_FULL) filledEarlyNights += 1;

    const byType = new Map<string, RateHistoryRow[]>();
    for (const r of sorted) {
      const l = byType.get(r.room_type_id);
      if (l) l.push(r);
      else byType.set(r.room_type_id, [r]);
    }
    for (const typeRows of byType.values()) {
      const isEarly = (r: RateHistoryRow) =>
        fullAt.get(r)! < EARLY_UNDER_FULL && daysBetween(r.booking_date, night) >= EARLY_MIN_DAYS_AHEAD;
      const early = typeRows.filter(isEarly);
      if (early.length === 0) continue;
      const earlyRate = median(early.map((r) => r.rate));
      for (const r of typeRows) {
        if (isEarly(r)) continue;
        obs.push({ night, group, full: fullAt.get(r)!, daysAhead: daysBetween(r.booking_date, night), ratio: r.rate / earlyRate });
      }
    }
  }

  const fill = byGroup(obs, fillFor, (m) => m.thresholdPct);
  const late = byGroup(obs, lateFor, (m) => m.withinDays);

  const nearlyFull = summarize(obs.filter((o) => o.full > NEARLY_FULL));
  const flatWhenNearlyFull =
    enough(nearlyFull) && Math.abs(nearlyFull.changePct) <= FLAT_WITHIN_PCT ? nearlyFull : null;

  return {
    nightsRead,
    fill,
    late,
    flatWhenNearlyFull,
    filledEarly: { nights: filledEarlyNights, share: filledEarlyNights / nightsRead },
  };
}

/* ── The rules each answer calls for ─────────────────────────────────────── */

export type StarterRuleSet = {
  rules: StarterRuleSpec[];
  /** Shown over the rules on the review when the set is not what the answer asked for. */
  note?: string;
};

/** "none" is no answer on file. */
export type StarterRuleSetKey = "none" | PricingConfidence;
export type StarterRuleSets = Record<StarterRuleSetKey, StarterRuleSet>;

export const NOTHING_TO_COPY_NOTE =
  `In the past year of your bookings, no raise or cut of ${MIN_MOVE_PCT}% or more showed up across at least ` +
  `${MIN_NIGHTS} nights, so there was nothing of yours to copy. These are the usual five starting rules.`;

const EARLY_GUESTS =
  "its early guests, who booked a week or more ahead while it was under 40% booked";

const GROUP_WORDS: Record<NightGroup, { nights: string; aNight: string; suffix: string }> = {
  all: { nights: "nights", aNight: "a night", suffix: "" },
  weekend: { nights: "Friday and Saturday nights", aNight: "a Friday or Saturday night", suffix: " (Fri and Sat)" },
  weekday: { nights: "Sunday to Thursday nights", aNight: "a Sunday to Thursday night", suffix: " (Sun to Thu)" },
};

/** Standard rules, like one built in the rule builder. */
const COPIED_PRIORITY = 100;

const FILL_RULE_NAME = "Filling-up raise";
const NEARLY_FULL_RULE_NAME = "Nearly-full raise";

/**
 * A rule named as the answer's occupancy raises are: a copied Filling-up
 * raise (any days) or the Nearly-full raise. Its threshold came from the
 * owner's own bookings, so "Get suggestions" offers no Tune card that would
 * move it to a level read another way.
 */
export function isOwnBookingsRaiseName(name: string): boolean {
  return (
    name === NEARLY_FULL_RULE_NAME ||
    Object.values(GROUP_WORDS).some((w) => name === `${FILL_RULE_NAME}${w.suffix}`)
  );
}

function fillRule(m: FillMove): StarterRuleSpec {
  const w = GROUP_WORDS[m.group];
  return {
    name: `${FILL_RULE_NAME}${w.suffix}`,
    priority: COPIED_PRIORITY,
    condition: { occupancy_operator: "gt", occupancy_threshold: m.thresholdPct / 100 },
    action: { action_type: "percent", action_direction: "increase", action_value: m.changePct },
    is_pickup_rule: false,
    dow_mask: GROUP_DOW_MASK[m.group],
    source: "your_moves",
    explanation:
      `On ${m.nights} ${w.nights} in the past year, guests who booked once the night was more than ` +
      `${m.thresholdPct}% booked paid about ${m.changePct}% more than ${EARLY_GUESTS}. This rule does the ` +
      `same: once ${w.aNight} is more than ${m.thresholdPct}% booked, it raises the price ${m.changePct}%.`,
  };
}

function lateRule(m: LateMove): StarterRuleSpec {
  const w = GROUP_WORDS[m.group];
  const cut = m.changePct < 0;
  const size = Math.abs(m.changePct);
  return {
    name: `Last-minute ${cut ? "cut" : "raise"}${w.suffix}`,
    priority: COPIED_PRIORITY,
    condition: {
      dta_operator: "lt",
      dta_threshold_days: m.withinDays,
      occupancy_operator: "lt",
      occupancy_threshold: LATE_UNDER_FULL,
    },
    action: { action_type: "percent", action_direction: cut ? "decrease" : "increase", action_value: size },
    is_pickup_rule: false,
    dow_mask: GROUP_DOW_MASK[m.group],
    source: "your_moves",
    explanation:
      `On ${m.nights} ${w.nights} in the past year, guests who booked fewer than ${m.withinDays} days ahead, ` +
      `while the night was still under half booked, paid about ${size}% ${cut ? "less" : "more"} than ` +
      `${EARLY_GUESTS}. This rule does the same: when ${w.aNight} is fewer than ${m.withinDays} days away ` +
      `and under half booked, it ${cut ? "cuts" : "raises"} the price ${size}%.`,
  };
}

/** automate_current: the owner's own moves as rules, raises first. */
export function copiedRules(moves: RateMoves): StarterRuleSpec[] {
  return [...moves.fill.map(fillRule), ...moves.late.map(lateRule)];
}

/** find_upside: the ladder, bigger raises when nights filled early, and the nearly-full raise. */
export function upsideRules(daysOfHistory: number, moves: RateMoves): StarterRuleSpec[] {
  const early = moves.filledEarly;
  const bigger = early.nights >= FILLED_EARLY_MIN_NIGHTS && early.share >= FILLED_EARLY_MIN_SHARE;
  const raises = bigger ? UPSIDE_RAISES : LADDER_RAISES;
  const ladder = computeStarterRules({ daysOfHistory, raises }).map((spec): StarterRuleSpec => {
    if (!bigger || spec.action.action_direction !== "increase") return { ...spec, source: "upside" };
    const usual =
      spec.name === "Warm-date bump" ? LADDER_RAISES.warm : spec.name === "Hot-week surge" ? LADDER_RAISES.hotWeek : LADDER_RAISES.spike;
    return {
      ...spec,
      source: "upside",
      explanation:
        `${spec.explanation} It raises ${spec.action.action_value}% rather than the usual ${usual}%: ` +
        `${early.nights} of your nights in the past year were already ${Math.round(FILLED_EARLY_FULL * 100)}% ` +
        `booked ${FILLED_EARLY_DAYS / 7} weeks or more before arrival.`,
    };
  });
  if (ladder.length === 0) return [];
  const flat = moves.flatWhenNearlyFull;
  if (!flat || moves.fill.length > 0) return ladder;
  const nearlyPct = Math.round(NEARLY_FULL * 100);
  return [
    ...ladder,
    {
      name: NEARLY_FULL_RULE_NAME,
      priority: COPIED_PRIORITY,
      condition: { occupancy_operator: "gt", occupancy_threshold: NEARLY_FULL },
      action: { action_type: "percent", action_direction: "increase", action_value: NEARLY_FULL_RAISE_PCT },
      is_pickup_rule: false,
      dow_mask: 127,
      source: "upside",
      explanation:
        `On ${flat.nights} nights in the past year, guests who booked once the night was more than ` +
        `${nearlyPct}% booked paid within ${FLAT_WITHIN_PCT}% of what ${EARLY_GUESTS} paid. This rule ` +
        `raises the price ${NEARLY_FULL_RAISE_PCT}% once a night is more than ${nearlyPct}% booked.`,
    },
  ];
}

/**
 * All three sets, so the rules can be swapped when the answer arrives after
 * they were built. No set at all below the starter rules' history minimum.
 */
export function starterRuleSets(input: { daysOfHistory: number; moves: RateMoves }): StarterRuleSets {
  const ladder = computeStarterRules({ daysOfHistory: input.daysOfHistory });
  if (ladder.length === 0) {
    return { none: { rules: [] }, automate_current: { rules: [] }, find_upside: { rules: [] } };
  }
  const copied = copiedRules(input.moves);
  return {
    none: { rules: ladder },
    automate_current: copied.length > 0 ? { rules: copied } : { rules: ladder, note: NOTHING_TO_COPY_NOTE },
    find_upside: { rules: upsideRules(input.daysOfHistory, input.moves) },
  };
}

/* ── Reading the history ─────────────────────────────────────────────────── */

/**
 * At most this many booking-nights are read, newest nights first. A year of a
 * 500-room property is well over 100,000, and the analysis runs as one call
 * inside the worker's time limit; a few months of a big property is already
 * far more than any move needs.
 */
export const MAX_RATE_ROWS = 50_000;

/**
 * The past year's booking-nights on `roomTypeIds`, with a booking date and a
 * rate above 0, and how many rooms those room types hold. Paged on
 * (stay_date, id), newest first, like the engine's reads; past MAX_RATE_ROWS
 * the oldest night read is dropped, since it may be only partly read. A
 * failed page throws, so the worker retries instead of reading a fragment.
 */
export async function loadRateHistory(
  supabase: SupabaseClient,
  hotelId: string,
  roomTypeIds: string[],
  todayYmd: string,
): Promise<{ rows: RateHistoryRow[]; rooms: number }> {
  if (roomTypeIds.length === 0) return { rows: [], rooms: 0 };
  const { data: types, error: typesErr } = await supabase
    .from("room_types")
    .select("id, total_rooms")
    .in("id", roomTypeIds);
  if (typesErr) throw new Error(`room counts failed: ${typesErr.message}`);
  const rooms = (types ?? []).reduce((sum, t) => sum + (Number(t.total_rooms) || 0), 0);

  const from = new Date(Date.parse(`${todayYmd}T00:00:00Z`) - RATE_MOVES_DAYS * DAY_MS).toISOString().slice(0, 10);
  const PAGE = 1000;
  const rows: RateHistoryRow[] = [];
  let cursor: { stayDate: string; id: string } | null = null;
  for (;;) {
    let q = supabase
      .from("reservations")
      .select("id, stay_date, booking_date, room_type_id, current_rate")
      .eq("hotel_id", hotelId)
      .gte("stay_date", from)
      .lt("stay_date", todayYmd)
      .in("room_type_id", roomTypeIds)
      .not("booking_date", "is", null)
      .gt("current_rate", 0);
    if (cursor) q = q.or(`stay_date.lt.${cursor.stayDate},and(stay_date.eq.${cursor.stayDate},id.lt.${cursor.id})`);
    const { data, error } = await q
      .order("stay_date", { ascending: false })
      .order("id", { ascending: false })
      .limit(PAGE);
    if (error) throw new Error(`rate history read failed: ${error.message}`);
    const page = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of page) {
      rows.push({
        stay_date: String(r.stay_date),
        booking_date: String(r.booking_date),
        room_type_id: String(r.room_type_id),
        rate: Number(r.current_rate),
      });
    }
    if (page.length < PAGE) break;
    if (rows.length >= MAX_RATE_ROWS) {
      const oldest = rows[rows.length - 1].stay_date;
      return { rows: rows.filter((r) => r.stay_date !== oldest), rooms };
    }
    const last = page[page.length - 1];
    cursor = { stayDate: String(last.stay_date), id: String(last.id) };
  }
  return { rows, rooms };
}
