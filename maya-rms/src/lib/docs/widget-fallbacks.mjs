// The one plain sentence each "Try it" widget shows before it runs: in
// print, with scripting off, and in the docs helper's index. Shared by the
// widgets and scripts/docs-build.mjs so both always say the same thing.

const WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty",
];

function count(n) {
  return n >= 0 && n < WORDS.length ? WORDS[n] : String(n);
}

function capital(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const OCCUPANCY_DEFAULTS = { rooms: 12, outOfService: 3, booked: 8, threshold: 80, compare: "greater" };

export function occupancySentence(props = {}) {
  const p = { ...OCCUPANCY_DEFAULTS, ...props };
  const sellable = Math.max(0, p.rooms - p.outOfService);
  const label = p.compare === "less" ? "Less than" : "Greater than";
  const lead = `${capital(count(p.rooms))} rooms, ${count(p.outOfService)} out of service, ${count(p.booked)} booked`;
  if (sellable === 0) return `${lead}: no rooms to sell, so a ${label} ${p.threshold} rule does not fire.`;
  // Shares against the threshold over 100, as the engine compares them. In
  // percents, 11 of 20 comes out a hair over 55.
  const share = p.booked / sellable;
  const line = p.threshold / 100;
  const fires = p.compare === "less" ? share < line : share > line;
  return `${lead}: ${Math.round(share * 100)}% sellable occupancy, so a ${label} ${p.threshold} rule ${fires ? "fires" : "does not fire"}.`;
}

const FIXED = {
  BookingSpeedPlayground: "Expected 5, received 9, with 5 similar nights: Faster Than Normal.",
  StackingCalculator:
    "$200, up 10% to $220, then up 25% to $275. The $300 ceiling is not reached, so $275 is published.",
  WaitTimeline:
    "A 2-day wait after a raise on Monday afternoon: the rule reads the night again on Wednesday afternoon and counts only the bookings made since the raise, Monday afternoon through Wednesday, against the same 3 days of similar nights.",
  PriceCalculator: "20 rooms: $110 a month. 21 rooms: $105 a month, or $1,134 a year with 10% off.",
  FloorLadder: "A $35 turnover cost offers $50, then $60, $70 and $85.",
  SentenceBuilder:
    "An occupancy rule set to Greater than 80 writes: It was 85% full, past the 80% mark you set.",
  DateStrip: "Less than 7 covers tonight and the next six nights.",
  AppTour:
    "The app is one page: a header with Help, Billing, Team and Sign Out, five tabs (Calendar, Rules, Rate Simulator, Change Log and PMS), the Property dropdown beside the tabs, and banners above the tabs when something needs you.",
  MessageFinder: "",
};

export const WIDGET_NAMES = ["OccupancySlider", ...Object.keys(FIXED)];

/** The fallback sentence for a widget, or null for a name that is not a widget. */
export function fallbackFor(name, props = {}) {
  if (name === "OccupancySlider") return occupancySentence(props);
  return Object.prototype.hasOwnProperty.call(FIXED, name) ? FIXED[name] : null;
}
