/**
 * GET /api/changelog: a live change speaks for the night's price ("Sent to
 * Cloudbeds.", "Waiting to be sent ...") only when its run wrote the night's
 * newest audit row, read from the data. What a page happens to show does not
 * decide it: not the page a change is on, and not a later change hidden past
 * the MAX_ENTRIES_PER_CYCLE a run shows.
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
const at = (hour: number) => new Date(START + hour * HOUR).toISOString();
const NIGHT = "2027-03-12";

const auditRow = (id: string, runId: string, t: string, over: Row = {}): Row => ({
  id,
  hotel_id: HOTEL,
  evaluation_run_id: runId,
  stay_date: NIGHT,
  room_type_id: "rt-1",
  evaluated_at: t,
  base_price: 150,
  final_price: 160,
  pre_clamp_price: 160,
  floor_price: 80,
  ceiling_price: 400,
  details: { application_order: [] },
  ...over,
});

const ledgerRow = (price: number, pushedAt: string): Row => ({
  hotel_id: HOTEL,
  room_type_id: "rt-1",
  stay_date: NIGHT,
  status: "sent",
  price,
  error: null,
  attempts: 1,
  pms_job_reference: "job-1",
  pushed_at: pushedAt,
});

function base(audit: Row[], runLog: Row[], ledger: Row[], published: number): Record<string, Row[]> {
  return {
    evaluation_audit: audit,
    evaluation_run_log: runLog,
    hotels: [{ id: HOTEL, currency: "USD", timezone: "UTC" }],
    hotel_settings: [{ hotel_id: HOTEL, simulation_mode: false }],
    room_types: [
      { id: "rt-1", hotel_id: HOTEL, name: "Queen" },
      { id: "rt-2", hotel_id: HOTEL, name: "King" },
    ],
    pricing_rules: [],
    pms_connections: [{ hotel_id: HOTEL, pms_type: "cloudbeds", status: "connected" }],
    hotel_mode_history: [{ hotel_id: HOTEL, since: "-infinity", simulated: false, recorded_at: at(0) }],
    published_price: [{ hotel_id: HOTEL, stay_date: NIGHT, room_type_id: "rt-1", price: published }],
    rate_updates: ledger,
  };
}

type Entry = { new_rate: number; stay_date?: string; room_type_id?: string; send_line?: string };
type Item = { changes?: Entry[]; timestamp: string };

async function page(older: string | null) {
  const res = await GET(new Request(`http://maya.test/api/changelog${older ? `?older=${encodeURIComponent(older)}` : ""}`));
  const items = (await res.json()) as Item[];
  expect(res.status, JSON.stringify(items)).toBe(200);
  return { items, older: res.headers.get(CHANGELOG_OLDER_HEADER) };
}

/** 25 live runs change the night, an hour apart; run 14 sets $175, runs 15 to 23 move it, run 24 sets $175 again. */
function ladderSeed(ledger: Row[]): Record<string, Row[]> {
  const audit: Row[] = [];
  const runLog: Row[] = [];
  for (let i = 0; i < 25; i++) {
    const price = i === 14 || i === 24 ? 175 : 150 + i + 1;
    audit.push(auditRow(`a-${i}`, `run-${i}`, at(i), { final_price: price, pre_clamp_price: price }));
    runLog.push({ hotel_id: HOTEL, evaluation_run_id: `run-${i}`, evaluated_at: at(i), cells_changed: 1 });
  }
  return base(audit, runLog, ledger, 175);
}

const runLine = (items: Item[], hour: number) => items.find((i) => i.timestamp === at(hour))?.changes?.[0]?.send_line;

describe("GET /api/changelog: which change speaks for the night's price", () => {
  it("gives an older change on page 2 no line when a later run, on page 1, set the same price", async () => {
    for (const ledger of [[ledgerRow(174, at(24.1))], [ledgerRow(175, at(24.1))]]) {
      state.client = fake(ladderSeed(ledger));
      state.admin = fake(ladderSeed(ledger));
      const first = await page(null);
      const second = await page(first.older);
      expect(second.items.some((i) => i.timestamp === at(14))).toBe(true);
      // Run 14's $175 was replaced by run 15: the ledger's row is run 24's (or older), never run 14's.
      expect(runLine(second.items, 14)).toBeUndefined();
      // Run 24 wrote the night's newest row, so it has the ledger's reading.
      expect(runLine(first.items, 24)).toBe(ledger[0].price === 175 ? "Sent to Cloudbeds." : "Waiting to be sent to Cloudbeds.");
      // Nothing else on either page claims anything.
      const lines = [...first.items, ...second.items].flatMap((i) => i.changes ?? []).filter((c) => c.send_line);
      expect(lines).toHaveLength(1);
    }
  });

  it("gives a shown change no line when a later run changed the night past the 40 changes it shows", async () => {
    // Run A sets the night to $160. Run B moves 40 other nights by more and
    // the night itself to $160 again (another reason), so its change is the
    // 41st and not shown. The ledger holds no send at $160 yet.
    const audit: Row[] = [auditRow("a-a", "run-a", at(1))];
    for (let n = 0; n < 40; n++) {
      const stay = new Date(Date.parse("2027-04-01T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
      audit.push(auditRow(`b-${n}`, "run-b", at(2), { stay_date: stay, room_type_id: "rt-2", final_price: 300, pre_clamp_price: 300 }));
    }
    audit.push(auditRow("b-night", "run-b", at(2), { details: { application_order: ["ladder:gone"] } }));
    const runLog = [
      { hotel_id: HOTEL, evaluation_run_id: "run-a", evaluated_at: at(1), cells_changed: 1 },
      { hotel_id: HOTEL, evaluation_run_id: "run-b", evaluated_at: at(2), cells_changed: 41 },
    ];
    const seed = base(audit, runLog, [ledgerRow(150, at(0.5))], 160);
    state.client = fake(seed);
    state.admin = fake(seed);
    const { items } = await page(null);
    const runB = items.find((i) => i.timestamp === at(2));
    expect(runB?.changes).toHaveLength(40);
    expect(runB?.changes?.some((c) => c.stay_date === NIGHT)).toBe(false);
    // Before: run A was the newest change shown for the night, so it read "Waiting to be sent".
    expect(runLine(items, 1)).toBeUndefined();
  });

  it("still gives the night's newest change its line", async () => {
    const audit = [auditRow("a-a", "run-a", at(1))];
    const runLog = [{ hotel_id: HOTEL, evaluation_run_id: "run-a", evaluated_at: at(1), cells_changed: 1 }];
    const seed = base(audit, runLog, [ledgerRow(160, at(1.1))], 160);
    state.client = fake(seed);
    state.admin = fake(seed);
    expect(runLine((await page(null)).items, 1)).toBe("Sent to Cloudbeds.");
  });
});
