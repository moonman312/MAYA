/**
 * The scheduled functions run with verify_jwt = false, so their cron secret
 * is the only lock (audit A33). A missing secret must refuse every request,
 * never open the door, and a wrong or absent header is refused as before.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refuseWithoutCronSecret, secretMatches } from "../../../supabase/functions/_shared/pms/cron-secret";

const CHECK = { fn: "cloudbeds-scheduled-sync", env: "CLOUDBEDS_CRON_SECRET", header: "x-cloudbeds-cron-secret" };
const req = (headers: Record<string, string> = {}) => new Request("https://example.test/functions/v1/x", { method: "POST", headers });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("refuseWithoutCronSecret", () => {
  it("refuses every request with 503 when the secret is not set, header or not, and logs it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const secret of [undefined, ""]) {
      for (const headers of [{}, { "x-cloudbeds-cron-secret": "" }, { "x-cloudbeds-cron-secret": "anything" }]) {
        const res = await refuseWithoutCronSecret(req(headers), { ...CHECK, secret });
        expect(res?.status).toBe(503);
        const body = await res!.json();
        expect(body.ok).toBe(false);
        expect(body.error).toContain("CLOUDBEDS_CRON_SECRET is not set for cloudbeds-scheduled-sync");
      }
    }
    expect(log).toHaveBeenCalled();
    expect(String(log.mock.calls[0][0])).toContain('"refused":true');
  });

  it("refuses a missing or wrong header with 401", async () => {
    for (const headers of [{}, { "x-cloudbeds-cron-secret": "wrong" }, { "x-cloudbeds-cron-secret": "s3cret-but-longer" }, { "x-other": "s3cret" }]) {
      const res = await refuseWithoutCronSecret(req(headers), { ...CHECK, secret: "s3cret" });
      expect(res?.status).toBe(401);
      expect((await res!.json()).error).toBe("Invalid or missing x-cloudbeds-cron-secret.");
    }
  });

  it("lets the right secret through", async () => {
    expect(await refuseWithoutCronSecret(req({ "x-cloudbeds-cron-secret": "s3cret" }), { ...CHECK, secret: "s3cret" })).toBeNull();
  });

  it("never echoes the secret or the header's value", async () => {
    const res = await refuseWithoutCronSecret(req({ "x-cloudbeds-cron-secret": "guess-123" }), { ...CHECK, secret: "real-456" });
    const text = await res!.text();
    expect(text).not.toContain("real-456");
    expect(text).not.toContain("guess-123");
  });
});

describe("secretMatches", () => {
  it("matches only the same value, whatever the lengths", async () => {
    expect(await secretMatches("abc", "abc")).toBe(true);
    expect(await secretMatches("abc", "abd")).toBe(false);
    expect(await secretMatches("ab", "abc")).toBe(false);
    expect(await secretMatches("abcd", "abc")).toBe(false);
    expect(await secretMatches(null, "abc")).toBe(false);
    expect(await secretMatches("", "")).toBe(false);
  });
});

describe("the four scheduled functions", () => {
  it.each([
    ["cloudbeds-scheduled-sync", "CLOUDBEDS_CRON_SECRET", "x-cloudbeds-cron-secret"],
    ["think-scheduled-sync", "THINK_CRON_SECRET", "x-think-cron-secret"],
    ["mews-scheduled-sync", "MEWS_CRON_SECRET", "x-mews-cron-secret"],
    ["onboarding-import-worker", "ONBOARDING_CRON_SECRET", "x-onboarding-cron-secret"],
  ])("%s checks its secret first, and never only when one is set", (fn, env, header) => {
    const source = readFileSync(resolve(__dirname, `../../../supabase/functions/${fn}/index.ts`), "utf8");
    const serve = source.slice(source.indexOf("Deno.serve("));
    const check = serve.indexOf("await refuseWithoutCronSecret(req, {");
    expect(check).toBeGreaterThan(0);
    // Before anything reads the body or makes a client.
    expect(check).toBeLessThan(serve.indexOf("createClient("));
    expect(serve.slice(check, check + 300)).toContain(`env: "${env}"`);
    expect(serve.slice(check, check + 300)).toContain(`header: "${header}"`);
    expect(serve.slice(check, check + 300)).toContain(`fn: "${fn}"`);
    // The old fail-open shape is gone.
    expect(source).not.toMatch(/if \(cronSecret\) \{/);
    expect(source).not.toMatch(/header !== cronSecret/);
  });
});
