/**
 * "Only update rates with isDerived set to false" is one of the few rules
 * Cloudbeds state as an imperative in the RMS blueprint, and it is the kind of
 * thing a certification reviewer asks about directly. These pin the filter at
 * both sites that use it — the push-target resolver and the rate-calendar read.
 *
 * The rule matters because a derived plan reprices off its parent. Pushing one
 * is not merely rejected; it means the property's real rate never moved while
 * MAYA's own ledger recorded a successful send.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { createCloudbedsRateAdapter } from "../../../supabase/functions/_shared/cloudbeds/rate-push";
import type { CloudbedsResolvedCredentials } from "../../../supabase/functions/_shared/cloudbeds/types";

const CREDS: CloudbedsResolvedCredentials = {
  accessToken: "tok",
  tokenType: "Bearer",
  baseUrl: "https://hotels.cloudbeds.com/api/v1.2",
  propertyId: "320691",
};

/** One getRatePlans row, shaped like the live sandbox returns them. */
function plan(over: Record<string, unknown>) {
  return {
    rateID: "3142970",
    roomTypeID: "676779",
    isDerived: false,
    parentRateID: null,
    roomRateDetailed: [{ date: "2026-10-15", rate: 200 }],
    ...over,
  };
}

function stubRatePlans(rows: unknown[]) {
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).includes("getRatePlans")) {
      return new Response(JSON.stringify({ success: true, data: rows }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("derived rates are never push targets", () => {
  it("picks a plan that says isDerived: false", async () => {
    stubRatePlans([plan({ rateID: "base-1" })]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    const targets = await adapter.resolveRateTargets(["676779"]);
    expect(targets["676779"]).toBe("base-1");
  });

  it("skips a plan that says isDerived: true", async () => {
    stubRatePlans([plan({ rateID: "derived-1", isDerived: true, ratePlanID: "475855" })]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    const targets = await adapter.resolveRateTargets(["676779"]);
    expect(targets["676779"]).toBeUndefined();
  });

  it.each([
    ["absent", { isDerived: undefined }],
    ["null", { isDerived: null }],
    ["the number 1", { isDerived: 1 }],
    ["the string \"1\"", { isDerived: "1" }],
    ["the string \"yes\"", { isDerived: "yes" }],
  ])("fails SAFE when isDerived is %s, rather than pushing it", async (_label, over) => {
    // The old filter skipped only an affirmative true, so every one of these
    // became a push target: Cloudbeds accepted the job, rejected the cell, and
    // the property's rate never moved while MAYA recorded a send.
    stubRatePlans([plan({ rateID: "ambiguous", ...over })]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    const targets = await adapter.resolveRateTargets(["676779"]);
    expect(targets["676779"]).toBeUndefined();
  });

  it("accepts the string \"false\", since v1.2 stringified other fields", async () => {
    stubRatePlans([plan({ rateID: "base-str", isDerived: "false" })]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    const targets = await adapter.resolveRateTargets(["676779"]);
    expect(targets["676779"]).toBe("base-str");
  });

  it("prefers the non-derived plan when both are offered for one room type", async () => {
    stubRatePlans([
      plan({ rateID: "derived-1", isDerived: true, ratePlanID: "475855" }),
      plan({ rateID: "base-1", isDerived: false }),
    ]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    const targets = await adapter.resolveRateTargets(["676779"]);
    expect(targets["676779"]).toBe("base-1");
  });
});

describe("the rate-calendar read applies the same rule", () => {
  it("reads the property's own rate from the non-derived plan only", async () => {
    stubRatePlans([
      plan({ rateID: "base-1", isDerived: false, roomRateDetailed: [{ date: "2026-10-15", rate: 200 }] }),
      plan({
        rateID: "derived-1",
        isDerived: true,
        ratePlanID: "475855",
        roomRateDetailed: [{ date: "2026-10-15", rate: 190 }],
      }),
    ]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    const cal = await adapter.fetchRateCalendar!("2026-10-15", "2026-10-16", { "676779": "base-1" });
    const rates = cal.map((c) => c.price);
    expect(rates).toContain(200);
    expect(rates).not.toContain(190);
  });
});
