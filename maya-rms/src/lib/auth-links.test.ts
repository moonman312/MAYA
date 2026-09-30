import {
  AuthApiError,
  AuthPKCECodeVerifierMissingError,
  AuthRetryableFetchError,
} from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { isEmailNotConfirmed, isRateLimited, linkProblem, linkRefusedInUrl } from "./auth-links";

describe("linkProblem", () => {
  it("reads an expired or already-used link as expired", () => {
    expect(linkProblem(new AuthApiError("Email link is invalid or has expired", 403, "otp_expired"))).toBe("expired");
    expect(linkProblem(new AuthApiError("invalid flow state, no valid flow state found", 404, "flow_state_not_found"))).toBe("expired");
    expect(linkProblem(new AuthApiError("invalid flow state, flow state has expired", 422, "flow_state_expired"))).toBe("expired");
  });

  it("reads a code link opened in another browser as its own case", () => {
    expect(linkProblem(new AuthPKCECodeVerifierMissingError())).toBe("other-browser");
  });

  it("reads no answer, a rate limit or an outage as worth another go", () => {
    expect(linkProblem(new AuthRetryableFetchError("Failed to fetch", 0))).toBe("retry");
    expect(linkProblem(new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit"))).toBe("retry");
    expect(linkProblem(new AuthApiError("Internal Server Error", 500, "unexpected_failure"))).toBe("retry");
    expect(linkProblem(new TypeError("Failed to fetch"))).toBe("retry");
  });
});

describe("linkRefusedInUrl", () => {
  it("spots Supabase's refusal in the query or the fragment", () => {
    expect(linkRefusedInUrl("https://maya.test/auth/accept-invite?error=access_denied&error_code=otp_expired")).toBe(true);
    expect(linkRefusedInUrl("https://maya.test/auth/accept-invite#error=access_denied&error_code=otp_expired")).toBe(true);
  });

  it("leaves a working link alone", () => {
    expect(linkRefusedInUrl("https://maya.test/auth/accept-invite?token_hash=abc&type=invite")).toBe(false);
    expect(linkRefusedInUrl("https://maya.test/auth/accept-invite")).toBe(false);
  });
});

describe("isRateLimited", () => {
  it("spots Supabase's too-many answers, and nothing else", () => {
    expect(isRateLimited(new AuthApiError("For security purposes, you can only request this after 42 seconds.", 429, "over_email_send_rate_limit"))).toBe(true);
    expect(isRateLimited(new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit"))).toBe(true);
    expect(isRateLimited(new AuthApiError("Error sending confirmation email", 500, "unexpected_failure"))).toBe(false);
    expect(isRateLimited(new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("isEmailNotConfirmed", () => {
  it("spots a sign-in refused for an unconfirmed address, and nothing else", () => {
    expect(isEmailNotConfirmed(new AuthApiError("Email not confirmed", 400, "email_not_confirmed"))).toBe(true);
    expect(isEmailNotConfirmed(new AuthApiError("Invalid login credentials", 400, "invalid_credentials"))).toBe(false);
    expect(isEmailNotConfirmed(null)).toBe(false);
  });
});
