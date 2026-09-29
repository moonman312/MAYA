/**
 * How the change log shows MAYA support: a platform admin who typed a price
 * or answered a banner is named "MAYA support", never by their own name; the
 * answer item carries by_support for the "MAYA support's answer" heading; and
 * every save made in God Mode is its own "Changed by MAYA support" item,
 * where it happened, however many rows it wrote. A database without support_changes yet shows none and
 * never fails the log.
 */
import { describe, expect, it, vi } from "vitest";
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
const state = vi.hoisted(() => ({ client: null as unknown, admin: null as unknown }));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("server-only", () => ({}));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.client }));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => state.admin != null,
  createAdminClient: () => state.admin,
}));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => HOTEL }));

const { GET } = await import("./route");

const RUN_AT = "2026-07-29T08:00:00Z";

/** One run in the log, and the rows the case adds. */
function seed(extra: Record<string, Row[]> = {}, opts: { missing?: string[] } = {}) {
  return fakeSupabase(
    {
      evaluation_audit: [
        {
          id: "audit-1",
          hotel_id: HOTEL,
          evaluation_run_id: "run-1",
          stay_date: "2026-08-02",
          room_type_id: "rt-1",
          evaluated_at: RUN_AT,
          base_price: 180,
          final_price: 180,
          pre_clamp_price: 180,
          floor_price: 100,
          ceiling_price: 400,
          details: {
            application_order: [],
            base_source: "manual",
            manual_override: { set_by: "staff-1", set_at: "2026-07-29T07:59:00Z" },
          },
        },
      ],
      hotels: [{ id: HOTEL, currency: "USD" }],
      room_types: [{ id: "rt-1", hotel_id: HOTEL, name: "Garden King" }],
      pricing_rules: [
        {
          id: "rule-1",
          hotel_id: HOTEL,
          name: "Slow-date rescue",
          action_type: "percent",
          action_direction: "decrease",
          action_value: 10,
          is_pickup_rule: false,
          undo_on_cancellation: false,
          rule_condition: { occupancy_operator: "lt", occupancy_threshold: 0.4 },
        },
      ],
      evaluation_run_log: [{ hotel_id: HOTEL, evaluation_run_id: "run-1", evaluated_at: RUN_AT, cells_changed: 1 }],
      ...extra,
    },
    opts,
  );
}

/** The service role: staff-1 is a platform admin with a real name on file. */
function adminClient() {
  return fakeSupabase({
    profiles: [
      { id: "staff-1", full_name: "Jake Mooney" },
      { id: "user-2", full_name: "Priya" },
    ],
    app_roles: [{ user_id: "staff-1", role: "platform_admin" }],
  }).client;
}

describe("the change log and MAYA support", () => {
  it("names a platform admin who typed a price as MAYA support, not by their name", async () => {
    state.client = seed().client;
    state.admin = adminClient();
    const body = await (await GET()).json();
    const run = body.find((i: { has_changes?: boolean }) => i.has_changes === true);
    expect(run.changes[0].description).toBe("MAYA support set the base rate to $180.00.");
  });

  it("keeps a teammate's own name, and falls back to A manager without a service role", async () => {
    state.client = seed({
      evaluation_audit: [
        {
          id: "audit-1",
          hotel_id: HOTEL,
          evaluation_run_id: "run-1",
          stay_date: "2026-08-02",
          room_type_id: "rt-1",
          evaluated_at: RUN_AT,
          base_price: 180,
          final_price: 180,
          pre_clamp_price: 180,
          floor_price: 100,
          ceiling_price: 400,
          details: { application_order: [], base_source: "manual", manual_override: { set_by: "user-2", set_at: "2026-07-29T07:59:00Z" } },
        },
      ],
    }).client;
    state.admin = adminClient();
    let body = await (await GET()).json();
    expect(body.find((i: { has_changes?: boolean }) => i.has_changes === true).changes[0].description).toBe("Priya set the base rate to $180.00.");

    state.client = seed().client;
    state.admin = null;
    body = await (await GET()).json();
    expect(body.find((i: { has_changes?: boolean }) => i.has_changes === true).changes[0].description).toBe("A manager set the base rate to $180.00.");
  });

  it("heads an answer a platform admin gave as MAYA support's, and names them so in the line", async () => {
    state.client = seed({
      rule_repeat_alert_nights: [
        { hotel_id: HOTEL, rule_id: "rule-1", stay_date: "2026-11-14", choice: "stop", chosen_at: "2026-07-29T09:00:00Z", chosen_by: "staff-1" },
        { hotel_id: HOTEL, rule_id: "rule-1", stay_date: "2026-11-16", choice: "keep_adjusting", chosen_at: "2026-07-29T09:30:00Z", chosen_by: "user-2" },
      ],
    }).client;
    state.admin = adminClient();
    const body = await (await GET()).json();
    const answers = body.filter((i: { kind?: string }) => i.kind === "rule_alert_choice");
    expect(answers).toHaveLength(2);
    const byStaff = answers.find((a: { choice: string }) => a.choice === "stop");
    expect(byStaff.by_support).toBe(true);
    expect(byStaff.title).toBe('MAYA support stopped "Slow-date rescue" on Sat, Nov 14 2026. What it already changed stays.');
    const byOwner = answers.find((a: { choice: string }) => a.choice === "keep_adjusting");
    expect(byOwner.by_support).toBeUndefined();
    expect(byOwner.title).toBe('Priya told "Slow-date rescue" to carry on with Mon, Nov 16 2026.');
  });

  it("shows every change made in God Mode as its own item, where it happened, newest first", async () => {
    state.client = seed({
      support_changes: [
        { id: 1, hotel_id: HOTEL, at: "2026-07-29T09:10:00Z", summary: "Took pricing live.", table_name: "hotel_settings", op: "update" },
        { id: 2, hotel_id: HOTEL, at: "2026-07-29T09:20:00Z", summary: null, table_name: "pricing_rules", op: "delete" },
        { id: 3, hotel_id: "hotel-9", at: "2026-07-29T09:30:00Z", summary: "Someone else's.", table_name: "hotels", op: "update" },
      ],
    }).client;
    state.admin = adminClient();
    const body = await (await GET()).json();
    const support = body.filter((i: { kind?: string }) => i.kind === "support_change");
    expect(support).toEqual([
      { kind: "support_change", id: "2", timestamp: "2026-07-29T09:20:00Z", summary: "Removed a pricing rules row." },
      { kind: "support_change", id: "1", timestamp: "2026-07-29T09:10:00Z", summary: "Took pricing live." },
    ]);
    // Newest first, above the run they came after.
    expect(body.map((i: { kind?: string; has_changes?: boolean }) => i.kind ?? (i.has_changes ? "run" : "quiet"))).toEqual([
      "support_change",
      "support_change",
      "run",
    ]);
  });

  it("shows one save that wrote many rows as one item, the rule's line with its nights", async () => {
    const at = "2026-07-29T09:40:00.000123+00:00";
    const nights = ["2026-08-02", "2026-08-03", "2026-08-04"];
    let id = 10;
    const rows: Row[] = [
      {
        id: id++,
        hotel_id: HOTEL,
        user_id: "admin-1",
        at,
        summary: 'Changed the pricing rule "Slow-date rescue": action_value from 10 to 15.',
        table_name: "pricing_rules",
        op: "update",
        after: { id: "rule-1", hotel_id: HOTEL },
      },
    ];
    for (const d of nights) {
      for (const rt of ["rt-1", "rt-2"]) {
        rows.push({
          id: id++,
          hotel_id: HOTEL,
          user_id: "admin-1",
          at,
          summary: "Added a held day of a rule.",
          table_name: "rule_skip_hold",
          op: "insert",
          after: { rule_id: "rule-1", stay_date: d, room_type_id: rt },
        });
      }
    }
    rows.push({ id: 1, hotel_id: HOTEL, user_id: "admin-1", at: "2026-07-29T09:10:00Z", summary: "Took pricing live.", table_name: "hotel_settings", op: "update" });
    state.client = seed({ support_changes: rows }).client;
    state.admin = adminClient();
    const body = await (await GET()).json();
    expect(body.filter((i: { kind?: string }) => i.kind === "support_change")).toEqual([
      {
        kind: "support_change",
        id: "10",
        timestamp: at,
        summary: 'Changed the pricing rule "Slow-date rescue": action_value from 10 to 15, 3 days.',
      },
      { kind: "support_change", id: "1", timestamp: "2026-07-29T09:10:00Z", summary: "Took pricing live." },
    ]);
  });

  it("shows no support items, and still the runs, on a database without the table yet", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    state.client = seed({}, { missing: ["support_changes"] }).client;
    state.admin = adminClient();
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.some((i: { kind?: string }) => i.kind === "support_change")).toBe(false);
    expect(body.some((i: { has_changes?: boolean }) => i.has_changes === true)).toBe(true);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
