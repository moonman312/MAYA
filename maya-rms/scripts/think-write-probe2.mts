// Follow-up: isolate whether MAYA's minimal-row shape works ALONE, and prove
// whether omitting restriction fields preserves or clears them.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createClient } from "@supabase/supabase-js";

const HOTEL_ROW = "0709dcce-86ea-4b09-aa17-25c70ece91e1";
const API = "https://api.thinkreservations.com";
const RATE_TYPE = "44186";
const DATE = "2026-11-14"; // fresh date, untouched by probe 1

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const { data: raw } = await admin.rpc("pms_secret_get", { p_hotel_id: HOTEL_ROW, p_pms_type: "think" });
const secret = typeof raw === "string" ? JSON.parse(raw) : raw;
const token = secret.accessToken as string;
const H = String(secret.propertyId);

const stamp = () => new Date().toISOString();
const getDaily = async () => {
  const r = await fetch(`${API}/v1/hotels/${H}/rate_types/${RATE_TYPE}/daily?startDate=${DATE}&endDate=${DATE}`, { headers: { Authorization: `Bearer ${token}` } });
  return (await r.json()) as any[];
};
const put = async (label: string, payload: unknown) => {
  const sent = stamp();
  const res = await fetch(`${API}/v1/hotels/${H}/rate_types/${RATE_TYPE}/daily`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/gzip" },
    body: gzipSync(Buffer.from(JSON.stringify(payload))),
  });
  const text = await res.text();
  console.log(`[${sent}] ${label} -> ${res.status} ${text ? text.slice(0, 300) : "(empty body)"}`);
  return res.status;
};
const settle = async (ms = 15000) => { await new Promise((r) => setTimeout(r, ms)); };
const show = (r: any, tag: string) =>
  console.log(`  ${tag}: price=${r?.price} minNightsArrival=${r?.minimumNightsOnArrival} stopSell=${r?.stopSell} closedOnArrival=${r?.closedOnArrival}`);

const rows0 = await getDaily();
const ROOM = String(rows0[0].roomTypeId);
const base = rows0.find((r) => String(r.roomTypeId) === ROOM)!;
console.log(`hotel ${H} rateType ${RATE_TYPE} room ${ROOM} date ${DATE}`);
show(base, "start");

// ── Step 1: set a restriction via full round-trip so we have something to clear
console.log("\n--- step 1: set minimumNightsOnArrival=2 + stopSell=true (full row) ---");
await put("full row w/ restrictions", [{ ...base, price: 250, minimumNightsOnArrival: 2, stopSell: true }]);
await settle();
const after1 = (await getDaily()).find((r) => String(r.roomTypeId) === ROOM);
show(after1, "after");

// ── Step 2: MAYA's minimal shape ALONE — price only, restrictions omitted
console.log("\n--- step 2: MAYA production shape ALONE (price only, restrictions omitted) ---");
const status = await put("minimal row", [{ roomTypeId: ROOM, rateTypeId: RATE_TYPE, date: DATE, price: 265 }]);
await settle();
const after2 = (await getDaily()).find((r) => String(r.roomTypeId) === ROOM);
show(after2, "after");

console.log("\n" + "=".repeat(64));
console.log(`minimal-shape PUT status:      ${status}`);
console.log(`price applied by minimal PUT:  ${Number(after2?.price) === 265 ? "YES (265)" : `NO (still ${after2?.price})`}`);
console.log(`minimumNightsOnArrival:        ${after1?.minimumNightsOnArrival} -> ${after2?.minimumNightsOnArrival} ${after2?.minimumNightsOnArrival === after1?.minimumNightsOnArrival ? "(PRESERVED)" : "(CHANGED!)"}`);
console.log(`stopSell:                      ${after1?.stopSell} -> ${after2?.stopSell} ${after2?.stopSell === after1?.stopSell ? "(PRESERVED)" : "(CHANGED!)"}`);
console.log("=".repeat(64));

// ── cleanup: restore the date to a clean baseline
console.log("\n--- cleanup: restoring date to price 200, no restrictions ---");
await put("restore", [{ ...base, price: 200, minimumNightsOnArrival: null, stopSell: false }]);
await settle(10000);
const done = (await getDaily()).find((r) => String(r.roomTypeId) === ROOM);
show(done, "restored");
