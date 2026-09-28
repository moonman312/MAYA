/**
 * Room type helpers the room types route uses, kept out of the route file:
 * a Next.js route may export only its handlers and route config.
 */

/** A type counts unless someone (or the import heuristic) said it doesn't. */
export function isCountingRoom(rt: { counts_as_room?: boolean | null }): boolean {
  return rt.counts_as_room !== false;
}

/**
 * A sane made-up starting price when nothing has been published yet.
 *
 * The guardrail midpoint only means something when the owner actually set
 * guardrails. MAYA's "no limit" default is floor 1 / ceiling 99999.99, whose
 * midpoint is $50,000 — so wide ranges fall back to the floor instead of
 * opening the simulator on an absurd number.
 */
export function fallbackSeed(floor: number, ceiling: number): number {
  if (ceiling > 0 && floor > 0 && ceiling <= floor * 10) {
    return Math.round((floor + ceiling) / 2);
  }
  return Math.max(1, Math.round(floor));
}
