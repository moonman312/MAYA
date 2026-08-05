// Timed end-to-end loop for Cloudbeds: new reservations → sync → rule fires →
// price published → push → poll Cloudbeds until the new rate is live.
//   npx tsx scripts/cloudbeds-live-loop.mts
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { runCloudbedsSyncForHotel } from "../src/lib/cloudbeds/sync-hotel";
import { evaluateHotel } from "../src/lib/engine/index";
import { pushRatesForHotel } from "../supabase/functions/_shared/pms/rate-push";
import { createCloudbedsRateAdapter } from "../supabase/functions/_shared/cloudbeds/rate-push";

const HOTEL_ID = "5846fcc4-4590-400c-8b08-50bd61ccdbf4";
const TARGET_DATE = "2026-09-02";
const QUEEN_RATE_ID = "3142970";
const KING_RATE_ID = "3142971";

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
const ms = (a: string, b: string) => `${((t[b] - t[a]) / 1000).toFixed(1)}s`;

// ── 1. SYNC ──
mark("syncStart");
const sync = await runCloudbedsSyncForHotel(admin, HOTEL_ID);
mark("syncEnd");
if (!sync.ok) throw new Error(`sync failed: ${sync.error}`);
console.log(`[1 SYNC] ${ms("syncStart", "syncEnd")} — rows upserted ${sync.reservationRowsUpserted}`);

const { data: newRows } = await admin
  .from("reservations")
  .select("external_reservation_id, room_type_id, current_rate")
  .eq("hotel_id", HOTEL_ID)
  .eq("stay_date", TARGET_DATE);
console.log(`  ${TARGET_DATE} booked room-nights: ${newRows?.length}`,
  newRows?.map((r) => `${r.external_reservation_id}@$${r.current_rate}`).join(", "));

// ── 2. EVALUATE ──
mark("evalStart");
const evalRes = await evaluateHotel(admin, HOTEL_ID, undefined, 45);
mark("evalEnd");
console.log(`[2 EVALUATE] ${ms("evalStart", "evalEnd")} —`, JSON.stringify(evalRes).slice(0, 250));

const { data: prices } = await admin
  .from("published_price")
  .select("room_type_id, price, base_price")
  .eq("hotel_id", HOTEL_ID)
  .eq("stay_date", TARGET_DATE);
console.log(`  published for ${TARGET_DATE}:`, prices?.map((p) => `$${p.price} (base $${p.base_price})`).join(", "));

// ── 3. PUSH ──
mark("pushStart");
const secretRes = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/pms_secret_get`, {
  method: "POST",
  headers: {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ p_hotel_id: HOTEL_ID, p_pms_type: "cloudbeds" }),
});
const secretRaw = await secretRes.json();
const secret = typeof secretRaw === "string" ? JSON.parse(secretRaw) : secretRaw;
const adapter = createCloudbedsRateAdapter({
  accessToken: secret.accessToken,
  tokenType: secret.tokenType ?? "Bearer",
  baseUrl: "https://api.cloudbeds.com/api/v1.2",
  propertyId: secret.propertyId,
});
const push = await pushRatesForHotel(admin, HOTEL_ID, adapter);
mark("pushEnd");
console.log(`[3 PUSH] ${ms("pushStart", "pushEnd")} —`, JSON.stringify(push));

// ── 4. POLL CLOUDBEDS ──
const want = prices?.[0] ? Number(prices[0].price) : null;
mark("pollStart");
console.log(`[4 POLL] waiting for Cloudbeds to show $${want} on ${TARGET_DATE}…`);
for (let i = 0; i < 36; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const u = new URL("https://api.cloudbeds.com/api/v1.2/getRatePlans");
  u.searchParams.set("startDate", TARGET_DATE);
  u.searchParams.set("endDate", "2026-09-03");
  const res = await fetch(u, { headers: { Authorization: `Bearer ${secret.accessToken}` } });
  const body = (await res.json()) as { data?: Array<{ rateID: string; roomRate: number }> };
  const queen = body.data?.find((p) => p.rateID === QUEEN_RATE_ID)?.roomRate;
  const king = body.data?.find((p) => p.rateID === KING_RATE_ID)?.roomRate;
  console.log(`  t+${(i + 1) * 5}s: queen $${queen} king $${king}`);
  if (queen === want && king === want) {
    mark("pollEnd");
    console.log(`[4 LANDED] both rates live in Cloudbeds ${ms("pollStart", "pollEnd")} after push`);
    process.exit(0);
  }
}
console.log("[4 NOT LANDED] within 180s");
