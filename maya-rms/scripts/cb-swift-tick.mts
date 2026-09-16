// The Swift test: one Phase-1 incremental tick, timed end to end.
// Three bookings landed on 2027-05-15 (~9 months out). This runs exactly what
// the scheduled tick runs: sync → change-triggered far pricing → push, then
// polls Cloudbeds until the far date's new rate is live.
//   npx tsx scripts/cb-swift-tick.mts
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { runCloudbedsSyncForHotel } from "../src/lib/cloudbeds/sync-hotel";
import { evaluateHotel } from "../src/lib/engine/index";
import { pushRatesForHotel } from "../supabase/functions/_shared/pms/rate-push";
import { createCloudbedsRateAdapter } from "../supabase/functions/_shared/cloudbeds/rate-push";

const HOTEL_ID = "5846fcc4-4590-400c-8b08-50bd61ccdbf4";
const TARGET = "2027-05-15";
const QUEEN_RATE_ID = "3142970";
const KING_RATE_ID = "3142971";
const HORIZON = 45;

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const t: Record<string, number> = {};
const mark = (k: string) => (t[k] = Date.now());
const s = (a: string, b: string) => `${((t[b] - t[a]) / 1000).toFixed(1)}s`;

// ── 1. SYNC (the tick's first act) ──
mark("syncStart");
const sync = await runCloudbedsSyncForHotel(admin, HOTEL_ID);
mark("syncEnd");
if (!sync.ok) throw new Error(`sync failed: ${sync.error}`);
console.log(`[1 SYNC] ${s("syncStart", "syncEnd")} — mode=${sync.mode}, upserted ${sync.reservationRowsUpserted}`);
console.log(`  changedStayDates: ${sync.changedStayDates.join(", ") || "(none)"}`);

// ── 2. The scheduled tick's far-change decision, verbatim ──
const FAR_TARGET_MAX = 50;
const horizonEnd = new Date(Date.now() + HORIZON * 86_400_000).toISOString().slice(0, 10);
const farChanged = sync.changedStayDates.filter((d) => d > horizonEnd);
console.log(`[2 DECISION] far-changed dates beyond ${horizonEnd}: ${farChanged.join(", ") || "(none)"}`);
if (farChanged.length === 0) {
  console.log("NOTHING FAR CHANGED — Cloudbeds index likely still cold. Re-run later.");
  process.exit(2);
}
const escalate = farChanged.length > FAR_TARGET_MAX;

// ── 3. EVALUATE: near horizon + the changed far dates, one run ──
mark("evalStart");
const evalRes = await evaluateHotel(
  admin,
  HOTEL_ID,
  undefined,
  escalate ? 396 : HORIZON,
  escalate ? undefined : { extraStayDates: farChanged },
);
mark("evalEnd");
console.log(`[3 EVALUATE] ${s("evalStart", "evalEnd")} —`, JSON.stringify(evalRes).slice(0, 220));

const { data: prices } = await admin
  .from("published_price")
  .select("room_type_id, price, base_price")
  .eq("hotel_id", HOTEL_ID)
  .eq("stay_date", TARGET);
console.log(`  published for ${TARGET}:`, prices?.map((p) => `$${p.price} (base $${p.base_price})`).join(", ") || "(none)");
if (!prices?.length) {
  console.log("NO PRICE PUBLISHED for the far date — investigate before pushing.");
  process.exit(1);
}
const want = Number(prices[0].price);

// ── 4. PUSH with the stretched window ──
mark("pushStart");
const rpc = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/pms_secret_get`, {
  method: "POST",
  headers: {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ p_hotel_id: HOTEL_ID, p_pms_type: "cloudbeds" }),
});
const secretRaw = await rpc.json();
const secret = typeof secretRaw === "string" ? JSON.parse(secretRaw) : secretRaw;
const adapter = createCloudbedsRateAdapter({
  accessToken: secret.accessToken,
  tokenType: secret.tokenType ?? "Bearer",
  baseUrl: "https://api.cloudbeds.com/api/v1.2",
  propertyId: secret.propertyId,
});
const push = await pushRatesForHotel(admin, HOTEL_ID, adapter, { pushHorizonDays: 396 });
mark("pushEnd");
console.log(`[4 PUSH] ${s("pushStart", "pushEnd")} —`, JSON.stringify(push));

// ── 5. POLL Cloudbeds for the far date ──
mark("pollStart");
console.log(`[5 POLL] waiting for Cloudbeds to show $${want} on ${TARGET}…`);
for (let i = 0; i < 36; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const u = new URL("https://api.cloudbeds.com/api/v1.2/getRatePlans");
  u.searchParams.set("startDate", TARGET);
  u.searchParams.set("endDate", "2027-05-16");
  const res = await fetch(u, { headers: { Authorization: `Bearer ${secret.accessToken}` } });
  const body = (await res.json()) as { data?: Array<{ rateID: string; roomRate: number }> };
  const queen = body.data?.find((p) => p.rateID === QUEEN_RATE_ID)?.roomRate;
  const king = body.data?.find((p) => p.rateID === KING_RATE_ID)?.roomRate;
  console.log(`  t+${(i + 1) * 5}s: queen $${queen} king $${king}`);
  if (queen === want && king === want) {
    mark("pollEnd");
    console.log(`\nSWIFT TEST PASSED: nine-months-out date repriced in one tick — sync ${s("syncStart", "syncEnd")}, evaluate ${s("evalStart", "evalEnd")}, push ${s("pushStart", "pushEnd")}, live in Cloudbeds ${s("pollStart", "pollEnd")} after push. Total tick-to-PMS: ${s("syncStart", "pollEnd")}.`);
    process.exit(0);
  }
}
console.log("[NOT LANDED] within 180s");
process.exit(1);
