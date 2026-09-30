import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  countOf,
  formatDuration,
  isMissingFunction,
  isoWeek,
  loadProductAnalytics,
  withoutSignupCodes,
  type AcquisitionRow,
  type EventCountRow,
  type ProductAnalytics,
} from "./product-analytics";

describe("isoWeek", () => {
  it("runs Monday to Sunday, whichever day it is asked about", () => {
    // 2026-09-16 is a Wednesday.
    expect(isoWeek("2026-09-16")).toEqual({ from: "2026-09-14", to: "2026-09-20" });
    expect(isoWeek("2026-09-14")).toEqual({ from: "2026-09-14", to: "2026-09-20" });
    expect(isoWeek("2026-09-20")).toEqual({ from: "2026-09-14", to: "2026-09-20" });
  });

  it("crosses a month and a year without drifting", () => {
    expect(isoWeek("2027-01-01")).toEqual({ from: "2026-12-28", to: "2027-01-03" });
  });
});

describe("formatDuration", () => {
  it("picks the unit a person would say", () => {
    expect(formatDuration(0.25)).toBe("15m");
    expect(formatDuration(3.46)).toBe("3.5h");
    expect(formatDuration(72)).toBe("3d");
    expect(formatDuration(null)).toBe("—");
  });
});

describe("countOf", () => {
  const events: EventCountRow[] = [
    { event: "rule.created", detail: "(all)", occurrences: 5, properties: 2, users: 2, quantity: null },
    { event: "rule.created", detail: "owner", occurrences: 2, properties: 2, users: 2, quantity: null },
    { event: "rule.created", detail: "starter", occurrences: 3, properties: 1, users: 0, quantity: null },
    { event: "manual_price.set", detail: "(all)", occurrences: 4, properties: 1, users: 1, quantity: 31 },
  ];

  it("reads the counted total, not a sum of details that would double-count properties", () => {
    expect(countOf(events, "rule.created")).toEqual({ occurrences: 5, properties: 2, quantity: 0 });
  });

  it("reads one detail when asked", () => {
    expect(countOf(events, "rule.created", "starter").occurrences).toBe(3);
    expect(countOf(events, "manual_price.set").quantity).toBe(31);
  });

  it("reads zero for an event that never happened", () => {
    expect(countOf(events, "explain.opened")).toEqual({ occurrences: 0, properties: 0, quantity: 0 });
  });
});

describe("loadProductAnalytics", () => {
  it("says the panel needs its migration instead of failing the page", async () => {
    const ssr = {
      rpc: async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.analytics_book" } }),
    } as unknown as SupabaseClient;
    const res = await loadProductAnalytics(ssr, "2026-09-14", "2026-09-20", false);
    expect(res.available).toBe(false);
  });

  it("throws on any other failure, so it is logged rather than shown as zeros", async () => {
    const ssr = {
      rpc: async () => ({ data: null, error: { code: "42501", message: "Not authorized" } }),
    } as unknown as SupabaseClient;
    await expect(loadProductAnalytics(ssr, "2026-09-14", "2026-09-20", false)).rejects.toThrow("Not authorized");
  });

  it("passes the window and the test switch to every range function", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const ssr = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { data: [], error: null };
      },
    } as unknown as SupabaseClient;
    const res = await loadProductAnalytics(ssr, "2026-09-14", "2026-09-20", true);
    expect(res.available).toBe(true);
    for (const c of calls.filter((c) => c.name !== "analytics_book")) {
      expect(c.args).toEqual({ p_from: "2026-09-14", p_to: "2026-09-20", p_include_test: true });
    }
    expect(calls.find((c) => c.name === "analytics_book")?.args).toEqual({ p_include_test: true });
  });
});

describe("isMissingFunction", () => {
  it("recognises only a missing function", () => {
    expect(isMissingFunction({ code: "42883", message: "function does not exist" })).toBe(true);
    expect(isMissingFunction({ code: "42501", message: "Not authorized" })).toBe(false);
    expect(isMissingFunction(null)).toBe(false);
  });
});

describe("withoutSignupCodes", () => {
  const source = (channel: string, code: string, subscriptions: number, rooms: number): AcquisitionRow => ({
    channel,
    code,
    subscriptions,
    trialing_now: subscriptions,
    paying_now: 0,
    lost_now: 0,
    billed_rooms: rooms,
  });
  const product = (acquisition: AcquisitionRow[], events: EventCountRow[]) =>
    ({ available: true, acquisition, events }) as unknown as ProductAnalytics;
  const redeemed = (detail: string | null, occurrences: number): EventCountRow => ({
    event: "signup_code.redeemed",
    detail,
    occurrences,
    properties: occurrences,
    users: occurrences,
    quantity: null,
  });

  it("says a code was used, never which, and adds up the sources that then read the same", () => {
    const out = withoutSignupCodes(
      product(
        [
          source("direct", "PILOT2026", 2, 30),
          source("direct", "(no code)", 4, 50),
          source("direct", "DRIFTWOOD", 1, 12),
          source("marketplace", "deleted code", 1, 8),
        ],
        [redeemed("(all)", 3), redeemed("PILOT2026", 2), redeemed("DRIFTWOOD", 1), { ...redeemed("owner", 5), event: "rule.created" }],
      ),
    );
    expect(out.available && out.acquisition).toEqual([
      source("direct", "(no code)", 4, 50),
      source("direct", "code", 3, 42),
      source("marketplace", "code", 1, 8),
    ]);
    expect(out.available && out.events).toEqual([redeemed("(all)", 3), { ...redeemed("owner", 5), event: "rule.created" }]);
    expect(JSON.stringify(out)).not.toMatch(/PILOT2026|DRIFTWOOD|deleted code/);
  });

  it("leaves a panel with nothing to show as it is", () => {
    const missing = { available: false, reason: "Run the migration." } as const;
    expect(withoutSignupCodes(missing)).toBe(missing);
  });
});
