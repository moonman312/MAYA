// One-off: run the Think sync pipeline against the live sandbox and dump
// what landed. Same invocation the manual-sync route makes after its gates.
//   npx tsx scripts/think-live-sync.ts
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { runThinkSyncForHotel } from "../src/lib/think/sync-hotel";

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

const result = await runThinkSyncForHotel(admin, HOTEL_ID);
console.log(JSON.stringify(result, null, 2));

if (result.ok) {
  const { data: rows } = await admin
    .from("reservations")
    .select("external_reservation_id, room_type_id, stay_date, booking_date, booking_window_days, current_rate")
    .eq("hotel_id", HOTEL_ID)
    .order("external_reservation_id")
    .order("stay_date");
  console.log(`\n${rows?.length ?? 0} reservation rows:`);
  for (const r of rows ?? []) {
    console.log(
      `${r.external_reservation_id}  ${r.stay_date}  rate=${r.current_rate}  booked=${r.booking_date} (${r.booking_window_days}d out)`,
    );
  }
  const { data: rts } = await admin
    .from("room_types")
    .select("external_room_type_id, name, total_rooms, is_active")
    .eq("hotel_id", HOTEL_ID)
    .order("name");
  console.log(`\n${rts?.length ?? 0} room types:`);
  for (const rt of rts ?? []) console.log(`${rt.name}  rooms=${rt.total_rooms} active=${rt.is_active}`);
}
