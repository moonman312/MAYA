import { describe, expect, it, vi } from "vitest";
import { FakeRpcError, fakeSupabase, type FakeRow } from "@/lib/engine/fake-supabase.test";
import { engineFromWatchdog } from "@/lib/pms/engine-status";

const state = vi.hoisted(() => ({ admin: null as unknown }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => state.admin }));

const { GET } = await import("./route");

const LIVE = "00000000-0000-4000-8000-00000000a001";
const SIM = "00000000-0000-4000-8000-00000000a002";
const TEST = "00000000-0000-4000-8000-00000000a003";
const MIN = 60_000;

/** A row as pricing_watchdog(p_post := false) returns it. */
function watched(hotelId: string, mode: "live" | "simulation", opts: { behind?: boolean; passLate?: boolean; lastRunAt?: string | null } = {}): FakeRow {
  return {
    hotel_id: hotelId,
    name: hotelId,
    mode,
    severity: mode === "live" ? "critical" : "warn",
    behind: opts.behind ?? false,
    pass_late: opts.passLate ?? false,
    last_run_at: opts.lastRunAt === undefined ? new Date(Date.now() - 4 * MIN).toISOString() : opts.lastRunAt,
    action: opts.behind || opts.passLate ? "dry_run" : "ok",
  };
}

/** A database with the watchdog (rows) or without it (rows null: the migration has not run). */
function db(tables: Record<string, FakeRow[]>, rows: FakeRow[] | null, extra: { maxRows?: number } = {}) {
  return fakeSupabase(
    { hotels: [], pms_request_log: [], evaluation_run_log: [], ...tables },
    {
      ...extra,
      rpc: (fn) => {
        if (fn !== "pricing_watchdog") return undefined;
        return rows ?? new FakeRpcError({ code: "PGRST202", message: "Could not find the function public.pricing_watchdog" });
      },
    },
  ).client;
}

describe("GET /api/status", () => {
  it("counts every request in the window past the 1,000-row cap", async () => {
    const now = Date.now();
    const log: FakeRow[] = [];
    for (let i = 0; i < 4000; i++) {
      log.push({
        id: `q${i}`,
        hotel_id: LIVE,
        pms_type: i % 3 === 0 ? "mews" : "cloudbeds",
        ok: i % 40 !== 0,
        created_at: new Date(now - (i % 2 === 0 ? 1000 : 2 * 86_400_000)).toISOString(),
      });
    }
    const run = async (rows: FakeRow[], maxRows?: number) => {
      state.admin = db({ pms_request_log: rows }, [watched(LIVE, "live")], maxRows ? { maxRows } : {});
      return (await GET()).json();
    };
    const body = await run(log, 1000);
    const byPms = Object.fromEntries(body.integrations.map((i: { pms: string; requests: number }) => [i.pms, i.requests]));
    const inWindow = log.filter((r) => Date.parse(String(r.created_at)) > now - 86_400_000);
    expect(byPms.cloudbeds).toBe(inWindow.filter((r) => r.pms_type === "cloudbeds").length);
    expect(byPms.mews).toBe(inWindow.filter((r) => r.pms_type === "mews").length);
    expect(byPms.cloudbeds).toBeGreaterThan(1000);
    expect(body.integrations.map((i: { pms: string }) => i.pms)).toEqual(["cloudbeds", "mews"]);
  });

  it("gives the same integrations as counting the rows did, on a small log, and leaves test hotels' traffic out", async () => {
    const now = Date.now();
    const log: FakeRow[] = [
      { id: "1", hotel_id: LIVE, pms_type: "think", ok: true, created_at: new Date(now - 1000).toISOString() },
      { id: "2", hotel_id: LIVE, pms_type: "think", ok: false, created_at: new Date(now - 1000).toISOString() },
      { id: "3", hotel_id: LIVE, pms_type: "cloudbeds", ok: true, created_at: new Date(now - 1000).toISOString() },
      { id: "4", hotel_id: LIVE, pms_type: "cloudbeds", ok: true, created_at: new Date(now - 3 * 86_400_000).toISOString() },
      // The sandbox failing all day says nothing about Cloudbeds.
      ...Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, hotel_id: TEST, pms_type: "cloudbeds", ok: false, created_at: new Date(now - 1000).toISOString() })),
    ];
    state.admin = db({ pms_request_log: log, hotels: [{ id: TEST, is_test: true }, { id: LIVE, is_test: false }] }, [watched(LIVE, "live")]);
    const res = await GET();
    const body = await res.json();
    expect(body.integrations.map((i: { pms: string; requests: number; state: string }) => [i.pms, i.requests, i.state])).toEqual([
      ["cloudbeds", 1, "healthy"],
      ["think", 2, "down"],
    ]);
    expect(body.status).toBe("down");
    expect(res.status).toBe(503);
  });

  it("is down (503) when a live hotel has had no pricing run for 30 minutes, whatever a test hotel is doing", async () => {
    const now = Date.now();
    state.admin = db(
      { evaluation_run_log: [{ hotel_id: TEST, evaluated_at: new Date(now - MIN).toISOString() }] },
      [watched(LIVE, "live", { behind: true, lastRunAt: new Date(now - 47 * MIN).toISOString() }), watched(SIM, "simulation")],
    );
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.status).toBe("down");
    expect(body.engine).toMatchObject({ state: "down", hotels: 2, behind: 1, passLate: 0, simulatingBehind: 0, minutesAgo: 4 });
  });

  it("is degraded for a late daily pass or a simulating hotel behind, healthy when every watched hotel is fine, unknown with none", async () => {
    const check = async (rows: FakeRow[]) => {
      state.admin = db({}, rows);
      const res = await GET();
      const body = await res.json();
      return { http: res.status, status: body.status, engine: body.engine };
    };
    expect(await check([watched(LIVE, "live", { passLate: true })])).toMatchObject({ http: 200, status: "degraded", engine: { state: "degraded", passLate: 1 } });
    expect(await check([watched(LIVE, "live"), watched(SIM, "simulation", { behind: true })])).toMatchObject({
      http: 200,
      status: "degraded",
      engine: { state: "degraded", behind: 0, simulatingBehind: 1 },
    });
    expect(await check([watched(LIVE, "live"), watched(SIM, "simulation")])).toMatchObject({ http: 200, status: "operational", engine: { state: "healthy", hotels: 2 } });
    expect(await check([])).toMatchObject({ http: 200, status: "unknown", engine: { state: "unknown", hotels: 0, note: "no_hotels_watched", lastRunAt: null } });
  });

  it("before the watchdog migration, goes by the newest run of any hotel and says so", async () => {
    const now = Date.now();
    state.admin = db({ evaluation_run_log: [{ hotel_id: LIVE, evaluated_at: new Date(now - 16 * MIN).toISOString() }] }, null);
    let res = await GET();
    let body = await res.json();
    expect(res.status).toBe(503);
    expect(body.engine).toMatchObject({ state: "down", minutesAgo: 16, note: "watchdog_migration_missing" });
    state.admin = db({ evaluation_run_log: [{ hotel_id: LIVE, evaluated_at: new Date(now - 2 * MIN).toISOString() }] }, null);
    res = await GET();
    body = await res.json();
    expect(res.status).toBe(200);
    expect(body.engine).toMatchObject({ state: "healthy", minutesAgo: 2, note: "watchdog_migration_missing" });
  });

  it("admits it broke with a 503 rather than a 500", async () => {
    state.admin = fakeSupabase({}, { rpc: () => new FakeRpcError({ code: "57014", message: "canceling statement due to statement timeout" }) }).client;
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "unknown" });
  });
});

describe("engineFromWatchdog", () => {
  const now = Date.parse("2026-09-30T03:00:00Z");
  it("takes the newest run over the rows, and a live hotel behind over everything else", () => {
    const rows = [
      { hotel_id: "a", mode: "live", behind: true, pass_late: true, last_run_at: "2026-09-30T02:00:00Z" },
      { hotel_id: "b", mode: "simulation", behind: false, pass_late: false, last_run_at: "2026-09-30T02:58:00Z" },
      { hotel_id: "c", mode: "live", behind: false, pass_late: false, last_run_at: null },
    ];
    expect(engineFromWatchdog(rows, now)).toEqual({
      state: "down",
      lastRunAt: "2026-09-30T02:58:00.000Z",
      minutesAgo: 2,
      hotels: 3,
      behind: 1,
      passLate: 1,
      simulatingBehind: 0,
    });
  });
});
