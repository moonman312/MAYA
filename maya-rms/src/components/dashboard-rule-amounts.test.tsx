// @vitest-environment jsdom
/**
 * The rule builder takes one amount: a percent or a fixed amount. A number
 * in one box greys out the other, and whichever has the number is saved.
 * The rules list does not show the undo box (Jake, 2026-09-28).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNDO_ON_CANCELLATION_LABEL } from "@/lib/rule-form";
import { Dashboard } from "./dashboard";

const ROOM_TYPES = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Standard", counts_as_room: true },
  { id: "22222222-2222-4222-8222-222222222222", name: "Suite", counts_as_room: true },
];

const SAVED_RULE = {
  id: "r1",
  rule_name: "Busy nights",
  conditions: { occupancy_percentage: ">80" },
  action: { adjust_rate_percent: 10 },
  room_types: ["Standard", "Suite"],
  enabled: true,
  undo_on_cancellation: false,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let rules: unknown[] = [];
let posts: unknown[] = [];

beforeEach(() => {
  rules = [];
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      // No preview here (demo mode): Add Rule saves the way it did before the
      // activation popup (dashboard-rule-editing.test.tsx has the popup).
      if (url === "/api/rules/preview") return json({ error: "Supabase required for rule changes." }, 501);
      if (url === "/api/rules" && method === "POST") {
        posts.push(JSON.parse(String(init?.body)));
        return json({ id: "r2" }, 201);
      }
      if (url === "/api/rules") return json(rules);
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

async function openBuilder(search = "/?tab=rules&panel=builder") {
  window.history.replaceState(null, "", search);
  render(<Dashboard initialSearch={window.location.search} />);
  await screen.findByPlaceholderText("e.g. Weekend surge");
  // The room type chips start selected once the room types have loaded.
  await screen.findByText("All room types");
  return {
    percent: screen.getByLabelText("Adjust by percent (%)") as HTMLInputElement,
    fixed: screen.getByLabelText("Adjust by fixed amount ($)") as HTMLInputElement,
  };
}

function fillTheRest() {
  fireEvent.change(screen.getByPlaceholderText("e.g. Weekend surge"), { target: { value: "Busy nights" } });
  fireEvent.change(screen.getByDisplayValue("Choose: increase or decrease the rate…"), { target: { value: "increase" } });
}

describe("the rule builder's amount", () => {
  it("starts with both boxes empty and open, and no checkboxes beside them", async () => {
    const { percent, fixed } = await openBuilder();
    expect(percent.value).toBe("");
    expect(fixed.value).toBe("");
    expect(percent.disabled).toBe(false);
    expect(fixed.disabled).toBe(false);
    expect(percent.placeholder).toBe("e.g. 10");
    expect(fixed.placeholder).toBe("e.g. 15");
    const adjustment = document.querySelector('[data-deeplink="rules.builder.adjustment"]') as HTMLElement;
    // The only checkbox left in the section is the undo box.
    expect(within(adjustment).getAllByRole("checkbox").map((c) => (c as HTMLInputElement).labels?.[0]?.textContent)).toEqual([
      UNDO_ON_CANCELLATION_LABEL,
    ]);
    expect(screen.queryByText(/both apply/i)).toBeNull();
  });

  it("greys out the other box while one has a number, and opens it again when cleared", async () => {
    const { percent, fixed } = await openBuilder();
    fireEvent.change(percent, { target: { value: "10" } });
    expect(fixed.disabled).toBe(true);
    expect(percent.disabled).toBe(false);
    fireEvent.change(percent, { target: { value: "" } });
    expect(fixed.disabled).toBe(false);
    fireEvent.change(fixed, { target: { value: "15" } });
    expect(percent.disabled).toBe(true);
    fireEvent.change(fixed, { target: { value: "" } });
    expect(percent.disabled).toBe(false);
  });

  it("saves the fixed amount when that is the box with the number", async () => {
    const { fixed } = await openBuilder();
    fillTheRest();
    fireEvent.change(fixed, { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Rule" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ rule_name: "Busy nights", action: { adjust_rate_dollars: 15 } });
    expect((posts[0] as { action: object }).action).not.toHaveProperty("adjust_rate_percent");
  });

  it("saves the percent, signed by the direction, and clears both boxes after", async () => {
    const { percent, fixed } = await openBuilder();
    fillTheRest();
    fireEvent.change(screen.getByDisplayValue("Increase the rate"), { target: { value: "decrease" } });
    fireEvent.change(percent, { target: { value: "12.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Rule" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect((posts[0] as { action: object }).action).toEqual({ adjust_rate_percent: -12.5 });
    await waitFor(() => expect(percent.value).toBe(""));
    expect(fixed.value).toBe("");
    expect(fixed.disabled).toBe(false);
  });

  it("says so, and saves nothing, when neither box has a number", async () => {
    await openBuilder();
    fillTheRest();
    fireEvent.click(screen.getByRole("button", { name: "Add Rule" }));
    expect(await screen.findByText("Enter a percent or a fixed amount.")).toBeTruthy();
    expect(posts).toEqual([]);
  });
});

describe("a link into the builder fills one amount", () => {
  it("a percent link fills the percent and greys out the fixed amount", async () => {
    const { percent, fixed } = await openBuilder(
      "/?tab=rules&panel=builder&dl=rules.new&name=Busy&occupancy=gt80&direction=increase&percent=15",
    );
    await waitFor(() => expect(percent.value).toBe("15"));
    expect(fixed.value).toBe("");
    expect(fixed.disabled).toBe(true);
  });

  it("an amount link fills the fixed amount and greys out the percent", async () => {
    const { percent, fixed } = await openBuilder(
      "/?tab=rules&panel=builder&dl=rules.new&name=Busy&occupancy=gt80&direction=increase&amount=20",
    );
    await waitFor(() => expect(fixed.value).toBe("20"));
    expect(percent.value).toBe("");
    expect(percent.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Add Rule" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect((posts[0] as { action: object }).action).toEqual({ adjust_rate_dollars: 20 });
  });
});

describe("the rules list", () => {
  it("does not show the undo box on a saved rule", async () => {
    rules = [SAVED_RULE];
    window.history.replaceState(null, "", "/?tab=rules");
    render(<Dashboard initialSearch={window.location.search} />);
    const row = (await screen.findByText("Busy nights")).closest("tr") as HTMLElement;
    expect(within(row).queryAllByRole("checkbox")).toEqual([]);
    expect(within(row).queryByText(/undo/i)).toBeNull();
    expect(screen.queryByLabelText(`${UNDO_ON_CANCELLATION_LABEL}: Busy nights`)).toBeNull();
    // The on/off switch is still there.
    expect(within(row).getByRole("switch", { name: "Disable Busy nights" })).toBeTruthy();
  });
});
