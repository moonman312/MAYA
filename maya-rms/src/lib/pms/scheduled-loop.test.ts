import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DISPATCH_LEASE_SECONDS,
  claimDispatchedHotel,
  runScheduledHotels,
  type ScheduledLoopConfig,
} from "../../../supabase/functions/_shared/pms/scheduled-loop";

const config: ScheduledLoopConfig = {
  invocationBudgetMs: 330_000,
  minHotelReserveMs: 30_000,
  evalReserveMs: 60_000,
  syncBudgetMs: 210_000,
};

function harness(durations: Record<string, number>, opts: { throws?: string } = {}) {
  let clock = 1_000_000;
  const events: string[] = [];
  const deadlines: Record<string, number> = {};
  const logs: Record<string, unknown>[] = [];
  const deps = {
    now: () => clock,
    processHotel: async (id: string, deadlineAt: number) => {
      events.push(`process:${id}`);
      deadlines[id] = deadlineAt;
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
  return { deps, events, deadlines, logs, start: clock };
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
