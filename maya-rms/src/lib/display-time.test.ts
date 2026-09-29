import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDisplayTime } from "./display-time";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("formatDisplayTime", () => {
  it("shows the moment on the viewer's clock, with the zone, not a raw UTC string", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(formatDisplayTime("2026-09-22T22:05:12.345+00:00", "en-US")).toBe("Sep 22, 2026, 3:05:12 PM PDT");
  });

  it("follows the viewer's zone, so the date can move too", () => {
    vi.stubEnv("TZ", "Europe/London");
    expect(formatDisplayTime("2026-09-22T23:30:00Z", "en-US")).toBe("Sep 23, 2026, 12:30:00 AM GMT+1");
  });

  it("gives back something that is not a date as it was", () => {
    expect(formatDisplayTime("not a date", "en-US")).toBe("not a date");
  });
});
