/**
 * A connection's stored base_url decides where every call for the hotel goes,
 * access token included (audit A34). Only the vendor's own hosts, or the one
 * the deployment configured, are ever used; anything else falls back to the
 * default host with a log line, so a bad row neither leaks the token nor
 * stops pricing.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedPmsBaseUrl } from "../../../supabase/functions/_shared/pms/base-url";
import { cloudbedsBaseUrlFor, defaultCloudbedsBaseUrl } from "../../../supabase/functions/_shared/cloudbeds/constants";
import { THINK_API_BASE_URL, thinkBaseUrlFor } from "../../../supabase/functions/_shared/think/constants";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("cloudbedsBaseUrlFor", () => {
  it("uses the default when the row has no address", () => {
    for (const stored of [null, undefined, "", "   "]) expect(cloudbedsBaseUrlFor(stored)).toBe(defaultCloudbedsBaseUrl());
  });

  it("keeps either of Cloudbeds' own hosts, trailing slash trimmed", () => {
    expect(cloudbedsBaseUrlFor("https://hotels.cloudbeds.com/api/v1.3/")).toBe("https://hotels.cloudbeds.com/api/v1.3");
    expect(cloudbedsBaseUrlFor("https://api.cloudbeds.com")).toBe("https://api.cloudbeds.com");
  });

  it.each([
    "https://example.test/api/v1.2",
    "http://hotels.cloudbeds.com/api/v1.2",
    "https://hotels.cloudbeds.com.example.test/api/v1.2",
    "https://hotels.cloudbeds.com@example.test/api/v1.2",
    "https://cloudbeds.com/api/v1.2",
    "not a url",
    "javascript:alert(1)",
  ])("never sends the token to %s: the default host instead, and a log line naming the host only", (stored) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(cloudbedsBaseUrlFor(stored, "hotel-1")).toBe(defaultCloudbedsBaseUrl());
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(log.mock.calls[0][0]));
    expect(line).toMatchObject({ fn: "pmsBaseUrlFor", pms: "cloudbeds", hotelId: "hotel-1", usingDefault: true });
    expect(String(log.mock.calls[0][0])).not.toContain("/api/v1.2");
  });

  it("trusts the address the deployment configured, and only its host", () => {
    vi.stubEnv("CLOUDBEDS_API_BASE_URL", "https://cb-proxy.example.test/api/v1.2");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(cloudbedsBaseUrlFor("https://cb-proxy.example.test/api/v1.3")).toBe("https://cb-proxy.example.test/api/v1.3");
    expect(cloudbedsBaseUrlFor("https://other.example.test/api/v1.2")).toBe("https://cb-proxy.example.test/api/v1.2");
  });
});

describe("thinkBaseUrlFor", () => {
  it("keeps ThinkReservations' host and refuses any other", () => {
    expect(thinkBaseUrlFor(null)).toBe(THINK_API_BASE_URL);
    expect(thinkBaseUrlFor("https://api.thinkreservations.com/")).toBe("https://api.thinkreservations.com");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(thinkBaseUrlFor("https://api.thinkreservations.com.example.test", "hotel-2")).toBe(THINK_API_BASE_URL);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ pms: "think", hotelId: "hotel-2", usingDefault: true });
  });
});

describe("isAllowedPmsBaseUrl", () => {
  it("matches on the https origin only", () => {
    const vendor = ["https://api.vendor.test"];
    expect(isAllowedPmsBaseUrl("https://api.vendor.test/v1", vendor, undefined)).toBe(true);
    expect(isAllowedPmsBaseUrl("https://api.vendor.test:8443/v1", vendor, undefined)).toBe(false);
    expect(isAllowedPmsBaseUrl("http://api.vendor.test/v1", vendor, undefined)).toBe(false);
    expect(isAllowedPmsBaseUrl("https://x.test/v1", vendor, "https://x.test/base")).toBe(true);
    expect(isAllowedPmsBaseUrl("https://x.test/v1", vendor, "not-a-url")).toBe(false);
  });
});

describe("every place a connection's address is read", () => {
  it.each([
    ["cloudbeds/sync-hotel.ts", "cloudbedsBaseUrlFor(", 2],
    ["cloudbeds/onboarding-adapter.ts", "cloudbedsBaseUrlFor(", 1],
    ["think/sync-hotel.ts", "thinkBaseUrlFor(", 1],
    ["think/onboarding-adapter.ts", "thinkBaseUrlFor(", 1],
  ])("%s goes through the check", (file, call, count) => {
    const source = readFileSync(resolve(__dirname, `../../../supabase/functions/_shared/${file}`), "utf8");
    expect(source.split(call).length - 1).toBe(count);
    expect(source).not.toMatch(/base_url\s*(as [^)]*\))?\s*\|\|/);
    expect(source).not.toMatch(/connRow\?\.base_url \|\|/);
  });
});
