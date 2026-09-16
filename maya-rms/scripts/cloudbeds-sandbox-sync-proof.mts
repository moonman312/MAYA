/* eslint-disable @typescript-eslint/no-explicit-any -- script over untyped rows. */
// Runs the real Cloudbeds current-window sync for the SANDBOX hotel only and
// measures it: Cloudbeds calls by method, wall time, rows written. Snapshots
// what is stored before and after so two runs (old path, new path) can be
// compared night by night.
//
//   npx tsx scripts/cloudbeds-sandbox-sync-proof.mts snapshot <out.json>
//   npx tsx scripts/cloudbeds-sandbox-sync-proof.mts sync <out.json> [--default-window]
//   npx tsx scripts/cloudbeds-sandbox-sync-proof.mts compare <a.json> <b.json>
//
// `sync` forces the full 30-back / 396-forward window unless --default-window
// is passed, in which case the run decides full or incremental the way the
// scheduler does. It writes only the sandbox hotel's own reservation rows,
// which the scheduled sync already does, and pushes no rates.
//
// Nothing guest-shaped is printed or saved: stored payloads are already
// redacted and only their key names are kept.
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { resolveOAuthCredentials } from "../supabase/functions/_shared/pms/oauth-credentials";

const env = Object.fromEntries(readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n").filter((l)=>l.includes("=")&&!l.startsWith("#")).map((l)=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1).trim()]));
for (const [k,v] of Object.entries(env)) process.env[k] ??= v as string;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth:{persistSession:false} });

const SANDBOX = "5846fcc4-4590-400c-8b08-50bd61ccdbf4";
const SANDBOX_PROPERTY = "320691";
const [mode, a, b] = process.argv.slice(2);

type Snap = Record<string, { room_type_id: string | null; current_rate: number | null; base_rate: number | null; booking_date: string | null; booking_window_days: number | null; payloadKeys: string }>;

async function snapshot(): Promise<Snap> {
  const out: Snap = {};
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("reservations")
      .select("external_reservation_id, stay_date, room_type_id, current_rate, base_rate, booking_date, booking_window_days, raw_payload")
      .eq("hotel_id", SANDBOX)
      .order("external_reservation_id")
      .order("stay_date")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      out[`${r.external_reservation_id}:${r.stay_date}`] = {
        room_type_id: r.room_type_id,
        current_rate: r.current_rate == null ? null : Number(r.current_rate),
        base_rate: r.base_rate == null ? null : Number(r.base_rate),
        booking_date: r.booking_date,
        booking_window_days: r.booking_window_days,
        payloadKeys: r.raw_payload && typeof r.raw_payload === "object" ? Object.keys(r.raw_payload).sort().join(",") : "null",
      };
    }
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

if (mode === "compare") {
  const A: Snap = JSON.parse(readFileSync(a, "utf8")).rows;
  const B: Snap = JSON.parse(readFileSync(b, "utf8")).rows;
  const today = new Date().toISOString().slice(0, 10);
  const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort();
  const onlyA = keys.filter((k) => A[k] && !B[k]);
  const onlyB = keys.filter((k) => !A[k] && B[k]);
  const both = keys.filter((k) => A[k] && B[k]);
  const diff = (field: keyof Snap[string]) => both.filter((k) => A[k][field] !== B[k][field]);
  const window = (k: string) => { const d = k.slice(-10); return d >= new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10); };
  console.log(`A ${Object.keys(A).length} rows, B ${Object.keys(B).length} rows, today ${today}`);
  console.log(`only in A: ${onlyA.length}${onlyA.length ? ` e.g. ${onlyA.slice(0, 5).join(" ")}` : ""}`);
  console.log(`only in B: ${onlyB.length}${onlyB.length ? ` e.g. ${onlyB.slice(0, 5).join(" ")}` : ""}`);
  console.log(`in both: ${both.length} (${both.filter(window).length} with a stay date inside the sync window)`);
  for (const f of ["current_rate", "base_rate", "room_type_id", "booking_date", "booking_window_days", "payloadKeys"] as const) {
    const d = diff(f);
    const sample = d.slice(0, 4).map((k) => `${k} ${String(A[k][f])} -> ${String(B[k][f])}`).join(" | ");
    console.log(`  ${f.padEnd(20)} differs on ${d.length}${d.length ? `: ${sample}` : ""}`);
  }
  const nightsByDate = (S: Snap) => Object.keys(S).reduce((m: Record<string, number>, k) => ((m[k.slice(-10)] = (m[k.slice(-10)] ?? 0) + 1), m), {});
  const nA = nightsByDate(A), nB = nightsByDate(B);
  const dates = [...new Set([...Object.keys(nA), ...Object.keys(nB)])].sort();
  const nightDiff = dates.filter((d) => (nA[d] ?? 0) !== (nB[d] ?? 0));
  console.log(`room-nights per stay date differ on ${nightDiff.length} of ${dates.length} dates${nightDiff.length ? `: ${nightDiff.slice(0, 6).map((d) => `${d} ${nA[d] ?? 0}->${nB[d] ?? 0}`).join(", ")}` : ""}`);
  const sum = (S: Snap, onlyFuture: boolean) => Math.round(Object.entries(S).filter(([k]) => !onlyFuture || k.slice(-10) >= today).reduce((s, [, r]) => s + (r.current_rate ?? 0), 0) * 100) / 100;
  console.log(`revenue sum all ${sum(A, false)} -> ${sum(B, false)}; stay dates from today ${sum(A, true)} -> ${sum(B, true)}`);
  process.exit(0);
}

// Every other mode touches the sandbox's credential, so prove it is the sandbox first.
const resolved = await resolveOAuthCredentials(admin as any, SANDBOX, "cloudbeds");
if ("error" in resolved) { console.log("could not resolve the sandbox credential"); process.exit(1); }
if (String(resolved.propertyId ?? "") !== SANDBOX_PROPERTY) { console.log(`refusing: the credential names property ${resolved.propertyId ?? "none"}, not the sandbox`); process.exit(1); }

if (mode === "snapshot") {
  const rows = await snapshot();
  writeFileSync(a, JSON.stringify({ takenAt: new Date().toISOString(), rows }));
  console.log(`snapshot: ${Object.keys(rows).length} rows -> ${a}`);
  process.exit(0);
}

if (mode === "sync") {
  const { data: before } = await admin.from("pms_connections").select("status, last_sync_at, last_full_sync_at, reservations_modified_through, full_sweep_after_id, full_sweep_started_at").eq("hotel_id", SANDBOX).eq("pms_type", "cloudbeds").maybeSingle();
  console.log("connection before:", JSON.stringify(before));

  // Count and time every Cloudbeds call by method. URLs carry no token (it rides
  // in a header), and only the method name is kept.
  const calls: Record<string, { n: number; ms: number }> = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    if (!/cloudbeds\.com/.test(url)) return realFetch(input, init);
    const method = new URL(url).pathname.split("/").pop() ?? "?";
    const t0 = Date.now();
    try {
      return await realFetch(input, init);
    } finally {
      const c = (calls[method] ??= { n: 0, ms: 0 });
      c.n += 1;
      c.ms += Date.now() - t0;
    }
  }) as typeof fetch;

  const { runCloudbedsSyncForHotel } = await import("../src/lib/cloudbeds/sync-hotel");
  const t0 = Date.now();
  const res = await runCloudbedsSyncForHotel(admin as any, SANDBOX, process.argv.includes("--default-window") ? undefined : { daysBack: 30, daysForward: 396 });
  const wallMs = Date.now() - t0;
  globalThis.fetch = realFetch;

  if (!res.ok) {
    console.log(`sync failed after ${wallMs} ms: ${res.error} (status ${res.cloudbedsStatus ?? "n/a"})`);
  } else {
    console.log("result:", JSON.stringify({ ...res, creds: "[withheld]" }));
  }
  console.log(`wall ${wallMs} ms`);
  console.log("cloudbeds calls:", JSON.stringify(calls), "total", Object.values(calls).reduce((s, c) => s + c.n, 0));
  const rows = await snapshot();
  writeFileSync(a, JSON.stringify({ takenAt: new Date().toISOString(), wallMs, calls, rows }));
  console.log(`stored after: ${Object.keys(rows).length} rows -> ${a}`);
  const { data: after } = await admin.from("pms_connections").select("status, last_sync_at, last_full_sync_at, reservations_modified_through, full_sweep_after_id, full_sweep_started_at").eq("hotel_id", SANDBOX).eq("pms_type", "cloudbeds").maybeSingle();
  console.log("connection after:", JSON.stringify(after));
  process.exit(res.ok ? 0 : 1);
}

console.log("usage: snapshot <out> | sync <out> [--default-window] | compare <a> <b>");
process.exit(1);
