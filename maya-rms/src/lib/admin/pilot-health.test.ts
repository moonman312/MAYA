import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { loadPilotHealth } from "./pilot-health";
import type { PilotHealthRow } from "./pilot-health-assess";

const row = (o: Partial<PilotHealthRow>): PilotHealthRow => ({
  hotel_id: "hotel-1",
  name: "Harbour Inn",
  timezone: "UTC",
  is_test: false,
  mode: "live",
  subscription_status: "active",
  pms_type: "mews",
  pms_status: "connected",
  last_sync_at: null,
  down_since: null,
  sync_failures: 0,
  last_ok_run_at: null,
  pass_date: null,
  pass_cursor: null,
  pass_started_at: null,
  pass_completed_at: null,
  pass_horizon_days: null,
  dirty_count: 0,
  dirty_oldest_marked_at: null,
  sent_24h: 0,
  open_incidents: 0,
  open_incidents_since: null,
  open_incidents_admin_only: 0,
  open_incident_causes: [],
  active_rules: 0,
  rule_changes_24h: 0,
  ...o,
});

describe("loadPilotHealth", () => {
  it("says the page needs its migration instead of failing", async () => {
    const ssr = {
      rpc: async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.platform_pilot_health" } }),
    } as unknown as SupabaseClient;
    const res = await loadPilotHealth(ssr, { includeTest: false });
    expect(res).toEqual({ available: false, reason: "Run 99_supabase_migration_pilot_health_v1.sql to see this." });
  });

  it("throws on any other failure, so it is logged rather than shown as an empty list", async () => {
    const ssr = {
      rpc: async () => ({ data: null, error: { code: "42501", message: "Not authorized" } }),
    } as unknown as SupabaseClient;
    await expect(loadPilotHealth(ssr, { includeTest: false })).rejects.toThrow("Not authorized");
  });

  it("reads every property once and holds the test ones back unless asked, counting what it hid", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const ssr = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return {
          data: [row({ hotel_id: "a" }), row({ hotel_id: "b", name: "Sandbox Inn", is_test: true })],
          error: null,
        };
      },
    } as unknown as SupabaseClient;

    const hidden = await loadPilotHealth(ssr, { includeTest: false });
    expect(hidden).toMatchObject({ available: true, hiddenTest: 1 });
    expect(hidden.available && hidden.rows.map((r) => r.hotel_id)).toEqual(["a"]);

    const shown = await loadPilotHealth(ssr, { includeTest: true });
    expect(shown).toMatchObject({ available: true, hiddenTest: 0 });
    expect(shown.available && shown.rows.map((r) => r.hotel_id)).toEqual(["a", "b"]);

    expect(calls).toEqual([
      { name: "platform_pilot_health", args: { p_include_test: true } },
      { name: "platform_pilot_health", args: { p_include_test: true } },
    ]);
  });

  it("reads no rows as an empty list", async () => {
    const ssr = { rpc: async () => ({ data: null, error: null }) } as unknown as SupabaseClient;
    expect(await loadPilotHealth(ssr, { includeTest: false })).toEqual({ available: true, rows: [], hiddenTest: 0 });
  });
});
