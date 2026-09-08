/**
 * The post-checkout poll's pacing. The numbers themselves are taste; what
 * these pin down is the shape — quick at first, easing off, and finite. A
 * regression here is invisible in the UI and shows up as a tab quietly making
 * thousands of requests an hour forever.
 */
import { describe, expect, it } from "vitest";
import {
  GIVE_UP_MS,
  INITIAL_POLL_MS,
  MAX_POLL_MS,
  PATIENCE_MS,
  nextPollDelay,
  phaseAfter,
} from "./confirm-poll";

describe("nextPollDelay", () => {
  it("grows from the initial delay and never passes the cap", () => {
    let delay = INITIAL_POLL_MS;
    for (let i = 0; i < 50; i++) {
      const next = nextPollDelay(delay);
      expect(next).toBeGreaterThan(delay - 1);
      expect(next).toBeLessThanOrEqual(MAX_POLL_MS);
      delay = next;
    }
    expect(delay).toBe(MAX_POLL_MS);
  });

  it("keeps the first re-asks quick — the webhook usually lands in seconds", () => {
    // Three misses in, the wait is still under 3s; the fast path stays fast.
    expect(nextPollDelay(nextPollDelay(INITIAL_POLL_MS))).toBeLessThan(3000);
  });
});

describe("phaseAfter", () => {
  it("waits quietly, then admits slowness, then stops", () => {
    expect(phaseAfter(0)).toBe("waiting");
    expect(phaseAfter(PATIENCE_MS)).toBe("waiting");
    expect(phaseAfter(PATIENCE_MS + 1)).toBe("slow");
    expect(phaseAfter(GIVE_UP_MS)).toBe("slow");
    expect(phaseAfter(GIVE_UP_MS + 1)).toBe("stalled");
  });
});

describe("the whole schedule", () => {
  it("gives up after a bounded number of polls", () => {
    let elapsed = 0;
    let delay = INITIAL_POLL_MS;
    let polls = 1; // the immediate ask on mount
    while (phaseAfter(elapsed) !== "stalled") {
      elapsed += delay;
      delay = nextPollDelay(delay);
      polls++;
    }
    // ~25 asks over five minutes, not the ~250 a fixed 1.2s timer would make.
    expect(polls).toBeLessThan(35);
  });
});
