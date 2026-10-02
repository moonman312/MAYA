/**
 * previewFingerprint, the check the activation popup's Apply and Skip are
 * saved on: the same data gives the same fingerprint whatever order the
 * network answers its reads in, and anything that could change the popup's
 * days gives another. Made-up data.
 */
import { describe, expect, it } from "vitest";
import { fakeSupabase, type FakeRow } from "@/lib/engine/fake-supabase.test";
import { previewFingerprint } from "@/lib/rule-preview";
import { reorderingReads } from "@/lib/rule-preview-fixture.test";

const H = "h1";
const AT = "2026-10-01T14:10:00.000Z";

function tables(): Record<string, FakeRow[]> {
  return {
    hotels: [{ id: H, timezone: "America/New_York" }],
    evaluation_run_log: [{ hotel_id: H, evaluated_at: "2026-10-01T14:05:00.000Z", run_kind: "nights" }],
    pricing_dirty_nights: [{ hotel_id: H, stay_date: "2026-10-12", mark_seq: 41 }],
    hotel_pricing_state: [{ hotel_id: H, full_reprice_seq: 7 }],
    pricing_rules: [
      { id: "r1", hotel_id: H, version: 1, is_active: true, updated_at: "2026-09-30T10:00:00.000Z", skip_at: null },
      { id: "r2", hotel_id: H, version: 3, is_active: false, updated_at: "2026-09-30T11:00:00.000Z", skip_at: null },
    ],
  };
}

describe("previewFingerprint", () => {
  it("is the same for the same data, whichever order its reads come back in", async () => {
    const reorder = reorderingReads();
    const db = fakeSupabase(tables(), { beforeCall: reorder });
    const prints = [];
    // Four requests, each answered in another order.
    for (let i = 0; i < 4; i++) prints.push(await previewFingerprint(db.client, H, AT));
    expect(new Set(prints).size).toBe(1);
    expect(prints[0]).toBe(await previewFingerprint(fakeSupabase(tables()).client, H, AT));
  });

  it("changes with anything that could change the popup's days", async () => {
    const base = await previewFingerprint(fakeSupabase(tables()).client, H, AT);
    const changed = (edit: (t: Record<string, FakeRow[]>) => void) => {
      const t = tables();
      edit(t);
      return previewFingerprint(fakeSupabase(t).client, H, AT);
    };
    const moved = await Promise.all([
      changed((t) => t.evaluation_run_log.push({ hotel_id: H, evaluated_at: "2026-10-01T14:09:00.000Z", run_kind: "nights" })),
      changed((t) => t.pricing_dirty_nights.push({ hotel_id: H, stay_date: "2026-10-13", mark_seq: 42 })),
      changed((t) => (t.hotel_pricing_state[0].full_reprice_seq = 8)),
      changed((t) => (t.pricing_rules[1].is_active = true)),
      changed((t) => (t.hotels[0].timezone = "America/Denver")),
    ]);
    for (const m of moved) expect(m).not.toBe(base);
    // A run with nothing to price moves nothing.
    expect(await changed((t) => t.evaluation_run_log.push({ hotel_id: H, evaluated_at: "2026-10-01T14:09:00.000Z", run_kind: "idle" }))).toBe(base);
    // The next day is another day.
    expect(await previewFingerprint(fakeSupabase(tables()).client, H, "2026-10-02T14:10:00.000Z")).not.toBe(base);
  });
});
