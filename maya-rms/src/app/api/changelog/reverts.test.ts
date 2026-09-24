/**
 * Runs that put a night's price back to its base, through the real engine
 * and then the real change log route, on the same in-memory database.
 *
 * The engine writes an audit row only when a night's outcome changes, so a
 * row at its base with nothing on it nearly always means a price moved back:
 * a rule came off, a raise came off because its bookings cancelled, a price
 * set by hand was cleared. Measured against the base such a row changed
 * nothing, and the log used to fold those runs into "nothing needed to
 * change" lines. Each is shown in full now, from the price it moved from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import { resetPriorRowsLogOnce } from "@/lib/changelog-prior-rows";
import { evaluateHotel } from "@/lib/engine/evaluate";
import { resetBookingSpeedLogOnce } from "@/lib/engine/booking-speed-provider";
import { FakeRpcError, fakeSupabase, missingFunction, type FakeRow } from "@/lib/engine/fake-supabase.test";

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.client }));
vi.mock("@/utils/supabase/admin", () => ({ isAdminConfigured: () => false, createAdminClient: () => null }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => "h1" }));

const { GET } = await import("./route");

const D0 = "2026-09-20";
const T0 = Date.parse(`${D0}T08:00:00.000Z`);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const STD = "a0000000-0000-4000-8000-0000000000a1";
const NIGHT = addDays(D0, 10);
const HORIZON = 14;
const iso = (ms: number) => new Date(ms).toISOString();

let resId = 0;
function booking(bookedOn: string): FakeRow {
  return {
    id: `f0000000-0000-4000-8000-${String(++resId).padStart(12, "0")}`,
    hotel_id: "h1",
    stay_date: NIGHT,
    room_type_id: STD,
    booking_date: bookedOn,
    booking_window_days: Math.round((Date.parse(NIGHT) - Date.parse(bookedOn)) / DAY),
    current_rate: 100,
    base_rate: 100,
    created_at: `${bookedOn}T06:00:00.000Z`,
  };
}
const bookings = (n: number, bookedOn: string) => Array.from({ length: n }, () => booking(bookedOn));

function rule(id: string, name: string, condition: FakeRow, isPickup: boolean): FakeRow {
  return {
    id,
    hotel_id: "h1",
    name,
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
    is_pickup_rule: isPickup,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    rule_condition: [condition],
    rule_signal_room_type: [{ room_type_id: STD }],
    rule_affected_room_type: [{ room_type_id: STD }],
  };
}

function world(opts: { rules: FakeRow[]; reservations: FakeRow[]; manual?: FakeRow[]; rpc?: Parameters<typeof fakeSupabase>[1] }) {
  const nights = Array.from({ length: HORIZON }, (_, i) => addDays(D0, i));
  // Snapshots every 6 hours over the 10 days before the first run, from the
  // bookings made by then: a pickup rule's window has somewhere to start.
  const snapshots: FakeRow[] = [];
  for (let h = 10 * 24; h > 0; h -= 6) {
    const ts = iso(T0 - h * HOUR);
    for (const stay of nights) {
      const n = opts.reservations.filter((r) => r.stay_date === stay && `${r.created_at}` <= ts).length;
      snapshots.push({ hotel_id: "h1", snapshot_ts: ts, stay_date: stay, room_type_id: STD, sellable_units: 10, booked_units: n, booked_revenue: n * 100 });
    }
  }
  const fake = fakeSupabase(
    {
      hotels: [{ id: "h1", timezone: "UTC", currency: "USD" }],
      room_types: [
        { id: STD, hotel_id: "h1", name: "Standard", is_active: true, total_rooms: 10, floor_price: 10, ceiling_price: 5000, counts_as_room: true },
      ],
      reservations: opts.reservations,
      base_rate_calendar: Array.from({ length: HORIZON + 5 }, (_, i) => ({ hotel_id: "h1", stay_date: addDays(D0, i), room_type_id: STD, price: 100 })),
      pricing_rules: opts.rules,
      stay_date_snapshot: snapshots,
      manual_price: opts.manual ?? [],
    },
    opts.rpc,
  );
  const run = async (atMs: number) => {
    vi.setSystemTime(new Date(atMs));
    await evaluateHotel(fake.client, "h1", iso(atMs), HORIZON);
  };
  const price = () => Number(fake.tables.published_price.find((p) => p.stay_date === NIGHT && p.room_type_id === STD)?.price);
  const changelog = async () => {
    state.client = Object.assign(fake.client, { auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } });
    const res = await GET();
    expect(res.status).toBe(200);
    return (await res.json()) as FakeRow[];
  };
  return { ...fake, run, price, changelog };
}

/** Each item as one line: a quiet stretch by its count and ends, a run by its time. */
const shape = (body: FakeRow[]) =>
  body.map((i) => (i.kind === "quiet_checks" ? `${i.checks} quiet ${i.first_at} to ${i.timestamp}` : `run ${i.timestamp}`));

const at = (m: number) => iso(T0 + m * MIN);

beforeEach(() => {
  resId = 0;
  resetBookingSpeedLogOnce();
  resetPriorRowsLogOnce();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("change log: a run that put a price back to base is a change", () => {
  it("shows a rule that came off, from the price the night had", async () => {
    const busy = rule("r-busy", "Busy", { occupancy_operator: "gt", occupancy_threshold: 0.5 }, false);
    const six = bookings(6, addDays(D0, -5));
    const w = world({ rules: [busy], reservations: six });
    await w.run(T0);
    expect(w.price()).toBe(110);
    for (const m of [5, 10]) await w.run(T0 + m * MIN);
    // Two cancel: 40% full, under the rule's 50%.
    const gone = new Set(six.slice(0, 2).map((r) => r.id));
    w.tables.reservations = w.tables.reservations.filter((r) => !gone.has(r.id));
    for (const m of [15, 20, 25]) await w.run(T0 + m * MIN);
    expect(w.price()).toBe(100);

    const body = await w.changelog();
    expect(shape(body)).toEqual([
      `2 quiet ${at(20)} to ${at(25)}`,
      `run ${at(15)}`,
      `2 quiet ${at(5)} to ${at(10)}`,
      `run ${at(0)}`,
    ]);
    expect(body[1]).toMatchObject({ has_changes: true });
    expect((body[1].changes as FakeRow[])[0]).toMatchObject({
      room_type: "Standard",
      stay_date: NIGHT,
      rule_name: "Busy",
      original_rate: 110,
      new_rate: 100,
      change_pct: -9.1,
      narrative: [
        '"Busy" stopped applying an earlier 10% raise here: this night no longer met its conditions.',
        "That took this night from $110.00 to $100.00.",
      ],
    });
  }, 60_000);

  it("shows a raise that came off because its bookings cancelled", async () => {
    const pickup = rule(
      "r-pickup",
      "Pickup",
      { pickup_operator: "gt", pickup_threshold: 3, pickup_window_days: 3, pickup_metric: "room_nights" },
      true,
    );
    const burst = bookings(5, D0);
    const w = world({ rules: [pickup], reservations: burst });
    await w.run(T0);
    expect(w.price()).toBe(110);
    await w.run(T0 + 5 * MIN);
    w.tables.reservations = [];
    for (const m of [10, 15, 20]) await w.run(T0 + m * MIN);
    expect(w.price()).toBe(100);

    const body = await w.changelog();
    expect(shape(body)).toEqual([`2 quiet ${at(15)} to ${at(20)}`, `run ${at(10)}`, `1 quiet ${at(5)} to ${at(5)}`, `run ${at(0)}`]);
    expect((body[1].changes as FakeRow[])[0]).toMatchObject({
      rule_name: "Pickup",
      original_rate: 110,
      new_rate: 100,
      narrative: [
        '"Pickup" stopped applying an earlier 10% raise here: enough of the bookings behind it cancelled.',
        "That took this night from $110.00 to $100.00.",
      ],
    });
  }, 60_000);

  it("shows a price set by hand being cleared", async () => {
    const manual = { hotel_id: "h1", stay_date: NIGHT, room_type_id: STD, price: 150, set_by: "u1", set_at: iso(T0 - MIN), cleared_at: null as string | null };
    const w = world({ rules: [], reservations: [], manual: [manual] });
    await w.run(T0);
    expect(w.price()).toBe(150);
    await w.run(T0 + 5 * MIN);
    w.tables.manual_price[0].cleared_at = iso(T0 + 7 * MIN);
    for (const m of [10, 15, 20]) await w.run(T0 + m * MIN);
    expect(w.price()).toBe(100);

    const body = await w.changelog();
    expect(shape(body)).toEqual([`2 quiet ${at(15)} to ${at(20)}`, `run ${at(10)}`, `1 quiet ${at(5)} to ${at(5)}`, `run ${at(0)}`]);
    expect((body[1].changes as FakeRow[])[0]).toMatchObject({
      rule_name: "Manual price cleared",
      original_rate: 150,
      new_rate: 100,
      narrative: ["The price set by hand was cleared.", "That took this night from $150.00 to $100.00."],
    });
  }, 60_000);

  it("reads each run's nights before it in one call, and still folds a run whose rows changed nothing", async () => {
    // Every night in the horizon gets its first row on the first run: at its
    // base with nothing before it, which is not a change.
    const w = world({ rules: [], reservations: [] });
    await w.run(T0);
    await w.run(T0 + 5 * MIN);
    const body = await w.changelog();
    expect(shape(body)).toEqual([`2 quiet ${at(0)} to ${at(5)}`]);
    const priorReads = w.calls.filter((c) => c.table === "rpc:audit_rows_before");
    expect(priorReads).toHaveLength(1);
    expect((priorReads[0].payload as { p_stay_dates: string[] }).p_stay_dates).toHaveLength(HORIZON);
  }, 60_000);

  it("before the migration, still shows a raise that came off, and says once what it can't read", async () => {
    const pickup = rule(
      "r-pickup",
      "Pickup",
      { pickup_operator: "gt", pickup_threshold: 3, pickup_window_days: 3, pickup_metric: "room_nights" },
      true,
    );
    const w = world({
      rules: [pickup],
      reservations: bookings(5, D0),
      rpc: { rpc: (fn: string) => (fn === "audit_rows_before" ? new FakeRpcError(missingFunction(fn)) : undefined) },
    });
    await w.run(T0);
    w.tables.reservations = [];
    await w.run(T0 + 10 * MIN);
    expect(w.price()).toBe(100);
    const body = await w.changelog();
    expect(shape(body)).toEqual([`run ${at(10)}`, `run ${at(0)}`]);
    expect((body[0].changes as FakeRow[])[0].narrative).toEqual([
      '"Pickup" stopped applying an earlier 10% raise here: enough of the bookings behind it cancelled.',
    ]);
    const lines = vi.mocked(console.error).mock.calls.filter((c) => String(c[0]).includes("audit_rows_before"));
    expect(lines).toHaveLength(1);
    expect(String(lines[0][0])).toContain("99_supabase_migration_pickup_wait_v1.sql");
  }, 60_000);
});
