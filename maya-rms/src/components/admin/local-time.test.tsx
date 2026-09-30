// @vitest-environment jsdom
/**
 * "as of" in the reader's own time: the time alone when it was today, the
 * date in front when it was not, and the day checked again when the reader
 * comes back to a tab left open.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalTime } from "./local-time";

// Local times, so the test reads the same in any time zone.
const local = (day: number, h: number, m: number) => new Date(2026, 8, day, h, m);
const time = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const date = (d: Date) => d.toLocaleDateString([], { month: "short", day: "numeric" });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("LocalTime", () => {
  it("says only the time when it was today", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(local(30, 14, 9));
    const at = local(30, 14, 5);
    const { container } = render(<LocalTime iso={at.toISOString()} serverToday="2026-09-30" />);
    expect(container.textContent).toBe(time(at));
  });

  it("puts the date in front when it was not today", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(local(30, 0, 3));
    const at = local(29, 23, 58);
    const { container } = render(<LocalTime iso={at.toISOString()} serverToday="2026-09-30" />);
    expect(container.textContent).toBe(`${date(at)}, ${time(at)}`);
  });

  it("checks the day again when the tab is looked at again", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(local(29, 23, 59));
    const at = local(29, 23, 58);
    const { container } = render(<LocalTime iso={at.toISOString()} serverToday="2026-09-29" />);
    expect(container.textContent).toBe(time(at));
    vi.setSystemTime(local(30, 8, 0));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(container.textContent).toBe(`${date(at)}, ${time(at)}`);
  });
});
