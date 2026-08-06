import { beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

const SECRET = "test-secret-that-is-at-least-32-bytes-long!!";

beforeAll(() => {
  process.env.PMS_OAUTH_STATE_SECRET = SECRET;
});

async function mod() {
  return await import("./oauth-state");
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Hand-sign an arbitrary payload the way oauth-state does. */
function handSign(payload: Record<string, unknown>): string {
  const payloadBuf = Buffer.from(JSON.stringify(payload), "utf-8");
  const sig = createHmac("sha256", Buffer.from(SECRET, "utf-8")).update(payloadBuf).digest();
  return `${b64url(payloadBuf)}.${b64url(sig)}`;
}

describe("oauth state", () => {
  it("hotel intent round-trips", async () => {
    const { signState, verifyState } = await mod();
    const state = signState("hotel-123", "cloudbeds");
    const v = verifyState(state, "cloudbeds");
    expect(v).toMatchObject({ ok: true, intent: "hotel", hotelId: "hotel-123" });
  });

  it("onboarding intent round-trips", async () => {
    const { signOnboardingState, verifyState } = await mod();
    const state = signOnboardingState("user-456", "cloudbeds");
    const v = verifyState(state, "cloudbeds");
    expect(v).toMatchObject({ ok: true, intent: "onboarding", userId: "user-456" });
  });

  it("legacy states without an intent field verify as hotel", async () => {
    const { verifyState } = await mod();
    const legacy = handSign({
      hotelId: "hotel-legacy",
      pmsType: "cloudbeds",
      nonce: "abc",
      exp: Date.now() + 60_000,
    });
    const v = verifyState(legacy, "cloudbeds");
    expect(v).toMatchObject({ ok: true, intent: "hotel", hotelId: "hotel-legacy" });
  });

  it("rejects tampered payloads", async () => {
    const { signOnboardingState, verifyState } = await mod();
    const state = signOnboardingState("user-456", "cloudbeds");
    const [payload, sig] = state.split(".");
    const tampered = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64")
      .toString("utf-8")
      .replace("user-456", "user-666");
    const forged = `${b64url(Buffer.from(tampered, "utf-8"))}.${sig}`;
    const v = verifyState(forged, "cloudbeds");
    expect(v.ok).toBe(false);
  });

  it("rejects the wrong pms type", async () => {
    const { signOnboardingState, verifyState } = await mod();
    const state = signOnboardingState("user-456", "cloudbeds");
    expect(verifyState(state, "think").ok).toBe(false);
  });

  it("rejects expired states", async () => {
    const { verifyState } = await mod();
    const expired = handSign({
      intent: "onboarding",
      userId: "user-456",
      pmsType: "cloudbeds",
      nonce: "abc",
      exp: Date.now() - 1000,
    });
    expect(verifyState(expired, "cloudbeds").ok).toBe(false);
  });
});
