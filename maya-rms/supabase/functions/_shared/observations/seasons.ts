/**
 * Data-driven season detection for the Observation Engine.
 *
 * Hotels do not have four seasons because the calendar says so — they have
 * however many demand regimes their history shows, however oddly shaped
 * or short-lived. This module finds them:
 *
 * 1. Excluded periods (closures, challenged dates) are removed up front.
 *    Holidays are deliberately NOT pre-filtered here (see below) — a
 *    sustained holiday-week regime (a property's "Christmas week" being its
 *    own distinct demand season) is exactly the kind of structure this
 *    module exists to find on its own, not erase.
 * 2. Statistical outliers are removed against a rolling median, but ONLY
 *    when the anomalous run is short (a handful of days) OR lacks
 *    corroboration across multiple years of history. A single Thanksgiving
 *    Thursday spike is noise and gets smoothed away regardless of how many
 *    years back it goes; a 10-day stretch that shows up consistently across
 *    several years of data is not noise, however short — it is a season,
 *    and is left alone for segmentation to find.
 * 3. The weekly rhythm is divided out before segmentation so a strong
 *    weekend pattern is not mistaken for tiny seasons.
 * 4. Segmentation watches TWO signals: overall demand level AND weekly
 *    shape (weekend vs weekday strength). A season where weekends are hot
 *    and weekdays are dead can sit at the same average level as a season
 *    with the opposite profile — level alone would never see the boundary.
 * 5. A new season needs a sustained shift (threshold + minimum run); short
 *    dips are absorbed. Seasons wrap across the year end. There is no
 *    target season count — the cap here is a backstop against pathological
 *    fragmentation, not a realistic ceiling; real properties with genuinely
 *    complex, unevenly-spaced calendars can and do produce many seasons.
 * 6. After a first pass, day-of-week factors are recomputed per season and
 *    the detection runs once more — a season's own weekly profile sharpens
 *    the boundaries around it.
 *
 * On the input metric: `DailyDemand.value` should be a pure demand signal —
 * occupancy or room-nights sold — never RevPAR or ADR. Price-based metrics
 * partly reflect MAYA's own past pricing decisions, which would make season
 * detection circular (a pricing rule reacting to "the season," where the
 * season was partly computed from earlier pricing). Keeping the input
 * price-independent is what lets rules safely react to the seasons this
 * module finds.
 *
 * None of this is user-facing. The outcome (season spans, relative levels,
 * weekly character) plus plain-language reasoning is; the algorithm is not.
 * Pure functions, no clocks, no I/O.
 */

import {
  YEAR_KEYS,
  dayOfWeek,
  dayOfYearIndex,
  foldedMonthDayKey,
  keyToHuman,
  MONTH_NAMES,
} from "./calendar.ts";

/* ── Types ───────────────────────────────────────────────────── */

export interface DailyDemand {
  stay_date: string;
  /** Demand metric for the day. Use occupancy or room-nights sold — never RevPAR or ADR (see file header). */
  value: number;
}

export interface DatePeriod {
  start_date: string;
  end_date: string;
}

export interface SeasonDowProfile {
  /** Multiplier per day of week (0 = Sunday .. 6 = Saturday), 1 = season norm. */
  factors: number[];
  /** Friday/Saturday strength relative to the other nights, 2dp. */
  weekendLift: number;
}

export interface Season {
  id: number;
  /** Inclusive folded "MM-DD" span; wraps across the year end when end is before start. */
  startKey: string;
  endKey: string;
  days: number;
  /** Raw demand level relative to the yearly norm, 2dp. */
  meanIndex: number;
  /** Booking-pace level relative to the yearly norm, 2dp — present only when a pace series was supplied. */
  paceIndex?: number;
  label: string;
  dow: SeasonDowProfile;
}

export interface SeasonModel {
  seasons: Season[];
  /** Folded "MM-DD" slots treated as one-off outliers and set aside. */
  outlierKeys: string[];
  observationsUsed: number;
  /** True when the per-season weekly-profile refinement moved a boundary. */
  refined: boolean;
}

/* ── Tunables (Observation Engine internals) ─────────────────── */

/**
 * Kept comfortably below MIN_SHIFT_RUN_DAYS: at a genuinely hard demand
 * boundary, this rolling mean blends roughly SMOOTH_WINDOW_DAYS worth of
 * points into a ramp — if that ramp were as wide as the walk's own entry
 * bar, the smoothing step could manufacture a pseudo-season out of its own
 * transition zone. Narrower than the entry bar, a pure ramp can never
 * itself sustain long enough to be mistaken for a season.
 */
export const SMOOTH_WINDOW_DAYS = 7;
export const OUTLIER_WINDOW_DAYS = 31;
export const OUTLIER_MAD_MULTIPLE = 3.5;
/**
 * A deviating run this long or shorter is always treated as noise and
 * smoothed away, regardless of how many years of history back it. Longer
 * runs are only smoothed if they ALSO lack multi-year corroboration
 * (see MIN_YEARS_FOR_TRUST) — otherwise they are real, if short, seasons.
 */
export const MAX_OUTLIER_RUN_DAYS = 7;
/**
 * A sustained deviation longer than MAX_OUTLIER_RUN_DAYS is only trusted as
 * real seasonal structure once at least this many distinct years agree it
 * happens there. Below that, even a multi-week run in the data could just
 * be a single unrepeated event (a one-time promotion, a fluke), so it gets
 * smoothed like any other outlier.
 */
export const MIN_YEARS_FOR_TRUST = 2;
export const LEVEL_SHIFT_THRESHOLD = 0.25;
export const SHAPE_SHIFT_THRESHOLD = 0.25;
/**
 * Booking-pace scores swing across a wider natural range than level or
 * shape (a date filling 60 days out vs 5 days out is a 12x ratio, where
 * demand levels rarely move 3x), so the pace signal gets a slightly higher
 * bar before it alone can declare a boundary.
 */
export const PACE_SHIFT_THRESHOLD = 0.35;
export const MIN_SHIFT_RUN_DAYS = 10;
/** How many of the confirming run's most recent days seed a new segment's running mean — see walkYear. */
export const TREND_SEED_TAIL_DAYS = 3;
/**
 * Equal to MIN_SHIFT_RUN_DAYS: a season this length was already trusted
 * enough to clear the segmentation walk's own entry bar, so the post-hoc
 * merge step only cleans up genuinely degenerate leftover fragments, never
 * a real minimal-length season (e.g. a property's holiday week).
 */
export const MIN_SEASON_LENGTH_DAYS = 10;
/**
 * A backstop against pathological fragmentation, not a realistic target.
 * Real properties can legitimately have many unevenly-spaced seasons;
 * this only guards against runaway noise producing dozens of "seasons".
 */
export const MAX_SEASONS = 16;
/**
 * Where the segmentation walk's own array boundary sits, in day-of-year
 * terms — see WALK_ROTATION_OFFSET below for why this isn't 0.
 */
export const WALK_ROTATION_OFFSET = 182;
export const MIN_OBSERVATIONS = 60;
export const MIN_SLOT_COVERAGE = 120;
export const MIN_DOW_OBSERVATIONS = 5;
/**
 * Same reasoning as SMOOTH_WINDOW_DAYS: kept below MIN_SHIFT_RUN_DAYS so the
 * shape series' own windowing can't manufacture a transition ramp wide
 * enough to pass as a season boundary on its own.
 */
export const SHAPE_WINDOW_DAYS = 7;
export const SHAPE_SMOOTH_WINDOW_DAYS = 5;
export const MIN_SHAPE_CLASS_OBS = 3;
/** Below this peak-to-trough spread, seasons differ by shape, not level. */
export const LEVEL_LABEL_SPREAD = 1.15;

/* ── Small math helpers ──────────────────────────────────────── */

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const KEY_IDX = new Map(YEAR_KEYS.map((k, i) => [k, i]));

/* ── Circular series utilities ───────────────────────────────── */

function rollingCircularMedian(base: (number | null)[], window: number): (number | null)[] {
  const half = Math.floor(window / 2);
  const n = base.length;
  return base.map((_, i) => {
    const vals: number[] = [];
    for (let j = -half; j <= half; j++) {
      const v = base[(i + j + n) % n];
      if (v !== null) vals.push(v);
    }
    return vals.length ? median(vals) : null;
  });
}

function rollingCircularMean(series: number[], window: number): number[] {
  const half = Math.floor(window / 2);
  const n = series.length;
  return series.map((_, i) => {
    let sum = 0;
    for (let j = -half; j <= half; j++) sum += series[(i + j + n) % n];
    return sum / (2 * half + 1);
  });
}

function interpolateCircular(base: (number | null)[]): number[] {
  const n = base.length;
  if (base.every((v) => v === null)) return new Array(n).fill(1);
  const out = base.slice();
  for (let i = 0; i < n; i++) {
    if (out[i] !== null) continue;
    let back = 1;
    while (out[(i - back + n) % n] === null) back++;
    let fwd = 1;
    while (base[(i + fwd) % n] === null) fwd++;
    const prev = out[(i - back + n) % n] as number;
    const next = base[(i + fwd) % n] as number;
    out[i] = prev + (next - prev) * (back / (back + fwd));
  }
  return out as number[];
}

/**
 * Groups a boolean flag array into contiguous circular runs, without ever
 * treating the array's [0]/[364] join as a false boundary. Rotates to start
 * right after a confirmed `false` slot (guaranteed to exist unless every
 * slot is flagged, an degenerate case handled by returning no runs at all).
 */
function circularRuns(flags: boolean[]): number[][] {
  const n = flags.length;
  const seam = flags.findIndex((v) => !v);
  if (seam === -1) return [];
  const runs: number[][] = [];
  let current: number[] = [];
  for (let k = 0; k < n; k++) {
    const idx = (seam + 1 + k) % n;
    if (flags[idx]) {
      current.push(idx);
    } else if (current.length) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length) runs.push(current);
  return runs;
}

/* ── Observation prep ────────────────────────────────────────── */

interface Obs {
  idx: number;
  dow: number;
  year: number;
  value: number;
}

function inAnyPeriod(date: string, periods: DatePeriod[]): boolean {
  return periods.some((p) => date >= p.start_date && date <= p.end_date);
}

function prepareObservations(daily: DailyDemand[], exclusions: DatePeriod[]): Obs[] {
  const obs: Obs[] = [];
  for (const d of daily) {
    if (d.value == null || !Number.isFinite(d.value) || d.value < 0) continue;
    if (inAnyPeriod(d.stay_date, exclusions)) continue;
    obs.push({
      idx: KEY_IDX.get(foldedMonthDayKey(d.stay_date))!,
      dow: dayOfWeek(d.stay_date),
      year: Number(d.stay_date.slice(0, 4)),
      value: d.value,
    });
  }
  return obs;
}

/** Distinct source years behind each of the 365 folded slots — the corroboration signal for outlier trust. */
function slotYearCounts(obs: Obs[]): number[] {
  const slots: Set<number>[] = Array.from({ length: 365 }, () => new Set());
  for (const o of obs) slots[o.idx].add(o.year);
  return slots.map((s) => s.size);
}

function globalDowFactors(obs: Obs[]): number[] {
  const byDow: number[][] = Array.from({ length: 7 }, () => []);
  for (const o of obs) byDow[o.dow].push(o.value);
  const overall = median(obs.map((o) => o.value));
  return byDow.map((vals) =>
    vals.length >= MIN_DOW_OBSERVATIONS && overall > 0
      ? clamp(median(vals) / overall, 0.2, 5)
      : 1,
  );
}

/* ── Series construction ─────────────────────────────────────── */

interface BuiltSeries {
  series: number[];
  outlierKeys: string[];
}

/**
 * Slot medians → outlier cleanup → gap fill → smooth → normalize to 1.
 *
 * Outlier cleanup groups deviating slots into contiguous runs and only
 * smooths a run away when it is short (<= MAX_OUTLIER_RUN_DAYS) or, for a
 * longer run, when it lacks corroboration across MIN_YEARS_FOR_TRUST
 * distinct years. A short run is always noise; a long, multi-year-agreed
 * run is a real season, however unusually short it is on the calendar.
 */
function buildSeries(slotValues: number[][], yearCounts: number[]): BuiltSeries {
  const base: (number | null)[] = slotValues.map((vs) => (vs.length ? median(vs) : null));

  const rolling = rollingCircularMedian(base, OUTLIER_WINDOW_DAYS);
  const residuals: number[] = [];
  for (let i = 0; i < base.length; i++) {
    if (base[i] !== null && rolling[i] !== null) {
      residuals.push(Math.abs((base[i] as number) - (rolling[i] as number)));
    }
  }
  const mad = median(residuals);
  const level = median(base.filter((v): v is number => v !== null).map(Math.abs));
  const scale = Math.max(1.4826 * mad, 0.02 * level, 1e-6);

  const isAnomalous = base.map(
    (v, i) =>
      v !== null &&
      rolling[i] !== null &&
      Math.abs((v as number) - (rolling[i] as number)) > OUTLIER_MAD_MULTIPLE * scale,
  );
  const runs = circularRuns(isAnomalous);

  // Cleaned slots are removed entirely (not patched with a per-index rolling
  // value) so interpolateCircular below bridges them with one straight line
  // from the nearest genuine data on each side. A per-index rolling median
  // varies slightly point-to-point across a run — patching with it can
  // leave a faint residual bump that the segmentation walk later mistakes
  // for a boundary of its own.
  const cleaned = base.slice();
  const outlierKeys: string[] = [];
  for (const run of runs) {
    const corroborated =
      run.length > MAX_OUTLIER_RUN_DAYS &&
      mean(run.map((idx) => yearCounts[idx])) >= MIN_YEARS_FOR_TRUST;
    if (corroborated) continue; // real, if short, seasonal structure — leave it alone
    for (const idx of run) {
      cleaned[idx] = null;
      outlierKeys.push(YEAR_KEYS[idx]);
    }
  }

  const filled = interpolateCircular(cleaned);
  const smoothed = rollingCircularMean(filled, SMOOTH_WINDOW_DAYS);
  const norm = median(smoothed) || 1;
  return {
    series: smoothed.map((v) => clamp(v / norm, 0.05, 20)),
    outlierKeys,
  };
}

function slotify(obs: Obs[], transform: (o: Obs) => number): number[][] {
  const slots: number[][] = Array.from({ length: 365 }, () => []);
  for (const o of obs) slots[o.idx].push(transform(o));
  return slots;
}

/**
 * Weekly-shape series: weekend vs weekday strength around each day of year,
 * from raw observations. This is the signal that catches seasons whose
 * overall level matches but whose weekly profile flips.
 */
function buildShapeSeries(obs: Obs[], excludeIdx: Set<number>): number[] {
  const byIdx: Obs[][] = Array.from({ length: 365 }, () => []);
  for (const o of obs) {
    if (excludeIdx.has(o.idx)) continue;
    byIdx[o.idx].push(o);
  }
  const half = Math.floor(SHAPE_WINDOW_DAYS / 2);

  const ratios: (number | null)[] = [];
  for (let i = 0; i < 365; i++) {
    const weekend: number[] = [];
    const weekday: number[] = [];
    for (let j = -half; j <= half; j++) {
      for (const o of byIdx[(i + j + 365) % 365]) {
        (o.dow === 5 || o.dow === 6 ? weekend : weekday).push(o.value);
      }
    }
    if (weekend.length >= MIN_SHAPE_CLASS_OBS && weekday.length >= MIN_SHAPE_CLASS_OBS) {
      ratios.push(clamp(median(weekend) / Math.max(median(weekday), 1e-6), 0.2, 5));
    } else {
      ratios.push(null);
    }
  }

  const filled = interpolateCircular(ratios);
  const smoothed = rollingCircularMean(filled, SHAPE_SMOOTH_WINDOW_DAYS);
  const norm = median(smoothed) || 1;
  return smoothed.map((v) => clamp(v / norm, 0.1, 10));
}

/* ── Segmentation ────────────────────────────────────────────── */

interface Seg {
  start: number;
  len: number;
}

function segMean(series: number[], seg: Seg): number {
  let sum = 0;
  for (let j = 0; j < seg.len; j++) sum += series[(seg.start + j) % 365];
  return sum / seg.len;
}

/**
 * One boundary signal for the segmentation walk: a normalized circular
 * series plus the log-space shift threshold that counts as a deviation for
 * it. The walk itself is signal-agnostic — level, weekly shape, and
 * booking pace all ride through the same machinery, and any one of them
 * sustaining a shift starts a season.
 */
interface SegSignal {
  values: number[];
  logThreshold: number;
}

const logShift = (threshold: number) => Math.log(1 + threshold);

/**
 * Distance between two segments in threshold units: each signal's absolute
 * log-ratio divided by its own threshold, max over signals. 1.0 means
 * "exactly at some signal's boundary bar", so similar = distance <= 1.
 */
function segDistance(a: Seg, b: Seg, signals: SegSignal[]): number {
  let worst = 0;
  for (const s of signals) {
    const d = Math.abs(Math.log(segMean(s.values, a) / segMean(s.values, b))) / s.logThreshold;
    if (d > worst) worst = d;
  }
  return worst;
}

function segsSimilar(a: Seg, b: Seg, signals: SegSignal[]): boolean {
  return segDistance(a, b, signals) <= 1;
}

/**
 * Walk the year watching every signal against the current season's running
 * means. A sustained deviation in ANY signal (same direction,
 * MIN_SHIFT_RUN_DAYS long) starts a new season; shorter excursions are
 * absorbed as dips. Staggered onsets are tolerated: a pending run survives
 * as long as no signal reverses direction.
 */
function walkYear(signals: SegSignal[]): Seg[] {
  const n = signals.length;
  const bounds: { start: number; end: number }[] = [];
  let segStart = 0;
  const means = signals.map((s) => s.values[0]);
  let count = 1;
  let pendStart = -1;
  let pendSig: number[] = new Array(n).fill(0);
  let pendVals: number[][] = signals.map(() => []);

  const clearPending = () => {
    pendStart = -1;
    pendSig = new Array(n).fill(0);
    pendVals = signals.map(() => []);
  };
  const absorbPending = () => {
    for (let j = 0; j < pendVals[0].length; j++) {
      for (let k = 0; k < n; k++) {
        means[k] = (means[k] * count + pendVals[k][j]) / (count + 1);
      }
      count++;
    }
    clearPending();
  };

  for (let i = 1; i < 365; i++) {
    const sigs = signals.map((s, k) => {
      const d = Math.log(s.values[i] / means[k]);
      return Math.abs(d) > s.logThreshold ? Math.sign(d) : 0;
    });

    if (sigs.some((s) => s !== 0)) {
      const reverses = sigs.some((s, k) => s * pendSig[k] === -1);
      if (pendStart === -1 || reverses) {
        pendStart = i;
        pendSig = sigs;
        pendVals = signals.map((s) => [s.values[i]]);
      } else {
        pendSig = pendSig.map((p, k) => p || sigs[k]);
        signals.forEach((s, k) => pendVals[k].push(s.values[i]));
      }
      if (pendVals[0].length >= MIN_SHIFT_RUN_DAYS) {
        bounds.push({ start: segStart, end: pendStart - 1 });
        segStart = pendStart;
        // Seed the new segment from the TAIL of the confirming run, not its
        // full average. The run itself is often a gradual ramp rather than
        // an instant step, so its average sits at the ramp's midpoint —
        // anchoring there makes the segment look "wrong" the moment the
        // series actually settles, which can immediately trigger a second,
        // spurious boundary right behind a real one. A small trailing
        // sample (already past the ramp by the time MIN_SHIFT_RUN_DAYS
        // elapses) is a much closer estimate of where the segment lands,
        // and a small starting count lets it adapt fast to what follows.
        const tail = Math.min(TREND_SEED_TAIL_DAYS, pendVals[0].length);
        for (let k = 0; k < n; k++) means[k] = mean(pendVals[k].slice(-tail));
        count = tail;
        clearPending();
      }
    } else {
      if (pendStart !== -1) absorbPending();
      for (let k = 0; k < n; k++) {
        means[k] = (means[k] * count + signals[k].values[i]) / (count + 1);
      }
      count++;
    }
  }
  bounds.push({ start: segStart, end: 364 });

  return bounds.map((b) => ({ start: b.start, len: b.end - b.start + 1 }));
}

function rotate<T>(arr: T[], offset: number): T[] {
  return arr.slice(offset).concat(arr.slice(0, offset));
}

/**
 * walkYear scans linearly and can never confirm a pending run that starts
 * too close to its array's own hard end — there aren't enough remaining
 * days left to reach MIN_SHIFT_RUN_DAYS. Scanning day-of-year 0..364
 * unrotated puts that blind spot exactly on Dec 31 / Jan 1, which for a
 * hotel is the single worst place for it: a demand regime starting in late
 * December (a property's Christmas/New Year's week) gets silently absorbed
 * into whatever segment was already running, with no run of days left to
 * prove itself before the array ends. Rotating the walk's own seam to
 * WALK_ROTATION_OFFSET (~July 1, the point of the year furthest from that
 * boundary) moves the blind spot to a date generic enough that almost no
 * property has a real season boundary sitting exactly on it — and even
 * where one does, that's no worse than the guaranteed miss every property
 * had at the old, calendar-driven seam.
 */
function segmentYear(signals: SegSignal[]): Seg[] {
  const rotated = signals.map((s) => ({ ...s, values: rotate(s.values, WALK_ROTATION_OFFSET) }));
  let segs = walkYear(rotated).map((s) => ({
    start: (s.start + WALK_ROTATION_OFFSET) % 365,
    len: s.len,
  }));

  // The walk's own seam is usually mid-season: if the segments touching it
  // (chronologically first and last in walk order) look alike, they are one
  // season split by the seam, not two.
  if (segs.length > 1 && segsSimilar(segs[0], segs[segs.length - 1], signals)) {
    const last = segs[segs.length - 1];
    const first = segs[0];
    segs = [{ start: last.start, len: last.len + first.len }, ...segs.slice(1, -1)];
  }

  // Absorb short seasons into their most similar neighbor.
  while (segs.length > 1) {
    let shortest = 0;
    for (let i = 1; i < segs.length; i++) if (segs[i].len < segs[shortest].len) shortest = i;
    if (segs[shortest].len >= MIN_SEASON_LENGTH_DAYS) break;
    const prev = (shortest - 1 + segs.length) % segs.length;
    const next = (shortest + 1) % segs.length;
    const mergeWithPrev =
      segDistance(segs[shortest], segs[prev], signals) <=
      segDistance(segs[shortest], segs[next], signals);
    segs = mergeAdjacent(segs, mergeWithPrev ? prev : shortest);
  }

  // Sanity cap: fold the most similar adjacent pair until under the limit.
  while (segs.length > MAX_SEASONS) {
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < segs.length; i++) {
      const d = segDistance(segs[i], segs[(i + 1) % segs.length], signals);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    segs = mergeAdjacent(segs, bestI);
  }

  return segs;
}

/** Merge segs[i] with its circular successor. */
function mergeAdjacent(segs: Seg[], i: number): Seg[] {
  const j = (i + 1) % segs.length;
  const merged = { start: segs[i].start, len: segs[i].len + segs[j].len };
  const out = segs.filter((_, k) => k !== i && k !== j);
  out.splice(Math.min(i, j) === j ? 0 : i, 0, merged);
  return out;
}

/* ── Season assembly ─────────────────────────────────────────── */

function segMembership(segs: Seg[]): number[] {
  const member = new Array<number>(365).fill(0);
  segs.forEach((seg, id) => {
    for (let j = 0; j < seg.len; j++) member[(seg.start + j) % 365] = id;
  });
  return member;
}

function dowProfileForSeg(obs: Obs[], member: number[], segId: number): SeasonDowProfile {
  const inSeg = obs.filter((o) => member[o.idx] === segId);
  const byDow: number[][] = Array.from({ length: 7 }, () => []);
  for (const o of inSeg) byDow[o.dow].push(o.value);
  const segMedian = median(inSeg.map((o) => o.value));
  const factors = byDow.map((vals) =>
    vals.length >= MIN_DOW_OBSERVATIONS && segMedian > 0
      ? round2(clamp(median(vals) / segMedian, 0.2, 5))
      : 1,
  );
  const weekend = (factors[5] + factors[6]) / 2;
  const weekday = mean([factors[0], factors[1], factors[2], factors[3], factors[4]]);
  return { factors, weekendLift: round2(weekend / Math.max(weekday, 1e-6)) };
}

function labelSeasons(entries: { meanIndex: number; start: number; len: number }[]): string[] {
  if (entries.length === 1) return ["Year-Round"];

  const max = Math.max(...entries.map((e) => e.meanIndex));
  const min = Math.min(...entries.map((e) => e.meanIndex));
  const monthOf = (slot: number) => Number(YEAR_KEYS[slot % 365].slice(0, 2));

  if (max / Math.max(min, 0.01) < LEVEL_LABEL_SPREAD) {
    // Levels are close — these seasons differ by weekly character, so name
    // them by their place in the year instead of peak/low.
    return entries.map((e) => {
      const startMonth = MONTH_NAMES[monthOf(e.start) - 1];
      const endMonth = MONTH_NAMES[monthOf(e.start + e.len - 1) - 1];
      return startMonth === endMonth ? `${startMonth} Season` : `${startMonth} to ${endMonth} Season`;
    });
  }

  const order = entries
    .map((e, i) => ({ i, meanIndex: e.meanIndex }))
    .sort((a, b) => b.meanIndex - a.meanIndex || a.i - b.i);
  const labels = new Array<string>(entries.length);
  labels[order[0].i] = "Peak Season";
  labels[order[order.length - 1].i] = "Low Season";
  const middles = order.slice(1, -1);
  for (const m of middles) {
    const e = entries[m.i];
    labels[m.i] =
      middles.length === 1
        ? "Shoulder Season"
        : `${MONTH_NAMES[monthOf(e.start + Math.floor(e.len / 2)) - 1]} Shoulder Season`;
  }
  return labels;
}

function assembleSeasons(
  segs: Seg[],
  rawSeries: number[],
  obs: Obs[],
  paceSeries: number[] | null,
): Season[] {
  const member = segMembership(segs);
  const entries = segs.map((seg) => ({
    start: seg.start,
    len: seg.len,
    meanIndex: round2(segMean(rawSeries, seg)),
  }));
  const labels = labelSeasons(entries);
  return segs.map((seg, id) => ({
    id,
    startKey: YEAR_KEYS[seg.start],
    endKey: YEAR_KEYS[(seg.start + seg.len - 1) % 365],
    days: seg.len,
    meanIndex: entries[id].meanIndex,
    ...(paceSeries ? { paceIndex: round2(segMean(paceSeries, seg)) } : {}),
    label: labels[id],
    dow: dowProfileForSeg(obs, member, id),
  }));
}

function segSignature(segs: Seg[]): string {
  return segs
    .map((s) => `${s.start}:${s.len}`)
    .sort()
    .join(",");
}

/* ── Public API ──────────────────────────────────────────────── */

export interface DetectSeasonsOptions {
  /** Closed periods, renovations, challenged dates — never used for seasons. */
  exclusions?: DatePeriod[];
  /**
   * Optional booking-pace series (see booking-pace.ts's dailyPaceSeries):
   * how early each historical stay date filled through its occupancy
   * milestones. A third boundary signal, catching demand-intensity shifts
   * occupancy alone cannot see — two periods that both end near sellout
   * look identical in occupancy even when one filled six weeks out and the
   * other filled in the final days. Pass fully observed (past) dates only.
   */
  pace?: DailyDemand[];
}

export function detectSeasons(
  daily: DailyDemand[],
  opts: DetectSeasonsOptions = {},
): SeasonModel {
  const obs = prepareObservations(daily, opts.exclusions ?? []);
  const coverage = new Set(obs.map((o) => o.idx)).size;

  if (obs.length < MIN_OBSERVATIONS || coverage < MIN_SLOT_COVERAGE) {
    const seg: Seg = { start: 0, len: 365 };
    return {
      seasons: [
        {
          id: 0,
          startKey: "01-01",
          endKey: "12-31",
          days: 365,
          meanIndex: 1,
          label: "Year-Round",
          dow: obs.length
            ? dowProfileForSeg(obs, segMembership([seg]), 0)
            : { factors: [1, 1, 1, 1, 1, 1, 1], weekendLift: 1 },
        },
      ],
      outlierKeys: [],
      observationsUsed: obs.length,
      refined: false,
    };
  }

  const yearCounts = slotYearCounts(obs);
  const globalFactors = globalDowFactors(obs);

  // Pass 1: global weekly detrend. Done before the shape series so its
  // outlier list — computed on DOW-detrended values — can be reused to keep
  // the shape computation clean too. The plain (undetrended) raw series
  // used only for level labeling is NOT a safe source for that exclusion
  // set: raw naturally oscillates weekly, and that expected oscillation can
  // itself trip the MAD threshold, feeding false "outliers" into the shape
  // computation that a one-off spike detector was never meant to produce.
  const det1 = buildSeries(slotify(obs, (o) => o.value / globalFactors[o.dow]), yearCounts);
  const outlierIdx = new Set(det1.outlierKeys.map((k) => KEY_IDX.get(k)!));
  const shape = buildShapeSeries(obs, outlierIdx);
  const raw = buildSeries(slotify(obs, (o) => o.value), yearCounts);

  // Optional third signal: booking pace, with its own weekly detrend
  // (weekend dates routinely fill on a different schedule than weekdays,
  // and that weekly rhythm must not read as tiny seasons any more than the
  // level series' weekly rhythm does). Ignored entirely when too sparse to
  // trust — a handful of paced dates is noise, not a boundary signal.
  const paceObs = opts.pace ? prepareObservations(opts.pace, opts.exclusions ?? []) : [];
  let paceSeries: number[] | null = null;
  if (paceObs.length >= MIN_OBSERVATIONS) {
    const paceFactors = globalDowFactors(paceObs);
    paceSeries = buildSeries(
      slotify(paceObs, (o) => o.value / paceFactors[o.dow]),
      slotYearCounts(paceObs),
    ).series;
  }

  const boundarySignals = (levelSeries: number[]): SegSignal[] => [
    { values: levelSeries, logThreshold: logShift(LEVEL_SHIFT_THRESHOLD) },
    { values: shape, logThreshold: logShift(SHAPE_SHIFT_THRESHOLD) },
    ...(paceSeries ? [{ values: paceSeries, logThreshold: logShift(PACE_SHIFT_THRESHOLD) }] : []),
  ];

  const segs1 = segmentYear(boundarySignals(det1.series));
  const seasons1 = assembleSeasons(segs1, raw.series, obs, paceSeries);

  // Pass 2: each season's own weekly profile detrends its stretch of the year.
  const member1 = segMembership(segs1);
  const det2 = buildSeries(
    slotify(obs, (o) => {
      const f = seasons1[member1[o.idx]].dow.factors[o.dow];
      return o.value / (f > 0 ? f : globalFactors[o.dow]);
    }),
    yearCounts,
  );
  const segs2 = segmentYear(boundarySignals(det2.series));
  const seasons2 = assembleSeasons(segs2, raw.series, obs, paceSeries);

  return {
    seasons: seasons2,
    outlierKeys: raw.outlierKeys,
    observationsUsed: obs.length,
    refined: segSignature(segs1) !== segSignature(segs2),
  };
}

export function seasonForDate(model: SeasonModel, date: string): Season {
  const idx = dayOfYearIndex(date);
  for (const s of model.seasons) {
    const start = KEY_IDX.get(s.startKey)!;
    if ((idx - start + 365) % 365 < s.days) return s;
  }
  return model.seasons[0];
}

/* ── Explainability ──────────────────────────────────────────── */

function levelPhrase(meanIndex: number): string {
  if (meanIndex >= 1.5) return "demand runs well above your yearly norm";
  if (meanIndex >= 1.1) return "demand runs above your yearly norm";
  if (meanIndex > 0.9) return "demand runs close to your yearly norm";
  if (meanIndex > 0.6) return "demand runs below your yearly norm";
  return "demand runs far below your yearly norm";
}

function dowPhrase(weekendLift: number): string {
  if (weekendLift >= 1.15) return "weekends run hotter than weekdays";
  if (weekendLift <= 0.87) return "weekdays run hotter than weekends";
  return "weekends and weekdays run about even";
}

function pacePhrase(paceIndex: number | undefined): string {
  if (paceIndex == null) return "";
  if (paceIndex >= 1.35) return ", and it books up earlier than the rest of your year";
  if (paceIndex <= 0.75) return ", and it books up closer to arrival than the rest of your year";
  return "";
}

/** Plain-language season summary — no thresholds, no math symbols. */
export function describeSeasonModel(model: SeasonModel): string {
  if (model.seasons.length === 1 && model.seasons[0].label === "Year-Round") {
    return "Your demand holds a steady pattern through the year, so we treat it as a single Year-Round season.";
  }
  const ordered = [...model.seasons].sort(
    (a, b) => KEY_IDX.get(a.startKey)! - KEY_IDX.get(b.startKey)!,
  );
  const lines = ordered.map(
    (s) =>
      `${s.label}, ${keyToHuman(s.startKey)} through ${keyToHuman(s.endKey)}: ${levelPhrase(s.meanIndex)}, and ${dowPhrase(s.dow.weekendLift)}${pacePhrase(s.paceIndex)}.`,
  );
  if (model.outlierKeys.length > 0) {
    lines.push(
      `We set aside ${model.outlierKeys.length} unusual ${model.outlierKeys.length === 1 ? "day" : "days"} that did not fit the surrounding pattern.`,
    );
  }
  return lines.join(" ");
}
