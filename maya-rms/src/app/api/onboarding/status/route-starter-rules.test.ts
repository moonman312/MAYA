/**
 * The review's go-live card lists the starter rules an import built. "Get
 * suggestions from my data" points the review at a job of its own that builds
 * none, so the status hands back the rules on record, not the newest job's.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { table: string; filters: Array<[string, ...unknown[]]> };

const state = vi.hoisted(() => ({
  jobs: {} as Record<string, { stats: Record<string, unknown> }>,
  /** What the "newest job with starter rules" read finds. */
  onRecord: null as { stats: Record<string, unknown> } | null,
  questions: {} as Record<string, unknown>,
  calls: [] as Call[],
}));

function builder(table: string) {
  const call: Call = { table, filters: [] };
  state.calls.push(call);
  const answer = () => {
    if (table === "onboarding_states") {
      return { data: { path: "guided", import_job_id: "job-new", questions: state.questions, review_completed_at: null }, error: null };
    }
    if (table === "hotels") return { data: { name: "The Harbour Inn", currency: "USD" }, error: null };
    if (table === "hotel_settings") return { data: { simulation_mode: true }, error: null };
    if (table === "pms_connections") return { data: [{ pms_type: "cloudbeds", status: "connected" }], error: null };
    if (table === "onboarding_findings") return { data: null, error: null, count: 0 };
    if (table === "import_jobs") {
      const byId = call.filters.find((f) => f[0] === "eq" && f[1] === "id");
      if (byId) return { data: state.jobs[String(byId[2])] ?? null, error: null };
      return { data: state.onRecord, error: null };
    }
    return { data: null, error: null };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {};
  for (const m of ["select", "eq", "not", "order", "limit", "in"]) {
    b[m] = (...args: unknown[]) => (call.filters.push([m, ...args]), b);
  }
  b.maybeSingle = async () => answer();
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answer()).then(resolve);
  return b;
}

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => "hotel-1" }));
vi.mock("@/utils/supabase/admin", () => ({ isAdminConfigured: () => false, createAdminClient: () => null }));
vi.mock("@/lib/pms/pricing-window", () => ({ pricingHorizonDays: () => 396 }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => builder(table),
  }),
}));

const { GET } = await import("./route");

const busyNights = { name: "Busy nights", explanation: "Raises busy nights." };

beforeEach(() => {
  state.jobs = {};
  state.onRecord = null;
  state.questions = {};
  state.calls = [];
});

describe("the starter rules the review's go-live card lists", () => {
  it("come from the import that built them when a suggestions read is the newest job", async () => {
    state.jobs["job-new"] = { stats: { mode: "refresh" } };
    state.onRecord = { stats: { starterRules: [busyNights] } };
    const body = await (await GET()).json();
    expect(body.starterRules).toEqual([busyNights]);
    expect(body.job.stats).toEqual({ mode: "refresh" });
    const lookup = state.calls.find((c) => c.table === "import_jobs" && c.filters.some((f) => f[0] === "not"));
    expect(lookup?.filters).toEqual(
      expect.arrayContaining([
        ["eq", "hotel_id", "hotel-1"],
        ["not", "stats->starterRules", "is", null],
        ["order", "created_at", { ascending: false }],
      ]),
    );
  });

  it("are the set the last question swapped in, with its note, when they come from an older import", async () => {
    const copied = { name: "Nearly full raise", explanation: "Copies your own raise." };
    state.jobs["job-new"] = { stats: { mode: "refresh" } };
    state.onRecord = {
      stats: {
        starterRules: [busyNights],
        starterRuleSets: {
          none: { rules: [busyNights] },
          automate_current: { rules: [copied], note: "Only one move of yours to copy." },
        },
      },
    };
    state.questions = { starterRulesFor: "automate_current" };
    const body = await (await GET()).json();
    expect(body.starterRules).toEqual([copied]);
    expect(body.starterRulesNote).toBe("Only one move of yours to copy.");
  });

  it("are the newest job's own when it built them, with no second read", async () => {
    state.jobs["job-new"] = { stats: { starterRules: [busyNights] } };
    const body = await (await GET()).json();
    expect(body.starterRules).toEqual([busyNights]);
    expect(state.calls.filter((c) => c.table === "import_jobs")).toHaveLength(1);
  });

  it("are empty when no import built any", async () => {
    state.jobs["job-new"] = { stats: { mode: "refresh" } };
    const body = await (await GET()).json();
    expect(body.starterRules).toEqual([]);
  });
});
