import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DISPATCH_BUSY_RETRY_MS,
  DISPATCH_BUSY_WAIT_MS,
  DISPATCH_LEASE_SECONDS,
  DUE_SLACK_SECONDS,
  claimDispatchedHotel,
  claimDispatchedHotelWaiting,
  healthyReleaseIntervalSeconds,
  MIN_HEALTHY_GAP_SECONDS,
  orderClaimedByDue,
  runScheduledHotels,
  type ScheduledLoopConfig,
} from "../../../supabase/functions/_shared/pms/scheduled-loop";
import { fakeSupabase } from "../engine/fake-supabase.test";

const config: ScheduledLoopConfig = {
  invocationBudgetMs: 330_000,
  minHotelReserveMs: 30_000,
  evalReserveMs: 60_000,
  syncBudgetMs: 210_000,
  minEvalMs: 30_000,
};

function harness(
  durations: Record<string, number>,
  opts: { throws?: string } = {},
) {
  let clock = 1_000_000;
  const events: string[] = [];
  const deadlines: Record<string, number> = {};
  const evaluateBy: Record<string, number> = {};
  const logs: Record<string, unknown>[] = [];
  const deps = {
    now: () => clock,
    processHotel: async (id: string, deadlineAt: number, _invocationDeadline: number, evalBy: number) => {
      events.push(`process:${id}`);
      deadlines[id] = deadlineAt;
      evaluateBy[id] = evalBy;
      clock += durations[id] ?? 1000;
      if (opts.throws === id) throw new Error("boom");
      events.push(`release:${id}`);
    },
    handBack: async (id: string) => {
      events.push(`handBack:${id}`);
    },
    releaseFailed: async (id: string) => {
      events.push(`releaseFailed:${id}`);
    },
    log: (line: Record<string, unknown>) => logs.push(line),
  };
  return { deps, events, deadlines, evaluateBy, logs, start: clock };
}

describe("runScheduledHotels", () => {
  it("hands back every hotel it has no time to start, once, and releases each started hotel once", async () => {
    const h = harness({ big: 250_000, a: 5_000, b: 5_000, c: 5_000 });
    const res = await runScheduledHotels(["big", "a", "b", "c"], h.start, config, h.deps);
    expect(res.started).toEqual(["big"]);
    expect(res.handedBack).toEqual(["a", "b", "c"]);
    expect(h.events).toEqual(["process:big", "release:big", "handBack:a", "handBack:b", "handBack:c"]);
    expect(h.logs.find((l) => l.step === "out_of_time")).toMatchObject({ handedBack: 3 });
  });

  it("keeps going while there is time for a hotel as slow as the slowest so far", async () => {
    const h = harness({ a: 40_000, b: 40_000, c: 40_000, d: 40_000, e: 40_000, f: 40_000, g: 40_000, i: 40_000 });
    const res = await runScheduledHotels(["a", "b", "c", "d", "e", "f", "g", "i"], h.start, config, h.deps);
    // 330s budget, 40s each: after 7 hotels 50s remain, above the 40s reserve;
    // after 8 there would be 10s, but there are no more.
    expect(res.started).toEqual(["a", "b", "c", "d", "e", "f", "g", "i"]);
    expect(res.handedBack).toEqual([]);
    const h2 = harness({ a: 100_000, b: 100_000, c: 100_000, d: 100_000 });
    const res2 = await runScheduledHotels(["a", "b", "c", "d"], h2.start, config, h2.deps);
    expect(res2.started).toEqual(["a", "b", "c"]);
    expect(res2.handedBack).toEqual(["d"]);
  });

  it("gives each hotel's PMS read a deadline that leaves the evaluation its reserve", async () => {
    const h = harness({ a: 100_000, b: 10_000 });
    await runScheduledHotels(["a", "b"], h.start, config, h.deps);
    // a: its own 210s read budget ends before the invocation needs it back.
    expect(h.deadlines.a).toBe(h.start + 210_000);
    // b starts 100s in: its 210s budget would overrun, so it stops 60s before the invocation's end.
    expect(h.deadlines.b).toBe(h.start + 330_000 - 60_000);
  });

  it("tells each hotel the last moment it may still start evaluating", async () => {
    const h = harness({ a: 1000 });
    await runScheduledHotels(["a"], h.start, config, h.deps);
    // 30s before the invocation's budget ends, still well inside the wall clock.
    expect(h.evaluateBy.a).toBe(h.start + 330_000 - 30_000);
  });

  it("keeps the full evaluate reserve for a large hotel after small, quick ones", async () => {
    // Small hotels first, then a big one: the cut-off must not shrink to what
    // the small ones took, or the big one starts an evaluation it can't finish.
    const h = harness({ small1: 1000, small2: 1000, big: 1000 });
    await runScheduledHotels(["small1", "small2", "big"], h.start, config, h.deps);
    const cutOff = h.start + config.invocationBudgetMs - config.minEvalMs;
    expect(h.evaluateBy.small1).toBe(cutOff);
    expect(h.evaluateBy.small2).toBe(cutOff);
    expect(h.evaluateBy.big).toBe(cutOff);
  });

  it("releases a hotel whose work throws and carries on", async () => {
    const h = harness({ a: 1000, b: 1000 }, { throws: "a" });
    const res = await runScheduledHotels(["a", "b"], h.start, config, h.deps);
    expect(res.crashed).toEqual(["a"]);
    expect(h.events).toEqual(["process:a", "releaseFailed:a", "process:b", "release:b"]);
  });
});

describe("claimDispatchedHotel", () => {
  function client(answer: { data: unknown; error: { message: string } | null }) {
    const calls: [string, Record<string, unknown>][] = [];
    const c = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push([fn, args]);
        return answer;
      },
    } as unknown as SupabaseClient;
    return { c, calls };
  }

  it("takes the same lease a cron claim does, for longer than one invocation", async () => {
    const { c, calls } = client({ data: "claimed", error: null });
    expect(await claimDispatchedHotel(c, "cloudbeds", "h1", "worker-1", () => {})).toBe("claimed");
    expect(calls).toEqual([
      ["claim_pms_sync_one", { p_hotel_id: "h1", p_pms_type: "cloudbeds", p_lease_seconds: DISPATCH_LEASE_SECONDS, p_owner: "worker-1" }],
    ]);
    expect(DISPATCH_LEASE_SECONDS).toBeGreaterThan(400);
  });

  it("steps aside while another run holds the hotel", async () => {
    expect(await claimDispatchedHotel(client({ data: "busy", error: null }).c, "think", "h1", "w", () => {})).toBe("busy");
  });

  it("runs unleased only when there is no connection row to hold", async () => {
    expect(await claimDispatchedHotel(client({ data: "missing", error: null }).c, "mews", "h1", "w", () => {})).toBe("unleased");
  });

  it("steps aside rather than run unleased when the claim errors or answers something unknown", async () => {
    // The cron may hold this hotel's lease right now; running anyway pushed the
    // same rates twice.
    const logs: Record<string, unknown>[] = [];
    expect(
      await claimDispatchedHotel(client({ data: null, error: { message: "timeout" } }).c, "mews", "h1", "w", (l) => logs.push(l)),
    ).toBe("busy");
    expect(await claimDispatchedHotel(client({ data: null, error: null }).c, "cloudbeds", "h1", "w", (l) => logs.push(l))).toBe("busy");
    expect(logs).toEqual([
      expect.objectContaining({ step: "dispatch_claim", error: "timeout", treatedAs: "busy" }),
      expect.objectContaining({ step: "dispatch_claim", answer: "null", treatedAs: "busy" }),
    ]);
  });
});

describe("claimDispatchedHotelWaiting", () => {
  /** An answer of "error" makes that claim fail the way a dropped connection does. */
  function scripted(answers: string[]) {
    let clock = 5_000_000;
    const startedAt = clock;
    const tries: number[] = [];
    const sleeps: number[] = [];
    const c = {
      rpc: async () => {
        tries.push(clock - startedAt);
        // Each claim round trip takes a little time too.
        clock += 150;
        const data = answers.length > 1 ? answers.shift() : answers[0];
        return data === "error" ? { data: null, error: { message: "connection reset" } } : { data, error: null };
      },
    } as unknown as SupabaseClient;
    const fakeClock = {
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    };
    return { c, fakeClock, startedAt, tries, sleeps, elapsed: () => clock - startedAt };
  }

  it("claims straight away when the hotel is free, without sleeping", async () => {
    const s = scripted(["claimed"]);
    expect(await claimDispatchedHotelWaiting(s.c, "cloudbeds", "h1", "w", () => {}, s.startedAt, s.fakeClock)).toBe("claimed");
    expect(s.sleeps).toEqual([]);
  });

  it("tries again every 3s while busy and runs once the holder lets go", async () => {
    const s = scripted(["busy", "busy", "busy", "claimed"]);
    const logs: Record<string, unknown>[] = [];
    const claim = await claimDispatchedHotelWaiting(s.c, "think", "h1", "w", (l) => logs.push(l), s.startedAt, s.fakeClock);
    expect(claim).toBe("claimed");
    expect(s.tries).toHaveLength(4);
    expect(s.sleeps).toEqual([DISPATCH_BUSY_RETRY_MS, DISPATCH_BUSY_RETRY_MS, DISPATCH_BUSY_RETRY_MS]);
    expect(logs.find((l) => l.step === "dispatch_claim_waited")).toMatchObject({ tries: 4, claim: "claimed" });
  });

  it("gives up as busy about a minute after the invocation started", async () => {
    const s = scripted(["busy"]);
    const logs: Record<string, unknown>[] = [];
    const claim = await claimDispatchedHotelWaiting(s.c, "mews", "h1", "w", (l) => logs.push(l), s.startedAt, s.fakeClock);
    expect(claim).toBe("busy");
    expect(DISPATCH_BUSY_WAIT_MS).toBe(60_000);
    expect(DISPATCH_BUSY_RETRY_MS).toBe(3_000);
    // Never sleeps past the minute, and uses nearly all of it.
    expect(s.elapsed()).toBeLessThanOrEqual(DISPATCH_BUSY_WAIT_MS);
    expect(s.elapsed()).toBeGreaterThan(DISPATCH_BUSY_WAIT_MS - DISPATCH_BUSY_RETRY_MS - 1_000);
    expect(s.tries.length).toBeGreaterThanOrEqual(18);
    expect(logs.filter((l) => l.step === "dispatch_busy")).toHaveLength(1);
  });

  it("counts the minute from the invocation's start, not from the first try", async () => {
    const s = scripted(["busy"]);
    // 58s already gone before the claim: one try, no sleep.
    const claim = await claimDispatchedHotelWaiting(s.c, "cloudbeds", "h1", "w", () => {}, s.startedAt - 58_000, s.fakeClock);
    expect(claim).toBe("busy");
    expect(s.tries).toHaveLength(1);
    expect(s.sleeps).toEqual([]);
  });

  it("stops waiting and runs unleased once the connection row is gone", async () => {
    const s = scripted(["busy", "missing"]);
    expect(await claimDispatchedHotelWaiting(s.c, "cloudbeds", "h1", "w", () => {}, s.startedAt, s.fakeClock)).toBe("unleased");
    expect(s.sleeps).toHaveLength(1);
  });

  it("never runs a hotel unleased on a claim that errors: tries again, then steps aside", async () => {
    const recovers = scripted(["error", "claimed"]);
    expect(await claimDispatchedHotelWaiting(recovers.c, "cloudbeds", "h1", "w", () => {}, recovers.startedAt, recovers.fakeClock)).toBe(
      "claimed",
    );
    expect(recovers.sleeps).toEqual([DISPATCH_BUSY_RETRY_MS]);

    const down = scripted(["error"]);
    const logs: Record<string, unknown>[] = [];
    expect(await claimDispatchedHotelWaiting(down.c, "think", "h1", "w", (l) => logs.push(l), down.startedAt, down.fakeClock)).toBe("busy");
    expect(logs.filter((l) => l.step === "dispatch_busy")).toHaveLength(1);
  });
});

describe("healthyReleaseIntervalSeconds", () => {
  const TICK_MS = 300_000;

  /**
   * A 5-minute cron over an hour, the way release_pms_sync and
   * claim_pms_sync_batch treat one hotel: each invocation starts a little
   * after its tick and claims once, a claimed hotel is leased until its
   * release, and the release makes it due `interval` seconds after it.
   */
  function simulate(intervalFor: (startedAt: number, releasedAt: number) => number, latencyMs: (tick: number) => number, workMs: (tick: number) => number) {
    let dueAt = 0;
    let leasedUntil = 0;
    const runs: { claimedAt: number; releasedAt: number }[] = [];
    for (let tick = 0; tick < 12; tick++) {
      const startedAt = tick * TICK_MS + latencyMs(tick);
      const claimedAt = startedAt + 300;
      if (dueAt > claimedAt || leasedUntil > claimedAt) continue;
      const releasedAt = claimedAt + workMs(tick);
      leasedUntil = releasedAt;
      dueAt = releasedAt + intervalFor(startedAt, releasedAt) * 1000;
      runs.push({ claimedAt, releasedAt });
    }
    return runs;
  }

  it("counts the interval from the invocation's start, less the slack", () => {
    expect(healthyReleaseIntervalSeconds(300, 1_000_000, 1_004_000)).toBe(300 - 4 - DUE_SLACK_SECONDS);
    expect(healthyReleaseIntervalSeconds(600, 1_000_000, 1_000_000)).toBe(600 - DUE_SLACK_SECONDS);
  });

  it("waits the floor after its release when the invocation ran near or past the point it would have been due", () => {
    expect(healthyReleaseIntervalSeconds(300, 1_000_000, 1_000_000 + 320_000)).toBe(MIN_HEALTHY_GAP_SECONDS);
    expect(healthyReleaseIntervalSeconds(300, 1_000_000, 1_000_000 + 250_000)).toBe(MIN_HEALTHY_GAP_SECONDS);
    // Counted from the start while that is longer.
    expect(healthyReleaseIntervalSeconds(300, 1_000_000, 1_000_000 + 200_000)).toBe(70);
    // Never longer than the interval itself.
    expect(healthyReleaseIntervalSeconds(40, 1_000_000, 1_000_000 + 60_000)).toBe(40);
  });

  it("syncs a hotel every tick, where counting from the release synced it every other tick", () => {
    // Production: released about 4 seconds in, due 5 minutes after that.
    const latency = () => 1_500;
    const work = () => 4_000;
    expect(simulate(() => 300, latency, work)).toHaveLength(6);
    expect(simulate((startedAt, releasedAt) => healthyReleaseIntervalSeconds(300, startedAt, releasedAt), latency, work)).toHaveLength(12);
  });

  it("keeps every tick however late the cron started it", () => {
    const runs = simulate(
      (startedAt, releasedAt) => healthyReleaseIntervalSeconds(300, startedAt, releasedAt),
      (tick) => [200, 25_000, 3_000, 800][tick % 4],
      (tick) => [5_000, 40_000, 60_000, 90_000][tick % 4] - [200, 25_000, 3_000, 800][tick % 4],
    );
    expect(runs).toHaveLength(12);
    // Never claimed while it was still running.
    for (let i = 1; i < runs.length; i++) expect(runs[i].claimedAt).toBeGreaterThanOrEqual(runs[i - 1].releasedAt);
  });

  it("never syncs a hotel released near the end of its invocation again seconds later", () => {
    // A large property that takes most of every invocation.
    const latency = () => 1_000;
    const work = () => 294_000;
    const gaps = (runs: { claimedAt: number; releasedAt: number }[]) =>
      runs.slice(1).map((r, i) => r.claimedAt - runs[i].releasedAt);
    // Due at once, it was taken by the next invocation seconds after it finished.
    const dueAtOnce = simulate((startedAt, releasedAt) => Math.max(0, Math.floor(300 - (releasedAt - startedAt) / 1000 - DUE_SLACK_SECONDS)), latency, work);
    expect(Math.min(...gaps(dueAtOnce))).toBeLessThan(10_000);
    const runs = simulate((startedAt, releasedAt) => healthyReleaseIntervalSeconds(300, startedAt, releasedAt), latency, work);
    expect(Math.min(...gaps(runs))).toBeGreaterThanOrEqual(MIN_HEALTHY_GAP_SECONDS * 1000);
    expect(runs).toHaveLength(6);
  });

  it("waits for the tick after when the run was still going at the next tick's claim", () => {
    const runs = simulate(
      (startedAt, releasedAt) => healthyReleaseIntervalSeconds(300, startedAt, releasedAt),
      () => 1_000,
      (tick) => (tick === 0 ? 310_000 : 5_000),
    );
    expect(runs.map((r) => Math.floor(r.claimedAt / TICK_MS))).toEqual([0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});

describe("orderClaimedByDue", () => {
  const rows = [
    { hotel_id: "h-late", pms_type: "cloudbeds", sync_due_at: "2026-09-17T12:04:00Z" },
    { hotel_id: "h-early", pms_type: "cloudbeds", sync_due_at: "2026-09-17T12:00:00Z" },
    { hotel_id: "h-mid", pms_type: "cloudbeds", sync_due_at: "2026-09-17T12:02:00Z" },
    { hotel_id: "h-early", pms_type: "think", sync_due_at: "2026-09-17T13:00:00Z" },
  ];

  it("puts the most overdue claimed hotel first, and one with no due time last", async () => {
    const d = fakeSupabase({ pms_connections: rows });
    const log: Record<string, unknown>[] = [];
    expect(await orderClaimedByDue(d.client, "cloudbeds", ["h-late", "h-gone", "h-early", "h-mid"], (l) => log.push(l))).toEqual([
      "h-early",
      "h-mid",
      "h-late",
      "h-gone",
    ]);
    expect(log).toEqual([]);
  });

  it("keeps the claim's order when the read fails, and reads nothing for one hotel", async () => {
    const d = fakeSupabase({ pms_connections: rows }, { fault: () => ({ code: "57014", message: "statement timeout" }) });
    const log: Record<string, unknown>[] = [];
    expect(await orderClaimedByDue(d.client, "cloudbeds", ["h-late", "h-early"], (l) => log.push(l))).toEqual(["h-late", "h-early"]);
    expect(log).toEqual([{ step: "order_claimed", error: "statement timeout" }]);
    expect(await orderClaimedByDue(d.client, "cloudbeds", ["h-late"], () => {})).toEqual(["h-late"]);
    expect(d.calls.filter((c) => c.table === "pms_connections")).toHaveLength(1);
  });
});
