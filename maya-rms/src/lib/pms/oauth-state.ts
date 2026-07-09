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

type StatePayload = {
  hotelId: string;
  pmsType: string;
  nonce: string;
  exp: number;
};

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(str: string): Buffer {
  const pad = str.length % 4 === 0 ? 0 : 4 - (str.length % 4);
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  return Buffer.from(padded, "base64");
}

function getSecret(): Buffer {
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

export function signState(hotelId: string, pmsType: string): string {
  const payload: StatePayload = {
    hotelId,
    pmsType,
    nonce: randomBytes(16).toString("hex"),
    exp: Date.now() + STATE_TTL_MS,
  };
  const payloadBuf = Buffer.from(JSON.stringify(payload), "utf-8");
  const sig = createHmac("sha256", getSecret()).update(payloadBuf).digest();
  return `${base64url(payloadBuf)}.${base64url(sig)}`;
}

export type StateVerification =
  | { ok: true; hotelId: string; pmsType: string }
  | { ok: false; error: string };

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

  const expectedSig = createHmac("sha256", getSecret()).update(payloadBuf).digest();
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
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) {
    return { ok: false, error: "State expired" };
  }
  if (typeof payload.hotelId !== "string" || !payload.hotelId) {
    return { ok: false, error: "State missing hotelId" };
  }

  return { ok: true, hotelId: payload.hotelId, pmsType: payload.pmsType };
}
