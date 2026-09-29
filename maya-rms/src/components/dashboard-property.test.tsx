// @vitest-environment jsdom
/**
 * The dashboard around the property: the connection is read when the page
 * opens, so a lost connection shows above whichever tab is open, and a
 * switch that fails says so and leaves the property as it was.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./dashboard";

vi.mock("@/lib/use-calendar-live", () => ({ useCalendarLive: () => {} }));
// Radix's select does not open in jsdom; a plain one calls the same handler.
vi.mock("@/components/property-select", () => ({
  PropertySelect: (p: { options: { id: string; name: string }[]; value: string | null; onValueChange: (id: string) => void; disabled?: boolean }) => (
    <select aria-label="Property" value={p.value ?? ""} disabled={p.disabled} onChange={(e) => p.onValueChange(e.target.value)}>
      {p.options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  ),
}));

const HOTELS = [
  { id: "hotel-1", name: "The Harbour Inn" },
  { id: "hotel-2", name: "Sea View Inn" },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function activity(overrides: Record<string, unknown> = {}) {
  return {
    connection: { pms_type: "cloudbeds", status: "connected", last_sync_at: null, last_tested_at: null },
    pms: { authKind: "oauth2_authorization_code", displayName: "Cloudbeds", canManage: true },
    historyRemoved: false,
    health: { state: "healthy", successRate: 1, total: 10, failures: 0 },
    log: [],
    ...overrides,
  };
}

let calls: { url: string; method: string }[] = [];
let routes: Record<string, (init?: RequestInit) => Response> = {};

beforeEach(() => {
  calls = [];
  routes = {
    "/api/rules": () => json([]),
    "/api/rules/fire-counts": () => json({}),
    "/api/rules/stops": () => json([]),
    "/api/room-types": () => json([]),
    "/api/hotels": () => json({ hotels: HOTELS, activeHotelId: "hotel-1" }),
    "/api/pms/activity": () => json(activity()),
    "/api/events": () => new Response(null, { status: 204 }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
      const route = routes[url];
      return route ? route(init) : json({}, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const reconnectLink = () => document.querySelector('a[href^="/api/pms/cloudbeds/connect"]');

describe("the lost-connection banner", () => {
  it("shows on the calendar as soon as the dashboard opens, without visiting the PMS tab", async () => {
    routes["/api/pms/activity"] = () =>
      json(activity({ connection: { pms_type: "cloudbeds", status: "disconnected", last_sync_at: null, last_tested_at: null } }));
    render(<Dashboard initialSearch="" />);
    await waitFor(() => expect(reconnectLink()).not.toBeNull());
    expect(reconnectLink()?.getAttribute("href")).toBe("/api/pms/cloudbeds/connect?hotelId=hotel-1");
    expect(calls.filter((c) => c.url === "/api/pms/activity")).toHaveLength(1);
  });

  it("stays away while the connection is fine", async () => {
    render(<Dashboard initialSearch="" />);
    await waitFor(() => expect(calls.some((c) => c.url === "/api/pms/activity")).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(reconnectLink()).toBeNull();
  });
});

describe("a property switch that fails", () => {
  it.each([
    { what: "the server refuses it", answer: () => json({ error: "Hotel not accessible." }, 403) },
    {
      what: "the request never arrives",
      answer: () => {
        throw new TypeError("Failed to fetch");
      },
    },
  ])("says so and keeps the property you were on when $what", async ({ answer }) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    routes["/api/hotels/active"] = answer;
    render(<Dashboard initialSearch="" />);
    const select = (await screen.findByLabelText("Property")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("hotel-1"));
    const rulesReads = () => calls.filter((c) => c.url === "/api/rules").length;
    const before = rulesReads();

    fireEvent.change(select, { target: { value: "hotel-2" } });

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't switch to Sea View Inn. You're still on The Harbour Inn. Try again in a moment.",
    );
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe("hotel-1");
    expect(rulesReads()).toBe(before);
  });

  it("clears the message once a switch goes through", async () => {
    let refuse = true;
    routes["/api/hotels/active"] = () => (refuse ? json({ error: "nope" }, 500) : json({ ok: true, activeHotelId: "hotel-2" }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Dashboard initialSearch="" />);
    const select = (await screen.findByLabelText("Property")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("hotel-1"));
    fireEvent.change(select, { target: { value: "hotel-2" } });
    await screen.findByRole("alert");
    await waitFor(() => expect(select.disabled).toBe(false));

    refuse = false;
    fireEvent.change(select, { target: { value: "hotel-2" } });
    await waitFor(() => expect(select.value).toBe("hotel-2"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
