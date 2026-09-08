/* eslint-disable @typescript-eslint/no-explicit-any -- diagnostic script: vendor JSON is untyped by nature. */
// End-to-end proof that MAYA can move a price in ThinkReservations:
// sync -> engine -> rate-push -> read it back out of Think.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { runThinkSyncForHotel } from "../src/lib/think/sync-hotel";
import { evaluateHotel } from "../src/lib/engine/index";
import { pushRatesForHotel } from "../supabase/functions/_shared/pms/rate-push";
import { createThinkRateAdapter } from "../src/lib/think/rate-push";

const HOTEL_ID = "0709dcce-86ea-4b09-aa17-25c70ece91e1";
const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const stamp = () => new Date().toISOString();

const t0 = Date.now();
const sync = await runThinkSyncForHotel(admin, HOTEL_ID);
console.log(`[${stamp()}] SYNC ${((Date.now()-t0)/1000).toFixed(1)}s ->`, JSON.stringify(sync).slice(0, 220));

const t1 = Date.now();
const ev = await evaluateHotel(admin, HOTEL_ID, undefined, 45);
console.log(`[${stamp()}] EVALUATE ${((Date.now()-t1)/1000).toFixed(1)}s ->`, JSON.stringify(ev));

const { data: raw } = await admin.rpc("pms_secret_get", { p_hotel_id: HOTEL_ID, p_pms_type: "think" });
const secret = typeof raw === "string" ? JSON.parse(raw) : raw;
const adapter = createThinkRateAdapter(
  { accessToken: secret.accessToken, baseUrl: "https://api.thinkreservations.com" },
  String(secret.propertyId),
);

const t2 = Date.now();
const push = await pushRatesForHotel(admin, HOTEL_ID, adapter, { pushHorizonDays: 45 });
console.log(`[${stamp()}] PUSH ${((Date.now()-t2)/1000).toFixed(1)}s ->`, JSON.stringify(push));

// What did MAYA think it sent? Compare against Think's own read.
const { data: sent } = await admin
  .from("rate_updates")
  .select("stay_date, room_type_id, price, status, sent_at")
  .eq("hotel_id", HOTEL_ID)
  .order("sent_at", { ascending: false })
  .limit(5);
console.log(`\nlatest ledger rows:`);
for (const r of sent ?? []) console.log(`  ${r.stay_date} ${String(r.room_type_id).slice(0,8)} $${r.price} ${r.status} ${r.sent_at}`);

if (sent?.length) {
  const probe = sent[0];
  const { data: rt } = await admin.from("room_types").select("external_room_type_id").eq("id", probe.room_type_id).single();
  console.log(`\nverifying ${probe.stay_date} in Think…`);
  await new Promise((r) => setTimeout(r, 15000));
  const res = await fetch(
    `https://api.thinkreservations.com/v1/hotels/${secret.propertyId}/rate_types/44186/daily?startDate=${probe.stay_date}&endDate=${probe.stay_date}`,
    { headers: { Authorization: `Bearer ${secret.accessToken}` } },
  );
  const rows = (await res.json()) as any[];
  const row = rows.find((r) => String(r.roomTypeId) === String(rt?.external_room_type_id));
  console.log(`  MAYA published: $${probe.price}`);
  console.log(`  Think returns:  $${row?.price}`);
  console.log(`  ${Number(row?.price) === Number(probe.price) ? "*** MATCH — MAYA moved a price in Think ***" : "*** MISMATCH ***"}`);
}
