// Does a booking taken AT MAYA's pushed price become the engine's new base?
// Uses the existing "Occupancy 60+ Surge" rule (+15% when occupancy > 60%).
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { evaluateHotel } from "../src/lib/engine/index";

const H = "0709dcce-86ea-4b09-aa17-25c70ece91e1";
const DATE = new Date(Date.now() + 5*86400000).toISOString().slice(0,10);
const HORIZON = 6;
const env = Object.fromEntries(readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n").filter((l)=>l.includes("=")&&!l.startsWith("#")).map((l)=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1).trim()]));
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth:{persistSession:false} });
const { data: rooms } = await admin.from("room_types").select("id,name").eq("hotel_id",H).order("name");

const clean = async () => {
  await admin.from("reservations").delete().eq("hotel_id",H).like("external_reservation_id","BF-%");
  for (const t of ["published_price","stay_date_snapshot","evaluation_audit"]) await admin.from(t).delete().eq("hotel_id",H).eq("stay_date",DATE);
  const { data: rs } = await admin.from("pricing_rules").select("id").eq("hotel_id",H);
  for (const r of rs ?? []) { await admin.from("ladder_rule_state").delete().eq("rule_id",r.id).eq("stay_date",DATE); await admin.from("pickup_event").delete().eq("rule_id",r.id).eq("stay_date",DATE); }
};
const showBase = async (tag: string) => {
  const { data: res } = await admin.from("reservations").select("base_rate,current_rate,created_at").eq("hotel_id",H).eq("stay_date",DATE).order("created_at",{ascending:false});
  const { data: pp } = await admin.from("published_price").select("price,base_price").eq("hotel_id",H).eq("stay_date",DATE).limit(1);
  console.log(`  ${tag}: newest reservation base_rate=${res?.[0]?.base_rate ?? "-"} | published price=$${pp?.[0]?.price ?? "-"} (base $${pp?.[0]?.base_price ?? "-"})`);
};

await clean();
console.log(`date under test: ${DATE}  (rule: Occupancy 60+ Surge, +15%)\n`);

// remembered base 200 for every room type, 5/8 booked at 200 -> 62.5% occupancy
await admin.from("published_price").insert(rooms!.map((r)=>({ hotel_id:H, stay_date:DATE, room_type_id:r.id, price:200, base_price:200, computed_at:new Date(Date.now()-30*86400000).toISOString() })));
await admin.from("reservations").insert(rooms!.slice(0,5).map((r,i)=>({
  hotel_id:H, external_reservation_id:`BF-INIT-${i}`, room_type_id:r.id, stay_date:DATE,
  booking_date:new Date(Date.now()-3*86400000).toISOString().slice(0,10), booking_window_days:8,
  current_rate:200, base_rate:200, raw_payload:null })));
console.log("seeded: base 200 everywhere, 5/8 rooms booked at $200 (62.5% occupancy)");
await showBase("before run 1");

const r1 = await evaluateHotel(admin, H, undefined, HORIZON);
console.log(`\nRUN 1 -> published ${r1.prices_published}, activations ${r1.ladder_activations}`);
await showBase("after run 1");

// A guest now books a 6th room AT MAYA's pushed price.
const { data: pp1 } = await admin.from("published_price").select("price").eq("hotel_id",H).eq("stay_date",DATE).limit(1);
const mayaPrice = Number(pp1![0].price);
await admin.from("reservations").insert([{
  hotel_id:H, external_reservation_id:"BF-GUEST-AT-MAYA-PRICE", room_type_id:rooms![5].id, stay_date:DATE,
  booking_date:new Date().toISOString().slice(0,10), booking_window_days:5,
  current_rate:mayaPrice, base_rate:null, raw_payload:null }]);
console.log(`\na guest books room 6 at MAYA's pushed price of $${mayaPrice} (base_rate left null -> trigger fills it)`);
await showBase("after booking");

const r2 = await evaluateHotel(admin, H, undefined, HORIZON);
console.log(`\nRUN 2 -> published ${r2.prices_published}, activations ${r2.ladder_activations}`);
await showBase("after run 2");

const { data: fin } = await admin.from("published_price").select("price,base_price,room_type_id").eq("hotel_id",H).eq("stay_date",DATE);
const booked = fin!.find((f)=>f.room_type_id===rooms![5].id);
const unbooked = fin!.find((f)=>f.room_type_id===rooms![7].id);
console.log(`\n${"=".repeat(66)}`);
console.log(`the cell the guest booked : base $${booked?.base_price} -> price $${booked?.price}`);
console.log(`an untouched cell         : base $${unbooked?.base_price} -> price $${unbooked?.price}`);
console.log(Number(booked?.base_price) > 200
  ? `RATCHET CONFIRMED: base moved 200 -> ${booked?.base_price} because of a booking at MAYA's own price`
  : `NO RATCHET: base stayed at ${booked?.base_price}`);
console.log("=".repeat(66));
await clean();
console.log("cleaned up");
