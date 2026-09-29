// @vitest-environment jsdom
/**
 * Editing a rule, and the activation popup in the rules list and the rule
 * builder (Jake, 2026-09-28):
 *
 *   - Edit opens the builder filled with the rule as saved, every setting
 *     (the undo box too), and Save changes sends the whole rule with the
 *     version it was filled from.
 *   - Switching a rule on opens the popup; switching it off doesn't.
 *   - Add Rule, and Save changes on a rule that is on, open the popup; a
 *     new name alone, or an edit to a rule that is off, saves at once.
 *   - Cancel in the popup saves nothing and leaves the form as it was.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNDO_ON_CANCELLATION_LABEL } from "@/lib/rule-form";
import { Dashboard } from "./dashboard";

const STD = "11111111-1111-4111-8111-111111111111";
const SUITE = "22222222-2222-4222-8222-222222222222";
const ROOM_TYPES = [
  { id: STD, name: "Standard", counts_as_room: true },
  { id: SUITE, name: "Suite", counts_as_room: true },
];

const LIST = [
  {
    id: "r1",
    rule_name: "Busy nights",
    conditions: { occupancy_percentage: ">80" },
    action: { adjust_rate_percent: 10 },
    room_types: ["Standard", "Suite"],
    enabled: true,
    undo_on_cancellation: false,
  },
  {
    id: "r2",
    rule_name: "Slow weeks",
    conditions: { booking_speed: "at most Slower Than Normal (past month), then waits 1 week" },
    action: { adjust_rate_percent: -7 },
    room_types: ["Standard"],
    enabled: false,
    undo_on_cancellation: true,
  },
];

const ENGINE = [
  {
    id: "r1",
    hotel_id: "h1",
    name: "Busy nights",
    is_active: true,
    version: 3,
    start_date: null,
    end_date: null,
    is_annual: false,
    dow_mask: 127,
    action_type: "percent",
    action_direction: "increase",
    action_value: 10,
    priority: 100,
    is_pickup_rule: false,
    condition: { occupancy_operator: "gt", occupancy_threshold: 0.8, dta_operator: "lt", dta_threshold_days: 14 },
    signal_room_type_ids: [STD],
    affected_room_type_ids: [STD, SUITE],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    undo_on_cancellation: false,
  },
  {
    id: "r2",
    hotel_id: "h1",
    name: "Slow weeks",
    is_active: false,
    version: 1,
    start_date: null,
    end_date: null,
    is_annual: false,
    dow_mask: 127,
    action_type: "percent",
    action_direction: "decrease",
    action_value: 7,
    priority: 105,
    is_pickup_rule: true,
    condition: {
      booking_speed_operator: "is",
      booking_speed_level: "slower",
      booking_speed_window_days: 30,
      booking_speed_cooldown_days: 7,
    },
    signal_room_type_ids: [STD],
    affected_room_type_ids: [STD],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    undo_on_cancellation: true,
  },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Sent = { url: string; method: string; body: Record<string, unknown> | null };
let sent: Sent[] = [];
let previewAnswer: () => Response;
/** What the next PUT answers, when a test says. */
let putAnswer: (() => Response) | null = null;

beforeEach(() => {
  sent = [];
  putAnswer = null;
  previewAnswer = () =>
    json({
      needsActivation: true,
      today: "2026-10-01",
      lastNight: "2027-10-31",
      affected: ["2026-10-03", "2026-10-04"],
      roomTypesChanged: { "2026-10-03": 1, "2026-10-04": 2 },
      touched: ["2026-10-03", "2026-10-04"],
      fingerprint: "fp",
      kind: "standard",
      ms: 80,
      nightsChecked: 4,
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      if (method !== "GET" && url !== "/api/events") sent.push({ url, method, body });
      if (url === "/api/rules/preview") return previewAnswer();
      if (url === "/api/rules" && method === "GET") return json(LIST);
      if (url === "/api/rules/engine") return json(ENGINE);
      if (url === "/api/rules/fire-counts") return json({});
      if (url === "/api/rules/stops") return json([]);
      if (url === "/api/room-types") return json(ROOM_TYPES);
      if (url === "/api/hotels") return json({ hotels: [], activeHotelId: null });
      if (url === "/api/events") return new Response(null, { status: 204 });
      if (method === "PUT" && putAnswer) {
        const answer = putAnswer();
        putAnswer = null;
        return answer;
      }
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

async function rulesTab() {
  window.history.replaceState(null, "", "/?tab=rules");
  render(<Dashboard initialSearch={window.location.search} />);
  const row = (await screen.findByText("Busy nights")).closest("tr") as HTMLElement;
  return row;
}

const saves = () => sent.filter((s) => s.url !== "/api/rules/preview");

describe("the rules list's switch", () => {
  it("switching a rule on opens the popup, and saves only on Apply or Skip", async () => {
    await rulesTab();
    const row = screen.getByText("Slow weeks").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("switch", { name: "Enable Slow weeks" }));
    const dialog = await screen.findByRole("dialog", { name: "Turn on “Slow weeks”?" });
    await waitFor(() => expect(within(dialog).getByTestId("activation-summary").textContent).toBe("2 days will be affected by this rule."));
    // A booking speed rule: asked in three parts.
    expect(sent.filter((s) => s.url === "/api/rules/preview")).toHaveLength(3);
    expect(sent[0].body).toMatchObject({ intent: "enable", ruleId: "r2" });
    expect(saves()).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Skip price adjustments" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(saves()).toEqual([
      { url: "/api/rules/r2/toggle", method: "POST", body: { on: true, activation: "skip", fingerprint: "fp", touched: ["2026-10-03", "2026-10-04"], days: 2, refreshed: false } },
    ]);
  });

  it("Cancel leaves the rule off and saves nothing", async () => {
    await rulesTab();
    const row = screen.getByText("Slow weeks").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("switch", { name: "Enable Slow weeks" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saves()).toEqual([]);
  });

  it("switching a rule off is at once, no popup", async () => {
    const row = await rulesTab();
    fireEvent.click(within(row).getByRole("switch", { name: "Disable Busy nights" }));
    await waitFor(() => expect(saves()).toEqual([{ url: "/api/rules/r1/toggle", method: "POST", body: { on: false } }]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a viewer is told why under the rule, and no popup stays open", async () => {
    previewAnswer = () => json({ error: "Only a Revenue Manager or above can change this." }, 403);
    await rulesTab();
    const row = screen.getByText("Slow weeks").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("switch", { name: "Enable Slow weeks" }));
    expect(await within(row).findByText("Only a Revenue Manager or above can change this.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("editing a rule", () => {
  it("Edit fills the builder with every setting of the rule as saved", async () => {
    const row = await rulesTab();
    fireEvent.click(within(row).getByRole("button", { name: "Edit Busy nights" }));
    expect(await screen.findByText("Edit “Busy nights”")).toBeTruthy();
    expect((screen.getByPlaceholderText("e.g. Weekend surge") as HTMLInputElement).value).toBe("Busy nights");
    // Occupancy above 80 and fewer than 14 days out.
    expect(screen.getByDisplayValue("80")).toBeTruthy();
    expect(screen.getByDisplayValue("14")).toBeTruthy();
    expect((screen.getByLabelText("Adjust by percent (%)") as HTMLInputElement).value).toBe("10");
    expect((screen.getByDisplayValue("Increase the rate") as HTMLSelectElement).value).toBe("increase");
    // It measures Standard and changes both: the lists are split.
    expect((screen.getByRole("checkbox", { name: /different room types/i }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(UNDO_ON_CANCELLATION_LABEL) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add Rule" })).toBeNull();
  });

  it("a new name alone saves at once, with the version it was filled from", async () => {
    const row = await rulesTab();
    fireEvent.click(within(row).getByRole("button", { name: "Edit Busy nights" }));
    const name = (await screen.findByDisplayValue("Busy nights")) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Busy weekends" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saves()[0]).toMatchObject({
      url: "/api/rules/r1",
      method: "PUT",
      body: {
        rule_name: "Busy weekends",
        expected_version: 3,
        condition: { occupancy_operator: "gt", occupancy_threshold: 0.8, dta_operator: "lt", dta_threshold_days: 14 },
        action: { adjust_rate_percent: 10 },
        signal_room_type_ids: [STD],
        affected_room_type_ids: [STD, SUITE],
        undo_on_cancellation: false,
      },
    });
    // Saved: the builder is empty again.
    await waitFor(() => expect(screen.queryByText("Edit “Busy nights”")).toBeNull());
  });

  it("a new amount on a rule that is on opens the popup, and Apply sends it; Cancel keeps the form", async () => {
    const row = await rulesTab();
    fireEvent.click(within(row).getByRole("button", { name: "Edit Busy nights" }));
    const percent = (await screen.findByDisplayValue("10")) as HTMLInputElement;
    fireEvent.change(percent, { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    let dialog = await screen.findByRole("dialog", { name: "Save changes to “Busy nights”?" });
    expect(sent.find((s) => s.url === "/api/rules/preview")?.body).toMatchObject({
      intent: "edit",
      ruleId: "r1",
      draft: expect.objectContaining({ action: { adjust_rate_percent: 15 }, expected_version: 3 }),
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(saves()).toEqual([]);
    expect((screen.getByLabelText("Adjust by percent (%)") as HTMLInputElement).value).toBe("15");

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Apply price adjustments" })).toHaveProperty("disabled", false));
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply price adjustments" }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0]).toMatchObject({
      url: "/api/rules/r1",
      method: "PUT",
      body: { action: { adjust_rate_percent: 15 }, expected_version: 3, activation: "apply", fingerprint: "fp" },
    });
  });

  it("an edit to a rule that is off saves at once, keeping a compare the builder can't pick", async () => {
    await rulesTab();
    const row = screen.getByText("Slow weeks").closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Edit Slow weeks" }));
    await screen.findByText("Edit “Slow weeks”");
    fireEvent.change(screen.getByLabelText("Adjust by percent (%)"), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    // "Exactly Slower" stays exactly Slower.
    expect(saves()[0].body).toMatchObject({
      action: { adjust_rate_percent: -9 },
      condition: { booking_speed_operator: "is", booking_speed_level: "slower", booking_speed_window_days: 30, booking_speed_cooldown_days: 7 },
    });
  });

  it("says when the rule changed in another tab, and offers to load it again", async () => {
    const row = await rulesTab();
    fireEvent.click(within(row).getByRole("button", { name: "Edit Busy nights" }));
    const name = (await screen.findByDisplayValue("Busy nights")) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Renamed" } });
    putAnswer = () => json({ error: "This rule changed in another tab. Reload it to edit.", code: "rule_changed" }, 409);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("This rule changed in another tab. Reload it to edit.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect((screen.getByPlaceholderText("e.g. Weekend surge") as HTMLInputElement).value).toBe("Busy nights"));
  });

  it("Cancel editing empties the builder", async () => {
    const row = await rulesTab();
    fireEvent.click(within(row).getByRole("button", { name: "Edit Busy nights" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel editing" }));
    expect(screen.queryByText("Edit “Busy nights”")).toBeNull();
    expect((screen.getByPlaceholderText("e.g. Weekend surge") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Add Rule" })).toBeTruthy();
  });
});

describe("adding a rule", () => {
  it("Add Rule opens the popup and saves the rule under the id it was previewed with", async () => {
    window.history.replaceState(null, "", "/?tab=rules&panel=builder");
    render(<Dashboard initialSearch={window.location.search} />);
    await screen.findByText("All room types");
    fireEvent.change(screen.getByPlaceholderText("e.g. Weekend surge"), { target: { value: "Full house" } });
    fireEvent.change(screen.getByDisplayValue("Choose: increase or decrease the rate…"), { target: { value: "increase" } });
    fireEvent.change(screen.getByLabelText("Adjust by percent (%)"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Rule" }));
    const dialog = await screen.findByRole("dialog", { name: "Add “Full house”?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Apply price adjustments" })).toHaveProperty("disabled", false));
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply price adjustments" }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    const previewed = sent.find((s) => s.url === "/api/rules/preview")!.body!;
    expect(previewed).toMatchObject({ intent: "create", draft: expect.objectContaining({ rule_name: "Full house" }) });
    expect(saves()[0]).toMatchObject({
      url: "/api/rules",
      method: "POST",
      body: { id: previewed.ruleId, rule_name: "Full house", activation: "apply", fingerprint: "fp", action: { adjust_rate_percent: 12 } },
    });
  });
});
