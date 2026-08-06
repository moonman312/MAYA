import { describe, expect, it } from "vitest";
import { isAllowedMewsBaseUrl } from "../../../supabase/functions/_shared/mews/constants";

describe("isAllowedMewsBaseUrl", () => {
  it("accepts Mews' own endpoints", () => {
    expect(isAllowedMewsBaseUrl("https://api.mews.com/api/connector/v1")).toBe(true);
    expect(isAllowedMewsBaseUrl("https://api.mews-demo.com/api/connector/v1")).toBe(true);
    // Any path under an allowed origin is fine — only the host is the gate.
    expect(isAllowedMewsBaseUrl("https://api.mews.com/anything/else")).toBe(true);
  });

  it("refuses the hosts an attacker would actually aim at", () => {
    expect(isAllowedMewsBaseUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isAllowedMewsBaseUrl("http://localhost:54321/rest/v1/reservations")).toBe(false);
    expect(isAllowedMewsBaseUrl("https://127.0.0.1/")).toBe(false);
    expect(isAllowedMewsBaseUrl("https://attacker.example.com/api/connector/v1")).toBe(false);
  });

  it("refuses plain http even for an otherwise allowed host", () => {
    expect(isAllowedMewsBaseUrl("http://api.mews.com/api/connector/v1")).toBe(false);
  });

  it("is not fooled by lookalike hosts", () => {
    expect(isAllowedMewsBaseUrl("https://api.mews.com.evil.example/x")).toBe(false);
    expect(isAllowedMewsBaseUrl("https://evil.example/?u=https://api.mews.com")).toBe(false);
    expect(isAllowedMewsBaseUrl("https://api.mews.com@evil.example/x")).toBe(false);
  });

  it("refuses input that is not a URL at all", () => {
    expect(isAllowedMewsBaseUrl("")).toBe(false);
    expect(isAllowedMewsBaseUrl("not a url")).toBe(false);
    expect(isAllowedMewsBaseUrl("//api.mews.com")).toBe(false);
  });
});
