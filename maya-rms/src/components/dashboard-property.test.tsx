// @vitest-environment jsdom
/**
 * The dashboard around the property: the connection is read when the page
 * opens, so a lost connection shows above whichever tab is open, a switch
 * that fails says so and leaves the property as it was, and the calendar's
 * amounts carry the property's own currency symbol.
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

describe("the PMS tab's Health card and request list", () => {
  it.each([
    { pms: "mews", name: "Mews" },
    { pms: "think", name: "Think Reservations" },
  ])("say $name requests are not tracked, rather than showing an empty log", async ({ pms, name }) => {
    routes["/api/pms/activity"] = () =>
      json(
        activity({
          connection: { pms_type: pms, status: "connected", last_sync_at: null, last_tested_at: null },
          pms: { authKind: "static_tokens", displayName: name, canManage: true },
          requestsTracked: false,
          health: { state: "unknown", successRate: null, total: 0, failures: 0 },
        }),
      );
    window.history.replaceState(null, "", "/?tab=pms");
    render(<Dashboard initialSearch={window.location.search} />);
    await screen.findByText(`Recent requests to ${name}`);
    expect(screen.getAllByText("Not tracked for this system")).toHaveLength(2);
    expect(screen.queryByText("No recent activity")).toBeNull();
    expect(screen.queryByText(/No requests recorded yet/)).toBeNull();
  });

  it("sit above the property's time zone and currency, read-only", async () => {
    routes["/api/pms/activity"] = () => json(activity({ property: { timezone: "America/Los_Angeles", currency: "EUR" } }));
    window.history.replaceState(null, "", "/?tab=pms");
    render(<Dashboard initialSearch={window.location.search} />);
    expect(await screen.findByText("America/Los_Angeles")).toBeTruthy();
    expect(screen.getByText("EUR (€)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "About the time zone and currency" })).toBeTruthy();
  });

  it("keep Cloudbeds' health and log as they are", async () => {
    routes["/api/pms/activity"] = () => json(activity({ requestsTracked: true, log: [] }));
    window.history.replaceState(null, "", "/?tab=pms");
    render(<Dashboard initialSearch={window.location.search} />);
    await screen.findByText("Recent requests to Cloudbeds");
    expect(screen.getByText("Healthy")).toBeTruthy();
    expect(screen.getByText(/No requests recorded yet/)).toBeTruthy();
    expect(screen.queryByText("Not tracked for this system")).toBeNull();
  });

  it("say an empty log and a sync that never ran with no em dash", async () => {
    routes["/api/pms/activity"] = () => json(activity({ requestsTracked: true, log: [] }));
    window.history.replaceState(null, "", "/?tab=pms");
    render(<Dashboard initialSearch={window.location.search} />);
    expect(await screen.findByText("No requests recorded yet. The log fills as syncs run.")).toBeTruthy();
    expect(screen.getByText("Last sync").nextElementSibling?.textContent).toBe("–");
    expect(document.body.textContent).not.toContain("\u2014");
  });
});

function october(currency?: string) {
  const days: Record<string, unknown> = {};
  for (let d = 1; d <= 31; d++) {
    days[String(d)] = {
      occupancy_pct: 50,
      booked: 5,
      total: 10,
      revenue: d === 10 ? 2180 : 850,
      weekday: "Saturday",
      revpar: 85,
      color: "orange",
      room_types:
        d === 10
          ? [
              {
                id: "rt1",
                name: "King",
                total_rooms: 10,
                occupancy_pct: 50,
                booked: 5,
                rate: 150,
                revenue: 750,
                current_rate: 165,
                manual_price: { price: 180, set_at: "2026-10-01T12:00:00Z", source: "maya" },
              },
            ]
          : [],
    };
  }
  return {
    year: 2026,
    month: 10,
    month_name: "October 2026",
    days_in_month: 31,
    first_weekday: 4,
    thresholds: { low: 40, high: 70, basis: "revpar", past: { p33: 1, p67: 2 }, future: { p33: 1, p67: 2 } },
    range: { min: "2026-01", max: "2027-10" },
    ...(currency ? { currency } : {}),
    days,
  };
}

describe("the calendar's amounts", () => {
  it("carry the property's currency symbol on the tiles, the day card and the price box", async () => {
    routes["/api/calendar/2026/10"] = () => json(october("EUR"));
    window.history.replaceState(null, "", "/?date=2026-10-10");
    render(<Dashboard initialSearch={window.location.search} />);

    expect(await screen.findByText("ADR €150.00")).toBeTruthy();
    expect(screen.getByText("€2.2k")).toBeTruthy();
    expect(screen.getAllByText("€850").length).toBeGreaterThan(0);
    expect(screen.getByText(/Current price\s*€165\.00/)).toBeTruthy();
    expect(screen.getByText("Revenue €750.00")).toBeTruthy();
    expect(screen.getByText("Manual · €180.00")).toBeTruthy();
    expect(document.querySelector('[data-deeplink="calendar.day"] > p')?.textContent).toMatch(/revenue.* €2.?180\.00$/);
    expect(screen.getByLabelText("Manual price for King").closest("label")?.textContent).toBe("€");
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });

  it("stays in dollars when the calendar names no currency", async () => {
    routes["/api/calendar/2026/10"] = () => json(october());
    window.history.replaceState(null, "", "/?date=2026-10-10");
    render(<Dashboard initialSearch={window.location.search} />);
    expect(await screen.findByText("ADR $150.00")).toBeTruthy();
    expect(screen.getByText("$2.2k")).toBeTruthy();
    expect(screen.getByText("Manual · $180.00")).toBeTruthy();
  });

  it("show a night with no current price, and the colour key, with no em dash", async () => {
    const cal = october();
    const day = cal.days["10"] as { room_types: Record<string, unknown>[] };
    day.room_types = [{ ...day.room_types[0], current_rate: null, manual_price: null }];
    routes["/api/calendar/2026/10"] = () => json(cal);
    window.history.replaceState(null, "", "/?date=2026-10-10");
    render(<Dashboard initialSearch={window.location.search} />);
    expect(await screen.findByText(/^Current price\s*–$/)).toBeTruthy();
    expect(screen.getByTestId("calendar-color-key").textContent).toContain("Strong night");
    fireEvent.click(screen.getByRole("button", { name: "What the colours mean" }));
    expect(screen.getByText(/revenue per room with this property's own nights/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("\u2014");
  });
});
