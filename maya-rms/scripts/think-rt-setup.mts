// Stage 1 of the Think roundtrip: create three rule types and seed the
// conditions they need. Reservations are written exactly as runThinkSyncForHotel
// writes them (Think's OAuth scopes are read:reservation, so bookings cannot be
// created through their API); everything downstream runs for real.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const H = "0709dcce-86ea-4b09-aa17-25c70ece91e1";
const env = Object.fromEntries(readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n").filter((l)=>l.includes("=")&&!l.startsWith("#")).map((l)=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1).trim()]));
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth:{persistSession:false} });

export const D1 = "2026-09-20"; // 12 days out
export const D2 = "2026-09-26"; // 18 days out
export const D3 = "2026-10-05"; // 27 days out

const { data: rts } = await admin.from("room_types").select("id,name,external_room_type_id").eq("hotel_id", H).order("name");
const rooms = rts!;
const allIds = rooms.map((r) => r.id);

// ── clean any prior run of this test ──────────────────────────────────────
await admin.from("reservations").delete().eq("hotel_id", H).like("external_reservation_id", "RT-TEST-%");
const { data: oldRules } = await admin.from("pricing_rules").select("id").eq("hotel_id", H).like("name", "RT %");
for (const r of oldRules ?? []) {
  await admin.from("pickup_event").delete().eq("rule_id", r.id);
  await admin.from("ladder_rule_state").delete().eq("rule_id", r.id);
  await admin.from("pricing_rules").delete().eq("id", r.id);
}
await admin.from("published_price").delete().eq("hotel_id", H).in("stay_date", [D1, D2, D3]);
await admin.from("stay_date_snapshot").delete().eq("hotel_id", H).in("stay_date", [D1, D2, D3]);
console.log("cleaned prior test artifacts");

// ── rules ─────────────────────────────────────────────────────────────────
async function mkRule(name: string, opts: {
  pickup?: boolean; dir: "increase"|"decrease"; type: "percent"|"fixed"; value: number; priority: number;
  cond: Record<string, unknown>;
}) {
  const { data: rule, error } = await admin.from("pricing_rules").insert({
    hotel_id: H, name, is_active: true, version: 1, priority: opts.priority,
    start_date: null, end_date: null, is_annual: false, dow_mask: 127,
    action_type: opts.type, action_direction: opts.dir, action_value: opts.value,
    is_pickup_rule: !!opts.pickup,
  }).select("id").single();
  if (error) throw new Error(`${name}: ${error.message}`);
  await admin.from("rule_condition").insert({ rule_id: rule.id, ...opts.cond });
  await admin.from("rule_signal_room_type").insert(allIds.map((room_type_id) => ({ rule_id: rule.id, room_type_id })));
  await admin.from("rule_affected_room_type").insert(allIds.map((room_type_id) => ({ rule_id: rule.id, room_type_id })));
  console.log(`  rule "${name}" -> ${rule.id.slice(0,8)}`);
  return rule.id;
}

console.log("\ncreating rules:");
await mkRule("RT Occupancy 60+", { dir:"increase", type:"percent", value:15, priority:100, cond:{ occupancy_operator:"gt", occupancy_threshold:0.6 } });
await mkRule("RT Close-in 21d",  { dir:"increase", type:"percent", value:8,  priority:90,  cond:{ dta_operator:"lt", dta_threshold_days:21 } });
await mkRule("RT Pickup surge",  { pickup:true, dir:"increase", type:"fixed", value:12, priority:120, cond:{ pickup_operator:"gt", pickup_threshold:2, pickup_window_days:1, pickup_metric:"room_nights" } });

// ── remembered base price for every cell (as a prior MAYA run would leave) ──
const rows = [];
for (const d of [D1, D2, D3]) for (const r of rooms) {
  rows.push({ hotel_id: H, stay_date: d, room_type_id: r.id, price: 200, base_price: 200, computed_at: new Date(Date.now() - 30*86400000).toISOString() });
}
await admin.from("published_price").insert(rows);
console.log(`\nseeded ${rows.length} published_price rows (base 200, matching Think's $200 daily rate)`);

// ── phase-1 bookings: drive occupancy differentially ──────────────────────
const mkRes = (tag: string, date: string, room: { id: string }, n: number) => ({
  hotel_id: H, external_reservation_id: `RT-TEST-${tag}`, room_type_id: room.id,
  stay_date: date, booking_date: new Date(Date.now()-5*86400000).toISOString().slice(0,10),
  booking_window_days: n, current_rate: 200, base_rate: 200, raw_payload: null,
});
const p1: Record<string, unknown>[] = [];
rooms.slice(0,5).forEach((r,i)=>p1.push(mkRes(`P1-D1-${i}`, D1, r, 12))); // 5/8 = 62.5% -> occupancy fires
rooms.slice(0,3).forEach((r,i)=>p1.push(mkRes(`P1-D2-${i}`, D2, r, 18))); // 3/8 = 37.5% -> no occupancy
rooms.slice(0,6).forEach((r,i)=>p1.push(mkRes(`P1-D3-${i}`, D3, r, 27))); // 6/8 = 75%   -> occupancy fires
const { error: resErr } = await admin.from("reservations").insert(p1);
if (resErr) throw new Error(resErr.message);
console.log(`seeded ${p1.length} phase-1 reservations`);
console.log(`\n  ${D1}: 5/8 booked (62.5%) -> occupancy YES, close-in YES (12d)`);
console.log(`  ${D2}: 3/8 booked (37.5%) -> occupancy no,  close-in YES (18d)`);
console.log(`  ${D3}: 6/8 booked (75.0%) -> occupancy YES, close-in no  (27d)`);
