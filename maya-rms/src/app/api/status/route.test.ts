import { describe, expect, it, vi } from "vitest";
import { fakeSupabase, type FakeRow } from "@/lib/engine/fake-supabase.test";

const state = vi.hoisted(() => ({ admin: null as unknown }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => state.admin }));

const { GET } = await import("./route");

describe("GET /api/status", () => {
  it("counts every request in the window past the 1,000-row cap", async () => {
    const now = Date.now();
    const log: FakeRow[] = [];
    for (let i = 0; i < 4000; i++) {
      log.push({
        id: `q${i}`,
        pms_type: i % 3 === 0 ? "mews" : "cloudbeds",
        ok: i % 40 !== 0,
        created_at: new Date(now - (i % 2 === 0 ? 1000 : 2 * 86_400_000)).toISOString(),
      });
    }
    const run = async (rows: FakeRow[], maxRows?: number) => {
      state.admin = fakeSupabase(
        { pms_request_log: rows, evaluation_run_log: [{ evaluated_at: new Date(now - 60_000).toISOString() }] },
        maxRows ? { maxRows } : {},
      ).client;
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

  it("gives the same integrations as counting the rows did, on a small log", async () => {
    const now = Date.now();
    const log: FakeRow[] = [
      { id: "1", pms_type: "think", ok: true, created_at: new Date(now - 1000).toISOString() },
      { id: "2", pms_type: "think", ok: false, created_at: new Date(now - 1000).toISOString() },
      { id: "3", pms_type: "cloudbeds", ok: true, created_at: new Date(now - 1000).toISOString() },
      { id: "4", pms_type: "cloudbeds", ok: true, created_at: new Date(now - 3 * 86_400_000).toISOString() },
    ];
    state.admin = fakeSupabase({ pms_request_log: log, evaluation_run_log: [] }).client;
    const body = await (await GET()).json();
    expect(body.integrations.map((i: { pms: string; requests: number }) => [i.pms, i.requests])).toEqual([
      ["cloudbeds", 1],
      ["think", 2],
    ]);
  });
});
