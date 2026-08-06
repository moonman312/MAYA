// One-off: run the pricing engine over the Think sandbox hotel's synced data
// and show what it computed. Proves the data → engine chain on live rows.
//   npx tsx scripts/think-live-evaluate.mts
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { evaluateHotel } from "../src/lib/engine/index";

const HOTEL_ID = "0709dcce-86ea-4b09-aa17-25c70ece91e1";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const result = await evaluateHotel(admin, HOTEL_ID, undefined, 45);
console.log(JSON.stringify(result, null, 2).slice(0, 1500));

const { data: prices } = await admin
  .from("published_price")
  .select("room_type_id, stay_date, price")
  .eq("hotel_id", HOTEL_ID)
  .order("stay_date")
  .limit(12);
console.log(`\npublished_price sample (${prices?.length ?? 0} of first 12):`);
for (const p of prices ?? []) console.log(`${p.stay_date}  $${p.price}`);
