// @vitest-environment jsdom
/**
 * Room types on the PMS tab. A type nobody has answered for is out of the
 * bill, so its box shows unticked with a "needs your answer" tag: the room
 * count email's "tick it under PMS > Room types" then does what it says.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COUNTS_AS_ROOM_HELP,
  RoomTypeSettings,
  needsAnswer,
  roomCountQuestion,
  saveCountsAsRoom,
  type RoomTypeOption,
} from "@/components/room-type-settings";

const TYPES: RoomTypeOption[] = [
  { id: "rt-king", name: "King Room", total_rooms: 20, counts_as_room: true },
  { id: "rt-court", name: "Pickleball Court", total_rooms: 4, counts_as_room: null },
  { id: "rt-parking", name: "Parking", total_rooms: 30, counts_as_room: false },
];

let patches: unknown[] = [];

beforeEach(() => {
  patches = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        return new Response("{}", { status: 200 });
      }
      if (url.startsWith("/api/room-types/out-of-service")) {
        return new Response(JSON.stringify({ blocks: [] }), { status: 200 });
      }
      return new Response(JSON.stringify(TYPES), { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("needsAnswer", () => {
  it("is only the null flag", () => {
    expect(needsAnswer({ counts_as_room: null })).toBe(true);
    expect(needsAnswer({ counts_as_room: true })).toBe(false);
    expect(needsAnswer({ counts_as_room: false })).toBe(false);
  });
});

describe("RoomTypeSettings", () => {
  it("shows an unanswered type unticked, tagged, and ticking it saves a yes", async () => {
    render(<RoomTypeSettings hotelId="hotel-1" />);

    const court = (await screen.findByLabelText("Pickleball Court counts as a room")) as HTMLInputElement;
    const king = screen.getByLabelText("King Room counts as a room") as HTMLInputElement;
    const parking = screen.getByLabelText("Parking counts as a room") as HTMLInputElement;

    expect(court.checked).toBe(false);
    expect(king.checked).toBe(true);
    expect(parking.checked).toBe(false);
    // One tag each: the unanswered type asks, the answered no says so.
    expect(screen.getAllByText("needs your answer")).toHaveLength(1);
    expect(screen.getAllByText("not a room")).toHaveLength(1);

    fireEvent.click(court);
    await waitFor(() => expect(patches).toEqual([{ hotelId: "hotel-1", roomTypeId: "rt-court", countsAsRoom: true }]));
    expect(court.checked).toBe(true);
    expect(screen.queryByText("needs your answer")).toBeNull();
  });
});

describe("room type wording", () => {
  it("asks and explains without an em dash", () => {
    expect(roomCountQuestion(3)).toBe("We're counting 3 room types as rooms. Anything here that isn't?");
    for (const line of COUNTS_AS_ROOM_HELP.lines) expect(line).not.toContain("\u2014");
  });

  it("says a failed save plainly", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    expect(await saveCountsAsRoom("hotel-1", "rt-king", true)).toBe("That didn't save. Try again.");
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(await saveCountsAsRoom("hotel-1", "rt-king", true)).toBe("That didn't save. Try again.");
  });
});
