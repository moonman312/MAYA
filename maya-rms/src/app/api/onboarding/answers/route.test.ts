/**
 * A floor or ceiling answer that a room type cannot take used to be dropped
 * by the database without a word. The card now stays up and names the room
 * type, which answer, and what it clashed with.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, type FakeRow } from "@/lib/engine/fake-supabase.test";

const state = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.client }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => "h1" }));

const { POST } = await import("./route");

/** room_types keeps ceiling_price >= floor_price, and refuses the whole row otherwise. */
function world(settings: FakeRow, types: FakeRow[], currency = "USD") {
  const db: { tables?: Record<string, FakeRow[]> } = {};
  const made = fakeSupabase(
    {
      hotels: [{ id: "h1", name: "The Harbour Inn", currency }],
      onboarding_states: [{ hotel_id: "h1", questions: {} }],
      hotel_settings: [{ hotel_id: "h1", strategy_floor: null, strategy_ceiling: null, ...settings }],
      room_types: types.map((t) => ({ hotel_id: "h1", is_active: true, floor_price: 1, ceiling_price: 99999.99, ...t })),
      reservations: [],
    },
    {
      fault: (call) => {
        if (call.table !== "room_types" || call.op !== "update") return null;
        const id = call.filters.find((f) => f.col === "id")?.value;
        const next = { ...db.tables!.room_types.find((r) => r.id === id), ...(call.payload as FakeRow) };
        return Number(next.floor_price) > Number(next.ceiling_price)
          ? { code: "23514", message: 'new row for relation "room_types" violates check constraint' }
          : null;
      },
    },
  );
  db.tables = made.tables;
  state.client = { ...made.client, auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } };
  return made.tables;
}

function answer(body: unknown) {
  return POST(
    new Request("http://localhost/api/onboarding/answers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const guardrails = (rows: FakeRow[]) => Object.fromEntries(rows.map((r) => [r.id, [r.floor_price, r.ceiling_price]]));

beforeEach(() => {
  state.client = null;
});

describe("floor and ceiling answers", () => {
  it("saves a floor on every room type that takes it and says which one did not, and why", async () => {
    const tables = world({}, [
      { id: "rt-std", name: "Standard" },
      { id: "rt-king", name: "Deluxe King", ceiling_price: 150 },
    ]);
    const res = await answer({ floor: 200 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "Your floor of $200 wasn't saved for Deluxe King: its ceiling is $150, and a floor can't be above the ceiling.",
    );
    expect(guardrails(tables.room_types)).toEqual({ "rt-std": [200, 99999.99], "rt-king": [1, 150] });
    expect(tables.hotel_settings[0].strategy_floor).toBe(200);
  });

  it("names every room type that kept its own number, in the property's currency", async () => {
    world({}, [
      { id: "rt-king", name: "Deluxe King", floor_price: 180 },
      { id: "rt-suite", name: "Suite", floor_price: 250 },
      { id: "rt-std", name: "Standard" },
    ], "EUR");
    const res = await answer({ ceiling: 170 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "Your ceiling of EUR 170 wasn't saved for Deluxe King: its floor is EUR 180, and a ceiling can't be below the floor. " +
        "Your ceiling of EUR 170 wasn't saved for Suite: its floor is EUR 250, and a ceiling can't be below the floor.",
    );
  });

  it("does not bring up an earlier answer's clash on a later card", async () => {
    // The floor was answered (and reported) before; saving the ceiling
    // writes it again, and only the ceiling is this card's business.
    world({ strategy_floor: 200 }, [
      { id: "rt-std", name: "Standard" },
      { id: "rt-king", name: "Deluxe King", ceiling_price: 150 },
    ]);
    const res = await answer({ ceiling: 500 });
    expect(res.status).toBe(200);
  });

  it("refuses a ceiling under the floor already on file, before saving anything", async () => {
    const tables = world({ strategy_floor: 200 }, [{ id: "rt-std", name: "Standard", floor_price: 200 }]);
    const res = await answer({ ceiling: 150 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Your ceiling price needs to be above your floor price of $200.");
    expect(tables.hotel_settings[0].strategy_ceiling).toBeNull();
    expect(guardrails(tables.room_types)).toEqual({ "rt-std": [200, 99999.99] });
  });

  it("refuses a floor over the ceiling already on file", async () => {
    const tables = world({ strategy_ceiling: 150 }, [{ id: "rt-std", name: "Standard" }]);
    const res = await answer({ floor: 1500.5 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Your floor price needs to be below your ceiling price of $150.");
    expect(tables.hotel_settings[0].strategy_floor).toBeNull();
  });

  it("answers ok when every room type takes the answer", async () => {
    const tables = world({}, [{ id: "rt-std", name: "Standard", ceiling_price: 300 }]);
    const res = await answer({ floor: 80 });
    expect(res.status).toBe(200);
    expect(guardrails(tables.room_types)).toEqual({ "rt-std": [80, 300] });
  });
});

describe("the property name", () => {
  it("says a name already in use plainly, with no em dash", async () => {
    const made = fakeSupabase(
      { hotels: [{ id: "h1", name: "The Harbour Inn", currency: "USD" }], onboarding_states: [], hotel_settings: [], room_types: [] },
      {
        fault: (call) =>
          call.table === "hotels" && call.op === "update"
            ? { code: "23505", message: 'duplicate key value violates unique constraint "hotels_name_key"' }
            : null,
      },
    );
    state.client = { ...made.client, auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } };
    const res = await answer({ propertyName: "Harbour Inn" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("That property name is already taken. Try adding your city or neighborhood.");
  });
});
