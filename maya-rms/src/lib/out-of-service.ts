/**
 * Units taken out of service on a room type, as room_type_out_of_service
 * rows keep them (start_date and end_date both included).
 */

/**
 * The most units already out on any one night of [startDate, endDate].
 * Night by night rather than a sum of rows: two rows that both touch the
 * range but not each other are not stacked, and two that do are.
 */
export function peakUnitsOut(
  rows: { start_date: string; end_date: string; units: number }[],
  startDate: string,
  endDate: string,
): number {
  let peak = 0;
  const d = new Date(`${startDate}T00:00:00Z`);
  for (let night = startDate; night <= endDate; ) {
    let out = 0;
    for (const r of rows) if (night >= r.start_date && night <= r.end_date) out += r.units;
    if (out > peak) peak = out;
    d.setUTCDate(d.getUTCDate() + 1);
    night = d.toISOString().slice(0, 10);
  }
  return peak;
}
