// @vitest-environment jsdom
/**
 * The guard the builder puts in the owner's sight for a cut on low pickup
 * with no booking window row (Jake, 2026-09-29, A4): the moment the form
 * takes that shape, a Booking window (days to stay) Less than 60 row is
 * filled in, with a "?" saying why. The owner can remove it, it never comes
 * back on its own, and saving never adds it: the draft is exactly the rows
 * on screen. Editing a saved rule of that shape offers the row the same
 * way, once, and every other shape is left alone.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAR_OUT_CUT_GUARD_HELP } from "@/lib/rule-form";
import { Dashboard } from "./dashboard";

const STD = "11111111-1111-4111-8111-111111111111";
const SUITE = "22222222-2222-4222-8222-222222222222";
const ROOM_TYPES = [
  { id: STD, name: "Standard", counts_as_room: true },
  { id: SUITE, name: "Suite", counts_as_room: true },
];

/** A saved rule of the shape, on: pickup under 1 room night over a week, cut 4%, no booking window. */
const LIST = [
  {
    id: "q1",
    rule_name: "Quiet nights",
    conditions: { pickup_rate: "<1", pickup_timing: "(past week), then waits 1 week" },
    action: { adjust_rate_percent: -4 },
    room_types: ["Standard", "Suite"],
    enabled: true,
    undo_on_cancellation: true,
  },
];

const ENGINE = [
  {
    id: "q1",
    hotel_id: "h1",
    name: "Quiet nights",
    is_active: true,
    version: 2,
    start_date: null,
    end_date: null,
    is_annual: false,
    dow_mask: 127,
    action_type: "percent",
    action_direction: "decrease",
    action_value: 4,
    priority: 100,
    is_pickup_rule: true,
    condition: { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 7, pickup_metric: "room_nights" },
    signal_room_type_ids: [STD, SUITE],
    affected_room_type_ids: [STD, SUITE],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    undo_on_cancellation: true,
  },
];

const PREVIEW = {
  needsActivation: true,
  today: "2026-10-01",
  lastNight: "2027-10-31",
  affected: [],
  roomTypesChanged: {},
  touched: [],
  fingerprint: "fp",
  kind: "event",
  ms: 80,
  nightsChecked: 4,
  horizonDays: 396,
  reach: 132,
  farOutCut: null,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Sent = { url: string; method: string; body: Record<string, unknown> | null };
let sent: Sent[] = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      if (method !== "GET" && url !== "/api/events") sent.push({ url, method, body });
      if (url === "/api/rules/preview") return json(PREVIEW);
      if (url === "/api/rules" && method === "GET") return json(LIST);
      if (url === "/api/rules/engine") return json(ENGINE);
      if (url === "/api/rules/fire-counts") return json({});
      if (url === "/api/rules/stops") return json([]);
      if (url === "/api/room-types") return json(ROOM_TYPES);
      if (url === "/api/hotels") return json({ hotels: [], activeHotelId: null });
      if (url === "/api/events") return new Response(null, { status: 204 });
      if (method === "POST" || method === "PUT") return json({ ok: true }, url === "/api/rules" ? 201 : 200);
      return json({}, 404);
    }),
  );
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const saves = () => sent.filter((s) => s.url !== "/api/rules/preview");
const previewed = () => sent.find((s) => s.url === "/api/rules/preview")!.body as { draft: { condition: Record<string, unknown> } };

/** The condition rows' Metric dropdowns, in order. */
function metricSelects(): HTMLSelectElement[] {
  return [...document.querySelectorAll<HTMLSelectElement>("select")].filter((s) => [...s.options].some((o) => o.value === "pickup"));
}
const metrics = () => metricSelects().map((s) => s.value);
const rowOf = (select: HTMLElement) => select.closest("div.rounded.border") as HTMLElement;
const guardRow = () => {
  const s = metricSelects().find((x) => x.value === "booking_window");
  return s ? rowOf(s) : null;
};
const directionSelect = () =>
  [...document.querySelectorAll<HTMLSelectElement>("select")].find((s) => [...s.options].some((o) => o.value === "decrease"))!;

async function openBuilder() {
  window.history.replaceState(null, "", "/?tab=rules&panel=builder");
  render(<Dashboard initialSearch={window.location.search} />);
  await screen.findByText("All room types");
}

/** The first row to pickup on Less than, and the direction to a cut. */
function makeFarOutCut() {
  fireEvent.change(directionSelect(), { target: { value: "decrease" } });
  const metric = metricSelects()[0];
  fireEvent.change(metric, { target: { value: "pickup" } });
  fireEvent.change(within(rowOf(metric)).getByDisplayValue("Greater than"), { target: { value: "lt" } });
}

function fillNameAndAmount(name: string) {
  fireEvent.change(screen.getByPlaceholderText("e.g. Weekend surge"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("Adjust by percent (%)"), { target: { value: "4" } });
}

describe("a cut on low pickup with no booking window row", () => {
  it("the builder fills a booking window row in, within 60 days of arrival, with a ? saying why", async () => {
    await openBuilder();
    expect(metrics()).toEqual(["occupancy"]);
    makeFarOutCut();
    await waitFor(() => expect(metrics()).toEqual(["pickup", "booking_window"]));
    const row = guardRow()!;
    expect((within(row).getByDisplayValue("Less than") as HTMLSelectElement).value).toBe("lt");
    expect((within(row).getByRole("spinbutton") as HTMLInputElement).value).toBe("60");
    const help = within(row).getByRole("button", { name: FAR_OUT_CUT_GUARD_HELP.label });
    fireEvent.click(help);
    expect(screen.getByText(FAR_OUT_CUT_GUARD_HELP.title)).toBeTruthy();
    expect(screen.getByText(FAR_OUT_CUT_GUARD_HELP.lines[0])).toBeTruthy();
    // The pickup row has no such "?".
    expect(within(rowOf(metricSelects()[0])).queryByRole("button", { name: FAR_OUT_CUT_GUARD_HELP.label })).toBeNull();
  });

  it("the row can be removed, does not come back, and saving never adds it", async () => {
    await openBuilder();
    makeFarOutCut();
    await waitFor(() => expect(metrics()).toEqual(["pickup", "booking_window"]));
    fireEvent.click(within(guardRow()!).getByRole("button", { name: "Remove condition" }));
    expect(metrics()).toEqual(["pickup"]);
    // The shape is touched again and again: still the owner's rows alone.
    const pickup = rowOf(metricSelects()[0]);
    fireEvent.change(within(pickup).getByRole("spinbutton"), { target: { value: "2" } });
    fireEvent.change(directionSelect(), { target: { value: "increase" } });
    fireEvent.change(directionSelect(), { target: { value: "decrease" } });
    fireEvent.change(within(pickup).getByDisplayValue("Less than"), { target: { value: "gt" } });
    fireEvent.change(within(pickup).getByDisplayValue("Greater than"), { target: { value: "lt" } });
    expect(metrics()).toEqual(["pickup"]);
    fillNameAndAmount("Quiet far out");
    fireEvent.click(screen.getByRole("button", { name: "Add Rule" }));
    await screen.findByRole("dialog", { name: "Add “Quiet far out”?" });
    expect(previewed().draft.condition).toMatchObject({ pickup_operator: "lt", pickup_threshold: 2 });
    expect(previewed().draft.condition).not.toHaveProperty("dta_operator");
    expect(saves()).toEqual([]);
  });

  it("kept, the row saves as within 60 days of arrival, and the next rule is offered it again", async () => {
    await openBuilder();
    makeFarOutCut();
    await waitFor(() => expect(metrics()).toEqual(["pickup", "booking_window"]));
    fillNameAndAmount("Quiet nights, near");
    fireEvent.click(screen.getByRole("button", { name: "Add Rule" }));
    const dialog = await screen.findByRole("dialog", { name: "Add “Quiet nights, near”?" });
    // The pickup row's threshold starts at 5; the row filled in is within 60 days.
    expect(previewed().draft.condition).toMatchObject({ pickup_operator: "lt", pickup_threshold: 5, dta_operator: "lt", dta_threshold_days: 60 });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Turn it on" })).toHaveProperty("disabled", false));
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn it on" }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0].body).toMatchObject({ condition: { dta_operator: "lt", dta_threshold_days: 60 } });
    // Saved: the builder is empty again, and the next rule of the shape gets the row.
    await waitFor(() => expect(metrics()).toEqual(["occupancy"]));
    makeFarOutCut();
    await waitFor(() => expect(metrics()).toEqual(["pickup", "booking_window"]));
    expect((within(guardRow()!).getByRole("spinbutton") as HTMLInputElement).value).toBe("60");
  });

  it("editing a saved rule of this shape offers the row once; removed, a rename saves at once and unchanged", async () => {
    window.history.replaceState(null, "", "/?tab=rules");
    render(<Dashboard initialSearch={window.location.search} />);
    const row = (await screen.findByText("Quiet nights")).closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Edit Quiet nights" }));
    await screen.findByText("Edit “Quiet nights”");
    await waitFor(() => expect(metrics()).toEqual(["pickup", "booking_window"]));
    expect((within(guardRow()!).getByRole("spinbutton") as HTMLInputElement).value).toBe("60");
    // With the row, the rule's behaviour changes, so the popup opens and previews it.
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const dialog = await screen.findByRole("dialog", { name: "Save changes to “Quiet nights”?" });
    expect(previewed().draft.condition).toMatchObject({ pickup_operator: "lt", dta_operator: "lt", dta_threshold_days: 60 });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(saves()).toEqual([]);
    // Without it, the rule is as saved: a new name alone saves at once, and the row stays away.
    fireEvent.click(within(guardRow()!).getByRole("button", { name: "Remove condition" }));
    expect(metrics()).toEqual(["pickup"]);
    fireEvent.change(screen.getByDisplayValue("Quiet nights"), { target: { value: "Quiet nights, renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saves()[0]).toMatchObject({
      url: "/api/rules/q1",
      method: "PUT",
      body: { rule_name: "Quiet nights, renamed", expected_version: 2, condition: { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 7 } },
    });
    expect(saves()[0].body!.condition).not.toHaveProperty("dta_operator");
  });

  it("leaves every other shape alone", async () => {
    await openBuilder();
    // A raise on low pickup.
    fireEvent.change(directionSelect(), { target: { value: "increase" } });
    const metric = metricSelects()[0];
    fireEvent.change(metric, { target: { value: "pickup" } });
    fireEvent.change(within(rowOf(metric)).getByDisplayValue("Greater than"), { target: { value: "lt" } });
    expect(metrics()).toEqual(["pickup"]);
    // A cut on high pickup.
    fireEvent.change(within(rowOf(metric)).getByDisplayValue("Less than"), { target: { value: "gt" } });
    fireEvent.change(directionSelect(), { target: { value: "decrease" } });
    expect(metrics()).toEqual(["pickup"]);
    // A cut on low pickup with a booking window row of the owner's own: nothing added, nothing changed.
    fireEvent.click(screen.getByRole("button", { name: "+ Add condition" }));
    const second = metricSelects()[1];
    fireEvent.change(second, { target: { value: "booking_window" } });
    fireEvent.change(within(rowOf(metric)).getByDisplayValue("Greater than"), { target: { value: "lt" } });
    expect(metrics()).toEqual(["pickup", "booking_window"]);
    expect((within(rowOf(second)).getByRole("spinbutton") as HTMLInputElement).value).toBe("7");
    expect(screen.queryByRole("button", { name: FAR_OUT_CUT_GUARD_HELP.label })).toBeNull();
  });
});
