import { afterEach, describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import type { EngineRule } from "@/types/domain";
import { resetBookingSpeedLogOnce } from "./booking-speed-provider";
import { evaluateHotel } from "./evaluate";
import { fakeSupabase as sharedFake, type FakeRow } from "./fake-supabase.test";
import { retireUndonePickupEvents } from "./pickup";

type Event = {
  id: string;
  rule_id: string;
  stay_date: string;
  signal_booked_units_start: number;
  retired_at: string | null;
};
type Snap = { stay_date: string; room_type_id: string; booked_units: number };

const NOW = "2026-08-01T00:00:00Z";

function fakeSupabase(events: Event[], snaps: Snap[]) {
  // Capped like PostgREST: an unpaged read would see only the first 1,000.
  const fake = sharedFake(
    {
      pickup_event: events.map((e) => ({ hotel_id: "h1", ...e })),
      stay_date_snapshot: snaps.map((x) => ({ hotel_id: "h1", snapshot_ts: NOW, ...x })),
    },
    { maxRows: 1000 },
  );
  const retired: string[] = [];
  for (const row of fake.tables.pickup_event) {
    Object.defineProperty(row, "retired_at", {
      enumerable: true,
      configurable: true,
      get: () => (row as { _retired?: string | null })._retired ?? null,
      set: (v: string | null) => {
        if (v != null) retired.push(String(row.id));
        (row as { _retired?: string | null })._retired = v;
      },
    });
  }
  return { client: fake.client, retired, events, calls: fake.calls, tables: fake.tables };
}

function rule(id: string, signalRoomTypeIds: string[]): EngineRule {
  return { id, signal_room_type_ids: signalRoomTypeIds } as unknown as EngineRule;
}


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

  it("checks every open event and snapshot cell past the 1,000-row page", async () => {
    // 1,500 stay dates, one open event each. Before paging, only the first
    // 1,000 events (and 1,000 snapshot cells) were ever read.
    const events: Event[] = [];
    const snaps: Snap[] = [];
    const base = Date.UTC(2026, 7, 1);
    for (let i = 0; i < 1500; i++) {
      const d = new Date(base + i * 86_400_000).toISOString().slice(0, 10);
      events.push({ id: `e${String(i).padStart(5, "0")}`, rule_id: "r1", stay_date: d, signal_booked_units_start: 2, retired_at: null });
      // Every third date has fallen back to its start.
      snaps.push({ stay_date: d, room_type_id: "rt1", booked_units: i % 3 === 0 ? 2 : 5 });
    }
    const expected = events.filter((_, i) => i % 3 === 0).map((e) => e.id);

    const { client, retired, calls } = fakeSupabase(events, snaps);
    const n = await retireUndonePickupEvents(client, "h1", [rule("r1", ["rt1"])], NOW, NOW);
    expect(n).toBe(500);
    expect([...retired].sort()).toEqual(expected);
    // Chunked writes, none larger than 200 ids.
    const updates = calls.filter((c) => c.table === "pickup_event" && c.op === "update");
    expect(updates.length).toBe(3);
    for (const u of updates) {
      const ids = u.filters.find((f) => f.col === "id")?.value as string[];
      expect(ids.length).toBeLessThanOrEqual(200);
    }
  });

  it("gives the same answer from the in-memory snapshot as from the table", async () => {
    const events: Event[] = [];
    const snaps: Snap[] = [];
    for (let i = 0; i < 1200; i++) {
      const d = new Date(Date.UTC(2026, 7, 1) + i * 86_400_000).toISOString().slice(0, 10);
      events.push({ id: `e${i}`, rule_id: i % 2 ? "r1" : "r2", stay_date: d, signal_booked_units_start: i % 4, retired_at: null });
      snaps.push({ stay_date: d, room_type_id: "rt1", booked_units: i % 5 });
      snaps.push({ stay_date: d, room_type_id: "rt2", booked_units: i % 2 });
    }
    const rules = [rule("r1", ["rt1"]), rule("r2", ["rt1", "rt2"])];

    const fromTable = fakeSupabase(events.map((e) => ({ ...e })), snaps);
    await retireUndonePickupEvents(fromTable.client, "h1", rules, NOW, NOW);

    const inMemory = fakeSupabase(events.map((e) => ({ ...e })), []);
    const map = new Map(snaps.map((x) => [`${x.stay_date}|${x.room_type_id}`, x.booked_units]));
    await retireUndonePickupEvents(inMemory.client, "h1", rules, NOW, NOW, map);

    expect(inMemory.retired.length).toBeGreaterThan(0);
    expect([...inMemory.retired].sort()).toEqual([...fromTable.retired].sort());
    expect(inMemory.calls.some((c) => c.table === "stay_date_snapshot")).toBe(false);
  });

  it("retires nothing when the events read fails", async () => {
    const fake = sharedFake(
      { pickup_event: [{ id: "e1", hotel_id: "h1", rule_id: "r1", stay_date: "2026-09-01", signal_booked_units_start: 1, retired_at: null }] },
      { fault: (c) => (c.table === "pickup_event" && c.op === "select" ? { message: "timeout" } : null) },
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await retireUndonePickupEvents(fake.client, "h1", [rule("r1", ["rt1"])], NOW, NOW)).toBe(0);
    expect(fake.calls.some((c) => c.op === "update")).toBe(false);
    spy.mockRestore();
  });
});

describe("a whole run after a pickup increase's bookings cancel", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("takes the increase off in the same run, not the one after", async () => {
    resetBookingSpeedLogOnce();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const TODAY = "2026-09-16";
    const RT = "a0000000-0000-4000-8000-0000000000a1";
    const NIGHT = addDays(TODAY, 5);
    const HORIZON = 10;
    const t0 = Date.parse(`${TODAY}T12:00:00.000Z`);
    let n = 0;
    const booking = (stay: string, lead: number, bookedOn = addDays(stay, -lead)): FakeRow => ({
      id: `f0000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
      hotel_id: "h1",
      stay_date: stay,
      room_type_id: RT,
      booking_date: bookedOn,
      booking_window_days: lead,
      current_rate: 100,
      base_rate: 100,
      created_at: `${bookedOn}T10:00:00Z`,
    });
    // One booking a night from long ago; the baseline three days back saw one on NIGHT.
    const reservations = Array.from({ length: HORIZON }, (_, i) => booking(addDays(TODAY, i), 40));
    const baselineTs = new Date(t0 - 73 * 3_600_000).toISOString();
    const stay_date_snapshot = reservations.map((r) => ({
      hotel_id: "h1",
      snapshot_ts: baselineTs,
      stay_date: r.stay_date,
      room_type_id: RT,
      sellable_units: 20,
      booked_units: 1,
      booked_revenue: 100,
    }));
    // Then four arrive today.
    const surge = [0, 1, 2, 3].map(() => booking(NIGHT, 5, TODAY));
    const { client, tables } = sharedFake({
      hotels: [{ id: "h1", timezone: "UTC" }],
      room_types: [{ id: RT, hotel_id: "h1", name: "Standard", is_active: true, total_rooms: 20, floor_price: 10, ceiling_price: 5000, counts_as_room: true }],
      reservations: [...reservations, ...surge],
      base_rate_calendar: Array.from({ length: HORIZON }, (_, i) => ({ hotel_id: "h1", stay_date: addDays(TODAY, i), room_type_id: RT, price: 100 })),
      pricing_rules: [
        {
          id: "r-surge",
          hotel_id: "h1",
          name: "Surge",
          is_active: true,
          version: 1,
          priority: 100,
          start_date: null,
          end_date: null,
          is_annual: false,
          dow_mask: 127,
          action_type: "percent",
          action_direction: "increase",
          action_value: 15,
          is_pickup_rule: true,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          rule_condition: [{ pickup_operator: "gt", pickup_threshold: 3, pickup_window_days: 3, pickup_metric: "units" }],
          rule_signal_room_type: [{ room_type_id: RT }],
          rule_affected_room_type: [{ room_type_id: RT }],
        },
      ],
      stay_date_snapshot,
    });
    const priceOnNight = () => Number(tables.published_price.find((p) => p.stay_date === NIGHT && p.room_type_id === RT)?.price);
    const runAt = (minutes: number) => {
      const at = new Date(t0 + minutes * 60_000).toISOString();
      vi.setSystemTime(new Date(at));
      return evaluateHotel(client, "h1", at, HORIZON).then(() => at);
    };

    await runAt(0);
    expect(priceOnNight()).toBe(115);
    // Priced in the run that fired it, before anything could retire it.
    expect(tables.pickup_event.filter((e) => e.stay_date === NIGHT)).toEqual([
      expect.objectContaining({ signal_booked_units_start: 1, retired_at: null }),
    ]);

    // All four cancel before the next run.
    const gone = new Set(surge.map((b) => b.id));
    tables.reservations = tables.reservations.filter((r) => !gone.has(r.id));
    const second = await runAt(5);

    expect(priceOnNight()).toBe(100);
    expect(tables.pickup_event.filter((e) => e.stay_date === NIGHT)).toEqual([
      expect.objectContaining({ retired_at: second }),
    ]);
  }, 60_000);
});
