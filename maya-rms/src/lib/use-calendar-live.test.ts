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
});
