/* eslint-disable @typescript-eslint/no-explicit-any -- probing untyped vendor JSON. */
// Live check of every endpoint Cloudbeds lists as MANDATORY for the RMS
// category, with the parameters their docs specify.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const H = "5846fcc4-4590-400c-8b08-50bd61ccdbf4";
const env = Object.fromEntries(readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n").filter((l)=>l.includes("=")&&!l.startsWith("#")).map((l)=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1).trim()]));
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth:{persistSession:false} });
const { data: raw } = await admin.rpc("pms_secret_get", { p_hotel_id:H, p_pms_type:"cloudbeds" });
const s = typeof raw==="string"?JSON.parse(raw):raw;
const TOKEN = s.accessToken, PID = s.propertyId;
const API = "https://api.cloudbeds.com/api/v1.2";

const today = new Date().toISOString().slice(0,10);
const plus7 = new Date(Date.now()+7*86400000).toISOString().slice(0,10);

async function probe(label: string, path: string, params: Record<string,string>) {
  const u = new URL(`${API}/${path}`);
  for (const [k,v] of Object.entries(params)) u.searchParams.set(k,v);
  try {
    const r = await fetch(u, { headers:{ Authorization:`Bearer ${TOKEN}` } });
    const t = await r.text();
    let j: any = null; try { j = JSON.parse(t); } catch {}
    const ok = r.ok && j?.success !== false;
    const n = Array.isArray(j?.data) ? j.data.length : (j?.data ? 1 : 0);
    const note = ok ? `${n} rows` : `${j?.message ?? t.slice(0,120)}`;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(38)} HTTP ${r.status}  ${note}`);
    return { ok, json: j };
  } catch (e) {
    console.log(`FAIL  ${label.padEnd(38)} ${e instanceof Error ? e.message : e}`);
    return { ok:false, json:null };
  }
}

console.log(`property ${PID} | window ${today} -> ${plus7}\n--- RMS MANDATORY ---`);
await probe("getRoomTypes", "getRoomTypes", { propertyID: PID });
await probe("getRooms", "getRooms", { propertyID: PID });
const rp = await probe("getRatePlans (detailedRates=true)", "getRatePlans", { propertyID: PID, startDate: today, endDate: plus7, detailedRates: "true" });
await probe("getRate (detailedRates=true)", "getRate", { propertyID: PID, startDate: today, endDate: plus7, detailedRates: "true" });
await probe("getTaxesAndFees", "getTaxesAndFees", { propertyID: PID });
await probe("getReservations", "getReservations", { propertyID: PID, pageSize: "5" });
await probe("getReservationsWithRateDetails", "getReservationsWithRateDetails", { propertyID: PID, pageSize: "2" });
await probe("getRateJobs", "getRateJobs", { propertyID: PID });
console.log("\n--- RMS OPTIONAL ---");
await probe("getRoomBlocks", "getRoomBlocks", { propertyID: PID, startDate: today, endDate: plus7 });
await probe("getAllotmentBlocks", "getAllotmentBlocks", { propertyID: PID });
console.log("\n--- BI / REPORTING (other category Cloudbeds linked) ---");
await probe("getHotelDetails", "getHotelDetails", { propertyID: PID });
await probe("getPaymentMethods", "getPaymentMethods", { propertyID: PID });
await probe("getSources", "getSources", { propertyID: PID });
await probe("getItems", "getItems", { propertyID: PID });
await probe("getGuestsByFilter", "getGuestsByFilter", { propertyID: PID, pageSize: "2" });

// What does detailedRates actually give us that MAYA isn't using?
if (rp.ok && rp.json?.data?.[0]) {
  console.log("\n--- what getRatePlans detailedRates returns (first plan) ---");
  const p = rp.json.data[0];
  console.log("  keys:", Object.keys(p).join(", "));
  if (p.roomRateDetailed) console.log("  roomRateDetailed sample:", JSON.stringify(p.roomRateDetailed).slice(0,300));
}
