import { describe, expect, it } from "vitest";
import type { EngineRule } from "@/types/domain";
import { retireUndonePickupEvents } from "./pickup";

type Event = {
  id: string;
  rule_id: string;
  stay_date: string;
  signal_booked_units_start: number;
  retired_at: string | null;
};
type Snap = { stay_date: string; room_type_id: string; booked_units: number };

function fakeSupabase(events: Event[], snaps: Snap[]) {
  const retired: string[] = [];
  const client = {
    from(table: string) {
      if (table === "pickup_event") {
        const api = {
          select() {
            return api;
          },
          eq() {
            return api;
          },
          is() {
            return Promise.resolve({ data: events.filter((e) => e.retired_at === null) });
          },
          update(patch: { retired_at: string }) {
            return {
              in(_col: string, ids: string[]) {
                for (const id of ids) {
                  const e = events.find((x) => x.id === id);
                  if (e) e.retired_at = patch.retired_at;
                  retired.push(id);
                }
                return Promise.resolve({ error: null });
              },
            };
          },
        };
        return api;
      }
      // stay_date_snapshot
      const q = {
        select() {
          return q;
        },
        eq(col: string, _val: string) {
          // second .eq resolves the query
          return col === "snapshot_ts" ? Promise.resolve({ data: snaps }) : q;
        },
      };
      return q;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, retired, events };
}

function rule(id: string, signalRoomTypeIds: string[]): EngineRule {
  return { id, signal_room_type_ids: signalRoomTypeIds } as unknown as EngineRule;
}

const NOW = "2026-08-01T00:00:00Z";

describe("retireUndonePickupEvents", () => {
  it("retires an event once bookings fall back to where they started", () => {
    // Fired at 4 bookings, having started from 1. All four cancelled.
    const { client, retired } = fakeSupabase(
      [{ id: "e1", rule_id: "r1", stay_date: "2026-09-01", signal_booked_units_start: 1, retired_at: null }],
      [{ stay_date: "2026-09-01", room_type_id: "rt1", booked_units: 1 }],
    );
    return retireUndonePickupEvents(client, "h1", [rule("r1", ["rt1"])], NOW, NOW).then((n) => {
      expect(n).toBe(1);
      expect(retired).toEqual(["e1"]);
    });
  });

  it("leaves the event alone when only some of the surge cancelled", async () => {
    // A cancellation or two out of a real surge is noise, not a reversal.
    const { client, retired } = fakeSupabase(
      [{ id: "e1", rule_id: "r1", stay_date: "2026-09-01", signal_booked_units_start: 1, retired_at: null }],
      [{ stay_date: "2026-09-01", room_type_id: "rt1", booked_units: 3 }],
    );
    const n = await retireUndonePickupEvents(client, "h1", [rule("r1", ["rt1"])], NOW, NOW);
    expect(n).toBe(0);
    expect(retired).toEqual([]);
  });

  it("sums across every room type the rule watches", async () => {
    // Still 2 booked across the signal set, above the starting 1 — keep it.
    const { client } = fakeSupabase(
      [{ id: "e1", rule_id: "r1", stay_date: "2026-09-01", signal_booked_units_start: 1, retired_at: null }],
      [
        { stay_date: "2026-09-01", room_type_id: "rt1", booked_units: 1 },
        { stay_date: "2026-09-01", room_type_id: "rt2", booked_units: 1 },
      ],
    );
    expect(await retireUndonePickupEvents(client, "h1", [rule("r1", ["rt1", "rt2"])], NOW, NOW)).toBe(0);
  });

  it("does not touch events whose rule is missing from this run", async () => {
    // No signal set means no evidence either way — never guess.
    const { client } = fakeSupabase(
      [{ id: "e1", rule_id: "gone", stay_date: "2026-09-01", signal_booked_units_start: 5, retired_at: null }],
      [{ stay_date: "2026-09-01", room_type_id: "rt1", booked_units: 0 }],
    );
    expect(await retireUndonePickupEvents(client, "h1", [rule("r1", ["rt1"])], NOW, NOW)).toBe(0);
  });

  it("does not act when the stay date has no snapshot this run", async () => {
    const { client } = fakeSupabase(
      [{ id: "e1", rule_id: "r1", stay_date: "2027-01-01", signal_booked_units_start: 5, retired_at: null }],
      [{ stay_date: "2026-09-01", room_type_id: "rt1", booked_units: 0 }],
    );
    expect(await retireUndonePickupEvents(client, "h1", [rule("r1", ["rt1"])], NOW, NOW)).toBe(0);
  });
});
