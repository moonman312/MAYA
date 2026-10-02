/**
 * Creating the rules an import from PIE read (POST /api/rules/import): who
 * may, the 40-rule cap, the rules that were on in PIE added on with Skip
 * and no popup, on the nights worked out at the save itself (Jake,
 * 2026-10-01: PIE has already adjusted them in Cloudbeds), rules off in PIE
 * created off, the floors and ceilings set before the rules, and the
 * analytics event. And the review's one check before anything is saved:
 * what the floors and ceilings change by themselves (POST
 * /api/rules/preview, intent "import_limits").
 *
 * The days come from the real engine (dry) over the preview fixture's hotel;
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
  /** The save's dry runs for the held nights fail (a read timed out). */
  daysFail: false,
};

vi.mock("@/lib/rule-preview", async (orig) => {
  const real = await orig<typeof import("@/lib/rule-preview")>();
  return {
    ...real,
    previewRuleSet: (...args: Parameters<typeof real.previewRuleSet>) =>
      state.daysFail ? Promise.reject(new Error("a read timed out")) : real.previewRuleSet(...args),
  };
});

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
const { planImportRequest, limitOverrides } = await import("@/lib/pie-import/server");
const { previewRuleSet } = await import("@/lib/rule-preview");

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
  state.daysFail = false;
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
const limitsCheck = (body: Record<string, unknown>) => call(preview, "/api/rules/preview", { intent: "import_limits", ...body });
const save = (body: Record<string, unknown>) => call(importRules, "/api/rules/import", body);

/** The nights the activation popup would have shown for the rules on, on the limits: what the save holds. */
async function daysToHold(rules: Record<string, unknown>[], limits: Record<string, unknown>[] = []) {
  const request = await planImportRequest(adminProxy, HOTEL, { rules, limits }, T10);
  const on = request.rules.flatMap((r) => (r.on && !r.existing ? [r.plan.after] : []));
  return previewRuleSet(adminProxy, { hotelId: HOTEL, rules: on, limits: limitOverrides(request.limits), at: T10, horizonDays: 45 });
}

describe("the review's check of the floors and ceilings", () => {
  it("says which days the limits being set change by themselves, on the engine", async () => {
    const { status, body } = await limitsCheck({ limits: LIMITS() });
    expect(status).toBe(200);
    expect(body).toMatchObject({ today: "2026-10-01", horizonDays: 45, nightsChecked: 90 });
    expect((body.limitsAffected as string[]).length).toBeGreaterThan(0);
    // Limits that are what the room type has already change nothing.
    const king = state.tables.room_types.find((r) => r.id === KING)!;
    const same = await limitsCheck({ limits: [{ roomTypeId: KING, floor: Number(king.floor_price), ceiling: Number(king.ceiling_price) }] });
    expect(same.body.limitsAffected).toEqual([]);
    // Nothing saved.
    expect(state.userWrites).toEqual([]);
  });

  it("refuses a viewer, and limits the import would refuse", async () => {
    state.canManage = false;
    expect((await limitsCheck({ limits: LIMITS() })).status).toBe(403);
    state.canManage = true;
    expect((await limitsCheck({ limits: [{ roomTypeId: KING, floor: 300, ceiling: 200 }] })).body.error).toBe("A ceiling can't be under its floor.");
    expect((await limitsCheck({ limits: [{ roomTypeId: "a0000000-0000-4000-8000-000000000099", floor: 1, ceiling: 2 }] })).body.error).toBe(
      "Pick a room type on this property.",
    );
  });

  it("no longer answers for an import's rules: they have no popup", async () => {
    expect((await call(preview, "/api/rules/preview", { intent: "import", ruleId: id(0), rules: RULES(), limits: LIMITS() })).status).toBe(400);
  });
});

describe("POST /api/rules/import", () => {
  it("sets the limits, then creates each rule, on with Skip or off as in PIE, in order, holding the nights the rules would change now", async () => {
    const days = await daysToHold(RULES(), LIMITS());
    expect(days.affected.length).toBeGreaterThan(0);
    const { status, body } = await save({ rules: RULES(), limits: LIMITS() });
    expect(status).toBe(200);
    expect(body).toEqual({
      created: [
        { id: id(0), on: true },
        { id: id(1), on: true },
        { id: id(2), on: false },
      ],
      failed: [],
      limits: 1,
      skipped: true,
    });
    expect(state.userWrites).toEqual([{ table: "room_types", payload: { floor_price: 150, ceiling_price: 215 }, order: 1 }]);
    expect(state.saves.map((s) => [s.p_rule_id, s.p_is_new, s.p_activation, s.order])).toEqual([
      [id(0), true, "skip", 2],
      [id(1), true, "skip", 3],
      [id(2), true, "off", 4],
    ]);
    const on = state.saves.filter((s) => s.p_activation === "skip");
    for (const s of on) {
      expect(s.p_hold_nights).toEqual(days.affected);
      expect(s.p_touched).toEqual(days.touched);
      for (const m of s.p_skip_marks as { d: string; w: string }[]) {
        expect(m.w).toBe("held");
        expect(days.affected).toContain(m.d);
      }
    }
    expect(on.flatMap((s) => s.p_skip_marks as unknown[]).length).toBeGreaterThan(0);
    expect(state.saves[0]).toMatchObject({ p_fields: expect.objectContaining({ name: "Imported 0", start_date: null }) });
    expect(state.saves[2]).toMatchObject({ p_touched: [], p_skip_marks: [], p_hold_nights: [] });
    expect(state.nudges).toBe(1);
    expect(state.events).toEqual([
      expect.objectContaining({
        p_event: "rules.imported",
        p_properties: { from: "pie", created: 3, created_on: 2, created_off: 1, failed: 0, limits: 1, choice: "skip", held_all: false, days: days.affected.length },
      }),
    ]);
  });

  it("skips even when a page from before sends Apply, with a fingerprint that no longer matches", async () => {
    const { status, body } = await save({ rules: RULES(), activation: "apply", fingerprint: "old", touched: [], days: 3 });
    expect(status).toBe(200);
    expect(body.skipped).toBe(true);
    expect(state.saves.map((s) => s.p_activation)).toEqual(["skip", "skip", "off"]);
  });

  it("when the nights can't be worked out, holds every night each rule could act on, as the popup's Skip did", async () => {
    state.daysFail = true;
    const { status } = await save({ rules: RULES(), limits: LIMITS() });
    expect(status).toBe(200);
    const on = state.saves.filter((s) => s.p_activation === "skip");
    expect(on).toHaveLength(2);
    // Rule 0 acts 10 or more days out: from the tenth night of the 45 on; rule 1 on every night.
    expect((on[0].p_hold_nights as string[]).length).toBe(35);
    expect((on[1].p_hold_nights as string[]).length).toBe(45);
    expect(on.every((s) => (s.p_skip_marks as { w: string }[]).every((m) => m.w === "held"))).toBe(true);
    expect(state.events).toEqual([expect.objectContaining({ p_properties: expect.objectContaining({ choice: "skip", held_all: true, days: null }) })]);
  });

  it("creates rules that were all off, and limits alone", async () => {
    expect((await save({ rules: RULES().map((r) => ({ ...r, on: false })) })).status).toBe(200);
    expect(state.saves.map((s) => s.p_activation)).toEqual(["off", "off", "off"]);
    expect(state.events).toEqual([expect.objectContaining({ p_properties: expect.objectContaining({ choice: "none", held_all: false, days: null }) })]);
    state.saves = [];
    const { status, body } = await save({ rules: [], limits: LIMITS() });
    expect(status).toBe(200);
    expect(body).toMatchObject({ created: [], limits: 1, skipped: false });
    expect(state.saves).toEqual([]);
    expect(state.tables.room_types.find((r) => r.id === KING)).toMatchObject({ floor_price: 150, ceiling_price: 215 });
  });

  it("refuses an import that would pass 40 rules on, saving nothing", async () => {
    for (let i = 0; i < 39; i++) state.tables.pricing_rules.push({ id: `filler-${i}`, hotel_id: HOTEL, is_active: true });
    const active = state.tables.pricing_rules.filter((r) => r.is_active).length;
    const { status, body } = await save({ rules: RULES(), limits: LIMITS() });
    expect(status).toBe(409);
    expect(body).toEqual({ error: `That makes ${active + 2} rules on, and a property can have 40. Untick ${active + 2 - 40} to fit.`, code: "cap" });
    expect(state.saves).toEqual([]);
    expect(state.userWrites).toEqual([]);
  });

  it("refuses what the builder would refuse", async () => {
    expect(await save({ rules: [{ ...RULES()[0], action: { adjust_rate_percent: 5, adjust_rate_dollars: 5 } }] })).toEqual({
      status: 400,
      body: { error: "Use a percent or a fixed amount, not both." },
    });
    expect((await save({ rules: [RULES()[0], RULES()[0]] })).status).toBe(400);
    expect((await save({ rules: [{ ...RULES()[0], id: "nope" }] })).status).toBe(400);
    expect((await save({ rules: [{ ...RULES()[0], start_date: "2026-12-01", end_date: "2026-11-01" }] })).body.error).toBe("The first night must come before the last.");
    expect(state.saves).toEqual([]);
  });

  it("names a rule that fails and saves the rest; one already created by an earlier try counts as created", async () => {
    state.failFor = { id: id(1), code: "22023", message: "Pick at least one room type to change." };
    state.tables.pricing_rules.push({ id: id(2), hotel_id: HOTEL, is_active: false });
    const { status, body } = await save({ rules: RULES() });
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
    expect((await save({ rules: RULES() })).status).toBe(403);
    expect(state.saves).toEqual([]);
  });
});

describe("Skip on a property with bookings, over a real network", () => {
  // Jake, 2026-10-01: on a Cloudbeds property, Import from PIE, the review,
  // then Skip price adjustments in the popup, failed every time with "Your
  // bookings changed while this was open, so the days were checked again."
  // in amber and then in red, and nothing was saved: the popup's
  // fingerprint and the save's never matched (previewFingerprint hashed its
  // reads in the order the network answered them). The import now has no
  // popup and no fingerprint: the owner clicks Add, and the save works out
  // the nights to hold itself.
  it("several rules and limits: saved at the first click, with the nights held for every rule that is on", async () => {
    state.network = reorderingReads();
    const rules = [
      ...RULES(),
      rule(3, true, { occupancy_operator: "gt", occupancy_threshold: 0.45, dta_operator: "gt", dta_threshold_days: 4 }, { adjust_rate_percent: 12 }),
    ];
    const limits = [...LIMITS(), { roomTypeId: SUITE, floor: 300, ceiling: 330 }];
    const days = await daysToHold(rules, limits);
    expect(days.affected.length).toBeGreaterThan(0);
    const res = await save({ rules, limits });
    expect([res.status, res.body.code]).toEqual([200, undefined]);
    expect(state.userWrites.map((w) => w.table)).toEqual(["room_types", "room_types"]);
    const on = state.saves.filter((s) => s.p_activation === "skip");
    expect(on.map((s) => s.p_rule_id)).toEqual([id(0), id(1), id(3)]);
    for (const s of on) expect(s.p_hold_nights).toEqual(days.affected);
    expect(state.saves.find((s) => s.p_rule_id === id(2))).toMatchObject({ p_activation: "off" });
  });
});
