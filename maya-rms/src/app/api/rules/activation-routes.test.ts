/**
 * The rule routes through the activation popup: who may preview and save,
 * that nothing switches a rule on without the owner's Apply or Skip, that a
 * save is refused when the numbers the popup showed may have moved, and that
 * a save goes to save_rule with the rule as previewed.
 *
 * The preview runs the real engine (dry) over the in-memory hotel of
 * rule-preview-fixture.test.ts; save_rule is recorded, not run (it runs in
 * Postgres in rule-activation-sql.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeCall, FakeRow } from "@/lib/engine/fake-supabase.test";

const HOTEL = "h1";
const USER = "00000000-0000-4000-8000-0000000000a1";
const NEW_ID = "d1000000-0000-4000-8000-000000000009";

const state = {
  tables: {} as Record<string, FakeRow[]>,
  canManage: true,
  /** The caller is MAYA staff (a platform admin); with canManage false, outside God Mode. */
  platformAdmin: false,
  supabase: true,
  saves: [] as Record<string, unknown>[],
  saveError: null as { code: string; message: string } | null,
  nudges: 0,
  events: [] as Record<string, unknown>[],
  userWrites: [] as { table: string; payload: unknown }[],
  /** How the admin client's reads come back (reorderingReads: as a real network does). */
  network: null as ((call: FakeCall) => Promise<void>) | null,
};

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => state.supabase }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => HOTEL }));
vi.mock("@/lib/pms/sync-nudge", () => ({
  nudgeHotelSync: async () => {
    state.nudges++;
    return "nudged";
  },
}));
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: async () => null }));
vi.mock("@/lib/require-supabase-hotel", () => ({ hasHotelRank: async () => state.canManage }));

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
  // The fake copies what it is given; keep writes where the test can see them.
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
    auth: {
      getUser: async () => ({ data: { user: { id: USER } } }),
      getSession: async () => ({ data: { session: { user: { id: USER } } } }),
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "can_manage_hotel") return { data: state.canManage, error: null };
      if (fn === "is_platform_admin") return { data: state.platformAdmin, error: null };
      if (fn === "save_rule") {
        state.saves.push(args);
        if (state.saveError) return { data: null, error: state.saveError };
        return {
          data: { id: args.p_rule_id, version: (args.p_fields as { version?: number } | null)?.version ?? 1, is_active: args.p_activation !== "keep", skip_at: null },
          error: null,
        };
      }
      return { data: null, error: null };
    },
    from: (table: string) => {
      const b = adminProxy.from(table);
      return new Proxy(b, {
        get(t, p) {
          if (p === "update") {
            return (payload: unknown) => {
              state.userWrites.push({ table, payload });
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

const { ENGINES, R, T10, KING, QUEEN, settle, reorderingReads } = await import("@/lib/rule-preview-fixture.test");
const { POST: preview } = await import("@/app/api/rules/preview/route");
const { POST: create } = await import("@/app/api/rules/route");
const { PUT: edit, DELETE: remove } = await import("@/app/api/rules/[id]/route");
const { POST: toggle } = await import("@/app/api/rules/[id]/toggle/route");

const json = (url: string, body: unknown, method = "POST") =>
  new Request(`https://maya-rms.com${url}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const draft = {
  rule_name: "Busy weekend",
  condition: { occupancy_operator: "gt", occupancy_threshold: 0.35 },
  action: { adjust_rate_percent: 8 },
  signal_room_type_ids: [KING, QUEEN],
  affected_room_type_ids: [KING, QUEEN],
  undo_on_cancellation: true,
};

let settled: Record<string, FakeRow[]>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T10));
  vi.spyOn(console, "error").mockImplementation(() => {});
  ENGINES[0].reset();
  settled ??= await settle(ENGINES[0].evaluate);
  state.tables = structuredClone(settled);
  // The window the hotel's last daily pass used.
  state.tables.hotel_pricing_state = [{ hotel_id: HOTEL, pass_horizon_days: 45 }];
  state.canManage = true;
  state.platformAdmin = false;
  state.supabase = true;
  state.saves = [];
  state.saveError = null;
  state.nudges = 0;
  state.events = [];
  state.userWrites = [];
  state.network = null;
  adminProxy = await adminClient();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function previewOf(body: Record<string, unknown>) {
  const res = await preview(json("/api/rules/preview", body));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/rules/preview", () => {
  it("answers with the nights the rule changes, from the engine, and a fingerprint to save with", async () => {
    const { status, body } = await previewOf({ intent: "create", ruleId: NEW_ID, draft });
    expect(status).toBe(200);
    expect(body.needsActivation).toBe(true);
    expect(body.kind).toBe("standard");
    expect(body.today).toBe("2026-10-01");
    expect(body.horizonDays).toBe(45);
    expect((body.affected as string[]).length).toBeGreaterThan(0);
    expect(typeof body.fingerprint).toBe("string");
    // Only the part asked for.
    const part = await previewOf({ intent: "create", ruleId: NEW_ID, draft, from: "2026-10-20", to: "2026-10-31" });
    expect((part.body.affected as string[]).every((d) => d >= "2026-10-20" && d <= "2026-10-31")).toBe(true);
    expect(part.body.affected).toEqual((body.affected as string[]).filter((d) => d >= "2026-10-20" && d <= "2026-10-31"));
  });

  it("switching a paused rule on", async () => {
    const { status, body } = await previewOf({ intent: "enable", ruleId: R.pausedLadder });
    expect(status).toBe(200);
    expect(body.needsActivation).toBe(true);
    expect(Array.isArray(body.affected)).toBe(true);
  });

  it("a new name alone needs no popup", async () => {
    const busy = state.tables.pricing_rules.find((r) => r.id === R.busy)!;
    const same = {
      rule_name: "A new name",
      condition: { occupancy_operator: "gt", occupancy_threshold: 0.6 },
      action: { adjust_rate_percent: 15 },
      signal_room_type_ids: (busy.rule_signal_room_type as { room_type_id: string }[]).map((x) => x.room_type_id),
      affected_room_type_ids: (busy.rule_affected_room_type as { room_type_id: string }[]).map((x) => x.room_type_id),
      undo_on_cancellation: true,
    };
    const { status, body } = await previewOf({ intent: "edit", ruleId: R.busy, draft: same });
    expect(status).toBe(200);
    expect(body).toEqual({ needsActivation: false, change: "name" });
  });

  it("refuses a viewer with the sentence the rules page shows", async () => {
    state.canManage = false;
    const { status, body } = await previewOf({ intent: "create", ruleId: NEW_ID, draft });
    expect(status).toBe(403);
    expect(body.error).toBe("Only a Revenue Manager or above can change this.");
  });

  it("refuses what the save would refuse, with the same words", async () => {
    const both = await previewOf({ intent: "create", ruleId: NEW_ID, draft: { ...draft, action: { adjust_rate_percent: 5, adjust_rate_dollars: 5 } } });
    expect(both).toEqual({ status: 400, body: { error: "Use a percent or a fixed amount, not both." } });
    const none = await previewOf({ intent: "create", ruleId: NEW_ID, draft: { ...draft, affected_room_type_ids: [] } });
    expect(none).toEqual({ status: 400, body: { error: "Pick at least one room type to change." } });
    expect((await previewOf({ intent: "create", ruleId: "not-an-id", draft })).status).toBe(400);
    expect((await previewOf({ intent: "sideways", ruleId: NEW_ID, draft })).status).toBe(400);
  });

  it("says so when the property is at 40 active rules", async () => {
    for (let i = 0; i < 40; i++) state.tables.pricing_rules.push({ id: `filler-${i}`, hotel_id: HOTEL, is_active: true });
    const { status, body } = await previewOf({ intent: "create", ruleId: NEW_ID, draft });
    expect(status).toBe(409);
    expect(body.error).toBe("This property already has 40 active rules, which is the maximum.");
  });

  it("answers 501 in demo mode, where the dashboard switches rules as before", async () => {
    state.supabase = false;
    expect((await previewOf({ intent: "create", ruleId: NEW_ID, draft })).status).toBe(501);
  });
});

describe("saving through the popup", () => {
  it("a new rule: refused without the owner's choice, refused on a stale fingerprint, saved with it", async () => {
    const without = await create(json("/api/rules", { ...draft, id: NEW_ID }));
    expect(without.status).toBe(409);
    expect(await without.json()).toMatchObject({ code: "activation_required" });

    // Apply changes the days shown, and Skip holds them: both only on the numbers the popup showed.
    for (const choice of [{ activation: "apply" }, { activation: "skip", held: ["2026-10-05"] }]) {
      const stale = await create(json("/api/rules", { ...draft, id: NEW_ID, ...choice, fingerprint: "old" }));
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: "stale", error: "Your bookings changed while this was open, so the days were checked again." });
    }
    expect(state.saves).toEqual([]);

    const { body } = await previewOf({ intent: "create", ruleId: NEW_ID, draft });
    const res = await create(
      json("/api/rules", { ...draft, id: NEW_ID, activation: "apply", fingerprint: body.fingerprint, touched: body.touched, days: (body.affected as string[]).length }),
    );
    expect(res.status).toBe(201);
    expect(state.saves).toHaveLength(1);
    expect(state.saves[0]).toMatchObject({
      p_hotel_id: HOTEL,
      p_rule_id: NEW_ID,
      p_is_new: true,
      p_activation: "apply",
      p_touched: body.touched,
      p_skip_marks: [],
      p_hold_nights: [],
      p_fields: expect.objectContaining({ name: "Busy weekend", action_type: "percent", action_value: 8, signal: [KING, QUEEN], version: 1 }),
    });
    expect(state.nudges).toBe(1);
    expect(state.events).toEqual([
      expect.objectContaining({
        p_event: "rule.activation_chosen",
        p_properties: expect.objectContaining({ rule_id: NEW_ID, choice: "apply", from: "builder_new", kind: "standard", days: (body.affected as string[]).length }),
      }),
    ]);
  });

  it("Skip holds exactly the days the popup showed: the rule's ladder rows there, and nowhere else", async () => {
    const { body } = await previewOf({ intent: "create", ruleId: NEW_ID, draft });
    const affected = body.affected as string[];
    expect(affected.length).toBeGreaterThan(0);
    const res = await create(json("/api/rules", { ...draft, id: NEW_ID, activation: "skip", fingerprint: body.fingerprint, held: affected }));
    expect(res.status).toBe(201);
    const marks = state.saves[0].p_skip_marks as { d: string; rt: string; w: string }[];
    expect(marks.every((m) => m.w === "held")).toBe(true);
    expect([...new Set(marks.map((m) => m.d))]).toEqual(affected);
    expect(state.saves[0].p_hold_nights).toEqual(affected);
    expect(state.events).toEqual([
      expect.objectContaining({ p_properties: expect.objectContaining({ choice: "skip", from: "builder_new", held_all: false }) }),
    ]);
  });

  it("Apply and Skip save at the first try when the reads come back in another order than the popup's did", async () => {
    // A real network answers the fingerprint's reads in any order; the
    // fingerprint is the same for the same data whatever that order.
    state.network = reorderingReads();
    for (const [i, choice] of (["apply", "skip"] as const).entries()) {
      const ruleId = `d1000000-0000-4000-8000-00000000001${i}`;
      const { body } = await previewOf({ intent: "create", ruleId, draft });
      const res = await create(
        json("/api/rules", { ...draft, id: ruleId, activation: choice, fingerprint: body.fingerprint, touched: body.touched, ...(choice === "skip" ? { held: body.affected } : {}) }),
      );
      expect([choice, res.status]).toEqual([choice, 201]);
    }
    expect(state.saves.map((s) => s.p_activation)).toEqual(["apply", "skip"]);
  });

  it("Skip when the days could not be worked out holds every day the rule could act on, with no check", async () => {
    const { body } = await previewOf({ intent: "create", ruleId: NEW_ID, draft });
    const res = await create(json("/api/rules", { ...draft, id: NEW_ID, activation: "skip", fingerprint: "", touched: [], hold_all: true }));
    expect(res.status).toBe(201);
    const marks = state.saves[0].p_skip_marks as { d: string; rt: string; w: string }[];
    const marked = new Set(marks.map((m) => m.d));
    // Every day the popup would have shown, and the days the rule matches where no price moves (a comp night).
    for (const night of body.affected as string[]) expect(marked.has(night)).toBe(true);
    expect((state.saves[0].p_hold_nights as string[]).length).toBe(45);
    expect(state.events).toEqual([
      expect.objectContaining({ p_properties: expect.objectContaining({ choice: "skip", days: null, held_all: true }) }),
    ]);
  });

  it("switching on: refused without Apply or Skip; switching off needs no popup", async () => {
    const refused = await toggle(json(`/api/rules/${R.pausedBs}/toggle`, {}), params(R.pausedBs));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "activation_required" });
    const { body } = await previewOf({ intent: "enable", ruleId: R.pausedBs });
    const on = await toggle(
      json(`/api/rules/${R.pausedBs}/toggle`, { on: true, activation: "skip", fingerprint: body.fingerprint, held: body.affected }),
      params(R.pausedBs),
    );
    expect(on.status).toBe(200);
    // A booking speed rule: its holds are made by save_rule on the days shown.
    expect(state.saves[0]).toMatchObject({
      p_rule_id: R.pausedBs,
      p_is_new: false,
      p_fields: null,
      p_activation: "skip",
      p_skip_marks: [],
      p_hold_nights: body.affected,
    });

    const off = await toggle(json(`/api/rules/${R.busy}/toggle`, { on: false }), params(R.busy));
    expect(off.status).toBe(200);
    expect(state.userWrites).toEqual([{ table: "pricing_rules", payload: expect.objectContaining({ is_active: false }) }]);
  });

  it("a viewer can't switch, save or delete, and is told why", async () => {
    state.canManage = false;
    for (const res of [
      await toggle(json(`/api/rules/${R.busy}/toggle`, { on: false }), params(R.busy)),
      await create(json("/api/rules", { ...draft, id: NEW_ID, activation: "apply", fingerprint: "x" })),
      await edit(json(`/api/rules/${R.busy}`, { ...draft, activation: "apply", fingerprint: "x" }, "PUT"), params(R.busy)),
      await remove(new Request(`https://maya-rms.com/api/rules/${R.busy}`, { method: "DELETE" }), params(R.busy)),
    ]) {
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("Only a Revenue Manager or above can change this.");
    }
    expect(state.saves).toEqual([]);
  });

  it("MAYA staff outside God Mode can't preview, switch, save, answer the popup or delete, and are told to turn it on", async () => {
    // can_manage_hotel() is false for an admin until god_mode_active().
    state.canManage = false;
    state.platformAdmin = true;
    for (const res of [
      await preview(json("/api/rules/preview", { intent: "create", ruleId: NEW_ID, draft })),
      await toggle(json(`/api/rules/${R.busy}/toggle`, { on: false }), params(R.busy)),
      await toggle(json(`/api/rules/${R.busy}/toggle`, { on: true, activation: "skip", hold_all: true }), params(R.busy)),
      await create(json("/api/rules", { ...draft, id: NEW_ID, activation: "apply", fingerprint: "x" })),
      await edit(json(`/api/rules/${R.busy}`, { ...draft, activation: "skip", hold_all: true }, "PUT"), params(R.busy)),
      await remove(new Request(`https://maya-rms.com/api/rules/${R.busy}`, { method: "DELETE" }), params(R.busy)),
    ]) {
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("God Mode is off. Turn it on from the Command Center to change this property.");
    }
    expect(state.saves).toEqual([]);
    expect(state.userWrites).toEqual([]);
  });

  it("an edit: a new name saves at once; a new bar on a rule that is on needs the popup; a stale form is refused", async () => {
    const busy = state.tables.pricing_rules.find((r) => r.id === R.busy)!;
    const sets = {
      signal_room_type_ids: (busy.rule_signal_room_type as { room_type_id: string }[]).map((x) => x.room_type_id),
      affected_room_type_ids: (busy.rule_affected_room_type as { room_type_id: string }[]).map((x) => x.room_type_id),
    };
    const base = { rule_name: "Renamed", condition: { occupancy_operator: "gt", occupancy_threshold: 0.6 }, action: { adjust_rate_percent: 15 }, undo_on_cancellation: true, ...sets };
    const renamed = await edit(json(`/api/rules/${R.busy}`, { ...base, expected_version: 1 }, "PUT"), params(R.busy));
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ change: "name" });
    expect(state.saves[0]).toMatchObject({ p_activation: "keep", p_fields: expect.objectContaining({ name: "Renamed", version: 1 }) });

    const higher = { ...base, condition: { occupancy_operator: "gt", occupancy_threshold: 0.7 } };
    const refused = await edit(json(`/api/rules/${R.busy}`, { ...higher, expected_version: 1 }, "PUT"), params(R.busy));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "activation_required" });

    const stale = await edit(json(`/api/rules/${R.busy}`, { ...higher, expected_version: 7 }, "PUT"), params(R.busy));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "rule_changed", error: "This rule changed in another tab. Reload it to edit." });

    const { body } = await previewOf({ intent: "edit", ruleId: R.busy, draft: higher });
    expect(body.versionAfter).toBe(2);
    const saved = await edit(json(`/api/rules/${R.busy}`, { ...higher, expected_version: 1, activation: "apply", fingerprint: body.fingerprint }, "PUT"), params(R.busy));
    expect(saved.status).toBe(200);
    expect(state.saves[1]).toMatchObject({
      p_expected_version: 1,
      p_activation: "apply",
      p_fields: expect.objectContaining({ version: 2, condition: expect.objectContaining({ occupancy_threshold: 0.7 }) }),
    });
  });

  it("an edit to a rule that is off saves without the popup and moves no price", async () => {
    const paused = state.tables.pricing_rules.find((r) => r.id === R.pausedLadder)!;
    const body = {
      rule_name: "Paused, edited",
      condition: { occupancy_operator: "gt", occupancy_threshold: 0.5 },
      action: { adjust_rate_dollars: 12 },
      signal_room_type_ids: (paused.rule_signal_room_type as { room_type_id: string }[]).map((x) => x.room_type_id),
      affected_room_type_ids: [KING],
      undo_on_cancellation: true,
      expected_version: 1,
    };
    const res = await edit(json(`/api/rules/${R.pausedLadder}`, body, "PUT"), params(R.pausedLadder));
    expect(res.status).toBe(200);
    expect(state.saves[0]).toMatchObject({ p_activation: "keep", p_fields: expect.objectContaining({ version: 2, affected: [KING] }) });
    expect(state.events).toEqual([]);
  });

  it("maps save_rule's refusals to what the popup says", async () => {
    const { body } = await previewOf({ intent: "create", ruleId: NEW_ID, draft });
    state.saveError = { code: "23514", message: "This property already has 40 active rules, which is the maximum." };
    const cap = await create(json("/api/rules", { ...draft, id: NEW_ID, activation: "apply", fingerprint: body.fingerprint }));
    expect(cap.status).toBe(409);
    expect((await cap.json()).error).toBe("This property already has 40 active rules, which is the maximum.");
    state.saveError = { code: "PGRST202", message: "Could not find the function public.save_rule" };
    const skip = await create(json("/api/rules", { ...draft, id: NEW_ID, activation: "skip", fingerprint: body.fingerprint, held: body.affected }));
    expect(skip.status).toBe(503);
    expect((await skip.json()).error).toBe("This needs a database update first.");
  });
});
