/**
 * GET /api/changelog page by page (A47): the newest page names where the next
 * one starts in its header, `?older=` with that reads the page before it, and
 * the pages between them hold every run that changed a price exactly once,
 * every quiet run counted once, and everything else where it happened, until
 * the last page, which names nothing. Ongoing push problems stay on top of
 * the first page.
 */
import { describe, expect, it, vi } from "vitest";
import { fakeSupabase as sharedFake } from "@/lib/engine/fake-supabase.test";
import { CHANGELOG_OLDER_HEADER } from "@/lib/changelog-paging";

type Row = Record<string, unknown>;

function fake(seed: Record<string, Row[]>) {
  const f = sharedFake(seed);
  return Object.assign(f.client, { auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } });
}

const HOTEL = "hotel-1";
const state = vi.hoisted(() => ({ client: null as unknown, admin: null as unknown }));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("server-only", () => ({}));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.client }));
vi.mock("@/utils/supabase/admin", () => ({ isAdminConfigured: () => state.admin != null, createAdminClient: () => state.admin }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => HOTEL }));

const { GET } = await import("./route");

const HOUR = 3_600_000;
const START = Date.parse("2026-09-01T00:00:00Z");
/** Run n, an hour apart, n = 0 the oldest. Changing runs on even hours, quiet ones on odd. */
const at = (hour: number) => new Date(START + hour * HOUR).toISOString();
const CHANGING = 25;

function seed(): Record<string, Row[]> {
  const audit: Row[] = [];
  const runLog: Row[] = [];
  for (let i = 0; i < CHANGING; i++) {
    const t = at(2 * i);
    runLog.push({ hotel_id: HOTEL, evaluation_run_id: `run-${i}`, evaluated_at: t, cells_changed: 1 });
    audit.push({
      id: `a-${i}`,
      hotel_id: HOTEL,
      evaluation_run_id: `run-${i}`,
      stay_date: "2027-03-12",
      room_type_id: "rt-1",
      evaluated_at: t,
      base_price: 150,
      final_price: 150 + i + 1,
      pre_clamp_price: 150 + i + 1,
      floor_price: 80,
      ceiling_price: 400,
      details: { application_order: [] },
    });
    // A quiet check an hour after each, three of them after the newest.
    runLog.push({ hotel_id: HOTEL, evaluation_run_id: `quiet-${i}`, evaluated_at: at(2 * i + 1), cells_changed: 0 });
  }
  return {
    evaluation_run_log: runLog,
    evaluation_audit: audit,
    hotels: [{ id: HOTEL, currency: "USD", timezone: "UTC" }],
    hotel_settings: [{ hotel_id: HOTEL, simulation_mode: false }],
    room_types: [{ id: "rt-1", hotel_id: HOTEL, name: "Queen" }],
    pricing_rules: [],
    pms_connections: [{ hotel_id: HOTEL, pms_type: "cloudbeds", status: "connected" }],
    // An answer during run 3's hour, and one during run 20's.
    rule_repeat_alert_nights: [
      { hotel_id: HOTEL, rule_id: "gone", stay_date: "2027-03-12", choice: "stop", chosen_at: at(2 * 3 + 0.5), chosen_by: null, resumed_at: null },
      { hotel_id: HOTEL, rule_id: "gone", stay_date: "2027-03-13", choice: "stop", chosen_at: at(2 * 20 + 0.5), chosen_by: null, resumed_at: null },
    ],
    rate_push_incidents: [
      // Still open: the first page's top only.
      { id: "inc-open", hotel_id: HOTEL, pms_type: "cloudbeds", cause: "auth", opened_at: at(2), attempt_count: 1, attempts_stored: 0, resolved_at: null, resolution: null, admin_only: false, customer_visible_at: at(2) },
      // Ended during run 5's hour: on the second page, which holds runs 5 to 14.
      { id: "inc-ended", hotel_id: HOTEL, pms_type: "cloudbeds", cause: "auth", opened_at: at(9), attempt_count: 1, attempts_stored: 0, resolved_at: at(2 * 5 + 0.5), resolution: "recovered", admin_only: false, customer_visible_at: at(9) },
    ],
  };
}

type Item = { kind?: string; changes?: { new_rate: number }[]; checks?: number; timestamp: string; id?: string };

async function page(older: string | null) {
  const req = new Request(`http://maya.test/api/changelog${older ? `?older=${encodeURIComponent(older)}` : ""}`);
  const res = await GET(req);
  const body = (await res.json()) as Item[];
  return { status: res.status, items: body, older: res.headers.get(CHANGELOG_OLDER_HEADER) };
}

describe("GET /api/changelog, page by page", () => {
  it("covers every run once across the pages, and says where each next page starts", async () => {
    state.client = fake(seed());
    state.admin = fake(seed());
    const pages = [];
    let older: string | null = null;
    for (let i = 0; i < 5; i++) {
      const p = await page(older);
      expect(p.status).toBe(200);
      pages.push(p);
      older = p.older;
      if (!older) break;
    }
    expect(pages).toHaveLength(3);
    // The first page stops at the 11th newest change, and the next page starts with it.
    expect(pages[0].older).toBe(at(2 * 14));
    const runs = pages.map((p) => p.items.filter((i) => i.changes).map((i) => i.changes![0].new_rate));
    expect(runs.map((r) => r.length)).toEqual([10, 10, 5]);
    const all = runs.flat();
    expect(all).toEqual(Array.from({ length: CHANGING }, (_, i) => 150 + CHANGING - i));

    // Every quiet check counted once, on the page whose stretch holds it.
    const quiet = pages.flatMap((p) => p.items.filter((i) => i.kind === "quiet_checks").map((i) => i.checks ?? 0));
    expect(quiet.reduce((a, b) => a + b, 0)).toBe(CHANGING);

    // Each page is newest first, and older than the page above.
    const stamps = pages.flatMap((p) => p.items.filter((i) => i.kind !== "push_problem").map((i) => Date.parse(i.timestamp)));
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
  });

  it("puts what else happened on the page that holds its time, and ongoing problems on the first page only", async () => {
    state.client = fake(seed());
    state.admin = fake(seed());
    const first = await page(null);
    const second = await page(first.older);
    const third = await page(second.older);
    const kinds = (items: Item[]) => items.filter((i) => i.kind === "rule_alert_choice" || i.kind === "push_problem").map((i) => i.id);
    expect(kinds(first.items)).toEqual(["inc-open", expect.stringContaining("gone|stop|")]);
    expect(kinds(second.items)).toEqual(["inc-ended"]);
    expect(kinds(third.items)).toEqual([expect.stringContaining("gone|stop|")]);
  });

  it("refuses a page link that isn't an instant", async () => {
    state.client = fake(seed());
    state.admin = fake(seed());
    expect((await page("not-a-time")).status).toBe(400);
  });

  it("names no older page when the first one reaches the first run on record", async () => {
    const small = seed();
    small.evaluation_run_log = (small.evaluation_run_log ?? []).filter((r) => Date.parse(String(r.evaluated_at)) >= START + 40 * HOUR);
    state.client = fake(small);
    state.admin = fake(small);
    const only = await page(null);
    expect(only.older).toBeNull();
    expect(only.items.filter((i) => i.changes)).toHaveLength(5);
  });
});
