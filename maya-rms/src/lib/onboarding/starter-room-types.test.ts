/**
 * Ticking a room type as a room during simulation adds it to the starter
 * rules the import built and nobody edited (Jake, 2026-09-30, audit A22).
 */
import { describe, expect, it, vi } from "vitest";
import { classifyRoomType } from "@/app/api/room-types/classify";
import { addToStarterRules } from "@/lib/onboarding/starter-room-types";
import { fakeSupabase, type FakeRow } from "../engine/fake-supabase.test";

const HOTEL = "hotel-1";

const LADDER = ["Slow-date rescue", "Slow-date trim", "Warm-date bump", "Hot-week surge", "Sudden-spike catcher"];

function harbourInn(opts: { simulation?: boolean; swappedTo?: string } = {}) {
  const starterRules = LADDER.map((name) => ({ name, explanation: "x" }));
  const job: FakeRow = {
    id: "job-1",
    hotel_id: HOTEL,
    created_at: "2026-09-20T10:00:00Z",
    stats: {
      starterRules,
      starterRulesFor: "none",
      starterRuleSets: {
        none: { rules: starterRules },
        automate_current: { rules: [{ name: "Filling-up raise", explanation: "y" }] },
        find_upside: { rules: starterRules },
      },
    },
  };
  // The fake reads a JSON path filter as a column of that name.
  job["stats->starterRules"] = starterRules;
  return fakeSupabase({
    hotel_settings: [{ hotel_id: HOTEL, simulation_mode: opts.simulation ?? true }],
    onboarding_states: [{ hotel_id: HOTEL, questions: opts.swappedTo ? { starterRulesFor: opts.swappedTo } : {} }],
    import_jobs: [job],
    room_types: [
      { id: "rt-king", hotel_id: HOTEL, name: "Harbour King", counts_as_room: true, counts_as_room_set_by: null },
      { id: "rt-exec", hotel_id: HOTEL, name: "Executive Conference Room", counts_as_room: false, counts_as_room_set_by: null },
    ],
    pricing_rules: [
      { id: "r-rescue", hotel_id: HOTEL, name: "Slow-date rescue", version: 1 },
      { id: "r-warm", hotel_id: HOTEL, name: "Warm-date bump", version: 2 },
      { id: "r-own", hotel_id: HOTEL, name: "Juniper weekend raise", version: 1 },
      { id: "r-fill", hotel_id: HOTEL, name: "Filling-up raise", version: 1 },
    ],
    rule_signal_room_type: [
      { rule_id: "r-rescue", room_type_id: "rt-king" },
      { rule_id: "r-warm", room_type_id: "rt-king" },
    ],
    rule_affected_room_type: [
      { rule_id: "r-rescue", room_type_id: "rt-king" },
      { rule_id: "r-warm", room_type_id: "rt-king" },
    ],
  });
}

const typesOf = (db: ReturnType<typeof harbourInn>, table: string, ruleId: string) =>
  db.tables[table].filter((j) => j.rule_id === ruleId).map((j) => j.room_type_id).sort();

describe("addToStarterRules", () => {
  it("adds the type to what each untouched starter rule measures and changes, and to nothing else", async () => {
    const db = harbourInn();
    expect(await addToStarterRules(db.client, HOTEL, "rt-exec")).toBe(1);
    for (const table of ["rule_signal_room_type", "rule_affected_room_type"]) {
      expect(typesOf(db, table, "r-rescue")).toEqual(["rt-exec", "rt-king"]);
      // Edited by the owner: the room types are theirs.
      expect(typesOf(db, table, "r-warm")).toEqual(["rt-king"]);
      // Not a starter rule.
      expect(typesOf(db, table, "r-own")).toEqual([]);
    }
  });

  it("adds it once, however often the answer is given", async () => {
    const db = harbourInn();
    await addToStarterRules(db.client, HOTEL, "rt-exec");
    await addToStarterRules(db.client, HOTEL, "rt-exec");
    expect(typesOf(db, "rule_signal_room_type", "r-rescue")).toEqual(["rt-exec", "rt-king"]);
  });

  it("follows the set the last question swapped in", async () => {
    const db = harbourInn({ swappedTo: "automate_current" });
    expect(await addToStarterRules(db.client, HOTEL, "rt-exec")).toBe(1);
    expect(typesOf(db, "rule_affected_room_type", "r-fill")).toEqual(["rt-exec"]);
    expect(typesOf(db, "rule_affected_room_type", "r-rescue")).toEqual(["rt-king"]);
  });

  it("changes no rule on a live property", async () => {
    const db = harbourInn({ simulation: false });
    expect(await addToStarterRules(db.client, HOTEL, "rt-exec")).toBe(0);
    expect(typesOf(db, "rule_signal_room_type", "r-rescue")).toEqual(["rt-king"]);
  });

  it("never throws: the tick is saved, and a failure is logged", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = fakeSupabase(
      { hotel_settings: [{ hotel_id: HOTEL, simulation_mode: true }] },
      { fault: (call) => (call.table === "import_jobs" ? { message: "statement timeout" } : null) },
    );
    expect(await addToStarterRules(db.client, HOTEL, "rt-exec")).toBe(0);
    expect(String(error.mock.calls[0]?.[0])).toContain("not added to the starter rules");
    error.mockRestore();
  });
});

describe("classifyRoomType", () => {
  it("adds a type ticked as a room to the starter rules, and leaves them alone on an untick", async () => {
    const db = harbourInn();
    const ticked = await classifyRoomType(db.client, {
      hotelId: HOTEL,
      roomTypeId: "rt-exec",
      countsAsRoom: true,
      actorUserId: "owner-1",
      via: "onboarding_review",
    });
    expect(ticked.kind).toBe("changed");
    expect(typesOf(db, "rule_signal_room_type", "r-rescue")).toEqual(["rt-exec", "rt-king"]);

    const unticked = await classifyRoomType(db.client, {
      hotelId: HOTEL,
      roomTypeId: "rt-king",
      countsAsRoom: false,
      actorUserId: "owner-1",
      via: "settings",
    });
    expect(unticked.kind).toBe("changed");
    expect(typesOf(db, "rule_signal_room_type", "r-rescue")).toEqual(["rt-exec", "rt-king"]);
  });
});
