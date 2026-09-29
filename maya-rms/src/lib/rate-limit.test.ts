import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("not used here");
  },
  isAdminConfigured: () => false,
}));

const { tooManyRequests } = await import("./rate-limit");

describe("tooManyRequests", () => {
  it("says it plainly when the route gives no message of its own", async () => {
    const res = tooManyRequests({ allowed: false, hits: 7, limit: 6, resetsAt: null });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("That's a bit fast. Try again shortly.");
    expect(body.error).not.toContain("—");
  });
});
