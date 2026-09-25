import { describe, expect, it } from "vitest";
import { hasSessionCookie } from "./session";

describe("hasSessionCookie", () => {
  it("finds the app's Supabase session cookie, chunked or whole", () => {
    expect(hasSessionCookie("sb-abcdefgh-auth-token=base64-xyz")).toBe(true);
    expect(hasSessionCookie("theme=dark; sb-abcdefgh-auth-token.0=base64-xyz; sb-abcdefgh-auth-token.1=abc")).toBe(true);
    expect(hasSessionCookie("")).toBe(false);
    expect(hasSessionCookie("maya_active_hotel=1; xsb-a-auth-token=1")).toBe(false);
    expect(hasSessionCookie("sb-abcdefgh-auth-token-code-verifier=1")).toBe(false);
  });
});
