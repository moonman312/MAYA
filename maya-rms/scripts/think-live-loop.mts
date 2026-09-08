// Timed end-to-end loop: new Think reservation → sync → rule fires →
// price published → push back to Think → poll for it landing.
// Run AFTER the trigger reservation exists in the Think console:
//   npx tsx scripts/think-live-loop.mts
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { runThinkSyncForHotel } from "../src/lib/think/sync-hotel";
import { evaluateHotel } from "../src/lib/engine/index";
import { pushRatesForHotel } from "../supabase/functions/_shared/pms/rate-push";
import { createThinkRateAdapter } from "../src/lib/think/rate-push";

const HOTEL_ID = "0709dcce-86ea-4b09-aa17-25c70ece91e1";
const THINK_HOTEL_ID = "613527194358";
const TARGET_DATE = "2026-08-14";
const ROOM1_EXTERNAL = "af45c5b1-14b5-4287-8de3-d8ff28ee24cd";

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
const ms = (a: string, b: string) => `${t[b] - t[a]}ms`;

// ── 1. SYNC ──
mark("syncStart");
const sync = await runThinkSyncForHotel(admin, HOTEL_ID);
mark("syncEnd");
if (!sync.ok) throw new Error(`sync failed: ${sync.error}`);
console.log(`[1 SYNC] ${ms("syncStart", "syncEnd")} — mode window ${sync.fetchWindow.start} → ${sync.fetchWindow.end}, rows upserted ${sync.reservationRowsUpserted}`);

const { data: newRows } = await admin
  .from("reservations")
  .select("external_reservation_id, stay_date, current_rate")
  .eq("hotel_id", HOTEL_ID)
  .eq("stay_date", TARGET_DATE);
console.log(`  ${TARGET_DATE} now has ${newRows?.length} booked room-nights:`, newRows?.map((r) => r.external_reservation_id).join(", "));

// ── 2. EVALUATE (rule should fire) ──
mark("evalStart");
const evalRes = await evaluateHotel(admin, HOTEL_ID, undefined, 45);
mark("evalEnd");
console.log(`[2 EVALUATE] ${ms("evalStart", "evalEnd")} —`, JSON.stringify(evalRes).slice(0, 300));

const { data: prices } = await admin
  .from("published_price")
  .select("room_type_id, stay_date, price")
  .eq("hotel_id", HOTEL_ID)
  .eq("stay_date", TARGET_DATE);
console.log(`  published prices for ${TARGET_DATE}:`, prices?.map((p) => `$${p.price}`).join(", "));

// ── 3. PUSH ──
mark("pushStart");
const { data: connRow } = await admin
  .from("pms_connections")
  .select("base_url")
  .eq("hotel_id", HOTEL_ID)
  .eq("pms_type", "think")
  .maybeSingle();
const secretRes = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/pms_secret_get`, {
  method: "POST",
  headers: {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ p_hotel_id: HOTEL_ID, p_pms_type: "think" }),
});
const secretRaw = await secretRes.json();
const secret = typeof secretRaw === "string" ? JSON.parse(secretRaw) : secretRaw;
const adapter = createThinkRateAdapter(
  {
    accessToken: secret.accessToken,
    baseUrl: ((connRow?.base_url as string | null) || "https://api.thinkreservations.com").replace(/\/$/, ""),
  },
  THINK_HOTEL_ID,
);
const push = await pushRatesForHotel(admin, HOTEL_ID, adapter);
mark("pushEnd");
console.log(`[3 PUSH] ${ms("pushStart", "pushEnd")} —`, JSON.stringify(push));

// ── 4. POLL THINK for the new rate ──
mark("pollStart");
const target = prices?.find(() => true);
const want = target ? Number(target.price) : null;
console.log(`[4 POLL] waiting for Think to show $${want} on ${TARGET_DATE} (Room 1)…`);
for (let i = 0; i < 24; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const rb = await fetch(
    `https://api.thinkreservations.com/v1/hotels/${THINK_HOTEL_ID}/rate_types/44186/daily?start_date=${TARGET_DATE}&end_date=${TARGET_DATE}`,
    { headers: { Authorization: `Bearer ${secret.accessToken}` } },
  );
  const daily = await rb.json();
  const cell = Array.isArray(daily) ? daily.find((d) => d.roomTypeId === ROOM1_EXTERNAL) : null;
  process.stdout.write(`  t+${(i + 1) * 5}s: $${cell?.price}\n`);
  if (cell?.price === want) {
    mark("pollEnd");
    console.log(`[4 LANDED] ${ms("pollStart", "pollEnd")} after 202`);
    process.exit(0);
  }
}
console.log("[4 NOT LANDED] within 120s — Think 202'd but the async job has not applied (known sandbox behavior, question pending with Think).");
