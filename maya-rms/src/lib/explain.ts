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
 * values in parentheses, sentences that survive a missing metric.
 */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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

function expectedWord(n: number): string {
  if (n < 1) return "almost none";
  const rounded = Math.round(n);
  return `about ${bookingWord(rounded)}`;
}

export type ExplainComparable = {
  /** The challengeable date — for momentum pairs this is the year-ago side, where "that week was not normal" almost always applies. */
  date: string;
  /** What this night contributed, in plain words ("4 bookings in the same stretch", "no history for this night"). */
  summary: string;
  /** Why this night was considered a fair comparison, in plain words. */
  reasons: string[];
};

export type ExplainView = {
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

/**
 * Build the tiered view from one raw snapshot. Returns null when the
 * snapshot lacks the essentials (legacy rows, malformed JSON).
 */
export function buildExplainView(raw: unknown): ExplainView | null {
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

  const windowPhrase = windowDays === 1 ? "day" : `${windowDays} days`;
  const observed = `In the last ${windowPhrase}, ${bookingWord(recent)} arrived for this night, with ${dayWord(daysOut)} still to go before arrival.`;

  // The engine persists insufficient_data snapshots with a numeric
  // expectedBookings of 0 and a fully computed classification — but it also
  // BLOCKED every booking-speed rule for the night. Rendering that
  // classification as a verdict would assert a call the engine refused to
  // act on, so the whole level-2 story switches to the honest version.
  const insufficient = methodKey === "insufficient_data";
  const expectedSentence = insufficient
    ? `We do not have enough history yet to say what would be normal for this night, so no expectation was formed.`
    : expected != null
      ? `By this point on nights like this one, we would expect ${expectedWord(expected)} over the same stretch.`
      : `We could not form an expectation for this night.`;
  const verdict = insufficient
    ? `No booking-speed call was made, and rules that watch booking speed were not allowed to act on this night.`
    : `That reads as ${label}.`;

  const guardNotes: Record<string, string> = {
    small_difference: `The raw numbers leaned away from Normal, but the gap was small enough to be ordinary noise at this volume, so we held the call at Normal.`,
    extreme_demoted: `The raw numbers pointed at an even stronger call, but not by enough evidence to justify it, so we softened it one step.`,
    few_comparables: `We found only a few genuinely comparable nights, so we kept the call within one step of Normal no matter how strong the numbers looked.`,
  };
  const guard_note = insufficient ? null : (guardNotes[guard] ?? null);

  /* ── Level 3: assumptions ── */
  const selection = rec(snap.selection);
  const selAssumptions = rec(selection?.assumptions);
  const assumptions: string[] = [];
  if (methodKey === "comparable" && selAssumptions) {
    const dow = str(selAssumptions.dayOfWeek);
    const seasonLabel = str(selAssumptions.seasonLabel);
    const seasonRange = str(selAssumptions.seasonRange);
    const holiday = rec(selAssumptions.holiday);
    if (dow) {
      assumptions.push(`We only compared against other ${dow} nights — booking rhythms differ too much across days of the week to mix them.`);
    }
    if (holiday) {
      const hLabel = str(holiday.label) ?? "a holiday";
      assumptions.push(`This night sits in the orbit of ${hLabel}, so we matched against the same position relative to that holiday in earlier years, not the same calendar date.`);
    } else if (seasonLabel) {
      const range = seasonRange ? ` (${seasonRange})` : "";
      assumptions.push(`We stayed inside the same demand season your history shows${range ? `: ${seasonLabel}${range}` : `: ${seasonLabel}`}.`);
    }
    if (selAssumptions.relaxed === true) {
      assumptions.push(`Strict matching found too few usable nights, so we relaxed the criteria a step — worth knowing when weighing how much to trust this one.`);
    }
    assumptions.push(`Closed periods and any dates you have told us were not normal are left out of the comparison entirely.`);
  }
  if (methodKey === "momentum") {
    assumptions.push(`This night had no usable comparable nights in your history, so instead of guessing from nothing we read your recent booking momentum.`);
    assumptions.push(`Momentum means: how nights near this one are filling right now, compared to how the same nights were filling at this time last year.`);
  }
  if (methodKey === "insufficient_data") {
    assumptions.push(`There was not enough history to form any expectation, so no rule was allowed to act on booking speed for this night.`);
  }

  /* ── Level 4: evidence ── */
  const perComparable = Array.isArray(snap.perComparable) ? snap.perComparable : [];
  const comparables: ExplainComparable[] = [];
  for (const item of perComparable) {
    const c = rec(item);
    const date = str(c?.date);
    if (!c || !date) continue;
    const hasData = c.hasData !== false;
    const bookings = num(c.bookings);
    comparables.push({
      date,
      summary:
        !hasData || bookings == null
          ? "no history for this night"
          : bookings === 1
            ? "1 booking in the same stretch"
            : `${bookings} bookings in the same stretch`,
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
          ? `No nearby night could be paired with a counterpart from last year, so we cannot say whether the pace has changed.`
          : pairs === 1
            ? `1 nearby night could be paired with its counterpart from last year.`
            : `${pairs} nearby nights could be paired with their counterparts from last year.`,
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
    momentum_notes.push(`A momentum read is fuzzier than a direct comparison — treat it as a best effort, not a measurement.`);

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
            ? `${bookingWord(Math.round(baseline))} at this point last year — the starting point for the estimate`
            : `the starting point for the estimate`,
        reasons: ["this same night a year ago"],
      });
    }
  }

  return {
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
