/**
 * A vendor saying "this app is not installed here" is a revocation, whatever
 * status code it wraps it in.
 *
 * Cloudbeds answer a revoked app with HTTP 200 + success:false, which the client
 * surfaces as a 400-class error. Matching only 401/403 meant a property that
 * uninstalled MAYA in the Cloudbeds Marketplace kept reading "connected" while
 * every call was refused — seen live on a partner's own property during
 * certification.
 */
import { describe, expect, it } from "vitest";
import { isAuthRevocation } from "../../../supabase/functions/_shared/pms/connection-health";

const CLOUDBEDS_REVOKED =
  "Cloudbeds getReservations failed (200): Application is not available to be connected. " +
  "Reach out to Modern Hospitality Solutions (Test) support for any questions.";

describe("isAuthRevocation", () => {
  it("still treats 401 and 403 as revocation", () => {
    expect(isAuthRevocation(401)).toBe(true);
    expect(isAuthRevocation(403)).toBe(true);
  });

  it("catches the Cloudbeds uninstall message, which arrives as a 400", () => {
    expect(isAuthRevocation(400, CLOUDBEDS_REVOKED)).toBe(true);
  });

  it("catches it regardless of casing", () => {
    expect(isAuthRevocation(400, "APPLICATION IS NOT AVAILABLE TO BE CONNECTED")).toBe(true);
  });

  it("catches an OAuth invalid_grant at refresh time", () => {
    expect(isAuthRevocation(400, "token refresh failed: invalid_grant")).toBe(true);
  });

  it("leaves an OUTAGE alone — a 500 is not a revocation", () => {
    expect(isAuthRevocation(500, "Internal Server Error")).toBe(false);
  });

  it("leaves throttling alone — a 429 is not a revocation", () => {
    expect(isAuthRevocation(429, "Too Many Requests")).toBe(false);
  });

  it("leaves an ordinary vendor complaint alone", () => {
    // This one matters: a bad parameter must never disconnect a live property.
    expect(isAuthRevocation(400, "Parameter status is not valid")).toBe(false);
    expect(isAuthRevocation(400, "Scope required for this call was not granted by property.")).toBe(false);
  });

  it("does not throw on a missing message", () => {
    expect(isAuthRevocation(400)).toBe(false);
    expect(isAuthRevocation(400, null)).toBe(false);
    expect(isAuthRevocation(null, undefined)).toBe(false);
  });
});
