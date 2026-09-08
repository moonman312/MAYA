// Think PUT /daily probe — re-test after ThinkRes deployed request-body
// validation (Alfred, Sep 2026). Unlike the production client this captures
// the FULL response body, which is where the new error messaging lands.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createClient } from "@supabase/supabase-js";

const HOTEL_ROW = "0709dcce-86ea-4b09-aa17-25c70ece91e1";
const API = "https://api.thinkreservations.com";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const stamp = () => new Date().toISOString();
const log = (...a: unknown[]) => console.log(...a);

// ── 1. Fresh token ────────────────────────────────────────────────────────
const { data: raw } = await admin.rpc("pms_secret_get", { p_hotel_id: HOTEL_ROW, p_pms_type: "think" });
const secret = typeof raw === "string" ? JSON.parse(raw) : raw;
const thinkHotelId = String(secret.propertyId);

log(`[${stamp()}] refreshing access token (stored one expired ${secret.expiresAt})`);
const tokenRes = await fetch(env.THINK_TOKEN_URL || "https://auth.thinkreservations.com/oauth/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: secret.refreshToken,
    client_id: env.THINK_CLIENT_ID!,
    client_secret: env.THINK_CLIENT_SECRET!,
    // Auth0 drops scopes on refresh unless they are re-requested.
    ...(secret.scope ? { scope: String(secret.scope) } : {}),
  }),
});
const tokenBody = await tokenRes.json().catch(() => ({}));
if (!tokenRes.ok || !tokenBody.access_token) {
  log(`  REFRESH FAILED ${tokenRes.status}: ${JSON.stringify(tokenBody).slice(0, 400)}`);
  process.exit(1);
}
const token = tokenBody.access_token as string;
log(`  ok — new token, expires_in ${tokenBody.expires_in}s`);

// Persist so the rest of the integration keeps working (refresh tokens may rotate).
await admin.rpc("pms_secret_set", {
  p_hotel_id: HOTEL_ROW,
  p_pms_type: "think",
  p_secret: {
    ...secret,
    accessToken: token,
    refreshToken: tokenBody.refresh_token ?? secret.refreshToken,
    expiresAt: new Date(Date.now() + Number(tokenBody.expires_in ?? 86400) * 1000).toISOString(),
  },
});
log("  persisted refreshed token to vault");

// ── 2. Discover rate types + current daily rows ───────────────────────────
const get = async (path: string) => {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; }
};

const rt = await get(`/v1/hotels/${thinkHotelId}/rate_types`);
log(`\n[${stamp()}] GET /rate_types -> ${rt.status}`);
const rateTypes = Array.isArray(rt.body) ? rt.body : [];
for (const t of rateTypes.slice(0, 8)) {
  log(`  id=${t.id} type=${t.type} name=${JSON.stringify(t.name)} roomTypes=${(t.roomTypeIds ?? []).length}`);
}

const RATE_TYPE = String(process.env.RATE_TYPE_ID || rateTypes.find((t: any) => t.type !== "DERIVED")?.id || "44186");
const target = rateTypes.find((t: any) => String(t.id) === RATE_TYPE);
const ROOM_TYPE = String(target?.roomTypeIds?.[0] ?? "");
const DATE = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
log(`\nusing rateTypeId=${RATE_TYPE} roomTypeId=${ROOM_TYPE} date=${DATE}`);

const before = await get(`/v1/hotels/${thinkHotelId}/rate_types/${RATE_TYPE}/daily?startDate=${DATE}&endDate=${DATE}`);
log(`\n[${stamp()}] GET /daily -> ${before.status}`);
log(`  ${JSON.stringify(before.body).slice(0, 600)}`);

const rows: any[] = Array.isArray(before.body) ? before.body : (before.body?.content ?? []);
const sample = rows.find((r: any) => String(r.roomTypeId) === ROOM_TYPE) ?? rows[0];
if (!sample) { log("  no daily row returned for that date — cannot build a round-trip body"); process.exit(2); }
log(`  sample row: ${JSON.stringify(sample)}`);
const currentPrice = Number(sample.price ?? sample.amount ?? 0);
const newPrice = Math.round((currentPrice + 11) * 100) / 100;
log(`  current price ${currentPrice} -> will attempt ${newPrice}`);

// ── 3. PUT attempts, capturing the FULL body ──────────────────────────────
const put = async (label: string, payload: unknown) => {
  const sent = stamp();
  const res = await fetch(`${API}/v1/hotels/${thinkHotelId}/rate_types/${RATE_TYPE}/daily`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/gzip" },
    body: gzipSync(Buffer.from(JSON.stringify(payload))),
  });
  const text = await res.text();
  log(`\n[${sent}] PUT ${label}`);
  log(`  payload: ${JSON.stringify(payload).slice(0, 300)}`);
  log(`  -> ${res.status} ${res.statusText}`);
  log(`  response body: ${text ? text.slice(0, 900) : "(empty)"}`);
  return { sent, status: res.status, text };
};

const attempts: { label: string; sent: string; status: number; text: string; applied?: boolean }[] = [];

attempts.push({ label: "A: minimal row (MAYA production shape)", ...await put(
  "A: minimal row (MAYA production shape)",
  [{ roomTypeId: ROOM_TYPE, rateTypeId: RATE_TYPE, date: DATE, price: newPrice }],
) });

attempts.push({ label: "B: exact GET round-trip, price changed", ...await put(
  "B: exact GET round-trip, price changed",
  [{ ...sample, price: newPrice }],
) });

attempts.push({ label: "C: round-trip without rateTypeId (it's in the path)", ...await put(
  "C: round-trip without rateTypeId (it's in the path)",
  [(() => { const { rateTypeId, ...rest } = sample as any; return { ...rest, price: newPrice }; })()],
) });

attempts.push({ label: "D: single object, not an array", ...await put(
  "D: single object, not an array",
  { ...sample, price: newPrice },
) });

// ── 4. Did anything land? ─────────────────────────────────────────────────
log(`\n[${stamp()}] waiting 20s for async workers…`);
await new Promise((r) => setTimeout(r, 20000));
const after = await get(`/v1/hotels/${thinkHotelId}/rate_types/${RATE_TYPE}/daily?startDate=${DATE}&endDate=${DATE}`);
const afterRows: any[] = Array.isArray(after.body) ? after.body : (after.body?.content ?? []);
const afterRow = afterRows.find((r: any) => String(r.roomTypeId) === ROOM_TYPE) ?? afterRows[0];
log(`[${stamp()}] GET /daily after -> ${after.status}`);
log(`  row now: ${JSON.stringify(afterRow)}`);

const landed = Number(afterRow?.price ?? -1) === newPrice;
log(`\n${"=".repeat(64)}`);
log(landed ? `WRITE LANDED: price is now ${newPrice}` : `WRITE DID NOT LAND: still ${afterRow?.price}, expected ${newPrice}`);
log(`${"=".repeat(64)}`);
log("\nFor ThinkReservations support — hotel " + thinkHotelId + ", rateType " + RATE_TYPE + ":");
for (const a of attempts) {
  log(`  ${a.sent}  ${a.status}  ${a.label}`);
  if (a.text) log(`      body: ${a.text.slice(0, 300)}`);
}
