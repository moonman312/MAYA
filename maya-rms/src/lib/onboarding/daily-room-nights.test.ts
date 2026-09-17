/**
 * onboarding_daily_room_nights returns one row per stay date. Ten years is
 * over 3,600 of them, and an unpaged rpc stops at PostgREST's 1,000, keeping
 * only the oldest dates.
 */
import { describe, expect, it } from "vitest";
import { findClosedPeriods } from "../../../supabase/functions/_shared/onboarding/analysis";
import {
  computeOccupancyReference,
  computeStarterRules,
  loadDailyRoomNights,
} from "../../../supabase/functions/_shared/onboarding/generate-rules";
import { FakeRpcError, fakeSupabase } from "../engine/fake-supabase.test";

const TODAY = "2026-09-16";

function series(days: number) {
  const out: { stay_date: string; room_nights: number }[] = [];
  const start = Date.UTC(2016, 8, 1);
  for (let i = 0; i < days; i++) {
    const d = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    // A closed month every January, and a busy summer.
    const month = Number(d.slice(5, 7));
    if (month === 1 && Number(d.slice(0, 4)) >= 2024) continue;
    out.push({ stay_date: d, room_nights: month >= 6 && month <= 8 ? 90 : 40 + (i % 17) });
  }
  return out;
}

describe("loadDailyRoomNights", () => {
  it("reads every date past the 1,000-row cap, and everything built on it matches the full series", async () => {
    const full = series(3800);
    expect(full.length).toBeGreaterThan(3000);
    const { client } = fakeSupabase({}, {
      maxRows: 1000,
      // The rpc returns dates in order; the fake applies .order/.range and the cap.
      rpc: (fn) => (fn === "onboarding_daily_room_nights" ? [...full].reverse() : undefined),
    });
    const got = await loadDailyRoomNights(client, "h1");
    expect(got).toEqual(full);

    const unpaged = full.slice(0, 1000);
    expect(findClosedPeriods(got, TODAY)).toEqual(findClosedPeriods(full, TODAY));
    expect(findClosedPeriods(unpaged, TODAY)).not.toEqual(findClosedPeriods(full, TODAY));
    const occ = (s: typeof full) => s.filter((x) => x.stay_date < TODAY).map((x) => Math.min(1, x.room_nights / 100));
    expect(computeOccupancyReference(occ(got))).toEqual(computeOccupancyReference(occ(full)));
    const days = (s: typeof full) => s.filter((x) => x.stay_date < TODAY).length;
    expect(computeStarterRules({ daysOfHistory: days(got) })).toEqual(computeStarterRules({ daysOfHistory: days(full) }));
  });

  it("throws on a failed page instead of analysing a fragment", async () => {
    const { client } = fakeSupabase({}, { rpc: () => new FakeRpcError({ code: "57014", message: "statement timeout" }) });
    await expect(loadDailyRoomNights(client, "h1")).rejects.toThrow(/statement timeout/);
  });
});
