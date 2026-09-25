/**
 * The import's room types: counted from Think's rooms list, and null (keep
 * what is stored) when that list cannot be read. The worker's write is
 * covered in the sync tests, which share it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const client = vi.hoisted(() => ({
  thinkGetHotels: vi.fn(),
  thinkGetRoomTypes: vi.fn(),
  thinkGetRooms: vi.fn(),
  thinkGetReservationsPage: vi.fn(),
}));
vi.mock("../../../supabase/functions/_shared/think/client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../supabase/functions/_shared/think/client")>()),
  ...client,
}));
vi.mock("../../../supabase/functions/_shared/pms/oauth-credentials.ts", () => ({
  resolveOAuthCredentials: vi.fn(),
  persistPropertyId: vi.fn(async () => {}),
}));

import { createThinkOnboardingAdapter } from "../../../supabase/functions/_shared/think/onboarding-adapter";

function supabaseStub(): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

async function adapter() {
  return createThinkOnboardingAdapter(supabaseStub(), "hotel-1", {
    accessToken: "at",
    tokenType: "Bearer",
    propertyId: "prop-1",
  });
}

beforeEach(() => {
  client.thinkGetHotels.mockReset();
  client.thinkGetHotels.mockResolvedValue([
    { id: "h1", externalId: "prop-1", name: "Inn", timeZone: "UTC", currencyCode: "USD" },
  ]);
  client.thinkGetRoomTypes.mockReset();
  client.thinkGetRoomTypes.mockResolvedValue([
    { id: "rt1", name: "Room 1" },
    { id: "rt2", name: "Room 2" },
    { id: "rt3", name: "Loft" },
  ]);
  client.thinkGetRooms.mockReset();
});

describe("Think onboarding fetchRoomTypes", () => {
  it("counts rooms per type, 0 for a type with none active", async () => {
    client.thinkGetRooms.mockResolvedValue([
      { id: "r1", roomTypeId: "rt1" },
      { id: "r2", roomTypeId: "rt2" },
      { id: "r3", roomTypeId: "rt2" },
      { id: "r4", roomTypeId: "rt3", inactive: true },
    ]);

    const types = await (await adapter()).fetchRoomTypes();

    expect(types.map((t) => [t.external_room_type_id, t.total_rooms])).toEqual([
      ["rt1", 1],
      ["rt2", 2],
      ["rt3", 0],
    ]);
    expect(client.thinkGetRooms.mock.calls[0][1]).toBe("prop-1");
  });

  it("returns null counts when the rooms call fails, instead of a default", async () => {
    client.thinkGetRooms.mockRejectedValue(new Error("Think /rooms failed (500)"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const types = await (await adapter()).fetchRoomTypes();

    expect(types.map((t) => t.total_rooms)).toEqual([null, null, null]);
    warn.mockRestore();
  });
});
