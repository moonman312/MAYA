/* eslint-disable @typescript-eslint/no-explicit-any -- ad-hoc probe against live rows. */
// Runs the Rate Simulator's own simulate() over a real property's real rules
// and real room types, so the browser isn't the only place it has been proven.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { listEngineRules } from "../src/lib/rules-store";
import { isoDatePlus, simulate, SIM_SKIP_LABEL, type SimRoomType } from "../src/lib/simulator";

const HOTEL = process.argv[2] ?? "5846fcc4-4590-400c-8b08-50bd61ccdbf4";
const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const { data: rts } = await admin
  .from("room_types").select("id, name, total_rooms, floor_price, ceiling_price")
  .eq("hotel_id", HOTEL).eq("is_active", true).order("name");
const roomTypes = (rts ?? []) as SimRoomType[];

// Mirror the seeding /api/room-types?withRate=1 does, so the probe opens on the
// same numbers the browser would.
const today = new Date().toISOString().slice(0, 10);
const { data: pubs } = await admin
  .from("published_price").select("room_type_id, stay_date, price, base_price")
  .eq("hotel_id", HOTEL).gte("stay_date", today).order("stay_date").limit(1000);
const seed = new Map<string, number>();
for (const row of pubs ?? []) {
  const id = String(row.room_type_id);
  if (seed.has(id)) continue;
  const pick = row.base_price != null && Number(row.base_price) > 0 ? Number(row.base_price) : Number(row.price);
  if (Number.isFinite(pick) && pick > 0) seed.set(id, pick);
}
const fallback = (f: number, c: number) => (c > 0 && f > 0 && c <= f * 10 ? Math.round((f + c) / 2) : Math.max(1, Math.round(f)));
const seedFor = (rt: SimRoomType) => seed.get(rt.id) ?? fallback(rt.floor_price, rt.ceiling_price);
const rules = await listEngineRules(admin as any, HOTEL, { includeInactive: true });

const stayDate = isoDatePlus(30);
for (const occ of [30, 70, 95]) {
  const rows = simulate(rules, roomTypes, {
    stayDate,
    evalDate: isoDatePlus(0),
    hotelTimeZone: "UTC",
    rooms: Object.fromEntries(
      roomTypes.map((rt) => [rt.id, {
        basePrice: Math.round(seedFor(rt)),
        occupancyPct: occ,
        pickupUnits: 4,
      }]),
    ),
    bookingSpeedLevel: null,
    bookingSpeedWindowDays: 7,
  });
  console.log(`\n===== ${occ}% occupancy, stay ${stayDate} =====`);
  for (const r of rows) {
    const fired = r.outcomes.filter((o) => o.fired).map((o) => o.ruleName);
    console.log(
      `  ${r.roomType.name.padEnd(22)} $${r.basePrice.toFixed(2).padStart(8)} -> $${r.finalPrice.toFixed(2).padStart(8)}` +
      `${r.clampedBy !== "none" ? ` [${r.clampedBy}, asked $${r.preClampPrice.toFixed(2)}]` : ""}  ${fired.length} fired: ${fired.join(", ") || "—"}`,
    );
    const blocked = r.outcomes.filter((o) => !o.fired && o.skipReason !== "not_affected");
    for (const b of blocked.slice(0, 3)) {
      console.log(`        · ${b.ruleName.slice(0,28).padEnd(28)} ${SIM_SKIP_LABEL[b.skipReason!]}`);
    }
  }
}
