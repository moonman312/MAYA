import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { evaluateHotel } from "../src/lib/engine/index";

const H = "0709dcce-86ea-4b09-aa17-25c70ece91e1";
const DATE = new Date(Date.now() + 5*86400000).toISOString().slice(0,10);
const env = Object.fromEntries(readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n").filter((l)=>l.includes("=")&&!l.startsWith("#")).map((l)=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1).trim()]));
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth:{persistSession:false} });
const { data: rooms } = await admin.from("room_types").select("id,name").eq("hotel_id",H).order("name");
const R = rooms!;
const clean = async () => {
  await admin.from("reservations").delete().eq("hotel_id",H).like("external_reservation_id","RV-%");
  for (const t of ["published_price","stay_date_snapshot","evaluation_audit"]) await admin.from(t).delete().eq("hotel_id",H).eq("stay_date",DATE);
  const { data: rs } = await admin.from("pricing_rules").select("id").eq("hotel_id",H);
  for (const r of rs ?? []) { await admin.from("ladder_rule_state").delete().eq("rule_id",r.id).eq("stay_date",DATE); await admin.from("ladder_transition_event").delete().eq("rule_id",r.id).eq("stay_date",DATE); }
};
const cell = async (i: number) => (await admin.from("published_price").select("price,base_price").eq("hotel_id",H).eq("stay_date",DATE).eq("room_type_id",R[i].id).maybeSingle()).data;
const occ = async () => { const { data } = await admin.from("reservations").select("id").eq("hotel_id",H).eq("stay_date",DATE); return `${data?.length ?? 0}/8 = ${(((data?.length ?? 0)/8)*100).toFixed(1)}%`; };

await clean();
await admin.from("published_price").insert(R.map((r)=>({ hotel_id:H, stay_date:DATE, room_type_id:r.id, price:200, base_price:200, computed_at:new Date(Date.now()-30*86400000).toISOString() })));
await admin.from("reservations").insert(R.slice(0,5).map((r,i)=>({ hotel_id:H, external_reservation_id:`RV-A${i}`, room_type_id:r.id, stay_date:DATE, booking_date:new Date(Date.now()-3*86400000).toISOString().slice(0,10), booking_window_days:8, current_rate:200, base_rate:200, raw_payload:null })));
console.log(`date ${DATE} | hotel rate $200 | rule: +15% over 60% occupancy\n`);
console.log(`occupancy ${await occ()} -> rule should ACTIVATE`);
let r = await evaluateHotel(admin, H, undefined, 6);
console.log(`  run 1: activations ${r.ladder_activations}, deactivations ${r.ladder_deactivations}`);
console.log(`  room 6: base $${(await cell(5))?.base_price} price $${(await cell(5))?.price}`);
const p = Number((await cell(5))!.price);
await admin.from("reservations").insert([{ hotel_id:H, external_reservation_id:"RV-GUEST", room_type_id:R[5].id, stay_date:DATE, booking_date:new Date().toISOString().slice(0,10), booking_window_days:5, current_rate:p, base_rate:null, raw_payload:null }]);
console.log(`\nguest books room 6 at MAYA's $${p}. occupancy ${await occ()} -> still over 60%`);
r = await evaluateHotel(admin, H, undefined, 6);
console.log(`  run 2: activations ${r.ladder_activations}, deactivations ${r.ladder_deactivations}  <- rule did NOT re-fire`);
console.log(`  room 6: base $${(await cell(5))?.base_price} price $${(await cell(5))?.price}`);
await admin.from("reservations").delete().eq("hotel_id",H).eq("stay_date",DATE).in("external_reservation_id",["RV-A0","RV-A1","RV-A2"]);
console.log(`\n3 cancellations. occupancy ${await occ()} -> under 60%, rule should DEACTIVATE`);
r = await evaluateHotel(admin, H, undefined, 6);
console.log(`  run 3: activations ${r.ladder_activations}, deactivations ${r.ladder_deactivations}`);
const b = await cell(5), u = await cell(7);
console.log(`\n${"=".repeat(64)}`);
console.log(`After revert the night should be back at the hotel's $200:`);
console.log(`  room 8 (never booked)   -> $${u?.price}   ${Number(u?.price)===200?"correct":"WRONG"}`);
console.log(`  room 6 (guest booked)   -> $${b?.price}   ${Number(b?.price)===200?"correct":"WRONG - permanently raised"}`);
console.log("=".repeat(64));
await clean(); console.log("cleaned up");
