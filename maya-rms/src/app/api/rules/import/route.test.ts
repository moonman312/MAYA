/**
 * Creating the rules an import from PIE read: the popup's one preview for
 * the rules that are on (POST /api/rules/preview, intent "import"), and the
 * save (POST /api/rules/import): who may, the 40-rule cap, the owner's
 * Apply or Skip for all of them on the numbers shown, rules off in PIE
 * created off, the floors and ceilings set first, and the analytics event.
 *
 * The preview runs the real engine (dry) over the preview fixture's hotel;
 * save_rule is recorded, not run (rule-activation-sql.test.ts runs it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeCall, FakeRow } from "@/lib/engine/fake-supabase.test";

const HOTEL = "h1";
const USER = "00000000-0000-4000-8000-0000000000a1";

const state = {
  tables: {} as Record<string, FakeRow[]>,
  canManage: true,
  saves: [] as Record<string, unknown>[],
  /** save_rule fails for this rule id with this error. */
  failFor: null as { id: string; code: string; message: string } | null,
  nudges: 0,
  events: [] as Record<string, unknown>[],
  userWrites: [] as { table: string; payload: unknown; order: number }[],
  order: 0,
  /** How the admin client's reads come back (reorderingReads: as a real network does). */
  network: null as ((call: FakeCall) => Promise<void>) | null,
};

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => HOTEL }));
vi.mock("@/lib/pms/sync-nudge", () => ({
  nudgeHotelSync: async () => {
    state.nudges++;
    return "nudged";
  },
}));
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: async () => null }));

async function adminClient() {
  const { fakeSupabase } = await import("@/lib/engine/fake-supabase.test");
  const db = fakeSupabase(state.tables, {
    beforeCall: (call) => state.network?.(call),
    rpc: (fn, args) => {
      if (fn === "engine_run_gaps") return [];
      if (fn === "product_event_emit") {
        state.events.push(args as Record<string, unknown>);
        return 1;
      }
      return undefined;
    },
  });
  state.tables = db.tables;
  return db.client;
}

vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => adminProxy,
}));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let adminProxy: any;

vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER } } }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "can_manage_hotel") return { data: state.canManage, error: null };
      if (fn === "is_platform_admin") return { data: false, error: null };
      if (fn === "save_rule") {
        if (state.failFor && args.p_rule_id === state.failFor.id) return { data: null, error: state.failFor };
        state.saves.push({ ...args, order: ++state.order });
        return { data: { id: args.p_rule_id, version: 1, is_active: args.p_activation === "apply" || args.p_activation === "skip", skip_at: null }, error: null };
      }
      return { data: null, error: null };
    },
    from: (table: string) => {
      const b = adminProxy.from(table);
      return new Proxy(b, {
        get(t, p) {
          if (p === "update") {
            return (payload: unknown) => {
              state.userWrites.push({ table, payload, order: ++state.order });
              return t.update(payload);
            };
          }
          const v = t[p];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    },
  }),
}));

const { ENGINES, T10, KING, QUEEN, SUITE, FAMILY, settle, reorderingReads } = await import("@/lib/rule-preview-fixture.test");
const { POST: preview } = await import("@/app/api/rules/preview/route");
const { POST: importRules } = await import("@/app/api/rules/import/route");

const json = (url: string, body: unknown) =>
  new Request(`https://maya-rms.com${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const ALL = () => [KING, QUEEN, SUITE, FAMILY];
const id = (i: number) => `0e5a1b0${i}-0000-4000-8000-000000000001`;
const rule = (i: number, on: boolean, cond: Record<string, unknown>, action: Record<string, number>) => ({
  id: id(i),
  on,
  rule_name: `Imported ${i}`,
  condition: cond,
  action,
  signal_room_type_ids: ALL(),
  affected_room_type_ids: ALL(),
  undo_on_cancellation: true,
});
const RULES = () => [
  rule(0, true, { occupancy_operator: "gt", occupancy_threshold: 0.3, dta_operator: "gt", dta_threshold_days: 9 }, { adjust_rate_percent: 10 }),
  rule(1, true, { occupancy_operator: "gt", occupancy_threshold: 0.55 }, { adjust_rate_percent: 5 }),
  rule(2, false, { occupancy_operator: "lt", occupancy_threshold: 0.3, dta_operator: "lt", dta_threshold_days: 5 }, { adjust_rate_percent: -10 }),
];
const LIMITS = () => [{ roomTypeId: KING, floor: 150, ceiling: 215 }];

let settled: Record<string, FakeRow[]>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T10));
  vi.spyOn(console, "error").mockImplementation(() => {});
  ENGINES[0].reset();
  settled ??= await settle(ENGINES[0].evaluate);
  state.tables = structuredClone(settled);
  state.tables.hotel_pricing_state = [{ hotel_id: HOTEL, pass_horizon_days: 45 }];
  state.canManage = true;
  state.saves = [];
  state.failFor = null;
  state.nudges = 0;
  state.events = [];
  state.userWrites = [];
  state.order = 0;
  state.network = null;
  adminProxy = await adminClient();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function call(fn: (r: Request) => Promise<Response>, url: string, body: Record<string, unknown>) {
  const res = await fn(json(url, body));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const previewOf = (body: Record<string, unknown>) => call(preview, "/api/rules/preview", { intent: "import", ...body });
const save = (body: Record<string, unknown>) => call(importRules, "/api/rules/import", body);

describe("the popup's preview for an import", () => {
  it("counts the days the rules that are on change, together, on the limits being set", async () => {
    const { status, body } = await previewOf({ rules: RULES(), limits: LIMITS() });
    expect(status).toBe(200);
    expect(body).toMatchObject({ needsActivation: true, kind: "standard", today: "2026-10-01", horizonDays: 45 });
    expect((body.affected as string[]).length).toBeGreaterThan(0);
    expect(typeof body.fingerprint).toBe("string");
  });

  it("needs no popup when every rule was off in PIE", async () => {
    const { body } = await previewOf({ rules: RULES().map((r) => ({ ...r, on: false })) });
    expect(body).toEqual({ needsActivation: false, change: "new" });
  });

  it("says so before anything when the rules on would pass 40", async () => {
    for (let i = 0; i < 39; i++) state.tables.pricing_rules.push({ id: `filler-${i}`, hotel_id: HOTEL, is_active: true });
    const active = state.tables.pricing_rules.filter((r) => r.is_active).length;
    const { status, body } = await previewOf({ rules: RULES() });
    expect(status).toBe(409);
    expect(body).toEqual({ error: `That makes ${active + 2} rules on, and a property can have 40. Untick ${active + 2 - 40} to fit.`, code: "cap" });
  });

  it("refuses a viewer, and what the builder would refuse", async () => {
    state.canManage = false;
    expect((await previewOf({ rules: RULES() })).status).toBe(403);
    state.canManage = true;
    expect(await previewOf({ rules: [{ ...RULES()[0], action: { adjust_rate_percent: 5, adjust_rate_dollars: 5 } }] })).toEqual({
      status: 400,
      body: { error: "Use a percent or a fixed amount, not both." },
    });
    expect((await previewOf({ rules: [RULES()[0], RULES()[0]] })).status).toBe(400);
    expect((await previewOf({ rules: [{ ...RULES()[0], id: "nope" }] })).status).toBe(400);
    expect((await previewOf({ rules: RULES(), limits: [{ roomTypeId: KING, floor: 300, ceiling: 200 }] })).body.error).toBe("A ceiling can't be under its floor.");
    expect((await previewOf({ rules: RULES(), limits: [{ roomTypeId: "a0000000-0000-4000-8000-000000000099", floor: 1, ceiling: 2 }] })).body.error).toBe(
      "Pick a room type on this property.",
    );
    expect((await previewOf({ rules: [{ ...RULES()[0], start_date: "2026-12-01", end_date: "2026-11-01" }] })).body.error).toBe(
      "The first night must come before the last.",
    );
  });
});

describe("POST /api/rules/import", () => {
  it("refuses rules that are on without the owner's choice, or on a stale fingerprint", async () => {
    expect(await save({ rules: RULES() })).toMatchObject({ status: 409, body: { code: "activation_required" } });
    expect(await save({ rules: RULES(), activation: "apply", fingerprint: "old" })).toMatchObject({ status: 409, body: { code: "stale" } });
    expect(state.saves).toEqual([]);
    expect(state.userWrites).toEqual([]);
  });

  it("Apply: sets the limits, then creates each rule, on or off as in PIE, in order", async () => {
    const shown = await previewOf({ rules: RULES(), limits: LIMITS() });
    const { status, body } = await save({
      rules: RULES(),
      limits: LIMITS(),
      activation: "apply",
      fingerprint: shown.body.fingerprint,
      touched: shown.body.touched,
      days: (shown.body.affected as string[]).length,
    });
    expect(status).toBe(200);
    expect(body).toEqual({
      created: [
        { id: id(0), on: true },
        { id: id(1), on: true },
        { id: id(2), on: false },
      ],
      failed: [],
      limits: 1,
      skipped: false,
    });
    expect(state.userWrites).toEqual([{ table: "room_types", payload: { floor_price: 150, ceiling_price: 215 }, order: 1 }]);
    expect(state.saves.map((s) => [s.p_rule_id, s.p_is_new, s.p_activation, s.order])).toEqual([
      [id(0), true, "apply", 2],
      [id(1), true, "apply", 3],
      [id(2), true, "off", 4],
    ]);
    expect(state.saves[0]).toMatchObject({ p_touched: shown.body.touched, p_skip_marks: [], p_fields: expect.objectContaining({ name: "Imported 0", start_date: null }) });
    expect(state.saves[2]).toMatchObject({ p_touched: [] });
    expect(state.nudges).toBe(1);
    expect(state.events).toEqual([
      expect.objectContaining({
        p_event: "rules.imported",
        p_properties: { from: "pie", created: 3, created_on: 2, created_off: 1, failed: 0, limits: 1, choice: "apply", held_all: false, days: (shown.body.affected as string[]).length },
      }),
    ]);
  });

  it("Skip: holds the days shown for every rule that is on", async () => {
    const shown = await previewOf({ rules: RULES() });
    const held = shown.body.affected as string[];
    const { status } = await save({ rules: RULES(), activation: "skip", fingerprint: shown.body.fingerprint, touched: shown.body.touched, held });
    expect(status).toBe(200);
    const on = state.saves.filter((s) => s.p_activation === "skip");
    expect(on).toHaveLength(2);
    for (const s of on) {
      expect(s.p_hold_nights).toEqual(held);
      for (const m of s.p_skip_marks as { d: string; w: string }[]) {
        expect(m.w).toBe("held");
        expect(held).toContain(m.d);
      }
    }
    expect(on.flatMap((s) => s.p_skip_marks as unknown[]).length).toBeGreaterThan(0);
    expect(state.saves.find((s) => s.p_rule_id === id(2))).toMatchObject({ p_activation: "off", p_skip_marks: [] });
  });

  it("creates rules that were all off with no popup, and limits alone", async () => {
    expect((await save({ rules: RULES().map((r) => ({ ...r, on: false })) })).status).toBe(200);
    expect(state.saves.map((s) => s.p_activation)).toEqual(["off", "off", "off"]);
    state.saves = [];
    const { status, body } = await save({ rules: [], limits: LIMITS() });
    expect(status).toBe(200);
    expect(body).toMatchObject({ created: [], limits: 1 });
    expect(state.saves).toEqual([]);
    expect(state.tables.room_types.find((r) => r.id === KING)).toMatchObject({ floor_price: 150, ceiling_price: 215 });
  });

  it("refuses an import that would pass 40 rules on, saving nothing", async () => {
    for (let i = 0; i < 39; i++) state.tables.pricing_rules.push({ id: `filler-${i}`, hotel_id: HOTEL, is_active: true });
    const { status, body } = await save({ rules: RULES(), limits: LIMITS(), activation: "skip", hold_all: true });
    expect(status).toBe(409);
    expect(body.code).toBe("cap");
    expect(state.saves).toEqual([]);
    expect(state.userWrites).toEqual([]);
  });

  it("names a rule that fails and saves the rest; one already created by an earlier try counts as created", async () => {
    state.failFor = { id: id(1), code: "22023", message: "Pick at least one room type to change." };
    state.tables.pricing_rules.push({ id: id(2), hotel_id: HOTEL, is_active: false });
    const { status, body } = await save({ rules: RULES(), activation: "skip", hold_all: true });
    expect(status).toBe(200);
    expect(body.created).toEqual([
      { id: id(0), on: true },
      { id: id(2), on: false },
    ]);
    expect(body.failed).toEqual([{ id: id(1), error: "Pick at least one room type to change." }]);
  });

  it("says the limits were set when every rule then fails", async () => {
    state.failFor = { id: id(2), code: "22023", message: "Pick at least one room type to change." };
    const { status, body } = await save({ rules: [RULES()[2]], limits: LIMITS() });
    expect(status).toBe(200);
    expect(body).toMatchObject({ created: [], failed: [{ id: id(2), error: "Pick at least one room type to change." }], limits: 1 });
    expect(body.error).toBeUndefined();
    expect(state.tables.room_types.find((r) => r.id === KING)).toMatchObject({ floor_price: 150, ceiling_price: 215 });
    // With no limits, nothing changed: refused with the rule's reason.
    const again = await save({ rules: [RULES()[2]] });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("Pick at least one room type to change.");
  });

  it("refuses a viewer", async () => {
    state.canManage = false;
    expect((await save({ rules: RULES(), activation: "skip", hold_all: true })).status).toBe(403);
    expect(state.saves).toEqual([]);
  });
});

describe("Skip on a property with bookings, over a real network", () => {
  // Jake, 2026-10-01: on a Cloudbeds property, Import from PIE, the review,
  // then Skip price adjustments, failed every time with "Your bookings changed
  // while this was open, so the days were checked again." in amber and then in
  // red, and nothing was saved. The popup does what this does: the preview,
  // the save with its fingerprint, and on "stale" one fresh preview and the
  // save again.
  it("saves at the first try, with the days shown held for every rule that is on", async () => {
    state.network = reorderingReads();
    const rules = [
      ...RULES(),
      rule(3, true, { occupancy_operator: "gt", occupancy_threshold: 0.45, dta_operator: "gt", dta_threshold_days: 4 }, { adjust_rate_percent: 12 }),
    ];
    const limits = [...LIMITS(), { roomTypeId: SUITE, floor: 300, ceiling: 330 }];
    const statuses: number[] = [];
    let held: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const shown = await previewOf({ rules, limits });
      expect(shown.status).toBe(200);
      held = shown.body.affected as string[];
      const res = await save({ rules, limits, activation: "skip", fingerprint: shown.body.fingerprint, touched: shown.body.touched, held, days: held.length, refreshed: attempt > 0 });
      statuses.push(res.status);
      if (res.body.code !== "stale") break;
    }
    expect(statuses).toEqual([200]);
    expect(held.length).toBeGreaterThan(0);
    expect(state.userWrites.map((w) => w.table)).toEqual(["room_types", "room_types"]);
    const on = state.saves.filter((s) => s.p_activation === "skip");
    expect(on.map((s) => s.p_rule_id)).toEqual([id(0), id(1), id(3)]);
    for (const s of on) expect(s.p_hold_nights).toEqual(held);
    expect(state.saves.find((s) => s.p_rule_id === id(2))).toMatchObject({ p_activation: "off" });
  });
});
