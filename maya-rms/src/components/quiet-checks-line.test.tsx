// @vitest-environment jsdom
/**
 * A stretch of pricing runs that changed nothing reads as one quiet line: how
 * many checks, from when to when, and how long ago the last one was.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangelogQuietChecks } from "@/types/domain";
import { clockTime, shortTime } from "./push-problem-item";
import { QuietChecksLine } from "./quiet-checks-line";

afterEach(cleanup);

// Minutes apart on one day in every time zone, so the span keeps one date.
const first = "2026-09-24T12:05:00Z";
const last = "2026-09-24T12:55:00Z";
const stretch = (over: Partial<ChangelogQuietChecks> = {}): ChangelogQuietChecks => ({
  kind: "quiet_checks",
  id: "q-1",
  timestamp: last,
  first_at: first,
  checks: 47,
  ...over,
});
const formats = { formatAge: () => "5 min ago", formatExact: (iso: string) => `exact ${iso}` };

describe("QuietChecksLine", () => {
  it("says how many checks changed nothing, when they ran and how long ago the last was", () => {
    const view = render(<QuietChecksLine item={stretch()} {...formats} />);
    expect(view.container.textContent).toBe(
      `Prices checked 47 times, nothing needed to change. from ${shortTime(first)} to ${clockTime(last)} (5 min ago)`,
    );
    const time = view.container.querySelector("time")!;
    expect(time.getAttribute("dateTime")).toBe(last);
    expect(time.getAttribute("title")).toBe(`exact ${first} to exact ${last}`);
  });

  it("says once for a single check, with its one time", () => {
    const view = render(<QuietChecksLine item={stretch({ checks: 1, first_at: last })} {...formats} />);
    expect(view.container.textContent).toBe(
      `Prices checked once, nothing needed to change. ${shortTime(last)} (5 min ago)`,
    );
  });

  it("says the oldest line is the stretch just before the change above it", () => {
    const view = render(<QuietChecksLine item={stretch({ checks: 9, just_before: true })} {...formats} />);
    expect(view.container.textContent).toContain(
      "Just before that, prices were checked 9 times and nothing needed to change.",
    );
  });

  it("dates both ends when the checks run over midnight, and reads quieter than a change", () => {
    const view = render(
      <QuietChecksLine
        item={stretch({ first_at: "2026-09-20T12:05:00Z", checks: 1_152 })}
        formatAge={() => null}
        formatExact={formats.formatExact}
      />,
    );
    const text = view.container.textContent ?? "";
    expect(text).toBe(
      `Prices checked 1,152 times, nothing needed to change. from ${shortTime("2026-09-20T12:05:00Z")} to ${shortTime(last)}`,
    );
    expect(text).not.toMatch(/[—!]/);
    // One line of small text, not a bordered card like a run that changed prices.
    const line = view.container.firstElementChild!;
    expect(line.className).not.toMatch(/\bborder\b/);
    expect(line.className).toContain("text-xs");
  });
});
