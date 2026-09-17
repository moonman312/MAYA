/**
 * room_types.counts_as_room: a court or meeting room configured as a room
 * type in the PMS must stay out of every room-count denominator (snapshots,
 * occupancy, Booking Speed capacity, new rules' default sets) while a rule
 * that lists it as AFFECTED keeps pricing it. null means unclassified and
 * counts, so an unmigrated or fresh import behaves exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateStarterRules } from "../../../supabase/functions/_shared/onboarding/generate-rules";
import { createRule } from "../rules-store";
import { loadBookingSpeedContext } from "./booking-speed-provider";
import { evaluateHotel } from "./evaluate";
import { FakeRpcError, fakeSupabase, missingFunction, type FakeRow } from "./fake-supabase.test";
import { scaleRpc } from "./scale-rpc-model.test";

const EVAL_TS = "2026-09-16T12:00:00Z";
const D0 = "2026-09-16";

function roomType(id: string, name: string, total_rooms: number, counts_as_room: boolean | null): FakeRow {
  return {
    id,
    hotel_id: "h1",
    name,
    is_active: true,
    total_rooms,
    floor_price: 10,
    ceiling_price: 1000,
    counts_as_room,
  };
}

function ladderRule(id: string, signal: string[], affected: string[], threshold = 0.75): FakeRow {
  return {
    id,
    hotel_id: "h1",
    name: `rule ${id}`,
    is_active: true,
    version: 1,
    priority: 100,
    start_date: null,
    end_date: null,
    is_annual: false,
    dow_mask: 127,
    action_type: "percent",
    action_direction: "increase",
    action_value: 10,
    is_pickup_rule: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    rule_condition: [{ occupancy_operator: "gt", occupancy_threshold: threshold }],
    rule_signal_room_type: signal.map((room_type_id) => ({ room_type_id })),
    rule_affected_room_type: affected.map((room_type_id) => ({ room_type_id })),
  };
}

function bookings(roomTypeId: string, n: number, rate: number): FakeRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${roomTypeId}-b${i}`,
    hotel_id: "h1",
    stay_date: D0,
    room_type_id: roomTypeId,
    base_rate: rate,
    current_rate: rate,
    created_at: "2026-09-01T00:00:00Z",
  }));
}

/**
 * 20 kings, 16 sold; a 5-unit "Court" that is not a room, unsold; 10 cabins
 * nobody has classified yet, unsold. Counting the court the hotel reads
 * 16/35; without it 16/30. The rule fires above 50%, so it fires only when
 * the court is out.
 */
function hotelSeed(): Record<string, FakeRow[]> {
  return {
    hotels: [{ id: "h1", timezone: "UTC" }],
    room_types: [
      roomType("rt1", "King", 20, true),
      roomType("rt2", "Court", 5, false),
      roomType("rt3", "Cabin", 10, null),
    ],
    reservations: bookings("rt1", 16, 100),
    published_price: [
      { id: "p2", hotel_id: "h1", stay_date: D0, room_type_id: "rt2", price: 40, base_price: 40 },
      { id: "p3", hotel_id: "h1", stay_date: D0, room_type_id: "rt3", price: 80, base_price: 80 },
    ],
  };
}

afterEach(() => vi.restoreAllMocks());

describe("counts_as_room in the engine", () => {
  it("keeps a non-room out of snapshots and occupancy but still prices it as an affected type", async () => {
    const { client, tables } = fakeSupabase({
      ...hotelSeed(),
      pricing_rules: [ladderRule("r1", ["rt1", "rt2", "rt3"], ["rt1", "rt2"], 0.5)],
    });

    const result = await evaluateHotel(client, "h1", EVAL_TS, 1);
    expect(result.stay_dates_evaluated).toBe(1);

    // Snapshot pass: the court never gets a row; the unclassified cabin does.
    const snapped = new Set(tables.stay_date_snapshot.map((s) => s.room_type_id));
    expect(snapped).toEqual(new Set(["rt1", "rt3"]));

    // 16/30 = 53% > 50%: the rule fires. With the court counted it is 46%.
    expect(result.ladder_activations).toBe(2);
    const price = (rt: string) => tables.published_price.find((p) => p.room_type_id === rt)!.price;
    expect(price("rt1")).toBe(110);
    // The court is AFFECTED, so it is priced. It just is not measured.
    expect(price("rt2")).toBe(44);

    // Explainability: what was dropped from the signal set, by name.
    const ev = tables.ladder_transition_event.find((e) => e.room_type_id === "rt1")!;
    expect((ev.metrics_snapshot as { excluded_from_occupancy?: string[] }).excluded_from_occupancy).toEqual(["Court"]);
    const audit = tables.evaluation_audit.find((a) => a.room_type_id === "rt1")!;
    const matched = (audit.details as { matched_ladder_rules: { metrics: Record<string, unknown> }[] })
      .matched_ladder_rules;
    expect(matched[0].metrics.excluded_from_occupancy).toEqual(["Court"]);
    expect(matched[0].metrics.occupancy).toBeCloseTo(16 / 30, 5);
  });

  // With nothing left to measure, its occupancy is null and the condition
  // cannot be met, so it never fires on an empty denominator.
  it("a rule whose only signal is a non-room never fires", async () => {
    const { client, tables } = fakeSupabase({
      ...hotelSeed(),
      pricing_rules: [ladderRule("r2", ["rt2"], ["rt1"], 0.0)],
    });
    const result = await evaluateHotel(client, "h1", EVAL_TS, 1);
    expect(result.ladder_activations).toBe(0);
    expect(tables.ladder_rule_state).toEqual([]);
    const audit = tables.evaluation_audit.find((a) => a.room_type_id === "rt1")!;
    // It was looked at (so the change log can say why nothing happened):
    // no occupancy to measure, and the name of what stopped counting.
    const matched = (audit.details as { matched_ladder_rules: { transition: string; metrics: Record<string, unknown> }[] })
      .matched_ladder_rules;
    expect(matched).toHaveLength(1);
    expect(matched[0].transition).toBe("noop");
    expect(matched[0].metrics.occupancy).toBeNull();
    expect(matched[0].metrics.excluded_from_occupancy).toEqual(["Court"]);
    expect(audit.final_price).toBe(100);
  });

  // Unlike a rule whose signals were all DEACTIVATED (out of scope, effects
  // untouched), one emptied by the room flag stays in scope: nobody paused it
  // and its affected rooms are still being priced, so a held effect has to
  // be able to let go. "Parking > 80% -> +10% on King" must not hold Kings
  // at +10% forever once Parking stops counting.
  it("a live effect held by a rule whose signals stopped counting is deactivated, not frozen", async () => {
    const { client, tables } = fakeSupabase({
      ...hotelSeed(),
      pricing_rules: [ladderRule("r4", ["rt2"], ["rt1"], 0.5)],
      ladder_rule_state: [
        {
          rule_id: "r4", rule_version: 1, stay_date: D0, room_type_id: "rt1", is_active: true,
          activated_at: "2026-09-01T00:00:00Z", deactivated_at: null,
          action_kind: "percent", action_direction: "increase", action_value: 10,
        },
      ],
    });
    const result = await evaluateHotel(client, "h1", EVAL_TS, 1);
    expect(result.ladder_deactivations).toBe(1);
    expect(tables.ladder_rule_state[0].is_active).toBe(false);
    // Base 100, no effect left: the Kings come back down.
    expect(tables.published_price.find((p) => p.room_type_id === "rt1")!.price).toBe(100);
    // The change log can say why: the transition carries what stopped counting.
    const ev = tables.ladder_transition_event.find((e) => e.room_type_id === "rt1")!;
    expect(ev.transition).toBe("deactivate");
    const metrics = ev.metrics_snapshot as { occupancy: number | null; excluded_from_occupancy?: string[] };
    expect(metrics.occupancy).toBeNull();
    expect(metrics.excluded_from_occupancy).toEqual(["Court"]);
  });

  // It used to read the hotel's pace instead, which is not what it was told
  // to measure.
  it("a Booking Speed rule whose only signal is a non-room is blocked, not read hotel-wide", async () => {
    const bsRule = (id: string, signal: string[]) => ({
      ...ladderRule(id, signal, ["rt1"]),
      rule_condition: [{ booking_speed_operator: "at_least", booking_speed_level: "stalled", booking_speed_window_days: 7 }],
    });
    const metricsOf = (tables: Record<string, FakeRow[]>) => {
      const audit = tables.evaluation_audit.find((a) => a.room_type_id === "rt1")!;
      return (audit.details as { matched_ladder_rules: { metrics: Record<string, unknown> }[] }).matched_ladder_rules[0]
        ?.metrics;
    };

    const court = fakeSupabase({ ...hotelSeed(), pricing_rules: [bsRule("r5", ["rt2"])] });
    const blocked = await evaluateHotel(court.client, "h1", EVAL_TS, 1);
    expect(blocked.ladder_activations).toBe(0);
    expect(metricsOf(court.tables)?.booking_speed_block_reason).toBe("insufficient_data");
    expect(metricsOf(court.tables)?.booking_speed ?? null).toBeNull();

    const king = fakeSupabase({ ...hotelSeed(), pricing_rules: [bsRule("r6", ["rt1"])] });
    const read = await evaluateHotel(king.client, "h1", EVAL_TS, 1);
    expect(read.ladder_activations).toBe(1);
    expect(metricsOf(king.tables)?.booking_speed).toBeTruthy();
  });

  it("does not annotate a rule that lost nothing", async () => {
    const { client, tables } = fakeSupabase({
      ...hotelSeed(),
      pricing_rules: [ladderRule("r3", ["rt1"], ["rt1"], 0.5)],
    });
    await evaluateHotel(client, "h1", EVAL_TS, 1);
    const ev = tables.ladder_transition_event[0];
    expect(ev.metrics_snapshot).not.toHaveProperty("excluded_from_occupancy");
  });
});

describe("counts_as_room in the rule builder", () => {
  function builderDb() {
    return fakeSupabase({
      room_types: [
        roomType("rt1", "King", 20, true),
        roomType("rt2", "Court", 5, false),
        roomType("rt3", "Cabin", 10, null),
      ],
    });
  }

  it("defaults signal and affected sets to counting types when resolved from names", async () => {
    const { client, tables } = builderDb();
    await createRule(
      {
        rule_name: "Busy",
        conditions: { occupancy_percentage: ">80" },
        action: { adjust_rate_percent: 10 },
        room_types: ["King", "Court", "Cabin"],
      },
      client,
      "h1",
    );
    expect(tables.rule_signal_room_type.map((r) => r.room_type_id).sort()).toEqual(["rt1", "rt3"]);
    expect(tables.rule_affected_room_type.map((r) => r.room_type_id).sort()).toEqual(["rt1", "rt3"]);
  });

  it("keeps an explicitly chosen affected set but still defaults signal to counting types", async () => {
    const { client, tables } = builderDb();
    await createRule(
      {
        rule_name: "Busy",
        conditions: { occupancy_percentage: ">80" },
        action: { adjust_rate_percent: 10 },
        room_types: [],
        affected_room_type_ids: ["rt1", "rt2"],
      },
      client,
      "h1",
    );
    expect(tables.rule_affected_room_type.map((r) => r.room_type_id).sort()).toEqual(["rt1", "rt2"]);
    expect(tables.rule_signal_room_type.map((r) => r.room_type_id)).toEqual(["rt1"]);
  });

  it("measures what it prices when the owner picks only non-rooms", async () => {
    // Ticking just the court is a decision to price it on its own occupancy.
    // Filtering the signal set to nothing would save an enabled rule that
    // never fires and never says why.
    const { client, tables } = builderDb();
    await createRule(
      {
        rule_name: "Court busy",
        conditions: { occupancy_percentage: ">80" },
        action: { adjust_rate_percent: 15 },
        room_types: [],
        affected_room_type_ids: ["rt2"],
      },
      client,
      "h1",
    );
    expect(tables.rule_affected_room_type.map((r) => r.room_type_id)).toEqual(["rt2"]);
    expect(tables.rule_signal_room_type.map((r) => r.room_type_id)).toEqual(["rt2"]);
  });

  it("an explicit signal set is taken as given", async () => {
    const { client, tables } = builderDb();
    await createRule(
      {
        rule_name: "Busy",
        conditions: { occupancy_percentage: ">80" },
        action: { adjust_rate_percent: 10 },
        room_types: [],
        affected_room_type_ids: ["rt1"],
        signal_room_type_ids: ["rt2"],
      },
      client,
      "h1",
    );
    expect(tables.rule_signal_room_type.map((r) => r.room_type_id)).toEqual(["rt2"]);
  });

  it("every type counts when the column is not there yet", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, tables } = fakeSupabase(
      {
        room_types: [
          { id: "rt1", hotel_id: "h1", name: "King", is_active: true },
          { id: "rt2", hotel_id: "h1", name: "Court", is_active: true },
        ],
      },
      {
        fault: (c) =>
          c.table === "room_types" && c.columns.includes("counts_as_room")
            ? { code: "42703", message: "column room_types.counts_as_room does not exist" }
            : null,
      },
    );
    await createRule(
      {
        rule_name: "Busy",
        conditions: { occupancy_percentage: ">80" },
        action: { adjust_rate_percent: 10 },
        room_types: ["King", "Court"],
      },
      client,
      "h1",
    );
    expect(tables.rule_signal_room_type.map((r) => r.room_type_id).sort()).toEqual(["rt1", "rt2"]);
    expect(err.mock.calls.some((c) => String(c[0]).includes("99_supabase_migration_room_type_counts_as_room_v1.sql"))).toBe(true);
  });
});

describe.each([
  ["migrated", { rpc: scaleRpc }],
  ["pre-migration", { rpc: () => new FakeRpcError(missingFunction("booking_speed_history_summary")) }],
] as const)("counts_as_room in Booking Speed (%s)", (_label, opts) => {
  // Capacity is summed over counting types only, so the booking history has
  // to be too: six court slots a night against a 20-room capacity would read
  // as the hotel filling up. A row with no room type is kept — no evidence
  // it was not a room.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("drops non-room bookings from the pace history but keeps unmapped ones", async () => {
    const row = (id: string, stay_date: string, room_type_id: string | null) => ({
      id, hotel_id: "h1", stay_date, room_type_id, booking_date: "2025-08-01", booking_window_days: 30,
    });
    const { client } = fakeSupabase(
      {
        reservations: [
          row("a", "2025-09-01", "rt1"),
          row("b", "2025-09-01", "rt2"),
          row("c", "2025-09-01", "rt2"),
          row("d", "2025-09-02", null),
          row("e", "2025-09-02", "rt3"),
        ],
      },
      opts,
    );
    const ctx = await loadBookingSpeedContext(client, "h1", D0, 30, new Set(["rt2"]));
    expect(ctx).not.toBeNull();
    const history = new Map(ctx!.dailyDemand.map((d) => [d.stay_date, d.value]));
    expect(history.get("2025-09-01")).toBe(1);
    expect(history.get("2025-09-02")).toBe(2);
  });

  it("keeps every booking when nothing is excluded", async () => {
    const { client } = fakeSupabase(
      {
        reservations: [
          { id: "a", hotel_id: "h1", stay_date: "2025-09-01", room_type_id: "rt2", booking_date: "2025-08-01", booking_window_days: 30 },
        ],
      },
      opts,
    );
    const ctx = await loadBookingSpeedContext(client, "h1", D0, 30);
    const history = new Map(ctx!.dailyDemand.map((d) => [d.stay_date, d.value]));
    expect(history.get("2025-09-01")).toBe(1);
  });
});

describe("counts_as_room in starter rules", () => {
  const history = Array.from({ length: 90 }, (_, i) => ({
    stay_date: `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, "0")}`,
    room_nights: 5,
  }));

  it("joins only counting types into both sets", async () => {
    const { client, tables } = fakeSupabase(
      {
        room_types: [
          roomType("rt1", "King", 20, true),
          roomType("rt2", "Court", 5, false),
          roomType("rt3", "Cabin", 10, null),
        ],
      },
      { rpc: () => history },
    );
    const specs = await generateStarterRules(client, "h1");
    expect(specs.length).toBeGreaterThan(0);
    const perRule = (t: FakeRow[]) => new Set(t.map((r) => r.room_type_id));
    expect(perRule(tables.rule_signal_room_type)).toEqual(new Set(["rt1", "rt3"]));
    expect(perRule(tables.rule_affected_room_type)).toEqual(new Set(["rt1", "rt3"]));
  });

  it("falls back to every active type before the migration", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, tables } = fakeSupabase(
      {
        room_types: [
          { id: "rt1", hotel_id: "h1", name: "King", is_active: true },
          { id: "rt2", hotel_id: "h1", name: "Court", is_active: true },
        ],
      },
      {
        rpc: () => history,
        fault: (c) =>
          c.table === "room_types" && c.columns.includes("counts_as_room")
            ? { code: "42703", message: "column room_types.counts_as_room does not exist" }
            : null,
      },
    );
    const specs = await generateStarterRules(client, "h1");
    expect(specs.length).toBeGreaterThan(0);
    expect(new Set(tables.rule_signal_room_type.map((r) => r.room_type_id))).toEqual(new Set(["rt1", "rt2"]));
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain("99_supabase_migration_room_type_counts_as_room_v1.sql");
  });
});
