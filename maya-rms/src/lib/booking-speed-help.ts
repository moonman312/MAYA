/**
 * The "?" panels beside Booking speed in the rule builder: how the speed
 * itself is measured, and how long the rule waits before it may fire again.
 * The example numbers are what classifyBookingSpeed really says against 5
 * expected (with at least 5 comparable dates), and the test holds them to it.
 *
 * The unit is a booking, not a room (observations/booking-rows.ts
 * bookingKeyOf): a reservation with several rooms counts once, live and on
 * the nights it is compared with, and the panel says so in one line.
 *
 * Once a night has been raised, a rule that raises counts only bookings
 * made after that raise, whichever rule made it (from the next day on,
 * bookingSpeedCountFrom in engine/pickup.ts), against the similar nights
 * over the same days; a rule that cuts counts from the night's last cut the
 * same way. Both panels say so. A typed price takes the adjustments off,
 * holds the night for the rule's wait from then, and then it judges its
 * whole window again.
 */

export const BOOKING_SPEED_HELP_EXAMPLE = {
  expected: 5,
  muchSlower: 1,
  normal: [5, 6],
  muchFaster: 10,
} as const;

export function bookingSpeedHelp(windowDays: number): { label: string; title: string; lines: string[] } {
  const span = windowDays === 1 ? "day" : windowDays === 30 ? "month" : "week";
  const e = BOOKING_SPEED_HELP_EXAMPLE;
  return {
    label: "How booking speed is measured",
    title: "How booking speed works",
    lines: [
      `MAYA counts how many bookings a night received during the past ${span}.`,
      "A booking with several rooms counts once.",
      `It compares that with similar nights from past years (same day of the week, same time of year) during a ${span} when they were just as far from arrival.`,
      `Say those nights usually got about ${e.expected} bookings in that ${span}. If this night got ${e.muchSlower}, that's much slower than normal. ${e.normal[0]} or ${e.normal[1]} is normal. ${e.muchFaster} is much faster than normal.`,
      "Only bookings in the room types this rule measures are counted.",
      "Once a night has been raised, rules that raise only count bookings made after that raise, whichever rule made it. Rules that cut count from the night's last cut the same way.",
      "Those bookings are compared with similar nights over the same days.",
      "If those keep the rule true after its wait, it adjusts that night again.",
    ],
  };
}

/**
 * The "?" beside the wait. What it says is what the engine does: the wait is
 * counted per night and room type from that cell's last fire, a stronger rule
 * may still step in during it, and a rule with no wait stored waits a week.
 * Once it is over the rule judges only bookings made after the night's last
 * raise (for a rule that raises) or last cut (for one that cuts), by any
 * rule; a price typed after that starts it over (waitAnchor and
 * bookingSpeedCountFrom in engine/pickup.ts).
 *
 * A rule that also counts pickup waits the longer of the two (ruleWaitDays),
 * so when the lookback window is what decides it the panel says so once and
 * `label` is that window, not the dropdown.
 */
export function bookingSpeedWaitHelp(
  label: string,
  pickupWindowLabel?: string | null,
): { label: string; title: string; lines: string[] } {
  return {
    label: "How the wait works",
    title: "Waiting before it fires again",
    lines: [
      `After this rule adjusts a night, it leaves that night alone for ${label}.`,
      ...(pickupWindowLabel
        ? [`This rule also counts pickup over ${pickupWindowLabel}, which is longer, so that is what it waits.`]
        : []),
      "When the wait is over it only counts bookings made since the night was last raised (for a rule that raises) or last cut (for one that cuts), whichever rule did it. If those keep it true, it adjusts again, and MAYA tells you once a night has been adjusted three times.",
      "A price you type on a night after it adjusted starts it over: it waits again from that price, then looks at its whole window.",
      "Each room type waits on its own, and a stronger rule can still step in while this one waits.",
    ],
  };
}
