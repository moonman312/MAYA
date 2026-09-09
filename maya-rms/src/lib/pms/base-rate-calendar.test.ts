/**
 * The calendar is the hotel's own rate. The rule that keeps it that way is
 * that a cell MAYA has already pushed to is never re-captured — after we push,
 * the PMS is quoting our own adjustment back at us.
 */
import { describe, expect, it, vi } from "vitest";
import { seedBaseRateCalendar } from "./base-rate-calendar";
import type { PmsRatePushAdapter } from "../../../supabase/functions/_shared/pms/rate-push";
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;

function makeSupabase(opts: {
  roomTypes?: Row[];
  pushed?: Row[];
  upsertError?: string;
}) {
  const upserts: Row[][] = [];
  const supabase = {
    from(table: string) {
      if (table === "base_rate_calendar") {
        return {
          upsert(rows: Row[]) {
            upserts.push(rows);
            return Promise.resolve({ error: opts.upsertError ? { message: opts.upsertError } : null });
          },
        };
      }
      const data = table === "room_types" ? (opts.roomTypes ?? []) : (opts.pushed ?? []);
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte", "lte"]) {
        q[m] = () => q;
      }
      // Every chain in the seeder ends by awaiting the builder.
      (q as { then: unknown }).then = (res: (v: { data: Row[] }) => unknown) => res({ data });
      return q;
    },
  } as unknown as SupabaseClient;
  return { supabase, upserts };
}

const ROOM_TYPES = [
  { id: "local-1", external_room_type_id: "EXT-1" },
  { id: "local-2", external_room_type_id: "EXT-2" },
];

function makeAdapter(entries: { stayDate: string; externalRoomTypeId: string; price: number }[]) {
  const calls: unknown[][] = [];
  const adapter = {
    pmsType: "think",
    resolveRateTargets: async () => ({ "EXT-1": "rate-a", "EXT-2": "rate-a" }),
    pushCells: async () => [],
    fetchRateCalendar: async (...args: unknown[]) => {
      calls.push(args);
      return entries;
    },
  } as unknown as PmsRatePushAdapter;
  return { adapter, calls };
}

describe("seedBaseRateCalendar", () => {
  it("captures the PMS rate for each cell, mapped to local room type ids", async () => {
    const { supabase, upserts } = makeSupabase({ roomTypes: ROOM_TYPES });
    const { adapter } = makeAdapter([
      { stayDate: "2026-10-01", externalRoomTypeId: "EXT-1", price: 200 },
      { stayDate: "2026-10-01", externalRoomTypeId: "EXT-2", price: 240 },
    ]);

    const res = await seedBaseRateCalendar(supabase, "h1", adapter, { horizonDays: 3, today: "2026-10-01" });

    expect(res).toMatchObject({ ok: true, captured: 2, skippedAlreadyPushed: 0 });
    expect(upserts[0]).toEqual([
      expect.objectContaining({ hotel_id: "h1", stay_date: "2026-10-01", room_type_id: "local-1", price: 200, source: "pms" }),
      expect.objectContaining({ room_type_id: "local-2", price: 240 }),
    ]);
  });

  it("never re-captures a cell MAYA has already pushed to", async () => {
    // The whole safety property: that PMS number is our own adjustment.
    const { supabase, upserts } = makeSupabase({
      roomTypes: ROOM_TYPES,
      pushed: [{ stay_date: "2026-10-01", room_type_id: "local-1" }],
    });
    const { adapter } = makeAdapter([
      { stayDate: "2026-10-01", externalRoomTypeId: "EXT-1", price: 230 }, // ours, tainted
      { stayDate: "2026-10-01", externalRoomTypeId: "EXT-2", price: 240 }, // untouched
    ]);

    const res = await seedBaseRateCalendar(supabase, "h1", adapter, { horizonDays: 3, today: "2026-10-01" });

    expect(res).toMatchObject({ ok: true, captured: 1, skippedAlreadyPushed: 1 });
    expect(upserts[0]).toHaveLength(1);
    expect(upserts[0][0]).toMatchObject({ room_type_id: "local-2", price: 240 });
  });

  it("ignores rates for room types this hotel does not track", async () => {
    const { supabase, upserts } = makeSupabase({ roomTypes: ROOM_TYPES });
    const { adapter } = makeAdapter([
      { stayDate: "2026-10-01", externalRoomTypeId: "EXT-UNKNOWN", price: 999 },
      { stayDate: "2026-10-01", externalRoomTypeId: "EXT-1", price: 200 },
    ]);

    const res = await seedBaseRateCalendar(supabase, "h1", adapter, { horizonDays: 1, today: "2026-10-01" });

    expect(res).toMatchObject({ captured: 1 });
    expect(upserts[0][0]).toMatchObject({ room_type_id: "local-1" });
  });

  it("asks the PMS for exactly the horizon window", async () => {
    const { supabase } = makeSupabase({ roomTypes: ROOM_TYPES });
    const { adapter, calls } = makeAdapter([]);
    await seedBaseRateCalendar(supabase, "h1", adapter, { horizonDays: 45, today: "2026-10-01" });
    expect(calls[0][0]).toBe("2026-10-01");
    expect(calls[0][1]).toBe("2026-11-14"); // 45 days inclusive
  });

  it("reports unsupported rather than failing when an adapter has no rate read", async () => {
    const { supabase } = makeSupabase({ roomTypes: ROOM_TYPES });
    const adapter = { pmsType: "mews", resolveRateTargets: async () => ({}), pushCells: async () => [] } as unknown as PmsRatePushAdapter;
    expect(await seedBaseRateCalendar(supabase, "h1", adapter)).toEqual({ ok: false, reason: "unsupported", captured: 0 });
  });

  it("logs and keeps going when a chunk fails to write", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { supabase } = makeSupabase({ roomTypes: ROOM_TYPES, upsertError: "statement timeout" });
    const { adapter } = makeAdapter([{ stayDate: "2026-10-01", externalRoomTypeId: "EXT-1", price: 200 }]);
    const res = await seedBaseRateCalendar(supabase, "h1", adapter, { horizonDays: 1, today: "2026-10-01" });
    expect(res).toMatchObject({ ok: true });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
