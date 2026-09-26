// The numbers the "Try it" widgets use, in one place so a change in the
// pricing engine is one edit here. Each matches the engine the docs describe.

export const engineFacts = {
  /** nights priced: tonight and the next 59 */
  windowNights: 60,
  /** about how often a cycle runs, as set up today */
  cycleMinutes: 5,
  bookingSpeed: {
    /** ratio edges on the fast side; the slow side mirrors them (0.8, 0.5, 1 in 3.5) */
    bands: { faster: 1.25, muchFaster: 2, surging: 3.5 },
    /** leaving Normal needs a difference of at least this many bookings */
    noiseGuard: (expected: number) => Math.max(2, 1.5 * Math.sqrt(expected)),
    /** Stalled and Surging need at least this much, or they step in one level */
    extremeGuard: (expected: number) => Math.max(4, 2 * Math.sqrt(expected)),
    /** with fewer similar nights than this, the level stays one step from Normal */
    fewComparables: 5,
    /** expected is treated as at least this for the division */
    minExpected: 0.5,
  },
  limits: { floorDefault: 1, ceilingDefault: 99999.99 },
  /** Greater than 80 means more than 80, never 80 exactly */
  strictCompare: true,
  /** the "Then waits (advanced)" choices, in days */
  waits: [1, 2, 3, 7, 14],
  /** the "Measured over" choices, in days */
  windows: [1, 7, 30],
  /** a pickup rule's lookback choices, in days */
  pickupLookbacks: [1, 3, 7],
  /** price per room per month by room count; yearly takes 10% off from 21 rooms */
  brackets: [
    { min: 1, max: 20, perRoom: 5.5, yearlyOff: 0 },
    { min: 21, max: 40, perRoom: 5.0, yearlyOff: 0.1 },
    { min: 41, max: 60, perRoom: 4.0, yearlyOff: 0.1 },
    { min: 61, max: 80, perRoom: 3.0, yearlyOff: 0.1 },
    { min: 81, max: 500, perRoom: 2.5, yearlyOff: 0.1 },
  ],
  floorLadder: { skippedFirstOffer: 40 },
} as const;

export type SpeedLevel =
  | "Stalled"
  | "Much Slower Than Normal"
  | "Slower Than Normal"
  | "Normal"
  | "Faster Than Normal"
  | "Much Faster Than Normal"
  | "Surging";

export const SPEED_LEVELS: SpeedLevel[] = [
  "Stalled",
  "Much Slower Than Normal",
  "Slower Than Normal",
  "Normal",
  "Faster Than Normal",
  "Much Faster Than Normal",
  "Surging",
];

export interface SpeedStep {
  /** which check this is */
  check: "band" | "noise" | "extreme" | "few";
  /** what the level was after this step */
  level: SpeedLevel;
  /** true when this check held the reading back, as the engine counts it */
  changed: boolean;
}

export interface SpeedReading {
  ratio: number;
  difference: number;
  level: SpeedLevel;
  steps: SpeedStep[];
  /**
   * The check "How did we know?" writes its one note about: the last that
   * changed the level, as the engine records it. Null when none did.
   */
  guard: SpeedStep["check"] | null;
}

const levelAt = (rank: number) => SPEED_LEVELS[rank + 3];

/** How a night reads: the same bands and checks, in the same order, as the engine. */
export function readBookingSpeed(expected: number, recent: number, similarNights: number): SpeedReading {
  const { bands, noiseGuard, extremeGuard, fewComparables, minExpected } = engineFacts.bookingSpeed;
  const e = Math.max(0, expected);
  const ratio = Math.max(recent, 0) / Math.max(e, minExpected);
  const difference = Math.abs(recent - e);
  let rank = 0;
  if (ratio >= bands.surging) rank = 3;
  else if (ratio >= bands.muchFaster) rank = 2;
  else if (ratio >= bands.faster) rank = 1;
  else if (ratio <= 1 / bands.surging) rank = -3;
  else if (ratio <= 1 / bands.muchFaster) rank = -2;
  else if (ratio <= 1 / bands.faster) rank = -1;
  const steps: SpeedStep[] = [{ check: "band", level: levelAt(rank), changed: false }];

  if (difference < noiseGuard(e)) {
    // With the same count expected and received there was nothing to hold
    // back: the band only reads off the minimum expected, and the engine
    // writes no note for it.
    const changed = rank !== 0 && difference > 0;
    rank = 0;
    steps.push({ check: "noise", level: levelAt(rank), changed });
  } else {
    steps.push({ check: "noise", level: levelAt(rank), changed: false });
    const extreme = Math.abs(rank) === 3 && difference < extremeGuard(e);
    if (extreme) rank = Math.sign(rank) * 2;
    steps.push({ check: "extreme", level: levelAt(rank), changed: extreme });
    const few = similarNights < fewComparables && Math.abs(rank) > 1;
    if (few) rank = Math.sign(rank);
    steps.push({ check: "few", level: levelAt(rank), changed: few });
  }
  const guard = steps.filter((s) => s.changed).at(-1)?.check ?? null;
  return { ratio, difference, level: levelAt(rank), steps, guard };
}

/**
 * Sellable occupancy as a share of the rooms you can sell (0.55 is 55%), or
 * null when there is nothing to sell. A share, as the engine keeps it.
 */
export function sellableOccupancy(rooms: number, outOfService: number, booked: number): number | null {
  const sellable = rooms - outOfService;
  if (sellable <= 0) return null;
  return booked / sellable;
}

/**
 * Whether an occupancy rule fires. The threshold is the percent the reader
 * types; the engine stores it as a share and compares shares, so this does
 * too. Multiplying up to a percent first makes 11 of 20 come out a hair over
 * 55, which would fire a Greater than 55 rule the engine does not.
 */
export function occupancyFires(share: number | null, compare: "greater" | "less", threshold: number): boolean {
  if (share === null) return false;
  const line = threshold / 100;
  return compare === "greater" ? share > line : share < line;
}

export interface Adjustment {
  kind: "percent" | "amount";
  direction: "up" | "down";
  value: number;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Applies changes in order: percents multiply, amounts add. Then, as MAYA
 * does, the result is rounded to the cent before the limits look at it, and
 * the ceiling is checked before the floor. Checking the unrounded price
 * would stop $125.999... at a $126 floor that the rounded $126.00 is on.
 */
export function stackPrice(base: number, changes: Adjustment[], floor: number, ceiling: number) {
  let running = base;
  const steps = changes.map((c) => {
    const sign = c.direction === "up" ? 1 : -1;
    running = c.kind === "percent" ? running * (1 + (sign * c.value) / 100) : running + sign * c.value;
    return cents(running);
  });
  const unclamped = cents(running);
  const clampedBy = unclamped > ceiling ? ("ceiling" as const) : unclamped < floor ? ("floor" as const) : null;
  return {
    steps,
    unclamped,
    published: clampedBy === "ceiling" ? ceiling : clampedBy === "floor" ? floor : unclamped,
    clampedBy,
  };
}

export function bracketFor(rooms: number) {
  return engineFacts.brackets.find((b) => rooms >= b.min && rooms <= b.max) ?? null;
}

/** What a property pays: monthly, or yearly paid once. */
export function priceFor(rooms: number, period: "monthly" | "yearly") {
  const bracket = bracketFor(rooms);
  if (!bracket) return null;
  const monthly = cents(rooms * bracket.perRoom);
  const yearly = cents(monthly * 12 * (1 - bracket.yearlyOff));
  return { bracket, monthly, yearly, total: period === "monthly" ? monthly : yearly };
}

/** The floor question's offers: a little above turnover cost, then at least 15% more each time. */
export function floorOffers(turnoverCost: number | null, count = 4): number[] {
  const up5 = (n: number) => Math.ceil(n / 5) * 5;
  let offer = turnoverCost && turnoverCost > 0 ? up5(turnoverCost * 1.2 + 5) : engineFacts.floorLadder.skippedFirstOffer;
  const out = [offer];
  while (out.length < count) {
    offer = up5(offer * 1.15 + 1);
    out.push(offer);
  }
  return out;
}

export function money(n: number, opts: { cents?: boolean } = {}): string {
  const showCents = opts.cents ?? !Number.isInteger(n);
  return (
    "$" +
    n.toLocaleString("en-US", { minimumFractionDigits: showCents ? 2 : 0, maximumFractionDigits: showCents ? 2 : 0 })
  );
}
