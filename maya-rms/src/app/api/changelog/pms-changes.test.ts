/**
 * Rates changed in the property system, in the change log: one item per
 * night and room type MAYA sends its price to again under "MAYA's price wins"
 * (naming the night, the room type, the property system's rate or that it was
 * removed, and MAYA's price, sent only when the send ledger says so), and the warning that something other than MAYA
 * seems to be changing rates, with a button to the setting. Each sits where
 * it was found. A database without the table yet shows none and never fails
 * the log.
 */
import { describe, expect, it, vi } from "vitest";
import { buildPmsChanges, MAX_PMS_CHANGES, moreTitle, otherToolTitle, overwriteTitle, type PmsChangeRow } from "@/lib/changelog-pms-changes";
import { fakeSupabase as sharedFake, missingRelation } from "@/lib/engine/fake-supabase.test";

type Row = Record<string, unknown>;

function fakeSupabase(seed: Record<string, Row[]> = {}, opts: { missing?: string[] } = {}) {
  const fake = sharedFake(seed, {
    fault: (c) => (c.op === "select" && opts.missing?.includes(c.table) ? missingRelation(c.table) : null),
  });
  const client = Object.assign(fake.client, {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls: fake.calls };
}

const HOTEL = "hotel-1";
const state = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("server-only", () => ({}));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.client }));
vi.mock("@/utils/supabase/admin", () => ({ isAdminConfigured: () => false, createAdminClient: () => null }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => HOTEL }));

const { GET } = await import("./route");

const RUN_AT = "2026-10-05T08:00:00Z";

const notice = (id: string, foundAt: string, over: Row = {}): Row => ({
  id, hotel_id: HOTEL, pms_type: "cloudbeds", kind: "overwrite", found_at: foundAt, stay_date: "2026-11-13", room_type_id: "rt-1",
  pms_rate: 175, maya_price: 165, rates: null, emailed_at: null, ...over,
});

function seed(extra: Record<string, Row[]> = {}, opts: { missing?: string[] } = {}) {
  return fakeSupabase(
    {
      evaluation_audit: [
        {
          id: "audit-1", hotel_id: HOTEL, evaluation_run_id: "run-1", stay_date: "2026-11-13", room_type_id: "rt-1", evaluated_at: RUN_AT,
          base_price: 180, final_price: 180, pre_clamp_price: 180, floor_price: 80, ceiling_price: 400,
          details: { application_order: [], base_source: "manual", manual_override: { set_by: "user-2", set_at: "2026-10-05T07:59:00Z" } },
        },
      ],
      hotels: [{ id: HOTEL, currency: "USD" }],
      hotel_settings: [{ hotel_id: HOTEL, simulation_mode: false, pms_rate_changes: "keep" }],
      room_types: [{ id: "rt-1", hotel_id: HOTEL, name: "Standard" }, { id: "rt-2", hotel_id: HOTEL, name: "Suite" }],
      pricing_rules: [],
      evaluation_run_log: [{ hotel_id: HOTEL, evaluation_run_id: "run-1", evaluated_at: RUN_AT, cells_changed: 1 }],
      ...extra,
    },
    opts,
  );
}

describe("the items", () => {
  const names = new Map([["rt-1", "Standard"]]);
  const row = (id: string, over: Partial<PmsChangeRow> = {}): PmsChangeRow => ({
    id, pms_type: "cloudbeds", kind: "overwrite", found_at: "2026-10-05T10:00:00Z", stay_date: "2026-11-13", room_type_id: "rt-1",
    pms_rate: "175.00", maya_price: "165.00", rates: null, ...over,
  });

  it("names the night, the room type, the rate there or that it was removed, and MAYA's price", () => {
    const items = buildPmsChanges(
      [row("a"), row("b", { pms_rate: null, found_at: "2026-10-05T11:00:00Z", pms_type: "think" })],
      { roomTypeNames: names, currencySymbol: "$", settingOn: true, sendStates: new Map([["a", "sent"], ["b", "sent"]]) },
    );
    expect(items.map((i) => i.title)).toEqual([
      "Fri, Nov 13, Standard: the rate was removed in Think Reservations. MAYA sent its price, $165.00, again.",
      "Fri, Nov 13, Standard: changed in Cloudbeds to $175.00. MAYA sent its price, $165.00, again.",
    ]);
    expect(items[1]).toMatchObject({ kind: "pms_change", change: "overwrite", pms: "Cloudbeds", stay_date: "2026-11-13", room_type: "Standard", pms_rate: 175, maya_price: 165 });
  });

  it("warns in plain words, and has nothing to open once MAYA's price wins is on", () => {
    const warn = row("w", { kind: "other_tool", stay_date: null, room_type_id: null, pms_rate: null, maya_price: null, rates: 34 });
    const [off] = buildPmsChanges([warn], { roomTypeNames: names, currencySymbol: "$", settingOn: false });
    expect(off.title).toBe(otherToolTitle("Cloudbeds", 34));
    expect(off.title).toBe(
      "Something other than MAYA seems to be changing rates in Cloudbeds: 34 rates changed in the last 7 days on nights MAYA had sent a price to. " +
        "Each change is kept as your price, so MAYA isn't pricing those nights. If you use another pricing tool, turn on \"MAYA's price wins\".",
    );
    expect(off).not.toHaveProperty("setting_on");
    expect(buildPmsChanges([warn], { roomTypeNames: names, currencySymbol: "$", settingOn: true })[0].setting_on).toBe(true);
  });

  it("says MAYA's price went out again only when the send ledger shows it", () => {
    const title = (sent: Parameters<typeof overwriteTitle>[0]["sent"]) =>
      overwriteTitle({ pms: "Cloudbeds", night: "2026-11-13", roomType: "Standard", pmsRate: 175, mayaPrice: 165, currencySymbol: "$", sent });
    expect(title("sent")).toBe("Fri, Nov 13, Standard: changed in Cloudbeds to $175.00. MAYA sent its price, $165.00, again.");
    expect(title("waiting")).toBe("Fri, Nov 13, Standard: changed in Cloudbeds to $175.00. MAYA's price, $165.00, is waiting to be sent again.");
    expect(title("failed")).toBe("Fri, Nov 13, Standard: changed in Cloudbeds to $175.00. MAYA's price, $165.00, couldn't be sent again.");
    expect(title("held")).toBe("Fri, Nov 13, Standard: changed in Cloudbeds to $175.00. MAYA's price, $165.00, was held back, not sent.");
    expect(title(null)).toBe("Fri, Nov 13, Standard: changed in Cloudbeds to $175.00. MAYA's price, $165.00, was due to go out again.");
    // Built without the ledger's word, nothing is claimed.
    expect(buildPmsChanges([row("a")], { roomTypeNames: names, currencySymbol: "$", settingOn: true })[0].title).toBe(title(null));
  });

  it("lists the newest overwrites and counts the rest on one line, without claiming they went", () => {
    const rows = Array.from({ length: MAX_PMS_CHANGES }, (_, i) => row(`r${i}`, { found_at: new Date(Date.parse("2026-10-05T00:00:00Z") + i * 60_000).toISOString() }));
    const items = buildPmsChanges(rows, { roomTypeNames: names, currencySymbol: "$", settingOn: true, overwriteTotal: MAX_PMS_CHANGES + 7 });
    expect(items).toHaveLength(MAX_PMS_CHANGES + 1);
    expect(items.at(-1)).toMatchObject({ change: "more", count: 7, title: moreTitle("Cloudbeds", 7), timestamp: items.at(-2)!.timestamp });
    expect(moreTitle("Cloudbeds", 7)).toBe("And 7 more times MAYA's price was due to go out again over a rate changed in Cloudbeds.");
    expect(moreTitle("Cloudbeds", 1)).toBe("And 1 more time MAYA's price was due to go out again over a rate changed in Cloudbeds.");
  });

  it("lists a warning whatever the overwrites around it, and never counts it as one", () => {
    const warn = row("w", { kind: "other_tool", stay_date: null, room_type_id: null, pms_rate: null, maya_price: null, rates: 34, found_at: "2026-10-04T00:00:00Z" });
    const rows = Array.from({ length: MAX_PMS_CHANGES }, (_, i) => row(`r${i}`, { found_at: new Date(Date.parse("2026-10-05T00:00:00Z") + i * 60_000).toISOString() }));
    const items = buildPmsChanges([...rows, warn], { roomTypeNames: names, currencySymbol: "$", settingOn: false, overwriteTotal: MAX_PMS_CHANGES + 3 });
    expect(items.filter((i) => i.change === "other_tool")).toHaveLength(1);
    expect(items.filter((i) => i.change === "overwrite")).toHaveLength(MAX_PMS_CHANGES);
    const more = items.find((i) => i.change === "more")!;
    expect(more).toMatchObject({ count: 3 });
    // Where the oldest listed overwrite sits, not the older warning.
    expect(more.timestamp).toBe(rows[0].found_at);
  });

  it("never uses an em dash", () => {
    for (const t of [overwriteTitle({ pms: "Cloudbeds", night: "2026-11-13", roomType: "Standard", pmsRate: null, mayaPrice: 1, currencySymbol: "$" }), otherToolTitle("Cloudbeds", 1), moreTitle("Cloudbeds", 1)]) {
      expect(t).not.toMatch(/—/);
    }
  });
});

describe("GET /api/changelog with rates changed in the property system", () => {
  it("puts each overwrite and the warning where they were found", async () => {
    state.client = seed({
      pms_change_notices: [
        notice("n1", "2026-10-05T09:00:00Z"),
        notice("n2", "2026-10-05T08:30:00Z", { room_type_id: "rt-2", pms_rate: null, maya_price: 240 }),
        // Before the oldest run the log covers: not in it.
        notice("n0", "2026-10-05T07:00:00Z"),
        notice("n3", "2026-10-05T10:00:00Z", { kind: "other_tool", stay_date: null, room_type_id: null, pms_rate: null, maya_price: null, rates: 21 }),
      ],
    }).client;
    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>[];
    expect(res.status, JSON.stringify(body)).toBe(200);
    const order = body.map((i) => (i.kind === "pms_change" ? `${i.change}:${i.id}` : i.kind ?? "run"));
    expect(order).toEqual(["other_tool:n3", "overwrite:n1", "overwrite:n2", "run"]);
    // Without the service role the ledger can't be read, so nothing is claimed.
    expect(body.find((i) => i.id === "n2")).toMatchObject({
      title: "Fri, Nov 13, Suite: the rate was removed in Cloudbeds. MAYA's price, $240.00, was due to go out again.",
    });
    expect(body.find((i) => i.id === "n3")).not.toHaveProperty("setting_on");
  });

  it("lists the warning even under more overwrites than the log lists, and counts only the overwrites left out", async () => {
    const flood = Array.from({ length: MAX_PMS_CHANGES + 5 }, (_, i) =>
      notice(`o${i}`, new Date(Date.parse("2026-10-05T08:30:00Z") + i * 1000).toISOString()),
    );
    state.client = seed({
      pms_change_notices: [
        notice("w1", "2026-10-05T08:10:00Z", { kind: "other_tool", stay_date: null, room_type_id: null, pms_rate: null, maya_price: null, rates: 21 }),
        ...flood,
      ],
    }).client;
    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>[];
    expect(res.status, JSON.stringify(body)).toBe(200);
    const changes = body.filter((i) => i.kind === "pms_change");
    expect(changes.filter((i) => i.change === "other_tool").map((i) => i.id)).toEqual(["w1"]);
    expect(changes.filter((i) => i.change === "overwrite")).toHaveLength(MAX_PMS_CHANGES);
    expect(changes.find((i) => i.change === "more")).toMatchObject({ count: 5, title: moreTitle("Cloudbeds", 5) });
  });

  it("shows none, and still the log, on a database without the table", async () => {
    state.client = seed({}, { missing: ["pms_change_notices"] }).client;
    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>[];
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.some((i) => i.kind === "pms_change")).toBe(false);
    expect(body.some((i) => i.has_changes === true)).toBe(true);
  });
});
