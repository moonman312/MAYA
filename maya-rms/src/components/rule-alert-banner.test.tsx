// @vitest-environment jsdom
/**
 * The banner that asks the owner about a rule which keeps adjusting.
 *
 * It only appears when there is something to answer, it shows the nights
 * grouped under their rule with the reason and the limit, and the buttons are
 * there only for someone who may change rules. Answering sends the night it
 * is about, and the list it gets back is what shows next.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuleAlertsView } from "@/lib/rule-alerts";
import { RuleAlertBanner } from "./rule-alert-banner";

const view = (over: Partial<RuleAlertsView> = {}): RuleAlertsView => ({
  currency_symbol: "$",
  can_manage: true,
  simulation: false,
  alerts: [
    {
      id: "alert-1",
      rule_id: "rule-1",
      rule_name: "Slow-date rescue",
      direction: "decrease",
      headline: '"Slow-date rescue" has cut 2 nights, 3 times each.',
      consequence: "It keeps cutting these nights until you stop it.",
      nights: [
        {
          stay_date: "2026-11-14",
          label: "Sat, Nov 14 2026",
          fires: 3,
          room_types: ["Standard"],
          why: ["In the 30 days it measured, 1 booking came in. A night like this usually has about 6 by then."],
          limit_line: "Your floor for Standard is still MAYA's $1.00 default, so the price can fall that far.",
          limit_is_default: true,
        },
        {
          stay_date: "2026-11-16",
          label: "Mon, Nov 16 2026",
          fires: 3,
          room_types: ["Standard"],
          why: ["In the 30 days it measured, no bookings came in."],
          limit_line: "If it keeps cutting, the price can fall to your $80.00 floor for Standard.",
          limit_is_default: false,
        },
      ],
    },
  ],
  ...over,
});

let fetchSpy: ReturnType<typeof vi.fn>;

function serve(first: RuleAlertsView, next?: RuleAlertsView) {
  let calls = 0;
  fetchSpy = vi.fn(async () => {
    const body = calls++ === 0 ? first : (next ?? first);
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchSpy);
}

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => serve(view()));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RuleAlertBanner", () => {
  it("shows nothing at all when no rule is waiting on an answer", async () => {
    serve(view({ alerts: [] }));
    const { container } = render(<RuleAlertBanner />);
    await settle();
    expect(container.textContent).toBe("");
  });

  it("puts the rule, its nights, the reason and where the price is heading on screen", async () => {
    render(<RuleAlertBanner onAskForLimits={() => {}} />);
    await waitFor(() => screen.getByText('"Slow-date rescue" has cut 2 nights, 3 times each.'));
    expect(screen.getByText("It keeps cutting these nights until you stop it.")).toBeTruthy();
    expect(screen.getByText("Sat, Nov 14 2026")).toBeTruthy();
    expect(screen.getByText(/1 booking came in/)).toBeTruthy();
    expect(screen.getByText(/still MAYA's \$1\.00 default/)).toBeTruthy();
    expect(screen.getByText("Ask MAYA for a floor")).toBeTruthy();
  });

  it("offers the way to set a limit only on the night whose limit is still MAYA's own", async () => {
    const asked = vi.fn();
    render(<RuleAlertBanner onAskForLimits={asked} />);
    await waitFor(() => screen.getByText("Ask MAYA for a floor"));
    // Two nights, one real floor and one default: only the default one asks.
    expect(screen.getAllByText("Ask MAYA for a floor")).toHaveLength(1);
    fireEvent.click(screen.getByText("Ask MAYA for a floor"));
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("gives a viewer the story and no buttons", async () => {
    serve(view({ can_manage: false }));
    render(<RuleAlertBanner />);
    await waitFor(() => screen.getByText(/has cut 2 nights/));
    expect(screen.queryByText("Stop for this night")).toBeNull();
    expect(screen.queryByText("Keep adjusting")).toBeNull();
    expect(screen.getByText("Only a Revenue Manager or above can answer this.")).toBeTruthy();
  });

  it("sends the night it is about, and shows what came back", async () => {
    const after = view();
    after.alerts[0].nights = [after.alerts[0].nights[1]];
    serve(view(), after);
    render(<RuleAlertBanner />);
    await waitFor(() => screen.getByText("Sat, Nov 14 2026"));

    await act(async () => {
      fireEvent.click(screen.getAllByText("Stop for this night")[0]);
    });
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/rules/alerts/alert-1");
    expect(JSON.parse(String(init.body))).toEqual({ choice: "stop", stay_dates: ["2026-11-14"] });
    await waitFor(() => expect(screen.queryByText("Sat, Nov 14 2026")).toBeNull());
    expect(screen.getByText("Mon, Nov 16 2026")).toBeTruthy();
  });

  it("answers every night at once when asked to, and names how many", async () => {
    serve(view(), view({ alerts: [] }));
    render(<RuleAlertBanner />);
    await waitFor(() => screen.getByText("Keep adjusting on all 2 nights"));
    await act(async () => {
      fireEvent.click(screen.getByText("Keep adjusting on all 2 nights"));
    });
    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ choice: "keep_adjusting" });
  });

  it("offers the all-nights answers only when there is more than one night", async () => {
    const one = view();
    one.alerts[0].nights = [one.alerts[0].nights[0]];
    serve(one);
    render(<RuleAlertBanner />);
    await waitFor(() => screen.getByText("Sat, Nov 14 2026"));
    expect(screen.queryByText(/on all 1 night/)).toBeNull();
    expect(screen.getByText("Stop for this night")).toBeTruthy();
  });

  it("says so when the answer did not save, and keeps the alert on screen", async () => {
    fetchSpy = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ error: "You need manager access to do that." }), { status: 403 })
        : new Response(JSON.stringify(view()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    render(<RuleAlertBanner />);
    await waitFor(() => screen.getByText("Sat, Nov 14 2026"));
    await act(async () => {
      fireEvent.click(screen.getAllByText("Stop for this night")[0]);
    });
    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByRole("alert").textContent).toBe("You need manager access to do that.");
    expect(screen.getByText("Sat, Nov 14 2026")).toBeTruthy();
  });
});
