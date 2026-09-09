/* eslint-disable @typescript-eslint/no-explicit-any -- probing untyped vendor JSON. */
// Settle it empirically: does the classic v1.2 data API answer on BOTH hosts?
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const H = "5846fcc4-4590-400c-8b08-50bd61ccdbf4";
const env = Object.fromEntries(readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n").filter((l)=>l.includes("=")&&!l.startsWith("#")).map((l)=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1).trim()]));
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth:{persistSession:false} });
const { data: raw } = await admin.rpc("pms_secret_get", { p_hotel_id:H, p_pms_type:"cloudbeds" });
const s = typeof raw==="string"?JSON.parse(raw):raw;
const TOKEN = s.accessToken, PID = s.propertyId;

const HOSTS = ["https://api.cloudbeds.com/api/v1.2", "https://hotels.cloudbeds.com/api/v1.2"];
const today = new Date().toISOString().slice(0,10);
const plus7 = new Date(Date.now()+7*86400000).toISOString().slice(0,10);
const CALLS: Array<[string, Record<string,string>]> = [
  ["getUserInfo", {}],
  ["getRoomTypes", { propertyID: PID }],
  ["getRatePlans", { propertyID: PID, startDate: today, endDate: plus7, detailedRates: "true" }],
  ["getReservations", { propertyID: PID, pageSize: "3" }],
  ["getRateJobs", { propertyID: PID }],
  ["getTaxesAndFees", { propertyID: PID }],
];

for (const base of HOSTS) {
  console.log(`\n===== ${base} =====`);
  for (const [m, params] of CALLS) {
    const u = new URL(`${base}/${m}`);
    for (const [k,v] of Object.entries(params)) u.searchParams.set(k,v);
    const t0 = Date.now();
    try {
      const r = await fetch(u, { headers: { Authorization: `Bearer ${TOKEN}` }, redirect: "manual" });
      const body = await r.text();
      let j: any = null; try { j = JSON.parse(body); } catch {}
      const isJson = j !== null;
      const ok = r.ok && j?.success !== false;
      const n = Array.isArray(j?.data) ? j.data.length : (j?.data ? 1 : 0);
      const note = isJson ? (ok ? `${n} rows` : String(j?.message ?? "").slice(0,80)) : `NON-JSON (${body.trim().slice(0,60).replace(/\s+/g," ")})`;
      const loc = r.headers.get("location");
      console.log(`  ${ok?"PASS":"FAIL"}  ${m.padEnd(16)} HTTP ${r.status}${loc?` -> ${loc.slice(0,50)}`:""}  ${Date.now()-t0}ms  ${note}`);
    } catch (e) {
      console.log(`  FAIL  ${m.padEnd(16)} ${e instanceof Error ? e.message : e}`);
    }
  }
}
