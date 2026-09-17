import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDebounced } from "./use-calendar-live";

describe("createDebounced", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once after the delay", () => {
    const fn = vi.fn();
    const debounced = createDebounced(fn, 2000);

    debounced.call();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst of calls into one invocation", () => {
    const fn = vi.fn();
    const debounced = createDebounced(fn, 2000);

    for (let i = 0; i < 365; i++) {
      debounced.call();
      vi.advanceTimersByTime(10);
    }
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resets the timer on each call", () => {
    const fn = vi.fn();
    const debounced = createDebounced(fn, 2000);

    debounced.call();
    vi.advanceTimersByTime(1500);
    debounced.call();
    vi.advanceTimersByTime(1500);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("can fire again after a completed cycle", () => {
    const fn = vi.fn();
    const debounced = createDebounced(fn, 2000);

    debounced.call();
    vi.advanceTimersByTime(2000);
    debounced.call();
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("cancel drops the pending invocation", () => {
    const fn = vi.fn();
    const debounced = createDebounced(fn, 2000);

    debounced.call();
    debounced.cancel();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel is a no-op when nothing is pending", () => {
    const fn = vi.fn();
    const debounced = createDebounced(fn, 2000);

    expect(() => debounced.cancel()).not.toThrow();
  });

  it("still fires during an endless stream once the max wait has passed, then starts a new burst", () => {
    const fn = vi.fn();
    const debounced = createDebounced(fn, 2000, 10_000);
    // A change every 500ms for 25 seconds never leaves a 2s gap.
    for (let t = 0; t < 25_000; t += 500) {
      debounced.call();
      vi.advanceTimersByTime(500);
    }
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("lets a reservations-only stream wait for its longer ceiling, and a price change bring it forward", () => {
    const fn = vi.fn();
    const debounced = createDebounced(fn, 2000, 10_000);
    // An import streaming reservation rows for 50 seconds: no refresh yet.
    for (let t = 0; t < 50_000; t += 500) {
      debounced.call(60_000);
      vi.advanceTimersByTime(500);
    }
    expect(fn).not.toHaveBeenCalled();
    // The engine republishes a price: the burst's ceiling drops to 10s, long past.
    debounced.call();
    vi.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledTimes(1);
    // A reservations-only stream still refreshes once its own minute is up.
    for (let t = 0; t < 70_000; t += 500) {
      debounced.call(60_000);
      vi.advanceTimersByTime(500);
    }
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
