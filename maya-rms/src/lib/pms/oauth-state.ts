import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * OAuth `state` parameter signing.
 *
 * The `state` param carries the hotel_id we're connecting for (plus a nonce
 * for replay protection). It's HMAC-signed with PMS_OAUTH_STATE_SECRET so a
 * malicious redirect cannot swap in a different hotel_id. On callback we
 * verify the signature and extract the hotel_id.
 *
 * State encoding: base64url(payload) . base64url(HMAC-SHA256(payload, secret))
 * where payload = base64url-encoded JSON { hotelId, pmsType, nonce, exp }.
 */

const STATE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Two intents:
 * - "hotel": connecting a PMS to an existing hotel again (the original
 *   flow). The state carries the hotel AND the person who started it, and
 *   the callback lets only that person, still allowed to reconnect that
 *   hotel, finish it. A signed link is good for 15 minutes and goes wherever
 *   the browser is sent, so without the person in it anyone could start a
 *   connect for a property of their own and hand the link to someone at
 *   another hotel to approve, and that hotel's login would be stored under
 *   the wrong property.
 * - "onboarding": a new user with NO hotel yet — the callback creates the
 *   hotel from PMS data, so state carries the user id instead.
 * Legacy states without an `intent` field verify as "hotel". A hotel state
 * signed before the person was put in it (none after this deploy is 15
 * minutes old) does not verify, and the callback says to start again.
 */
type StatePayload =
  | {
      intent?: "hotel";
      hotelId: string;
      /** The signed-in person who started the connect. */
      userId?: string;
      pmsType: string;
      nonce: string;
      exp: number;
      from?: "admin";
      /** Started by MAYA staff in God Mode: runs out with the window, and the callback checks again. */
      support?: true;
    }
  | { intent: "onboarding"; userId: string; pmsType: string; nonce: string; exp: number };

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(str: string): Buffer {
  const pad = str.length % 4 === 0 ? 0 : 4 - (str.length % 4);
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  return Buffer.from(padded, "base64");
}

export function getStateSecret(): Buffer {
  const raw = process.env.PMS_OAUTH_STATE_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      "PMS_OAUTH_STATE_SECRET is not set (or too short). " +
        "Generate a 32+ byte secret and add it to your env before initiating OAuth.",
    );
  }
  // Accept hex or base64; fall back to raw bytes.
  if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0) {
    return Buffer.from(raw, "hex");
  }
  try {
    const b = Buffer.from(raw, "base64");
    if (b.length >= 32) return b;
  } catch {
    // fall through
  }
  return Buffer.from(raw, "utf-8");
}

function signPayload(payload: StatePayload): string {
  const payloadBuf = Buffer.from(JSON.stringify(payload), "utf-8");
  const sig = createHmac("sha256", getStateSecret()).update(payloadBuf).digest();
  return `${base64url(payloadBuf)}.${base64url(sig)}`;
}

/**
 * `userId` is the signed-in person starting the connect: the callback
 * finishes it for them alone. `from: "admin"` marks a connect started in the
 * staff console, which is where its callback returns; everyone else lands
 * back on the dashboard. `godModeUntilMs` marks one started by MAYA staff in
 * God Mode: the state runs out no later than their window does, and the
 * callback asks again whether they may still change the property.
 */
export function signState(
  hotelId: string,
  pmsType: string,
  opts: { userId: string; from?: "admin"; godModeUntilMs?: number },
): string {
  if (!opts.userId) throw new Error("signState needs the person starting the connect");
  const support = opts.godModeUntilMs != null && Number.isFinite(opts.godModeUntilMs);
  const exp = Date.now() + STATE_TTL_MS;
  return signPayload({
    intent: "hotel",
    hotelId,
    userId: opts.userId,
    pmsType,
    nonce: randomBytes(16).toString("hex"),
    exp: support ? Math.min(exp, opts.godModeUntilMs as number) : exp,
    ...(opts.from ? { from: opts.from } : {}),
    ...(support ? { support: true as const } : {}),
  });
}

/** Onboarding variant: no hotel exists yet, so state carries the user id. */
export function signOnboardingState(userId: string, pmsType: string): string {
  return signPayload({
    intent: "onboarding",
    userId,
    pmsType,
    nonce: randomBytes(16).toString("hex"),
    exp: Date.now() + STATE_TTL_MS,
  });
}

export type StateVerification =
  | { ok: true; intent: "hotel"; hotelId: string; userId: string; pmsType: string; from?: "admin"; support?: true }
  | { ok: true; intent: "onboarding"; userId: string; pmsType: string }
  | {
      ok: false;
      error: string;
      /** Ours, and simply too old. */
      expired?: true;
      /** Ours, signed before the person starting it was put in the state. */
      stale?: true;
      support?: true;
    };

export function verifyState(state: string, expectedPmsType: string): StateVerification {
  const parts = state.split(".");
  if (parts.length !== 2) return { ok: false, error: "Malformed state" };
  const [payloadPart, sigPart] = parts;

  let payloadBuf: Buffer;
  let sigBuf: Buffer;
  try {
    payloadBuf = fromBase64url(payloadPart);
    sigBuf = fromBase64url(sigPart);
  } catch {
    return { ok: false, error: "Malformed state encoding" };
  }

  const expectedSig = createHmac("sha256", getStateSecret()).update(payloadBuf).digest();
  if (expectedSig.length !== sigBuf.length || !timingSafeEqual(expectedSig, sigBuf)) {
    return { ok: false, error: "Signature mismatch" };
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(payloadBuf.toString("utf-8")) as StatePayload;
  } catch {
    return { ok: false, error: "Malformed payload" };
  }

  if (payload.pmsType !== expectedPmsType) {
    return { ok: false, error: `State was signed for '${payload.pmsType}' not '${expectedPmsType}'` };
  }
  if (typeof payload.exp !== "number") return { ok: false, error: "State expired" };
  if (payload.exp < Date.now()) {
    // Signed by us and simply too old: the one failure the person at the
    // browser caused themselves, by taking longer than STATE_TTL_MS to sign in.
    return {
      ok: false,
      error: "State expired",
      expired: true,
      ...(payload.intent !== "onboarding" && payload.support === true ? { support: true as const } : {}),
    };
  }

  if (payload.intent === "onboarding") {
    if (typeof payload.userId !== "string" || !payload.userId) {
      return { ok: false, error: "State missing userId" };
    }
    return { ok: true, intent: "onboarding", userId: payload.userId, pmsType: payload.pmsType };
  }

  // "hotel" intent, including legacy states with no intent field.
  if (typeof payload.hotelId !== "string" || !payload.hotelId) {
    return { ok: false, error: "State missing hotelId" };
  }
  // Signed by us before the person was put in: never a Marketplace grant, and
  // never finished for whoever holds it either.
  if (typeof payload.userId !== "string" || !payload.userId) {
    return { ok: false, error: "State missing userId", stale: true };
  }
  return {
    ok: true,
    intent: "hotel",
    hotelId: payload.hotelId,
    userId: payload.userId,
    pmsType: payload.pmsType,
    ...(payload.from === "admin" ? { from: "admin" as const } : {}),
    ...(payload.support === true ? { support: true as const } : {}),
  };
}
