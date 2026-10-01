// @vitest-environment jsdom
/**
 * A pricing run in the change log shows each change's words as the server
 * wrote them for the run's mode: a simulated run is tagged and says nothing
 * was sent; a live change says where its price went; the demo log, which
 * carries none of that, reads as it always did.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ModeSwitchItem } from "./mode-switch-item";
import { PricingRunItem } from "./pricing-run-item";
import type { ChangelogCycle, ChangelogEntry } from "@/types/domain";

afterEach(cleanup);

const entry = (o: Partial<ChangelogEntry> = {}): ChangelogEntry => ({
  room_type: "Queen",
  rule_name: "Busy nights",
  original_rate: 150,
  new_rate: 165,
  change_pct: 10,
  occupancy_pct: 82,
  description: "",
  stay_date: "2026-11-13",
  room_type_id: "rt-1",
  evaluation_run_id: "run-1",
  narrative: ['"Busy nights" raised this night 10%, from $150.00 to $165.00.'],
  ...o,
});

const run = (changes: ChangelogEntry[], mode?: "simulation" | "live"): ChangelogCycle => ({
  cycle: 1,
  timestamp: "2026-10-01T10:00:00Z",
  has_changes: true,
  changes,
  ...(mode ? { mode } : {}),
});

const show = (cycle: ChangelogCycle) =>
  render(<PricingRunItem cycle={cycle} formatWhen={() => "Thu, Oct 1, 2026, 10:00 AM"} formatAge={() => "4 min ago"} formatExact={() => "exact"} />);

describe("PricingRunItem", () => {
  it("tags a simulated run and says what would have happened, and that nothing was sent", () => {
    show(
      run(
        [
          entry({
            mode: "simulation",
            headline: "Simulation: the price for Fri Nov 13, Queen would have gone from $150.00 to $165.00.",
            send_state: "simulated",
            send_line: "Nothing was sent to Cloudbeds.",
            narrative: ['"Busy nights" would have raised this night 10%, from $150.00 to $165.00.'],
          }),
        ],
        "simulation",
      ),
    );
    expect(screen.getByText("Simulation")).toBeTruthy();
    expect(screen.getByText("Simulation: the price for Fri Nov 13, Queen would have gone from $150.00 to $165.00.")).toBeTruthy();
    expect(screen.getByText("Nothing was sent to Cloudbeds.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/up to \$165/);
  });

  it("adds what going live did with a simulated price, and words the count it doesn't show as would-have", () => {
    show({
      ...run(
        [
          entry({
            mode: "simulation",
            headline: "Simulation: the price for Fri Nov 13, Queen would have gone from $150.00 to $165.00.",
            send_state: "simulated",
            send_line: "Nothing was sent to Cloudbeds at the time.",
            send_after_state: "sent",
            send_after_line: "Sent to Cloudbeds after you went live.",
          }),
        ],
        "simulation",
      ),
      total_changes: 13,
    });
    expect(screen.getByText("Nothing was sent to Cloudbeds at the time.").className).toContain("amber");
    expect(screen.getByText("Sent to Cloudbeds after you went live.").className).toContain("emerald");
    expect(screen.getByText("And 12 more prices would have changed in this run.")).toBeTruthy();
  });

  it("shows a switch to live as a line of its own", () => {
    render(
      <ModeSwitchItem
        item={{ kind: "mode_switch", id: "m1", timestamp: "2026-10-01T10:00:00Z", to: "live", title: "Sam took pricing live. From the next cycle, MAYA sends its prices to Cloudbeds." }}
        formatWhen={() => "Thu, Oct 1, 2026, 10:00 AM"}
        formatAge={() => null}
        formatExact={() => "exact"}
      />,
    );
    expect(screen.getByText("Went live").className).toContain("emerald");
    expect(screen.getByText("Sam took pricing live. From the next cycle, MAYA sends its prices to Cloudbeds.")).toBeTruthy();
  });

  it("says where a live price went", () => {
    show(
      run(
        [entry({ mode: "live", headline: "Queen · stay 2026-11-13: $150.00 up to $165.00 (+10%)", send_state: "sent", send_line: "Sent to Cloudbeds." })],
        "live",
      ),
    );
    expect(screen.queryByText("Simulation")).toBeNull();
    expect(screen.getByText("Sent to Cloudbeds.")).toBeTruthy();
  });

  it("reads as it always did without the server's words", () => {
    show(run([entry()]));
    expect(screen.getByText("Queen · stay 2026-11-13: $150.00 up to $165.00 (+10%)")).toBeTruthy();
    expect(screen.queryByText(/sent/i)).toBeNull();
  });
});
