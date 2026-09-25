// @vitest-environment jsdom
/**
 * A link into the dashboard opens the right tab and fills in the form, and
 * nothing else: every request it causes is a read, apart from the one
 * analytics event that says a link landed.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./dashboard";

const ROOM_TYPES = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Standard", counts_as_room: true },
  { id: "22222222-2222-4222-8222-222222222222", name: "Suite", counts_as_room: true },
  { id: "33333333-3333-4333-8333-333333333333", name: "Meeting room", counts_as_room: false },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let calls: { url: string; method: string }[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
      if (url === "/api/rules") return json([]);
      if (url === "/api/rules/fire-counts") return json({});
      if (url === "/api/rules/stops") return json([]);
      if (url === "/api/room-types") return json(ROOM_TYPES);
      if (url === "/api/hotels") return json({ hotels: [], activeHotelId: null });
      if (url === "/api/events") return new Response(null, { status: 204 });
      return json({}, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function writes() {
  return calls.filter((c) => c.method !== "GET" && c.url !== "/api/events");
}

describe("arriving at the rule builder from a link", () => {
  it("opens the builder filled in exactly as the link says, and saves nothing", async () => {
    window.history.replaceState(
      null,
      "",
      "/?tab=rules&panel=builder&dl=rules.new&name=Slow-date+rescue%2C+not+full&speed=much_slower&over=30&wait=7&occupancy=lt50&direction=decrease&percent=15&split=1",
    );
    render(<Dashboard initialSearch={window.location.search} />);

    const name = await screen.findByPlaceholderText("e.g. Weekend surge");
    await waitFor(() => expect((name as HTMLInputElement).value).toBe("Slow-date rescue, not full"));
    expect(screen.getByText("Filled in from a link")).toBeTruthy();
    const direction = screen.getByDisplayValue("Decrease the rate") as HTMLSelectElement;
    expect(direction.value).toBe("decrease");
    expect(screen.getByDisplayValue("Past month")).toBeTruthy();
    expect(screen.getByDisplayValue("1 week")).toBeTruthy();
    expect((screen.getByPlaceholderText("e.g. 10") as HTMLInputElement).value).toBe("15");
    const split = screen.getByLabelText("Change prices on different room types") as HTMLInputElement;
    expect(split.checked).toBe(true);

    // The place stays in the address; the fill does not.
    expect(window.location.search).toBe("?tab=rules&panel=builder");
    expect(writes()).toEqual([]);
    expect(calls.some((c) => c.url === "/api/events" && c.method === "POST")).toBe(true);
  });

  it("fills nothing without the dl that /go adds, and still opens the place", async () => {
    window.history.replaceState(null, "", "/?tab=rules&panel=builder&name=Sneaky&percent=10&direction=increase");
    render(<Dashboard initialSearch={window.location.search} />);
    const name = await screen.findByPlaceholderText("e.g. Weekend surge");
    await new Promise((r) => setTimeout(r, 50));
    expect((name as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("Filled in from a link")).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("shows the note a Viewer is sent with, from the fixed list only", async () => {
    window.history.replaceState(null, "", "/?tab=rules&dl=rules.list&note=role-rules");
    render(<Dashboard initialSearch={window.location.search} />);
    expect(await screen.findByText("Adding a rule needs Revenue Manager access or higher on this property.")).toBeTruthy();
    expect(window.location.search).toBe("?tab=rules");
    expect(writes()).toEqual([]);
  });
});

describe("Help in the header", () => {
  it("opens the docs page about the screen in a new tab", async () => {
    window.history.replaceState(null, "", "/?tab=changelog");
    render(<Dashboard initialSearch={window.location.search} />);
    const help = (await screen.findByText("Help")) as HTMLAnchorElement;
    expect(help.getAttribute("href")).toBe("/docs/watch/the-change-log");
    expect(help.getAttribute("target")).toBe("_blank");
  });
});
