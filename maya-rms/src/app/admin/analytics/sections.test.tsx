/**
 * The analytics page's sections rendered to markup, over kept numbers: the
 * tiles and lists say what the numbers mean in plain words, and a section
 * whose numbers could not be had says so in place without taking the rest
 * down.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsNow, AnalyticsRange } from "@/lib/admin/analytics";

const kept = vi.hoisted(() => ({
  now: null as unknown,
  range: null as unknown,
  product: null as unknown,
  push: null as unknown,
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/lib/admin/analytics-cache", () => {
  const give = (v: unknown) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  return {
    analyticsNow: () => give(kept.now),
    analyticsRange: () => give(kept.range),
    productAnalytics: () => give(kept.product),
    pushProblemAnalytics: () => give(kept.push),
  };
});

const S = await import("./sections");
const { AnalyticsMigrationMissing } = await import("@/lib/admin/analytics");

const html = async (el: Promise<React.ReactNode> | React.ReactNode) => renderToStaticMarkup(<>{await el}</>);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const NOW: AnalyticsNow = {
  listMrrCents: 50_000,
  netMrrCents: 42_000,
  payingCount: 3,
  trialingCount: 1,
  trialPotentialCents: 9_000,
  byBracket: [{ label: "1–20", count: 3, netMrrCents: 42_000 }],
  liveCount: 3,
  simulationCount: 1,
  attention: {
    cardTrouble: [],
    roomShortfall: [],
    syncBroken: [{ hotelId: "c", name: "Cedar House", pmsType: "cloudbeds", status: "error" }],
    engineSilent: [{ hotelId: "b", name: "Birch Lodge" }],
  },
};
const RANGE: AnalyticsRange = {
  series: [],
  newPaying: [{ hotelId: "d", name: "Dogwood Rooms", day: "2026-09-27" }],
  wonBack: [{ hotelId: "c", name: "Cedar House", day: "2026-09-15" }],
  churned: [{ hotelId: "c", name: "Cedar House", day: "2026-09-10" }],
  funnel: [{ stage: "Accounts created", count: 3 }],
  medianHoursToLive: 10.2,
};
const WINDOW = { from: "2026-09-01", to: "2026-09-30", includeTest: false, words: "last 30 days" };
const stamp = (value: unknown, computedAt = "2026-09-30T14:05:00.000Z") => ({ value, computedAt });

beforeEach(() => {
  kept.now = stamp(NOW);
  kept.range = stamp(RANGE);
  kept.product = stamp({ available: false, reason: "Run the product migration." });
  kept.push = stamp({ available: true, causes: [], open: [] });
});

describe("the analytics sections", () => {
  it("says what was gained and lost in the window's own words", async () => {
    const t = text(await html(S.GainedLostTile(WINDOW)));
    expect(t).toContain("Gained / lost");
    expect(t).toContain("+2 / −1");
    expect(t).toContain("last 30 days · 10h median to first price");
    expect(t).not.toContain("Range:");
  });

  it("names the money tiles plainly", async () => {
    const t = text(await html(S.NowTiles({ includeTest: false })));
    expect(t).toContain("Net MRR $420");
    expect(t).toContain("$500 before discounts");
    expect(t).toContain("On trial 1");
    expect(t).toContain("$90/mo if they all pay");
  });

  it("lists who needs attention, with no dashes to decode", async () => {
    const t = text(await html(S.NeedsAttention({ includeTest: false })));
    expect(t).toContain("Needs attention (2)");
    expect(t).toContain("Cedar House: cloudbeds error");
    expect(t).toContain("Served, but no pricing run in 24 hours");
    expect(t).not.toContain("—");
  });

  it("titles the signup funnel with the window", async () => {
    expect(text(await html(S.Signups(WINDOW)))).toContain("Signups, last 30 days");
  });

  it("says which file to run when the database hasn't got the functions yet, section by section", async () => {
    kept.range = new AnalyticsMigrationMissing();
    const t = text(await html(S.Charts(WINDOW)));
    expect(t).toContain("Run 99_supabase_migration_command_center_speed_v1.sql to see these.");
    // The sections that don't need it still show.
    expect(text(await html(S.NowTiles({ includeTest: false })))).toContain("Net MRR");
  });

  it("keeps any other failure to its own section and the log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    kept.now = new Error("statement timeout");
    expect(text(await html(S.RevenueBySize({ includeTest: false })))).toContain("Could not load these numbers. The server log has the error.");
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("says as of the oldest kept number", async () => {
    kept.push = stamp({ available: true, causes: [], open: [] }, "2026-09-30T14:01:00.000Z");
    const t = text(await html(S.AsOf({ ...WINDOW, today: "2026-09-30" })));
    expect(t).toBe("as of 14:01 UTC");
  });

  it("dates the as of when it was not today, so an old page never reads as fresh", async () => {
    kept.now = stamp(NOW, "2026-09-29T23:58:00.000Z");
    const t = text(await html(S.AsOf({ ...WINDOW, today: "2026-09-30" })));
    expect(t).toBe("as of Sep 29, 23:58 UTC");
  });

  it("passes the product half's own reason through", async () => {
    expect(text(await html(S.Product(WINDOW)))).toContain("Run the product migration.");
  });

  it("names the signup code behind each source for a platform admin only", async () => {
    kept.product = stamp({
      available: true,
      walkedAwaySummary: [],
      walkedAway: [],
      funnel: [],
      timeToValue: [],
      trials: [],
      retention: null,
      cancellations: [],
      acquisition: [
        { channel: "direct", code: "PILOT2026", subscriptions: 2, trialing_now: 2, paying_now: 0, lost_now: 0, billed_rooms: 30 },
        { channel: "direct", code: "DRIFTWOOD", subscriptions: 1, trialing_now: 0, paying_now: 1, lost_now: 0, billed_rooms: 12 },
        { channel: "direct", code: "(no code)", subscriptions: 1, trialing_now: 0, paying_now: 1, lost_now: 0, billed_rooms: 9 },
      ],
      events: [
        { event: "signup_code.redeemed", detail: "(all)", occurrences: 3, properties: 3, users: 3, quantity: null },
        { event: "signup_code.redeemed", detail: "PILOT2026", occurrences: 2, properties: 2, users: 2, quantity: null },
        { event: "signup_code.redeemed", detail: "DRIFTWOOD", occurrences: 1, properties: 1, users: 1, quantity: null },
      ],
      health: [],
      groups: [],
      book: null,
    });
    const admin = text(await html(S.Product({ ...WINDOW, showCodes: true })));
    expect(admin).toContain("direct · PILOT2026 2");
    expect(admin).toContain("direct · DRIFTWOOD 1");
    for (const out of [text(await html(S.Product(WINDOW))), text(await html(S.Product({ ...WINDOW, showCodes: false })))]) {
      expect(out).not.toMatch(/PILOT2026|DRIFTWOOD/);
      expect(out).toContain("direct · code 3 2 1 0 42");
      expect(out).toContain("direct · (no code) 1 0 1 0 9");
    }
  });
});
