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
 * Once a rule has adjusted a night, it counts only the bookings made since
 * its own last adjustment there (bookingSpeedCountFrom in engine/pickup.ts:
 * a raise rule from the raise on, the rest of that day included; a cut
 * rule from the day after its cut), against the similar nights over the
 * same days. Bookings another rule acted on still count toward it (Jake,
 * 2026-09-24: the count carries on across rules). A rule that cuts reads
 * full days only, ending yesterday; one that raises counts today so far
 * too (countsCompleteDays in engine/booking-speed-provider.ts). Both panels
 * say what applies. A typed price takes the adjustments off, holds the
 * night for the rule's wait from then, and then it judges its whole window
 * again.
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
      "A rule that cuts counts full days only, up to yesterday. A rule that raises counts today so far too.",
      "Once this rule has adjusted a night, it only counts bookings made since then. Bookings another rule acted on still count.",
      "Those bookings are compared with similar nights over the same days.",
      "If those keep the rule true after its wait, it adjusts that night again.",
    ],
  };
}

/**
 * The "?" beside the wait. What it says is what the engine does: the wait is
 * counted per night and room type from that cell's last fire, a stronger rule
 * may still step in during it, and a rule with no wait stored waits a week.
 * Once it is over the rule judges only bookings made since its own last
 * adjustment of the night, bookings another rule acted on included; a
 * price typed after that starts it over (waitAnchor and
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
      "When the wait is over it only counts bookings made since it last adjusted that night. Bookings another rule acted on still count. If those keep it true, it adjusts again, and MAYA tells you once a night has been adjusted three times.",
      "A price you type on a night after it adjusted starts it over: it waits again from that price, then looks at its whole window.",
      "Each room type waits on its own, and a stronger rule can still step in while this one waits.",
    ],
  };
}
