// @vitest-environment jsdom
/**
 * The review screen as a whole: Finish only moves on once the server says the
 * review is marked done, and says why when it isn't; the go-live card stays
 * after "Get suggestions from my data", whose own job builds no rules; and the
 * room count strip ticks a type only on a yes, the same as the PMS tab.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: () => {}, refresh: () => {} }) }));
vi.mock("@/lib/analytics/track", () => ({ track: () => {}, useTrackOnce: () => {} }));

const { ReviewFindings } = await import("./review-findings");

let completeReply: () => Response | Promise<Response> = () => json({ ok: true, totalRooms: 20 });
let completeCalls = 0;
let statusReply: Record<string, unknown> = {};
let statusCalls = 0;
let roomTypes: unknown[] = [];
let roomTypePatches: unknown[] = [];
let findings: unknown[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  push.mockClear();
  completeCalls = 0;
  completeReply = () => json({ ok: true, totalRooms: 20 });
  statusReply = { connected: true, hotelId: "h1", simulationMode: true };
  statusCalls = 0;
  roomTypes = [];
  roomTypePatches = [];
  findings = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/onboarding/findings") return json({ findings });
    // An answer that doesn't save, with no words of its own.
    if (url.startsWith("/api/onboarding/findings/")) return new Response("", { status: 500 });
    if (url === "/api/onboarding/status") {
      statusCalls += 1;
      return json(statusReply);
    }
    if (url === "/api/room-types" && init?.method === "PATCH") {
      roomTypePatches.push(JSON.parse(String(init.body)));
      return json({});
    }
    if (url === "/api/room-types") return json(roomTypes);
    if (url === "/api/onboarding/complete") {
      completeCalls += 1;
      return completeReply();
    }
    return json({});
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function pressFinish() {
  render(<ReviewFindings />);
  const button = await screen.findByRole("button", { name: /Finish/ });
  fireEvent.click(button);
  await waitFor(() => expect(completeCalls).toBe(1));
}

describe("Finish", () => {
  it("goes to the dashboard once the review is marked done", async () => {
    await pressFinish();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
  });

  it("stays and says why when the role can't finish it, with a way to the dashboard", async () => {
    completeReply = () => json({ error: "Only a Revenue Manager or above can finish the review." }, 403);
    await pressFinish();
    await screen.findByText("Only a Revenue Manager or above can finish the review.");
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Go to my dashboard" }).getAttribute("href")).toBe("/");
    expect((screen.getByRole("button", { name: /Finish/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("stays and says so when the save did not go through", async () => {
    completeReply = () => json({ error: "Your review couldn't be marked as finished. Reload the page and try again." }, 409);
    await pressFinish();
    await screen.findByText("Your review couldn't be marked as finished. Reload the page and try again.");
    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Go to my dashboard" })).toBeNull();
  });

  it("stays and says so when the server can't be reached", async () => {
    completeReply = () => Promise.reject(new TypeError("Failed to fetch"));
    await pressFinish();
    await screen.findByText("Couldn't finish the review. Try again.");
    expect(push).not.toHaveBeenCalled();
  });
});

describe("the go-live card", () => {
  const busyNights = { name: "Busy nights", explanation: "Raises busy nights." };

  it("stays after Get suggestions from my data, whose own read built no starter rules", async () => {
    statusReply = {
      connected: true,
      hotelId: "h1",
      simulationMode: true,
      job: { status: "completed", phase: "done", rows_upserted: 900, stats: { mode: "refresh" } },
      starterRules: [busyNights],
    };
    render(<ReviewFindings />);
    await screen.findByRole("button", { name: "Turn them on for real" });
    expect(screen.getByText("Busy nights")).not.toBeNull();
  });

  it("still reads the rules off the job for a server that doesn't send them separately", async () => {
    statusReply = {
      connected: true,
      hotelId: "h1",
      simulationMode: true,
      job: { status: "completed", phase: "done", rows_upserted: 900, stats: { starterRules: [busyNights] } },
    };
    render(<ReviewFindings />);
    await screen.findByRole("button", { name: "Turn them on for real" });
  });

  it("is not there for a property no import built starter rules for", async () => {
    statusReply = {
      connected: true,
      hotelId: "h1",
      simulationMode: true,
      job: { status: "completed", phase: "done", rows_upserted: 900, stats: { mode: "refresh" } },
      starterRules: [],
    };
    render(<ReviewFindings />);
    await screen.findByRole("button", { name: /Finish/ });
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Turn them on for real" })).toBeNull();
  });
});

describe("the room count strip", () => {
  beforeEach(() => {
    roomTypes = [
      { id: "rt-king", name: "King", total_rooms: 5, counts_as_room: true },
      { id: "rt-std", name: "Standard", total_rooms: 10, counts_as_room: true },
      { id: "rt-pool", name: "Deluxe Pool View", total_rooms: 10, counts_as_room: null },
      { id: "rt-park", name: "Parking", total_rooms: 30, counts_as_room: false },
    ];
  });

  it("shows a type nobody has answered for unticked and tagged, and leaves it out of the count", async () => {
    render(<ReviewFindings />);
    const pool = (await screen.findByLabelText("Deluxe Pool View counts as a room")) as HTMLInputElement;

    expect(pool.checked).toBe(false);
    expect((screen.getByLabelText("King counts as a room") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Parking counts as a room") as HTMLInputElement).checked).toBe(false);
    expect(screen.getAllByText("needs your answer")).toHaveLength(1);
    expect(screen.getByText(/^We're counting 2 room types as rooms/)).not.toBeNull();

    // The "?" explains the tag here too.
    fireEvent.click(screen.getByRole("button", { name: "What counting as a room changes" }));
    expect(screen.getByText(/^A type tagged "needs your answer" is one nobody has ticked or unticked yet\./)).not.toBeNull();
  });

  it("brings it into the count when ticked, saving a yes", async () => {
    render(<ReviewFindings />);
    const pool = (await screen.findByLabelText("Deluxe Pool View counts as a room")) as HTMLInputElement;
    await waitFor(() => expect(pool.disabled).toBe(false));

    fireEvent.click(pool);
    await waitFor(() =>
      expect(roomTypePatches).toEqual([{ hotelId: "h1", roomTypeId: "rt-pool", countsAsRoom: true }]),
    );
    expect(pool.checked).toBe(true);
    expect(screen.queryByText("needs your answer")).toBeNull();
    expect(screen.getByText(/^We're counting 3 room types as rooms/)).not.toBeNull();
  });
});

describe("the words on the review", () => {
  const card = (id: string, kind: string, payload: Record<string, unknown>, status = "proposed") => ({
    id,
    kind,
    status,
    payload,
    created_at: "2026-09-01T00:00:00Z",
  });

  it("use no em dash on either screen, a failed answer and the go-live card included", async () => {
    findings = [
      card("f1", "closed_period", { start_date: "2025-01-01", end_date: "2025-01-19", days: 19 }),
      card("f2", "duplicate_room_type", { name: "Standard", deactivate_room_type_id: "rt-9" }, "auto_applied"),
      card("f3", "unmapped_room_type", { count: 7 }),
    ];
    statusReply = { connected: true, hotelId: "h1", simulationMode: true, starterRules: [{ name: "Busy nights", explanation: "Raises busy nights." }] };
    render(<ReviewFindings />);
    fireEvent.click(await screen.findByRole("button", { name: "Yes, we were closed" }));
    await screen.findByText("That didn't save. Try again.");
    expect(screen.getByText("We already did this for you. Dismiss to undo it.")).not.toBeNull();
    const first = document.body.textContent;

    fireEvent.click(screen.getByRole("button", { name: "Continue to recommendations" }));
    await screen.findByRole("button", { name: "Turn them on for real" });
    expect(screen.getByRole("button", { name: "Finish and take me to my dashboard" })).not.toBeNull();

    expect(first).not.toContain("—");
    expect(document.body.textContent).not.toContain("—");
  });

  it("says a clean review without one", async () => {
    render(<ReviewFindings />);
    await screen.findByText("Nothing left to review. Your data looks clean.");
    expect(document.body.textContent).not.toContain("—");
  });
});
