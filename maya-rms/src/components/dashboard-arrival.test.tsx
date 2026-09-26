// @vitest-environment jsdom
/**
 * A link into the dashboard opens the right tab and fills in the form, and
 * nothing else: every request it causes is a read, apart from the one
 * analytics event that says a link landed.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./dashboard";

// Demo mode: the live calendar never opens a connection from a test.
vi.mock("@/utils/supabase/shared", () => ({
  isSupabaseConfigured: () => false,
  getSupabaseEnv: () => ({ supabaseUrl: undefined, supabasePublishableKey: undefined }),
}));

const ROOM_TYPES = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Standard", counts_as_room: true },
  { id: "22222222-2222-4222-8222-222222222222", name: "Suite", counts_as_room: true },
  { id: "33333333-3333-4333-8333-333333333333", name: "Meeting room", counts_as_room: false },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let calls: { url: string; method: string; body?: string }[] = [];
/** What a test adds to the answers below, by "METHOD url" or by url. */
let routes: Record<string, unknown> = {};

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
      const route = routes[`${method} ${url}`] ?? routes[url];
      if (route !== undefined) return json(route);
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

/** Over to Rules and straight back, as an owner checking something would. */
function toRulesAndBack(tab: string) {
  fireEvent.click(screen.getByRole("button", { name: "Rules" }));
  fireEvent.click(screen.getByRole("button", { name: tab }));
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

describe("coming back to the Rate Simulator after a link filled its test rule", () => {
  beforeEach(() => {
    routes["/api/room-types?withRate=1"] = {
      timezone: "UTC",
      roomTypes: [{ id: ROOM_TYPES[0].id, name: "Standard", total_rooms: 12, floor_price: 1, ceiling_price: 99999, seed_rate: 150 }],
    };
    routes["/api/rules/engine"] = [];
    routes["POST /api/rules"] = { id: "44444444-4444-4444-8444-444444444444" };
    window.history.replaceState(
      null,
      "",
      "/?tab=simulator&panel=test-rule&dl=simulator.test-rule&name=Last+minute&occupancy=lt50&direction=decrease&percent=15",
    );
  });

  it("does not fill the rule in again once it is saved, so it cannot be saved twice", async () => {
    render(<Dashboard initialSearch={window.location.search} />);
    const name = (await screen.findByLabelText("Rule name")) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe("Last minute"));
    fireEvent.click(screen.getByRole("button", { name: "Save This Rule" }));
    await screen.findByText(/Rule Added to Rules Tab/);

    toRulesAndBack("Rate Simulator");
    await screen.findByText("Rules in play");
    expect(screen.queryByLabelText("Rule name")).toBeNull();
    expect(screen.queryByText("Filled in from a link")).toBeNull();
    expect(window.location.search).toBe("?tab=simulator");
    expect(writes().filter((c) => c.url === "/api/rules")).toHaveLength(1);
  });

  it("does not fill the rule in again once it is discarded", async () => {
    render(<Dashboard initialSearch={window.location.search} />);
    await screen.findByLabelText("Rule name");
    fireEvent.click(screen.getByRole("button", { name: "Discard test rule" }));

    toRulesAndBack("Rate Simulator");
    await screen.findByText("Rules in play");
    expect(screen.queryByLabelText("Rule name")).toBeNull();
    expect(screen.queryByText("Filled in from a link")).toBeNull();
    expect(writes()).toEqual([]);
  });
});

describe("a manual price link's range after the owner closed it", () => {
  const RT = ROOM_TYPES[0].id;
  const night = {
    occupancy_pct: 50,
    booked: 6,
    total: 12,
    revenue: 900,
    weekday: "Saturday",
    revpar: 75,
    color: "orange",
    room_types: [
      { id: RT, name: "Standard", total_rooms: 12, occupancy_pct: 50, booked: 6, rate: 150, revenue: 900, current_rate: 160, base_price: 150, manual_price: null },
    ],
  };
  const october = {
    year: 2026,
    month: 10,
    month_name: "October",
    days_in_month: 31,
    first_weekday: 4,
    thresholds: { low: 40, high: 70, basis: "revpar", past: { p33: 50, p67: 90 }, future: { p33: 50, p67: 90 } },
    range: { min: "2026-01", max: "2026-12" },
    days: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [String(i + 1), night])),
  };

  it("stays closed when the owner comes back to the night, so Enter prices that night alone", async () => {
    routes["/api/hotels"] = { hotels: [{ id: "h1", name: "Seaside" }], activeHotelId: "h1" };
    routes["/api/calendar/2026/10"] = october;
    window.history.replaceState(null, "", `/?tab=calendar&dl=calendar.manual-price&date=2026-10-03&roomType=${RT}&through=2026-10-05`);
    render(<Dashboard initialSearch={window.location.search} />);

    const through = (await screen.findByLabelText("Last night this price applies to")) as HTMLInputElement;
    expect(through.value).toBe("2026-10-05");
    fireEvent.click(screen.getByRole("button", { name: "Back to a single night" }));

    // Another night, then back to the linked one.
    fireEvent.click(screen.getByText("4", { selector: "button > div" }));
    await waitFor(() => expect(window.location.search).toBe("?date=2026-10-04"));
    await act(async () => {
      window.history.back();
      await new Promise((r) => window.addEventListener("popstate", r, { once: true }));
    });
    expect(window.location.search).toBe("?tab=calendar&date=2026-10-03");
    const price = await screen.findByLabelText("Manual price for Standard");
    expect(screen.queryByLabelText("Last night this price applies to")).toBeNull();

    fireEvent.change(price, { target: { value: "199" } });
    fireEvent.keyDown(price, { key: "Enter" });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body ?? "{}")).toEqual({ hotelId: "h1", roomTypeId: RT, dateFrom: "2026-10-03", price: 199 });
  });
});

describe("a link to a change in the Change Log", () => {
  const RUN = "55555555-5555-4555-8555-555555555555";
  const change = (stayDate: string, rt: { id: string; name: string }) => ({
    room_type: rt.name,
    rule_name: "Slow dates",
    original_rate: 150,
    new_rate: 135,
    change_pct: -10,
    occupancy_pct: 40,
    description: "Slow dates took the rate down.",
    stay_date: stayDate,
    evaluation_run_id: RUN,
    room_type_id: rt.id,
    has_booking_speed_details: true,
  });
  const GONE = "That change is no longer in the list shown here.";
  const explains = () => calls.filter((c) => c.url.startsWith("/api/explain"));
  const closedDrilldowns = () => screen.queryAllByRole("button", { name: "How did we know?" });
  const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));

  beforeEach(() => {
    routes["/api/changelog"] = [
      {
        cycle: 1,
        timestamp: "2026-09-25T10:00:00Z",
        has_changes: true,
        changes: [change("2026-10-03", ROOM_TYPES[0]), change("2026-10-03", ROOM_TYPES[1]), change("2026-10-04", ROOM_TYPES[0])],
      },
    ];
  });

  it("naming only the run highlights the run and opens none of its changes", async () => {
    window.history.replaceState(null, "", `/?tab=changelog&dl=changelog.entry&run=${RUN}`);
    render(<Dashboard initialSearch={window.location.search} />);
    await screen.findAllByText("Slow dates took the rate down.");
    const run = document.querySelector(`[data-deeplink="changelog.run:${RUN}"]`) as HTMLElement;
    await waitFor(() => expect(run.hasAttribute("data-dl-flash")).toBe(true));
    await settle();
    expect(explains()).toHaveLength(0);
    expect(closedDrilldowns()).toHaveLength(3);
  });

  it("naming one change opens that one, once, not again when the owner comes back", async () => {
    window.history.replaceState(null, "", `/?tab=changelog&dl=changelog.entry&run=${RUN}&date=2026-10-03&roomType=${ROOM_TYPES[0].id}`);
    render(<Dashboard initialSearch={window.location.search} />);
    await waitFor(() => expect(explains()).toHaveLength(1));
    expect(explains()[0].url).toContain(`room_type_id=${ROOM_TYPES[0].id}`);
    expect(closedDrilldowns()).toHaveLength(2);

    toRulesAndBack("Change Log");
    await screen.findAllByText("Slow dates took the rate down.");
    await settle();
    expect(explains()).toHaveLength(1);
    expect(closedDrilldowns()).toHaveLength(3);
  });

  it("says the change has gone once, and not again after the owner closed the note", async () => {
    window.history.replaceState(null, "", "/?tab=changelog&dl=changelog.entry&run=66666666-6666-4666-8666-666666666666");
    render(<Dashboard initialSearch={window.location.search} />);
    const note = await screen.findByText(GONE);
    fireEvent.click(note.parentElement!.querySelector("button")!);
    expect(screen.queryByText(GONE)).toBeNull();

    toRulesAndBack("Change Log");
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/changelog")).toHaveLength(2));
    await settle();
    expect(screen.queryByText(GONE)).toBeNull();
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
