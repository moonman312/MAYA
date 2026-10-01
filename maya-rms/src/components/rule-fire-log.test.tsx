// @vitest-environment jsdom
/**
 * The fire count in the rules list opens that rule's fire log: compact rows
 * (when with the property's zone, night and room type, adjustment), each
 * opening to the rest; "Older" adds the next
 * page; the log's count puts the list's right. And the change log's own
 * "Older" button, on the same paging.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuleFireItem, RuleFireLogResponse } from "@/lib/rule-fire-log";
import { CHANGELOG_OLDER_HEADER } from "@/lib/changelog-paging";
import { Dashboard } from "./dashboard";
import { RuleFireCount } from "./rule-fire-log";

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

const fire = (n: number, over: Partial<RuleFireItem> = {}): RuleFireItem => ({
  id: `ladder:e${n}`,
  kind: "ladder",
  fired_at: `2026-09-${String(28 - n).padStart(2, "0")}T18:05:00Z`,
  when: `Sep ${28 - n}, 2:05 PM EDT`,
  when_exact: `Sep ${28 - n}, 2026, 2:05:00 PM EDT`,
  stay_date: "2026-11-13",
  night: "Fri Nov 13",
  room_type: "Queen",
  room_type_id: "q",
  adjustment: "+10%",
  mode: "live",
  price_line: "Queen · stay 2026-11-13: $150.00 up to $165.00 (+10%)",
  price_note: null,
  send_state: "sent",
  send_line: "Sent to Cloudbeds.",
  why: ["It was 82% full, past the 70% mark you set."],
  later: [],
  ...over,
});

const simulated = fire(9, {
  mode: "simulation",
  price_line: "Simulation: the price for Fri Nov 13, Queen would have gone from $150.00 to $165.00.",
  send_state: "simulated",
  send_line: "Nothing was sent to Cloudbeds at the time.",
  send_after_state: "sent",
  send_after_line: "Sent to Cloudbeds after you went live.",
  later: ["Would have come off Sep 20, 8:00 AM EDT."],
});

/** The fire rows in the popup (its "?" opens and closes too, so rows are read off the list). */
const rowsIn = (dialog: HTMLElement) => within(within(dialog).getByRole("list")).getAllByRole("button");
const rowsSoon = async (dialog: HTMLElement) => within(await within(dialog).findByRole("list")).getAllByRole("button");

const firstPage: RuleFireLogResponse = {
  rule: { id: "r1", name: "Busy nights", enabled: true },
  total: 3,
  days: 90,
  fires: [fire(1), fire(2)],
  older: "CURSOR",
};
const secondPage: RuleFireLogResponse = { ...firstPage, total: null, fires: [simulated], older: null };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("RuleFireCount", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/rules/r1/fires") return json(firstPage);
      if (url === "/api/rules/r1/fires?older=CURSOR") return json(secondPage);
      return json({ error: "no" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("fetches nothing until it is opened, then lists the rule's fires as compact rows", async () => {
    const onCount = vi.fn();
    render(<RuleFireCount ruleId="r1" ruleName="Busy nights" count={2} onCount={onCount} />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Busy nights fired 2 times. See each one." }));
    const dialog = await screen.findByRole("dialog", { name: "Busy nights" });
    expect(await within(dialog).findByText("3 fires in the last 90 days")).toBeTruthy();
    // The list's count is put right from the log's.
    expect(onCount).toHaveBeenCalledWith(3);
    const rows = rowsIn(dialog);
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toBe("Sep 27, 2:05 PM EDTFri Nov 13 · Queen+10%");
    expect(within(rows[0]).getByText("Sep 27, 2:05 PM EDT").getAttribute("title")).toBe("Sep 27, 2026, 2:05:00 PM EDT");
    // Closed rows show nothing more.
    expect(within(dialog).queryByText("Sent to Cloudbeds.")).toBeNull();
  });

  it("tells one run's fires on two room types apart without opening them", async () => {
    const king = fire(1, { id: "ladder:k1", room_type: "King", room_type_id: "k" });
    fetchMock.mockImplementation(async () => json({ ...firstPage, total: 2, fires: [fire(1), king], older: null }));
    render(<RuleFireCount ruleId="r1" ruleName="Busy nights" count={2} />);
    fireEvent.click(screen.getByRole("button", { name: /fired 2 times/ }));
    const rows = await rowsSoon(await screen.findByRole("dialog"));
    expect(rows.map((r) => r.textContent)).toEqual([
      "Sep 27, 2:05 PM EDTFri Nov 13 · Queen+10%",
      "Sep 27, 2:05 PM EDTFri Nov 13 · King+10%",
    ]);
  });

  it("opens a row to the price, where it went, why, and what came later", async () => {
    render(<RuleFireCount ruleId="r1" ruleName="Busy nights" count={2} />);
    fireEvent.click(screen.getByRole("button", { name: /fired 2 times/ }));
    const dialog = await screen.findByRole("dialog");
    const [first] = await rowsSoon(dialog);
    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(within(dialog).getByText("Queen · stay 2026-11-13: $150.00 up to $165.00 (+10%)")).toBeTruthy();
    expect(within(dialog).getByText("Sent to Cloudbeds.").className).toContain("emerald");
    expect(within(dialog).getByText("It was 82% full, past the 70% mark you set.")).toBeTruthy();
    fireEvent.click(first);
    expect(within(dialog).queryByText("Sent to Cloudbeds.")).toBeNull();
  });

  it("adds the older page under the first, marks a simulated fire, and says when there is nothing older", async () => {
    render(<RuleFireCount ruleId="r1" ruleName="Busy nights" count={2} />);
    fireEvent.click(screen.getByRole("button", { name: /fired 2 times/ }));
    const dialog = await screen.findByRole("dialog");
    await rowsSoon(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Older" }));
    expect(await within(dialog).findByText("Simulation")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/rules/r1/fires?older=CURSOR");
    expect(rowsIn(dialog)).toHaveLength(3);
    expect(within(dialog).queryByRole("button", { name: "Older" })).toBeNull();
    // The fires themselves are kept; the log stops at 90 days by choice.
    expect(within(dialog).getByText("Nothing older. The fire log shows the last 90 days.")).toBeTruthy();
    const sim = rowsIn(dialog)[2];
    fireEvent.click(sim);
    expect(within(dialog).getByText(simulated.price_line!)).toBeTruthy();
    expect(within(dialog).getByText("Nothing was sent to Cloudbeds at the time.").className).toContain("amber");
    expect(within(dialog).getByText("Sent to Cloudbeds after you went live.").className).toContain("emerald");
    expect(within(dialog).getByText("Would have come off Sep 20, 8:00 AM EDT.")).toBeTruthy();
  });

  it("says when a rule is off, or has no fires, and closes on Escape back to the count", async () => {
    fetchMock.mockImplementation(async () => json({ ...firstPage, rule: { ...firstPage.rule, enabled: false }, total: 0, fires: [], older: null }));
    render(<RuleFireCount ruleId="r1" ruleName="Busy nights" count={1} />);
    const count = screen.getByRole("button", { name: /fired 1 time\./ });
    fireEvent.click(count);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("No fires in the last 90 days.")).toBeTruthy();
    expect(within(dialog).getByText("This rule is off. Its changes stay where they are.")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(count);
  });

  it("says it couldn't load, and tries again", async () => {
    fetchMock.mockImplementationOnce(async () => json({ error: "x" }, 500));
    render(<RuleFireCount ruleId="r1" ruleName="Busy nights" count={2} />);
    fireEvent.click(screen.getByRole("button", { name: /fired 2 times/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/Couldn't load this rule's fires\./)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByText("3 fires in the last 90 days")).toBeTruthy();
  });
});

describe("in the dashboard", () => {
  const run = (n: number, at: string) => ({
    cycle: n,
    timestamp: at,
    has_changes: true,
    changes: [
      {
        room_type: "Queen",
        rule_name: "Busy nights",
        original_rate: 150,
        new_rate: 150 + n,
        change_pct: 1,
        occupancy_pct: 0,
        stay_date: "2026-11-13",
        description: `Run ${n} raised it.`,
        narrative: [`Run ${n} raised it.`],
        headline: `Run ${n} headline`,
      },
    ],
  });

  function stubDashboard(extra: (url: string) => Response | null) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const hit = extra(url);
      if (hit) return hit;
      if (url === "/api/settings") {
        return json({
          property: { canEdit: true, readOnly: null },
          calendar: { big: "occupancy", small: ["rooms_booked", "room_revenue"], price_room_type_id: null, colors: "standard" },
          pms: { type: "cloudbeds", name: "Cloudbeds", mode: "keep" },
          textSize: "standard",
        });
      }
      if (url === "/api/rules/stops" || url === "/api/room-types") return json([]);
      if (url === "/api/hotels") return json({ hotels: [], activeHotelId: null });
      if (url.startsWith("/api/calendar/")) return json({ error: "not in this test" }, 404);
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("turns a rule's count into the button that opens its log, and takes the log's count", async () => {
    stubDashboard((url) => {
      if (url === "/api/rules")
        return json([{ id: "r1", rule_name: "Busy nights", conditions: { occupancy_above: 70 }, action: { adjust_rate_percent: 10 }, room_types: [], enabled: true }]);
      if (url === "/api/rules/fire-counts") return json({ r1: 2 });
      if (url === "/api/rules/r1/fires") return json(firstPage);
      return null;
    });
    window.history.replaceState(null, "", "/?tab=rules");
    await act(async () => {
      render(<Dashboard initialSearch={window.location.search} />);
    });
    const count = await screen.findByRole("button", { name: "Busy nights fired 2 times. See each one." });
    fireEvent.click(count);
    await screen.findByText("3 fires in the last 90 days");
    expect(await screen.findByRole("button", { name: "Busy nights fired 3 times. See each one." })).toBeTruthy();
  });

  it("pages the change log back with Older, keeping the newest page on top", async () => {
    const fetchMock = stubDashboard((url) => {
      if (url === "/api/changelog") return json([run(2, "2026-09-30T10:00:00Z")], 200, { [CHANGELOG_OLDER_HEADER]: "2026-09-20T10:00:00.123456+00:00" });
      if (url === `/api/changelog?older=${encodeURIComponent("2026-09-20T10:00:00.123456+00:00")}`) return json([run(1, "2026-09-20T10:00:00Z")]);
      if (url === "/api/rules" ) return json([]);
      if (url === "/api/rules/fire-counts") return json({});
      return null;
    });
    window.history.replaceState(null, "", "/?tab=changelog");
    await act(async () => {
      render(<Dashboard initialSearch={window.location.search} />);
    });
    expect(await screen.findByText("Run 2 headline")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Older" }));
    expect(await screen.findByText("Run 1 headline")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(`/api/changelog?older=${encodeURIComponent("2026-09-20T10:00:00.123456+00:00")}`, expect.anything());
    const headlines = screen.getAllByText(/^Run \d headline$/).map((n) => n.textContent);
    expect(headlines).toEqual(["Run 2 headline", "Run 1 headline"]);
    expect(screen.queryByRole("button", { name: "Older" })).toBeNull();
    expect(screen.getByText("Nothing older. History is kept for 90 days.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Couldn't load/)).toBeNull());
  });
});
