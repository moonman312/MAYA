import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DISPATCH_BUSY_RETRY_MS,
  DISPATCH_BUSY_WAIT_MS,
  DISPATCH_LEASE_SECONDS,
  EVAL_RESERVE_FLOOR_MS,
  claimDispatchedHotel,
  claimDispatchedHotelWaiting,
  runScheduledHotels,
  type ScheduledLoopConfig,
} from "../../../supabase/functions/_shared/pms/scheduled-loop";

const config: ScheduledLoopConfig = {
  invocationBudgetMs: 330_000,
  minHotelReserveMs: 30_000,
  evalReserveMs: 60_000,
  syncBudgetMs: 210_000,
  minEvalMs: 30_000,
};

function harness(
  durations: Record<string, number>,
  opts: { throws?: string; evalMs?: Record<string, number> } = {},
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
      return opts.evalMs?.[id];
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

  it("sizes the evaluate cut-off from the slowest evaluation so far, between the floor and minEvalMs", async () => {
    const end = (h: { start: number }) => h.start + config.invocationBudgetMs;
    const h = harness(
      { a: 1000, b: 1000, c: 1000, d: 1000, e: 1000 },
      { evalMs: { a: 8_000, b: 2_000, c: 45_000 } },
    );
    await runScheduledHotels(["a", "b", "c", "d", "e"], h.start, config, h.deps);
    // Nothing measured yet: the first hotel keeps the full minEvalMs.
    expect(h.evaluateBy.a).toBe(end(h) - 30_000);
    // a took 8s to evaluate and push, so b keeps back 8s.
    expect(h.evaluateBy.b).toBe(end(h) - 8_000);
    // b was quicker; the slowest still rules.
    expect(h.evaluateBy.c).toBe(end(h) - 8_000);
    // c took 45s: capped at minEvalMs.
    expect(h.evaluateBy.d).toBe(end(h) - 30_000);
    expect(h.evaluateBy.e).toBe(end(h) - 30_000);

    const fast = harness({ a: 1000, b: 1000 }, { evalMs: { a: 700 } });
    await runScheduledHotels(["a", "b"], fast.start, config, fast.deps);
    // A very quick evaluation never shrinks the reserve below the floor.
    expect(fast.evaluateBy.b).toBe(end(fast) - EVAL_RESERVE_FLOOR_MS);
  });

  it("lets a small hotel late in the batch evaluate instead of skipping after its read", async () => {
    // Ten 29s hotels that each spend 4s evaluating: the eleventh starts with
    // 40s left, reads for 20s and has 20s to go. A flat 30s cut-off skipped it.
    const durations: Record<string, number> = {};
    const evalMs: Record<string, number> = {};
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(`h${i}`);
      durations[`h${i}`] = 29_000;
      evalMs[`h${i}`] = 4_000;
    }
    ids.push("tail");
    durations.tail = 20_000;
    const h = harness(durations, { evalMs });
    const res = await runScheduledHotels(ids, h.start, config, h.deps);
    expect(res.started).toContain("tail");
    const readDoneAt = h.start + 10 * 29_000 + 20_000;
    expect(readDoneAt).toBeGreaterThan(h.start + config.invocationBudgetMs - config.minEvalMs);
    expect(readDoneAt).toBeLessThanOrEqual(h.evaluateBy.tail);
  });

  it("ignores a hotel that reports no evaluation time", async () => {
    const h = harness({ a: 1000, b: 1000 }, { evalMs: {} });
    await runScheduledHotels(["a", "b"], h.start, config, h.deps);
    expect(h.evaluateBy.b).toBe(h.start + config.invocationBudgetMs - config.minEvalMs);
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

  it("runs unleased with no connection row, or when the claim cannot be read", async () => {
    const logs: Record<string, unknown>[] = [];
    expect(await claimDispatchedHotel(client({ data: "missing", error: null }).c, "mews", "h1", "w", () => {})).toBe("unleased");
    expect(
      await claimDispatchedHotel(client({ data: null, error: { message: "timeout" } }).c, "mews", "h1", "w", (l) => logs.push(l)),
    ).toBe("unleased");
    expect(logs).toHaveLength(1);
  });
});

describe("claimDispatchedHotelWaiting", () => {
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
        return { data, error: null };
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

  it("stops waiting and runs unleased when the claim cannot be read", async () => {
    const s = scripted(["busy", "missing"]);
    expect(await claimDispatchedHotelWaiting(s.c, "cloudbeds", "h1", "w", () => {}, s.startedAt, s.fakeClock)).toBe("unleased");
    expect(s.sleeps).toHaveLength(1);
  });
});
