// Timed live runs of the batched engine against the Cloudbeds sandbox.
// Before the refactor the swift tick's evaluate(45 + 1 far date) took 275s.
//   npx tsx scripts/cb-batch-timing.mts
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { evaluateHotel } from "../src/lib/engine/index";

const HOTEL_ID = "5846fcc4-4590-400c-8b08-50bd61ccdbf4";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function timed(label: string, horizon: number, extras?: string[]) {
  const t0 = Date.now();
  const res = await evaluateHotel(admin, HOTEL_ID, undefined, horizon, extras ? { extraStayDates: extras } : undefined);
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[${label}] ${s}s —`, JSON.stringify(res));
  return res;
}

// The deployed (pre-refactor) engine has been keeping this hotel current, so
// beyond incidental drift these runs should publish ~nothing — a live
// equivalence check on real data, not just the fixture.
await timed("45d + far extra (the old 275s case)", 45, ["2027-05-15"]);
await timed("396d deep sweep", 396);
