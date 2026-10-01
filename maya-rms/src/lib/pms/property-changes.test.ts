/**
 * What the syncs do with the database's answers about the property itself
 * (supabase/functions/_shared/pms/property-changes.ts): which room types were
 * switched off or back on, the time zone saved, a currency never changed on a
 * live property and never saved when MAYA does not price in it, staff told
 * when something needs a person, and a database without the functions yet
 * changing nothing and failing nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  reconcileListedRoomTypes,
  refreshPropertyDetails,
  sameTimeZone,
} from "../../../supabase/functions/_shared/pms/property-changes";
import { roomTypeLabel, roomTypeNames } from "../../../supabase/functions/_shared/pms/room-type-label";
import { FakeRpcError, fakeSupabase, missingFunction, type FakeRow } from "../engine/fake-supabase.test";

const HOTEL = "hotel-1";

function db(answers: Record<string, unknown>, seed: Record<string, FakeRow[]> = {}) {
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  const made = fakeSupabase(
    { platform_audit_events: [], hotels: [{ id: HOTEL, currency: "USD", timezone: "UTC" }], ...seed },
    {
      rpc: (fn, args) => {
        rpcCalls.push({ fn, args: args as Record<string, unknown> });
        if (fn === "platform_log_event") return "ev";
        return fn in answers ? answers[fn] : null;
      },
    },
  );
  return { ...made, rpcCalls };
}

beforeEach(() => {
  process.env.MAYA_ALERT_WEBHOOK = "https://hooks.example.com/abc";
  process.env.MAYA_ALERT_MIN_SEVERITY = "warn";
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.MAYA_ALERT_WEBHOOK;
  delete process.env.MAYA_ALERT_MIN_SEVERITY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const alertsSent = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String((c[1] as { body?: string })?.body ?? ""));

describe("room types the property system no longer lists", () => {
  it("passes the ids the read listed and whether it may switch any off, and names what changed", async () => {
    const made = db({
      pms_room_types_reconcile: [
        { change: "removed", room_type_id: "rt-q", room_type_name: "Harbour Double Deluxe" },
        { change: "back", room_type_id: "rt-s", room_type_name: "Juniper Suite" },
      ],
    });
    const out = await reconcileListedRoomTypes(made.client, HOTEL, "cloudbeds", ["RT-K", "RT-S", "RT-K", ""], true);
    expect(out).toEqual({ removed: ["Harbour Double Deluxe"], back: ["Juniper Suite"], kept: [] });
    expect(made.rpcCalls).toEqual([
      { fn: "pms_room_types_reconcile", args: { p_hotel_id: HOTEL, p_pms_type: "cloudbeds", p_listed: ["RT-K", "RT-S"], p_remove: true } },
    ]);
    expect(alertsSent()).toEqual([]);
  });

  it("asks nothing of the database for an empty read", async () => {
    const made = db({ pms_room_types_reconcile: [] });
    expect(await reconcileListedRoomTypes(made.client, HOTEL, "cloudbeds", [], true)).toEqual({ removed: [], back: [], kept: [] });
    expect(made.rpcCalls).toEqual([]);
  });

  it("tells MAYA staff when a full read listed none of the property's types, and switches nothing off", async () => {
    const made = db({
      pms_room_types_reconcile: [
        { change: "kept", room_type_id: "rt-k", room_type_name: "Harbour Double" },
        { change: "kept", room_type_id: "rt-q", room_type_name: "Harbour Double Deluxe" },
      ],
    });
    const out = await reconcileListedRoomTypes(made.client, HOTEL, "cloudbeds", ["X-1"], true);
    expect(out.kept).toEqual(["Harbour Double", "Harbour Double Deluxe"]);
    expect(out.removed).toEqual([]);
    expect(alertsSent()).toHaveLength(1);
    expect(alertsSent()[0]).toContain("listed none of the property's room types");
    expect(alertsSent()[0]).toContain("Harbour Double, Harbour Double Deluxe");
  });

  it("changes nothing and fails nothing before the migration, or when the call fails", async () => {
    const missing = db({ pms_room_types_reconcile: new FakeRpcError(missingFunction("pms_room_types_reconcile")) });
    expect(await reconcileListedRoomTypes(missing.client, HOTEL, "cloudbeds", ["RT-K"], true)).toEqual({ removed: [], back: [], kept: [] });
    expect(String((console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain(
      "99_supabase_migration_pms_property_changes_v1.sql",
    );
    const broken = db({ pms_room_types_reconcile: new FakeRpcError({ message: "timeout" }) });
    expect(await reconcileListedRoomTypes(broken.client, HOTEL, "cloudbeds", ["RT-K"], true)).toEqual({ removed: [], back: [], kept: [] });
  });
});

describe("the time zone and currency", () => {
  it("passes what the system reports and says what was saved", async () => {
    const made = db({ pms_property_details_refresh: [{ change: "timezone", before_value: "UTC", after_value: "America/Chicago" }] });
    const out = await refreshPropertyDetails(made.client, HOTEL, "cloudbeds", { timezone: "America/Chicago", currency: "usd" });
    expect(out).toEqual({ timezone: { from: "UTC", to: "America/Chicago" }, currency: null, currencyHeld: null });
    expect(made.rpcCalls[0]).toEqual({
      fn: "pms_property_details_refresh",
      args: { p_hotel_id: HOTEL, p_pms_type: "cloudbeds", p_timezone: "America/Chicago", p_currency: "USD" },
    });
    expect(alertsSent()).toEqual([]);
  });

  it("asks nothing when the system reported neither", async () => {
    const made = db({ pms_property_details_refresh: [] });
    expect(await refreshPropertyDetails(made.client, HOTEL, "cloudbeds", { timezone: null, currency: " " })).toEqual({
      timezone: null,
      currency: null,
      currencyHeld: null,
    });
    expect(made.rpcCalls).toEqual([]);
  });

  it("raises a live property's different currency with MAYA staff as critical, and changes nothing", async () => {
    delete process.env.MAYA_ALERT_MIN_SEVERITY;
    const made = db({ pms_property_details_refresh: [{ change: "currency_kept", before_value: "USD", after_value: "EUR" }] });
    const out = await refreshPropertyDetails(made.client, HOTEL, "cloudbeds", { timezone: null, currency: "EUR" });
    expect(out.currencyHeld).toEqual({ from: "USD", to: "EUR", why: "live" });
    expect(out.currency).toBeNull();
    expect(alertsSent()).toHaveLength(1);
    expect(alertsSent()[0]).toContain("now reports EUR");
  });

  it("never saves a currency MAYA does not price in, and says so when it differs", async () => {
    const made = db({ pms_property_details_refresh: [] });
    const out = await refreshPropertyDetails(made.client, HOTEL, "cloudbeds", { timezone: "America/Chicago", currency: "JPY" });
    expect(made.rpcCalls.find((c) => c.fn === "pms_property_details_refresh")?.args).toMatchObject({ p_currency: null });
    expect(out.currencyHeld).toEqual({ from: "USD", to: "JPY", why: "unsupported" });
    expect(alertsSent()[0]).toContain("which MAYA does not price in");
  });

  it("takes another name for the zone the hotel has as no change: no line, no re-price", async () => {
    for (const [stored, reported] of [
      ["America/Indiana/Indianapolis", "America/Indianapolis"],
      ["America/Indianapolis", "America/Indiana/Indianapolis"],
      ["Asia/Calcutta", "Asia/Kolkata"],
      ["Europe/Kyiv", "Europe/Kiev"],
    ]) {
      const made = db({ pms_property_details_refresh: [] }, { hotels: [{ id: HOTEL, currency: "USD", timezone: stored }] });
      const out = await refreshPropertyDetails(made.client, HOTEL, "cloudbeds", { timezone: reported, currency: "USD" });
      expect(out.timezone).toBeNull();
      expect(made.rpcCalls.find((c) => c.fn === "pms_property_details_refresh")?.args).toMatchObject({ p_timezone: null, p_currency: "USD" });
    }
  });

  it("still passes a real change of zone, and the same name as stored, through to the database", async () => {
    const moved = db({ pms_property_details_refresh: [] }, { hotels: [{ id: HOTEL, currency: "USD", timezone: "Asia/Kolkata" }] });
    await refreshPropertyDetails(moved.client, HOTEL, "cloudbeds", { timezone: "America/Chicago", currency: null });
    expect(moved.rpcCalls[0].args).toMatchObject({ p_timezone: "America/Chicago" });
    const same = db({ pms_property_details_refresh: [] }, { hotels: [{ id: HOTEL, currency: "USD", timezone: "Asia/Kolkata" }] });
    await refreshPropertyDetails(same.client, HOTEL, "cloudbeds", { timezone: "Asia/Kolkata", currency: null });
    expect(same.rpcCalls[0].args).toMatchObject({ p_timezone: "Asia/Kolkata" });
  });

  it("changes nothing and fails nothing before the migration", async () => {
    const made = db({ pms_property_details_refresh: new FakeRpcError(missingFunction("pms_property_details_refresh")) });
    expect(await refreshPropertyDetails(made.client, HOTEL, "cloudbeds", { timezone: "America/Chicago", currency: "USD" })).toEqual({
      timezone: null,
      currency: null,
      currencyHeld: null,
    });
  });
});

describe("a room type's name", () => {
  it("shows the full name, and tests both for the word that says it is not a bedroom", () => {
    expect(roomTypeLabel({ name: "Harbour Double", display_name: "DBL" })).toBe("Harbour Double");
    expect(roomTypeLabel({ name: " ", display_name: "Harbour Double" })).toBe("Harbour Double");
    expect(roomTypeLabel(null)).toBe("");
    expect(roomTypeNames({ name: "Board Room", display_name: "Boardroom" })).toEqual(["Board Room", "Boardroom"]);
    expect(roomTypeNames({ name: "King", display_name: "King" })).toEqual(["King"]);
  });
});

describe("sameTimeZone", () => {
  it("is one zone under two spellings, and not two different zones or a name nothing knows", () => {
    expect(sameTimeZone("Asia/Kolkata", "Asia/Calcutta")).toBe(true);
    expect(sameTimeZone("America/Indiana/Indianapolis", "America/Indianapolis")).toBe(true);
    expect(sameTimeZone("US/Central", "America/Chicago")).toBe(true);
    expect(sameTimeZone("America/Chicago", "America/Denver")).toBe(false);
    expect(sameTimeZone("Not/AZone", "Not/AZone")).toBe(true);
    expect(sameTimeZone("Not/AZone", "America/Chicago")).toBe(false);
    expect(sameTimeZone(null, "UTC")).toBe(false);
  });
});
