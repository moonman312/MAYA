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
  it("hotel intent round-trips, with the person who started it", async () => {
    const { signState, verifyState } = await mod();
    const state = signState("hotel-123", "cloudbeds", { userId: "user-1" });
    const v = verifyState(state, "cloudbeds");
    expect(v).toMatchObject({ ok: true, intent: "hotel", hotelId: "hotel-123", userId: "user-1" });
    expect(() => signState("hotel-123", "cloudbeds", { userId: "" })).toThrow(/person/);
  });

  it("a hotel state signed without the person, or with the person swapped, does not verify", async () => {
    const { signState, verifyState } = await mod();
    // Signed by us before the person was put in: ours, so never a Marketplace grant, and stale.
    const before = handSign({ intent: "hotel", hotelId: "hotel-123", pmsType: "cloudbeds", nonce: "abc", exp: Date.now() + 60_000 });
    expect(verifyState(before, "cloudbeds")).toMatchObject({ ok: false, stale: true });
    expect(verifyState(before, "cloudbeds")).not.toHaveProperty("expired");
    // The person swapped in the payload: the signature no longer matches.
    const state = signState("hotel-123", "cloudbeds", { userId: "user-1" });
    const [payload, sig] = state.split(".");
    const swapped = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8").replace("user-1", "user-2");
    expect(verifyState(`${b64url(Buffer.from(swapped, "utf-8"))}.${sig}`, "cloudbeds")).toMatchObject({ ok: false, error: "Signature mismatch" });
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
      userId: "user-1",
      pmsType: "cloudbeds",
      nonce: "abc",
      exp: Date.now() + 60_000,
    });
    const v = verifyState(legacy, "cloudbeds");
    expect(v).toMatchObject({ ok: true, intent: "hotel", hotelId: "hotel-legacy", userId: "user-1" });
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
    expect(verifyState(expired, "cloudbeds")).toMatchObject({ ok: false, expired: true });
  });

  it("carries a staff console start through to the callback, and nothing else", async () => {
    const { signState, verifyState } = await mod();
    expect(verifyState(signState("hotel-123", "cloudbeds", { userId: "u", from: "admin" }), "cloudbeds")).toMatchObject({ ok: true, from: "admin" });
    expect(verifyState(signState("hotel-123", "cloudbeds", { userId: "u" }), "cloudbeds")).not.toHaveProperty("from");
  });

  it("runs a God Mode reconnect out with the window, and says so", async () => {
    const { signState, verifyState } = await mod();
    const soon = signState("hotel-123", "cloudbeds", { userId: "u", from: "admin", godModeUntilMs: Date.now() + 60_000 });
    expect(verifyState(soon, "cloudbeds")).toMatchObject({ ok: true, from: "admin", support: true });
    const payload = JSON.parse(Buffer.from(soon.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"));
    expect(payload.exp).toBeLessThanOrEqual(Date.now() + 60_000);

    const ended = signState("hotel-123", "cloudbeds", { userId: "u", godModeUntilMs: Date.now() - 1_000 });
    expect(verifyState(ended, "cloudbeds")).toMatchObject({ ok: false, expired: true, support: true });

    // A member's reconnect is unchanged: 15 minutes, no flag.
    const member = signState("hotel-123", "cloudbeds", { userId: "u" });
    expect(verifyState(member, "cloudbeds")).not.toHaveProperty("support");
  });

  it("only calls a state expired when it is ours and too old", async () => {
    const { signState, verifyState } = await mod();
    const state = signState("hotel-123", "think", { userId: "u" });
    const [, sig] = state.split(".");
    const forged = `${b64url(Buffer.from(JSON.stringify({ hotelId: "h", pmsType: "think", nonce: "n", exp: 1 }), "utf-8"))}.${sig}`;
    expect(verifyState(forged, "think")).not.toHaveProperty("expired");
    expect(verifyState(state, "think")).not.toHaveProperty("expired");
  });
});
