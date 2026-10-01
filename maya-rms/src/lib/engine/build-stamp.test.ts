/**
 * Which build made a price (audit A29): buildStamp in both engine copies,
 * stamped on every pricing run's heartbeat and every push's ledger rows, and
 * left out against a database from before
 * 99_supabase_migration_pricing_records_v1.sql.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildStamp } from "./build";
import { buildStamp as edgeBuildStamp } from "../../../supabase/functions/_shared/engine/build";
import { recordRunHeartbeat } from "./audit";
import { recordRunHeartbeat as edgeRecordRunHeartbeat } from "../../../supabase/functions/_shared/engine/audit";
import { upsertLedger } from "../../../supabase/functions/_shared/pms/rate-push";
import { callTouchesColumn, fakeSupabase, missingColumn } from "./fake-supabase.test";
import type { SupabaseClient } from "@supabase/supabase-js";

afterEach(() => vi.unstubAllEnvs());

describe("buildStamp", () => {
  it.each([
    ["app", buildStamp],
    ["edge", edgeBuildStamp],
  ])("says dev when nothing stamped the build, and the Vercel commit in the app (%s copy)", (_copy, stamp) => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    expect(stamp()).toBe("app@dev");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "0123456789abcdef0123456789abcdef01234567");
    expect(stamp()).toBe("app@0123456789ab");
  });

  it("reads a stamp file the deploy script can write into", () => {
    const files = ["src/lib/engine/build-stamp.ts", "supabase/functions/_shared/engine/build-stamp.ts"].map((f) =>
      readFileSync(resolve(__dirname, "../../..", f), "utf8"),
    );
    expect(files[0]).toBe(files[1]);
    // scripts/deploy-function.mjs replaces exactly this.
    expect(files[0].match(/BUILD_STAMP: string = "[^"]*"/g)).toEqual(['BUILD_STAMP: string = "dev"']);
    const script = readFileSync(resolve(__dirname, "../../../scripts/deploy-function.mjs"), "utf8");
    expect(script).toContain('replace(/BUILD_STAMP: string = "[^"]*"/');
    expect(script).toContain("writeFileSync(stampFile, original)");
  });
});

describe.each([
  ["app", recordRunHeartbeat],
  ["edge", edgeRecordRunHeartbeat],
])("the run heartbeat (%s copy)", (_copy, heartbeat) => {
  it("carries the build", async () => {
    const { client, tables } = fakeSupabase({ evaluation_run_log: [] });
    await heartbeat(client as unknown as SupabaseClient, "h1", "r1", "2026-10-01T12:00:00Z", 10, 2, { first: "2026-10-01", last: "2026-10-10" }, { runKind: "nights", nightsPriced: 10 });
    expect(tables.evaluation_run_log).toEqual([expect.objectContaining({ evaluation_run_id: "r1", build: "app@dev", run_kind: "nights" })]);
  });

  it("is written without it before the column exists", async () => {
    const { client, tables } = fakeSupabase(
      { evaluation_run_log: [] },
      { fault: (c) => (c.table === "evaluation_run_log" && callTouchesColumn(c, "build") ? missingColumn("evaluation_run_log", "build") : null) },
    );
    await heartbeat(client as unknown as SupabaseClient, "h1", "r1", "2026-10-01T12:00:00Z", 10, 2, null, { runKind: "window", nightsPriced: 10 });
    expect(tables.evaluation_run_log).toHaveLength(1);
    expect(tables.evaluation_run_log[0]).not.toHaveProperty("build");
    expect(tables.evaluation_run_log[0]).toMatchObject({ run_kind: "window" });
  });
});

describe("upsertLedger", () => {
  const row = { hotel_id: "h1", pms_type: "cloudbeds", room_type_id: "rt1", stay_date: "2026-12-12", price: 219, status: "sent", sent_price: 219 };
  const stamp = { push_run_id: "99999999-9999-4999-8999-999999999401", build: "edge@abc123" };

  it("stamps every row with the run and build when given them", async () => {
    const { client, tables } = fakeSupabase({ rate_updates: [] });
    expect(await upsertLedger(client as unknown as SupabaseClient, [row], stamp)).toBeNull();
    expect(tables.rate_updates).toEqual([expect.objectContaining({ ...row, ...stamp })]);
  });

  it("writes the rows without the stamp before the columns exist, and keeps the rest", async () => {
    const { client, tables } = fakeSupabase(
      { rate_updates: [] },
      { fault: (c) => (c.table === "rate_updates" && callTouchesColumn(c, "push_run_id") ? missingColumn("rate_updates", "push_run_id") : null) },
    );
    expect(await upsertLedger(client as unknown as SupabaseClient, [row], stamp)).toBeNull();
    expect(tables.rate_updates).toEqual([expect.objectContaining(row)]);
    expect(tables.rate_updates[0]).not.toHaveProperty("push_run_id");
    expect(tables.rate_updates[0]).not.toHaveProperty("build");
  });
});
