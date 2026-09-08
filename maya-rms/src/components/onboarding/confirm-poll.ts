/**
 * Pacing for the post-checkout poll.
 *
 * The webhook almost always lands within seconds, so the first few asks come
 * quickly — that part is for the person watching. Everything after is for us:
 * each miss stretches the next wait, and past the deadline the tab stops
 * asking altogether, because the pathological case is not a slow webhook but
 * an abandoned tab left polling an endpoint that will never say yes.
 */

export const INITIAL_POLL_MS = 1200;
export const MAX_POLL_MS = 15_000;
export const BACKOFF_FACTOR = 1.5;
/** After this, stop pretending it is about to happen and say something useful. */
export const PATIENCE_MS = 25_000;
/** After this, stop asking entirely — the email path owns it now. */
export const GIVE_UP_MS = 300_000;

export type ConfirmPhase = "waiting" | "slow" | "stalled";

export function nextPollDelay(previousMs: number): number {
  return Math.min(Math.round(previousMs * BACKOFF_FACTOR), MAX_POLL_MS);
}

export function phaseAfter(elapsedMs: number): ConfirmPhase {
  if (elapsedMs > GIVE_UP_MS) return "stalled";
  if (elapsedMs > PATIENCE_MS) return "slow";
  return "waiting";
}
