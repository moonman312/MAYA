/* eslint-disable @typescript-eslint/no-explicit-any -- diagnostic script: vendor JSON is untyped by nature. */
// Full Think roundtrip, timed: bookings -> engine -> rates pushed -> verified
// live in the PMS. Phase 1 is backdated ~25h so it lays the baseline snapshot
// the pickup rule measures against; phase 2 runs at "now".
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { evaluateHotel } from "../src/lib/engine/index";
import { pushRatesForHotel } from "../supabase/functions/_shared/pms/rate-push";
import { createThinkRateAdapter } from "../src/lib/think/rate-push";

const H = "0709dcce-86ea-4b09-aa17-25c70ece91e1";
const D1 = "2026-09-20", D2 = "2026-09-26", D3 = "2026-10-05";
const HORIZON = 30;
const PHASE = process.argv[2] ?? "1";

const env = Object.fromEntries(readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n").filter((l)=>l.includes("=")&&!l.startsWith("#")).map((l)=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1).trim()]));
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth:{persistSession:false} });
const { data: raw } = await admin.rpc("pms_secret_get", { p_hotel_id: H, p_pms_type: "think" });
const secret = typeof raw === "string" ? JSON.parse(raw) : raw;
const THINK_H = String(secret.propertyId);
const adapter = createThinkRateAdapter({ accessToken: secret.accessToken, baseUrl: "https://api.thinkreservations.com" }, THINK_H);

const { data: rooms } = await admin.from("room_types").select("id,name,external_room_type_id").eq("hotel_id", H).order("name");
const extOf = new Map(rooms!.map((r)=>[r.id, r.external_room_type_id]));
const nameOf = new Map(rooms!.map((r)=>[r.id, r.name]));

const readThink = async (date: string) => {
  const r = await fetch(`https://api.thinkreservations.com/v1/hotels/${THINK_H}/rate_types/44186/daily?startDate=${date}&endDate=${date}`, { headers:{ Authorization:`Bearer ${secret.accessToken}` } });
  const rows = (await r.json()) as any[];
  return new Map(rows.map((x)=>[String(x.roomTypeId), Number(x.price)]));
};

console.log(`\n${"=".repeat(70)}\nPHASE ${PHASE}\n${"=".repeat(70)}`);
console.log(`Think BEFORE:`);
for (const d of [D1,D2,D3]) {
  const m = await readThink(d);
  console.log(`  ${d}: ${[...new Set(m.values())].map((v)=>`$${v}`).join(", ")}`);
}

// ── ENGINE ────────────────────────────────────────────────────────────────
const evalTs = PHASE === "1" ? new Date(Date.now() - 25*3600*1000).toISOString() : undefined;
const tE = Date.now();
const ev = await evaluateHotel(admin, H, evalTs, HORIZON);
const evalSec = (Date.now()-tE)/1000;
console.log(`\nENGINE  ${evalSec.toFixed(1)}s  ${JSON.stringify({published:ev.prices_published, act:ev.ladder_activations, deact:ev.ladder_deactivations, pickup:ev.pickup_events_created})}`);

const { data: pp } = await admin.from("published_price").select("stay_date,room_type_id,price,base_price").eq("hotel_id", H).in("stay_date",[D1,D2,D3]).order("stay_date");
console.log("MAYA computed:");
for (const d of [D1,D2,D3]) {
  const vals = [...new Set(pp!.filter((p)=>p.stay_date===d).map((p)=>Number(p.price)))];
  console.log(`  ${d}: ${vals.map((v)=>`$${v}`).join(", ")}`);
}

// which rules fired, from the audit
const { data: audit } = await admin.from("evaluation_audit").select("stay_date,room_type_id,details,final_price").eq("evaluation_run_id", ev.run_id);
const fired = new Map<string,Set<string>>();
for (const a of audit ?? []) {
  const order = ((a.details as any)?.application_order ?? []) as string[];
  if (!fired.has(a.stay_date)) fired.set(a.stay_date, new Set());
  order.forEach((o)=>fired.get(a.stay_date)!.add(o));
}
const { data: rules } = await admin.from("pricing_rules").select("id,name").eq("hotel_id", H);
const rname = new Map(rules!.map((r)=>[r.id, r.name]));
console.log("rules applied:");
for (const d of [D1,D2,D3]) {
  const s = [...(fired.get(d) ?? [])].map((o)=>{ const [k,id]=o.split(":"); return k==="ladder" ? (rname.get(id) ?? id) : `pickup event`; });
  console.log(`  ${d}: ${s.length ? [...new Set(s)].join(" + ") : "(none)"}`);
}

// ── PUSH ──────────────────────────────────────────────────────────────────
const tP = Date.now();
const push = await pushRatesForHotel(admin, H, adapter, { pushHorizonDays: HORIZON });
const pushSec = (Date.now()-tP)/1000;
console.log(`\nPUSH    ${pushSec.toFixed(1)}s  ${JSON.stringify(push)}`);

// ── VERIFY IN PMS ─────────────────────────────────────────────────────────
const tV = Date.now();
let landed = false, waited = 0;
const want = new Map<string, Map<string, number>>();
for (const d of [D1,D2,D3]) {
  want.set(d, new Map(pp!.filter((p)=>p.stay_date===d).map((p)=>[String(extOf.get(p.room_type_id)), Number(p.price)])));
}
for (let i=0;i<20;i++){
  await new Promise((r)=>setTimeout(r,3000));
  waited = (Date.now()-tV)/1000;
  let ok = true;
  for (const d of [D1,D2,D3]) {
    const live = await readThink(d);
    for (const [ext, price] of want.get(d)!) if (live.get(ext) !== price) { ok = false; break; }
    if (!ok) break;
  }
  if (ok) { landed = true; break; }
}
console.log(`VERIFY  ${waited.toFixed(1)}s  ${landed ? "all pushed rates present in Think" : "NOT all rates matched"}`);

console.log(`\nThink AFTER:`);
for (const d of [D1,D2,D3]) {
  const m = await readThink(d);
  const byPrice = new Map<number,string[]>();
  for (const [ext,price] of m) { const n = nameOf.get([...extOf.entries()].find(([,e])=>e===ext)?.[0] ?? "") ?? ext.slice(0,6); (byPrice.get(price) ?? byPrice.set(price,[]).get(price)!).push(n); }
  console.log(`  ${d}: ${[...byPrice.entries()].map(([p,ns])=>`$${p} (${ns.length} rooms)`).join(", ")}`);
}

console.log(`\nTIMING  engine ${evalSec.toFixed(1)}s + push ${pushSec.toFixed(1)}s + PMS apply ${waited.toFixed(1)}s = ${(evalSec+pushSec+waited).toFixed(1)}s total`);
