/**
 * The "?" beside Booking speed's Measured over in the rule builder. The
 * example numbers are what classifyBookingSpeed really says against 5
 * expected (with at least 5 comparable dates), and the test holds them to it.
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
      `MAYA counts how many rooms were booked for a night during the past ${span}.`,
      `It compares that with similar nights from past years (same day of the week, same time of year) during a ${span} when they were just as far from arrival.`,
      `Say those nights usually got about ${e.expected} rooms booked in that ${span}. If this night got ${e.muchSlower}, that's much slower than normal. ${e.normal[0]} or ${e.normal[1]} is normal. ${e.muchFaster} is much faster than normal.`,
      "Only the room types this rule measures are counted.",
    ],
  };
}
