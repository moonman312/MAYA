// @vitest-environment jsdom
/**
 * A push problem reads as one item, collapsed: what is wrong, how much, and
 * whether it is still going on. The tries only show when asked for.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangelogPushProblem } from "@/types/domain";
import { PushProblemItem } from "./push-problem-item";

afterEach(cleanup);

const item: ChangelogPushProblem = {
  kind: "push_problem",
  id: "inc-1",
  timestamp: "2026-09-17T10:00:00Z",
  pms: "Cloudbeds",
  cause: "rate_plan_not_updatable",
  title: "Cloudbeds won't let MAYA change Deluxe King rates because that rate follows another rate plan",
  action: "In Cloudbeds, give this room type a base rate of its own that doesn't follow another plan.",
  nights: 6,
  room_types: ["Deluxe King"],
  status: "ongoing",
  resolved_at: null,
  resolution: null,
  attempts: 31,
  retries: [
    {
      first_at: "2026-09-17T10:00:00Z",
      last_at: "2026-09-17T10:45:00Z",
      count: 30,
      nights: 6,
      room_types: 1,
      outcome: "failed",
      label: "Cloudbeds refused them",
      detail: "Rate is derived",
    },
    {
      first_at: "2026-09-17T10:50:00Z",
      last_at: "2026-09-17T10:50:00Z",
      count: 1,
      nights: 1,
      room_types: 1,
      outcome: "landed",
      label: "Went through",
      detail: null,
    },
  ],
  retries_not_kept: 0,
};

const formats = { formatWhen: (iso: string) => `when ${iso}`, formatAge: () => "2 hr ago", formatExact: (iso: string) => iso };

describe("PushProblemItem", () => {
  it("is collapsed by default and says what is wrong, how much, and that it is still happening", () => {
    const view = render(<PushProblemItem item={item} {...formats} />);
    const text = view.container.textContent ?? "";
    expect(text).toContain("Rates not reaching Cloudbeds");
    expect(text).toContain(`${item.title}.`);
    expect(text).toContain("6 nights, 1 room type");
    expect(text).toContain("Still happening");
    expect(text).toContain(item.action!);
    expect(text).not.toContain("Cloudbeds refused them");
    expect(text).not.toMatch(/[—–]/);
  });

  it("opens to the condensed tries, one line per kind of outcome", () => {
    const view = render(<PushProblemItem item={item} {...formats} />);
    fireEvent.click(view.getByRole("button", { name: "Show 31 tries" }));
    const lines = view.getAllByRole("listitem").map((li) => li.textContent);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^30 tries, .+ to .+, 6 nights: Cloudbeds refused them$/);
    expect(lines[1]).toMatch(/^1 try, .+, 1 night: Went through$/);
    expect(view.getAllByRole("listitem")[0].getAttribute("title")).toBe("Rate is derived");
  });

  it("says when it ended, and offers no advice once it has", () => {
    const view = render(
      <PushProblemItem item={{ ...item, status: "resolved", resolved_at: "2026-09-17T11:00:00Z", resolution: "landed", action: null }} {...formats} />,
    );
    const text = view.container.textContent ?? "";
    expect(text).toContain("Resolved when 2026-09-17T11:00:00Z");
    expect(text).not.toContain("Still happening");
  });
});
