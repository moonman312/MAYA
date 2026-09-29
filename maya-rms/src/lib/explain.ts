/**
 * Explainability drill-down: turns a persisted booking-speed audit snapshot
 * into the tiered story behind a price change.
 *
 * Level 1 is the changelog sentence (changelog-narrative.ts). This module
 * builds the deeper levels for owners who want to dig until they can
 * falsify the reasoning:
 *   - Level 2: what we observed vs what we expected, and the verdict.
 *   - Level 3: how the expectation was formed — which nights we compared
 *     to and why, or the momentum fallback when history was too thin.
 *   - Level 4: the raw evidence, one row per comparable night, each one
 *     challengeable ("that week was our renovation").
 *
 * Snapshots are stored as plain JSON in evaluation_audit.details and may
 * predate this code — every accessor is defensive, and a snapshot missing
 * the essentials yields null rather than a half-rendered explanation.
 *
 * Same prose house rules as the changelog: no math symbols, observed
 * values in parentheses, sentences that survive a missing metric. Plain
 * words: the owner reads what was counted and compared, never what MAYA
 * "knew", "expected" or "called".
 */

// The tunables alone: comparable-dates would pull the whole search, the
// season detection and the holiday calendar into the browser.
import { MIN_TARGET_COMPARABLES, NO_MODEL_SEASON_SPAN_DAYS } from "@/lib/observations/comparable-tunables";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The notes shown when a check held a reading back, by the guard that did
 * it. Exported so the docs' booking speed playground quotes them as written.
 */
export const GUARD_NOTES = {
  small_difference: "The numbers leaned away from Normal, but by too little to matter at this many bookings, so it stays Normal.",
  extreme_demoted: "The numbers pointed one step further from Normal, but not clearly enough, so it reads one step closer to Normal.",
  few_comparables: "Only a few similar nights were found, so it stays within one step of Normal however strong the numbers look.",
} as const;

/** "Fri, Jul 18 2025" — compact but unambiguous for evidence tables. */
export function humanDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  const month = dt.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${WEEKDAYS[dt.getUTCDay()].slice(0, 3)}, ${month} ${d} ${y}`;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function bookingWord(n: number): string {
  return n === 1 ? "1 booking" : `${n} bookings`;
}

function dayWord(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

/** The YYYY-MM-DD before `iso`, or null when it doesn't parse. */
function dayBefore(iso: string): string | null {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** "day", "week", "month" or "N days": a window's length in words. */
function spanWord(days: number): string {
  return days === 1 ? "day" : days === 7 ? "week" : days === 30 ? "month" : `${days} days`;
}

function expectedWord(n: number): string {
  if (n < 1) return "almost no bookings";
  const rounded = Math.round(n);
  return `about ${bookingWord(rounded)}`;
}

export type ExplainComparable = {
  /** The challengeable date — for momentum pairs this is the year-ago side, where "that week was not normal" almost always applies. */
  date: string;
  /** What this night contributed, in plain words ("4 bookings in the same stretch", "4 bookings in a whole week", "no history for this night"). */
  summary: string;
  /** Why this night was considered a fair comparison, in plain words. */
  reasons: string[];
};

export type ExplainView = {
  /**
   * Names of the room types this observation counted, when a rule measures
   * only some of them. null for a hotel-wide observation. Every count below
   * is over these room types.
   */
  measured: string[] | null;
  /** Level 2 — the observation and the verdict. */
  observed: string;
  expected: string;
  verdict: string;
  /** Set when an evidence guard softened the raw verdict — the honesty note. */
  guard_note: string | null;
  /** Level 3 — how the expectation was formed. */
  method: "comparable" | "momentum" | "insufficient_data";
  assumptions: string[];
  /** Level 4 — the raw evidence. */
  window_days: number;
  days_out: number;
  comparables: ExplainComparable[];
  momentum_notes: string[];
};

function listWords(items: string[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Day of the week of a YYYY-MM-DD (0 = Sunday), or null when it doesn't parse. */
function weekdayOf(iso: string): number | null {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Friday and Saturday nights are weekend nights (observations/calendar.ts dowClass). */
function isWeekendNight(day: number): boolean {
  return day === 5 || day === 6;
}

/**
 * Which days of the week the compared nights fall on, said from the nights
 * themselves so the line never disagrees with the list under it. The search
 * starts with the night's own weekday; when too few match it adds the other
 * nights of the same kind (weekend: Friday and Saturday; weekday: the rest),
 * and around a holiday the nights are lined up by the holiday, whatever
 * weekday that puts them on.
 */
function comparedDaysLine(target: string, dates: string[], holidayLabel: string | null): string | null {
  const own = weekdayOf(target);
  if (own == null) return null;
  const days = [...new Set(dates.map(weekdayOf).filter((d): d is number => d != null))].sort((a, b) => a - b);
  if (days.length === 0) return null;
  const names = (ds: number[]) => listWords(ds.map((d) => WEEKDAYS[d]));
  if (days.length === 1 && days[0] === own) {
    return `Only other ${WEEKDAYS[own]} nights were compared, since each night of the week books in its own way.`;
  }
  if (holidayLabel) {
    return `Around ${holidayLabel} the day of the week changes from year to year, so the nights compared fall on ${names(days)}.`;
  }
  if (days.every((d) => isWeekendNight(d) === isWeekendNight(own))) {
    const others = days.filter((d) => d !== own);
    const kind = isWeekendNight(own) ? "weekend" : "weekday";
    const lead = days.includes(own)
      ? `Too few other ${WEEKDAYS[own]} nights matched, so ${names(others)} nights were compared too, since they are also ${kind} nights.`
      : `No other ${WEEKDAYS[own]} nights matched, so ${names(others)} nights were compared instead, since they are also ${kind} nights.`;
    return `${lead} Friday and Saturday nights count as weekend nights, the rest as weekday nights.`;
  }
  return `The nights compared fall on ${names(days)}.`;
}

/**
 * The season line, true to the nights compared: the search keeps to the
 * night's season, and when too few match there it adds nights of the same
 * weekday from around the same time of year, whatever their season (tier 3
 * in observations/comparable-dates.ts).
 */
function seasonLine(season: string, tiers: (number | null)[]): string {
  const wider = tiers.filter((t) => t === 3).length;
  const around = `nights within ${NO_MODEL_SEASON_SPAN_DAYS} days of the same time of year`;
  if (wider === 0) return `Only nights in the same season of your history were compared: ${season}.`;
  if (wider === tiers.length) {
    return `Too few nights matched in the same season of your history, ${season}, so ${around} were compared instead.`;
  }
  return `Nights in the same season of your history were compared: ${season}. Too few matched there, so ${around} were added.`;
}

/**
 * Build the tiered view from one raw snapshot. Returns null when the
 * snapshot lacks the essentials (legacy rows, malformed JSON).
 * `roomTypeNames` turns a snapshot's measured room type ids into names.
 */
export function buildExplainView(
  raw: unknown,
  roomTypeNames?: ReadonlyMap<string, string>,
): ExplainView | null {
  const snap = rec(raw);
  if (!snap) return null;
  const target = str(snap.target);
  const windowDays = num(snap.windowDays);
  const daysOut = num(snap.daysOut);
  const recent = num(snap.recentBookings);
  const classification = rec(snap.classification);
  if (!target || windowDays == null || daysOut == null || recent == null || !classification) {
    return null;
  }
  const label = str(classification.label) ?? "Normal";
  const guard = str(classification.guard) ?? "none";
  const expected = num(snap.expectedBookings);
  const method = str(snap.method);
  const methodKey: ExplainView["method"] =
    method === "momentum" ? "momentum" : method === "insufficient_data" ? "insufficient_data" : "comparable";

  const measuredIds = Array.isArray(snap.measuredRoomTypeIds)
    ? snap.measuredRoomTypeIds.filter((id): id is string => typeof id === "string")
    : null;
  const measured = measuredIds
    ? measuredIds.map((id) => roomTypeNames?.get(id)).filter((n): n is string => !!n)
    : null;
  const windowPhrase = windowDays === 1 ? "day" : `${windowDays} days`;
  const arrived = !measured
    ? bookingWord(recent)
    : measured.length > 0
      ? `${recent} ${listWords(measured)} ${recent === 1 ? "booking" : "bookings"}`
      : `${bookingWord(recent)} for the room types this rule watches`;
  // Set when this night had already been raised (for a rule that raises) or
  // cut (one that cuts) by the rule behind this reading or by a stronger
  // rule that moves the price the same way, and the reading counted only
  // from the newest of those changes still on the price (engine/pickup.ts,
  // countFromFireAt over openFireHeads, and bookingSpeedCountFrom: one that
  // came off for cancellations covers nothing). A weaker rule's change, or one the other way,
  // never moves where it counts from. The day named is the change's own:
  // counting runs from when it was made (its applied_at), and a change a
  // cancellation check kept on bookings made since still counts from then,
  // so this never names the day it was last checked. The reading is shared by every rule
  // that counts from the same change, so it can't name which rule made it:
  // the copy says "this rule or a stronger one". countedAfter says raise or
  // cut; a snapshot without it reads as a change. With countedSince the
  // count started at the raise itself, the rest of its day included;
  // without it (a cut) the day after. countedThrough: the reading counted
  // full days only, up to the day before it was taken, as a rule that cuts
  // does (countsCompleteDays), on this night and the nights it is compared
  // with. expectedOverFullWindow: a rule that raises on a fast pace
  // (keepsWholeWindowBar) read the nights it is compared with over its
  // whole window (fullWindowDays), not the days it counted, so the
  // expectation is a whole window's.
  const countedFrom = str(snap.countedFrom);
  const countedSince = str(snap.countedSince);
  const countedThrough = str(snap.countedThrough);
  const changedOn = countedFrom ? (countedSince ? countedFrom : dayBefore(countedFrom)) : null;
  const countedAfter = str(snap.countedAfter);
  const fullWindowDays = num(snap.fullWindowDays);
  const wholeSpan = countedFrom && snap.expectedOverFullWindow === true && fullWindowDays != null ? spanWord(fullWindowDays) : null;
  const lastChange = countedAfter === "cut" ? "cut" : countedAfter === "raise" ? "raised" : "changed";
  const change = countedAfter === "cut" ? "cut" : countedAfter === "raise" ? "raise" : "change";
  const changes = countedAfter === "cut" ? "cuts" : countedAfter === "raise" ? "raises" : "changes";
  const fullDays = windowDays === 1 ? "full day" : `${windowDays} full days`;
  const stretch = countedSince
    ? windowDays === 1
      ? "Later that day,"
      : `In the ${windowDays} days from that ${change} on,`
    : countedThrough
      ? `In the ${fullDays} after that, up to yesterday,`
      : `In the ${windowPhrase} after that,`;
  const toGo = `with ${dayWord(daysOut)} still to go before arrival.`;
  const observed = changedOn
    ? `The newest ${change} still on this night's price, by the rule behind this reading or a stronger rule, was made on ${humanDate(changedOn)}. ${stretch} ${arrived} arrived for it, ${toGo}`
    : countedThrough
      ? `In the ${fullDays} up to yesterday, ${arrived} arrived for this night, ${toGo}`
      : `In the last ${windowPhrase}, ${arrived} arrived for this night, ${toGo}`;

  // The engine persists insufficient_data snapshots with a numeric
  // expectedBookings of 0 and a fully computed classification — but it also
  // BLOCKED every booking-speed rule for the night. Rendering that
  // classification as a verdict would assert a call the engine refused to
  // act on, so the whole level-2 story switches to the honest version.
  const insufficient = methodKey === "insufficient_data";
  const expectedSentence = insufficient
    ? `There isn't enough booking history yet to say what is usual for this night.`
    : expected != null
      ? wholeSpan
        ? `By this point, nights like this one usually get ${expectedWord(expected)} over a whole ${wholeSpan}.`
        : `By this point, nights like this one usually get ${expectedWord(expected)} over the same stretch.`
      : `There was no usual number to compare this night with.`;
  const verdict = insufficient
    ? `Booking speed wasn't rated for this night, so rules that watch booking speed left it alone.`
    : `That reads as ${label}.`;

  const guard_note = insufficient ? null : ((GUARD_NOTES as Record<string, string>)[guard] ?? null);

  /* ── Level 3: assumptions ── */
  const selection = rec(snap.selection);
  const selAssumptions = rec(selection?.assumptions);
  const assumptions: string[] = [];
  if (countedThrough) {
    assumptions.push(
      `A rule that cuts counts full days only, up to yesterday, on this night and on the nights it is compared with alike.`,
    );
  }
  if (changedOn) {
    // With countedSince the rest of the raise's own day counted too; a cut
    // counts from the day after its own.
    const counts = countedSince
      ? `the bookings made after the newest of those ${changes} still on the price, the rest of that day included,`
      : countedThrough
        ? `the full days after the day of the newest of those ${changes} still on the price,`
        : `the bookings made after the day of the newest of those ${changes} still on the price,`;
    const unmoved =
      countedAfter === "cut"
        ? "A weaker rule's cut, or any raise, doesn't move where it starts."
        : countedAfter === "raise"
          ? "A weaker rule's raise, or any cut, doesn't move where it starts."
          : "A weaker rule's change doesn't move where it starts.";
    assumptions.push(
      wholeSpan
        ? `Once a rule or a stronger one has ${lastChange} this night, it counts only ${counts} and those alone have to beat what the nights it is compared with get in a whole ${wholeSpan}. ${unmoved}`
        : `Once a rule or a stronger one has ${lastChange} this night, it counts only ${counts} and reads the nights it is compared with over the same days. ${unmoved}`,
    );
  }
  const perComparable = Array.isArray(snap.perComparable) ? snap.perComparable : [];
  if (methodKey === "comparable" && selAssumptions) {
    const seasonLabel = str(selAssumptions.seasonLabel);
    const seasonRange = str(selAssumptions.seasonRange);
    const holiday = rec(selAssumptions.holiday);
    const hLabel = holiday ? (str(holiday.label) ?? "the holiday") : null;
    const compared = perComparable.map(rec).filter((c): c is Record<string, unknown> => !!c && !!str(c.date));
    const days = comparedDaysLine(
      target,
      compared.map((c) => str(c.date)!),
      hLabel,
    );
    if (days) assumptions.push(days);
    if (hLabel) {
      assumptions.push(`This night is near ${hLabel}, so it is compared with the same days around ${hLabel} in earlier years, not the same date.`);
    } else if (seasonLabel) {
      const season = seasonRange ? `${seasonLabel} (${seasonRange})` : seasonLabel;
      assumptions.push(seasonLine(season, compared.map((c) => num(c.tier))));
    }
    if (selAssumptions.relaxed === true) {
      assumptions.push(
        `Fewer than ${MIN_TARGET_COMPARABLES} nights matched closely, so the search was widened. Check the nights below and set aside any that were not normal.`,
      );
    }
    assumptions.push(`Closed periods, and any nights you have set aside as not normal, are never compared.`);
  }
  if (methodKey === "momentum") {
    assumptions.push(`Your history has no usable similar nights for this one, so the usual number comes from booking momentum instead.`);
    assumptions.push(`Momentum here means how nights near this one are filling now, compared with how the same nights were filling at this point last year.`);
  }
  if (methodKey === "insufficient_data") {
    assumptions.push(`There wasn't enough history to say what is usual, so no rule acted on booking speed for this night.`);
  }

  /* ── Level 4: evidence ── */
  const comparables: ExplainComparable[] = [];
  for (const item of perComparable) {
    const c = rec(item);
    const date = str(c?.date);
    if (!c || !date) continue;
    const hasData = c.hasData !== false;
    const bookings = num(c.bookings);
    const over = wholeSpan ? `in a whole ${wholeSpan}` : "in the same stretch";
    comparables.push({
      date,
      summary:
        !hasData || bookings == null
          ? "no history for this night"
          : bookings === 1
            ? `1 booking ${over}`
            : `${bookings} bookings ${over}`,
      reasons: Array.isArray(c.reasons) ? c.reasons.filter((r): r is string => typeof r === "string") : [],
    });
  }

  const momentum_notes: string[] = [];
  const momentum = rec(snap.momentum);
  if (methodKey === "momentum" && momentum) {
    const pairs = num(momentum.matchedPairs);
    const ratio = num(momentum.momentumRatio);
    const baseline = num(momentum.naiveBaselineBookings);
    const source = str(momentum.baselineSource);
    if (pairs != null) {
      momentum_notes.push(
        pairs === 0
          ? `No nearby night could be paired with the same night last year, so there is no telling whether the pace has changed.`
          : pairs === 1
            ? `1 nearby night could be paired with the same night last year.`
            : `${pairs} nearby nights could be paired with the same nights last year.`,
      );
    }
    // The pace claim only exists when pairs were actually measured — a
    // ratio of exactly 1 with zero pairs is the engine's no-evidence
    // placeholder, not a measurement. Same near-1 band as the canonical
    // describeMomentum, so levels never disagree about "unchanged".
    if (ratio != null && pairs != null && pairs > 0) {
      const pct = Math.round(Math.abs(ratio - 1) * 100);
      momentum_notes.push(
        ratio > 1.05
          ? `Those nights are filling about ${pct}% faster than they were a year ago.`
          : ratio < 0.95
            ? `Those nights are filling about ${pct}% slower than they were a year ago.`
            : `Those nights are filling at about the same pace as a year ago.`,
      );
    }
    if (baseline != null) {
      const baselineDate = str(momentum.baselineDate);
      const from =
        source === "neighbor_pace"
          ? `the typical pace of nearby nights (this night itself had no usable history from last year)`
          : baselineDate
            ? `how this same night was booking at this point last year (${humanDate(baselineDate)})`
            : `how this same night was booking at this point last year`;
      momentum_notes.push(`The starting point was ${expectedWord(baseline)}, taken from ${from}.`);
    }
    momentum_notes.push(`Momentum is rougher than comparing similar nights, so treat it as a best effort, not a measurement.`);

    // The pairings themselves become challengeable evidence rows, keyed on
    // the year-ago side — that is where "that week was not normal" almost
    // always applies (a renovation or outage last year polluting the read).
    const rawPairs = Array.isArray(momentum.pairs) ? momentum.pairs : [];
    for (const item of rawPairs) {
      const p = rec(item);
      const yearAgoDate = str(p?.yearAgoDate);
      const pairDate = str(p?.date);
      if (!p || !yearAgoDate || !pairDate) continue;
      const recentCount = num(p.bookings);
      const priorCount = num(p.yearAgoBookings);
      comparables.push({
        date: yearAgoDate,
        summary:
          recentCount != null && priorCount != null
            ? `${bookingWord(priorCount)} at this point last year, against ${bookingWord(recentCount)} now for ${humanDate(pairDate)}`
            : `paired with ${humanDate(pairDate)} to read the pace`,
        reasons: ["used to read how the pace has changed since last year"],
      });
    }
    const baselineDate = str(momentum.baselineDate);
    if (baselineDate) {
      comparables.push({
        date: baselineDate,
        summary:
          baseline != null
            ? `${bookingWord(Math.round(baseline))} at this point last year, the starting point for the estimate`
            : `the starting point for the estimate`,
        reasons: ["this same night a year ago"],
      });
    }
  }

  return {
    measured,
    observed,
    expected: expectedSentence,
    verdict,
    guard_note,
    method: methodKey,
    assumptions,
    window_days: windowDays,
    days_out: daysOut,
    comparables,
    momentum_notes,
  };
}
