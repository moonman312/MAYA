/* eslint-disable @typescript-eslint/no-explicit-any -- probing untyped vendor JSON. */
// Can getReservationsWithRateDetails replace the one-getReservation-per-booking
// pass in sync-hotel.ts? Read-only GETs against the Cloudbeds sandbox.
//
//   npx tsx scripts/probe-cloudbeds-rate-details.mts [--params-only] [--skip-detail] [--out <file.json>]
//
// --skip-detail re-checks the listings without spending any getReservation calls.
//
// Guest identities never leave this process. Payloads are described by key
// names only; the only values printed or compared are ids, dates, statuses,
// counts and amounts.
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { resolveOAuthCredentials } from "../supabase/functions/_shared/pms/oauth-credentials";

const env = Object.fromEntries(readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n").filter((l)=>l.includes("=")&&!l.startsWith("#")).map((l)=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1).trim()]));
for (const [k,v] of Object.entries(env)) process.env[k] ??= v as string;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth:{persistSession:false} });

const SANDBOX = "5846fcc4-4590-400c-8b08-50bd61ccdbf4";
const SANDBOX_PROPERTY = "320691";
// Start-to-start. MAYA paces at 220; a few ms over so timer rounding can never undercut it.
const GAP_MS = 225;
const DETAIL_CAP = 60;
const DAYS_BACK = 30;     // sync-hotel.ts DEFAULT_BACK
const DAYS_FORWARD = 396; // sync-hotel.ts DEFAULT_FORWARD
const ACTIVE = ["confirmed", "checked_in", "checked_out", "not_confirmed"];
const CANCELED = ["canceled", "no_show"];
const READ_METHODS = new Set(["getReservationsWithRateDetails", "getReservations", "getReservation"]);
const RWRD = "getReservationsWithRateDetails";

const paramsOnly = process.argv.includes("--params-only");
const skipDetail = process.argv.includes("--skip-detail");
const outIdx = process.argv.indexOf("--out");
const outPath = outIdx !== -1 ? process.argv[outIdx + 1] : null;

let TOKEN = "";
function scrub(s: string): string {
  let out = s;
  if (TOKEN) out = out.split(TOKEN).join("[redacted]");
  return out.replace(/cb(at|rt)_[A-Za-z0-9._-]+/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ymdOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const toYmd = (v: unknown) => (typeof v === "string" ? (v.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null) : null);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const sameMoney = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) < 0.005;

/* ── credentials ─────────────────────────────────────────────────────────── */

const resolved = await resolveOAuthCredentials(admin as any, SANDBOX, "cloudbeds");
if ("error" in resolved) { console.log("could not refresh the sandbox token:", scrub(resolved.error)); process.exit(1); }
const { data: raw } = await admin.rpc("pms_secret_get", { p_hotel_id: SANDBOX, p_pms_type: "cloudbeds" });
const secret = typeof raw === "string" ? JSON.parse(raw) : raw;
TOKEN = String(secret?.accessToken ?? "");
const TOKEN_TYPE = String(secret?.tokenType ?? "Bearer");
const PID = String(secret?.propertyId ?? resolved.propertyId ?? "");
// A secret that has drifted to another property must never be probed, sandbox or not.
if (!TOKEN || PID !== SANDBOX_PROPERTY) { console.log(`refusing: expected sandbox property ${SANDBOX_PROPERTY}, secret names ${PID || "none"}`); process.exit(1); }
const { data: conn } = await admin.from("pms_connections").select("base_url").eq("hotel_id", SANDBOX).eq("pms_type", "cloudbeds").maybeSingle();
const BASE = String(conn?.base_url || "https://hotels.cloudbeds.com/api/v1.2").replace(/\/$/, "");

/* ── paced GET ───────────────────────────────────────────────────────────── */

type CallRec = { method: string; label: string; status: number | null; ok: boolean; ms: number; bytes: number; count: number | null; total: number | null; message?: string };
const calls: CallRec[] = [];
const headerNames = new Set<string>();
const limitHeaders: Record<string, string> = {};
let lastStart = 0;
let detailCalls = 0;
let throttled = 0;

type Got = { ok: boolean; status: number | null; json: any; bytes: number; ms: number; message?: string };

async function get(method: string, params: Record<string, string | number | undefined>, label = method): Promise<Got> {
  if (!READ_METHODS.has(method)) throw new Error(`refusing non-read method ${method}`);
  const url = new URL(`${BASE}/${method}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 4; attempt++) {
    if (method === "getReservation") {
      if (detailCalls >= DETAIL_CAP) return { ok: false, status: null, json: null, bytes: 0, ms: 0, message: "detail cap reached" };
      detailCalls += 1;
    }
    const wait = lastStart + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
    const t0 = performance.now();
    let status: number | null = null;
    try {
      const res = await fetch(url, { method: "GET", headers: { Authorization: `${TOKEN_TYPE} ${TOKEN}`, Accept: "application/json" } });
      status = res.status;
      res.headers.forEach((value, name) => {
        headerNames.add(name);
        if (/rate|limit|retry|throttl|quota/i.test(name)) limitHeaders[name] = scrub(value);
      });
      const text = await res.text();
      const ms = Math.round(performance.now() - t0);
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* reported below */ }
      if (res.status === 429 && attempt < 3) {
        throttled += 1;
        calls.push({ method, label: `${label} (429)`, status, ok: false, ms, bytes: text.length, count: null, total: null });
        await sleep(Math.min((num(res.headers.get("retry-after")) ?? 2) * 1000, 30_000));
        continue;
      }
      const ok = res.ok && json != null && json.success !== false;
      const message = ok ? undefined : scrub(String(json?.message ?? text.slice(0, 160)));
      calls.push({
        method, label, status, ok, ms, bytes: text.length,
        count: Array.isArray(json?.data) ? json.data.length : null,
        total: num(json?.total),
        ...(message ? { message } : {}),
      });
      return { ok, status, json, bytes: text.length, ms, message };
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      const message = scrub(e instanceof Error ? e.message : String(e));
      calls.push({ method, label, status, ok: false, ms, bytes: 0, count: null, total: null, message });
      return { ok: false, status, json: null, bytes: 0, ms, message };
    }
  }
  return { ok: false, status: 429, json: null, bytes: 0, ms: 0, message: "throttled 4 times" };
}

/* ── shapes without values ───────────────────────────────────────────────── */

const GUESTY = /guest(?!s?count)|email|phone|mobile|address|firstname|lastname|birth|document|passport|zip|postal/i;

function shape(v: any, depth = 0): any {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    const firstObj = v.find((e) => e && typeof e === "object");
    return firstObj && depth < 2 ? { [`array(${v.length})`]: shape(firstObj, depth + 1) } : `array(${v.length})`;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v);
    // Date-keyed maps: report the key pattern, not every date.
    if (keys.length > 0 && keys.every((k) => /^\d{4}-\d{2}-\d{2}/.test(k))) return `map<date,${typeof v[keys[0]]}>(${keys.length})`;
    if (depth >= 2) return `object{${keys.join(",")}}`;
    const out: Record<string, any> = {};
    for (const k of keys) out[k] = GUESTY.test(k) ? `${typeof v[k]}${v[k] == null || v[k] === "" ? " (empty)" : " (present)"}` : shape(v[k], depth + 1);
    return out;
  }
  return typeof v;
}

function keyUnion(rows: any[]): string[] {
  const s = new Set<string>();
  for (const r of rows) if (r && typeof r === "object") for (const k of Object.keys(r)) s.add(k);
  return [...s].sort();
}

/* ── A. parameters ───────────────────────────────────────────────────────── */

const WINDOW = { from: ymdOffset(-DAYS_BACK), to: ymdOffset(DAYS_FORWARD) };
const FAR = { from: "2031-01-01", to: "2031-01-05" };
const report: Record<string, any> = { window: WINDOW, property: PID, base: BASE, ranAt: new Date().toISOString() };

console.log(`sandbox property ${PID} via ${BASE}`);
console.log(`window (check-in) ${WINDOW.from} -> ${WINDOW.to}\n`);
console.log("A. parameter behaviour");

const tA = Date.now();
const baseline = await get(RWRD, { propertyID: PID, pageNumber: 1, pageSize: 100 }, "rwrd baseline");
if (!baseline.ok) { console.log("  baseline failed:", baseline.message); process.exit(1); }
const T0 = num(baseline.json.total);
const baseRows: any[] = baseline.json.data ?? [];
console.log(`  baseline (no filters): HTTP ${baseline.status}, count ${baseRows.length}, total ${T0}, ${baseline.bytes} bytes`);

const params: Record<string, any> = {};
async function probeTotal(label: string, extra: Record<string, string | number>, method = RWRD, pageSize = 100) {
  const g = await get(method, { propertyID: PID, pageNumber: 1, pageSize, ...extra }, label);
  const rows: any[] = Array.isArray(g.json?.data) ? g.json.data : [];
  const r = { ok: g.ok, status: g.status, count: g.ok ? rows.length : null, total: g.ok ? num(g.json?.total) : null, message: g.message };
  params[label] = r;
  console.log(`  ${label.padEnd(58)} ${g.ok ? `count ${String(r.count).padStart(4)} total ${r.total}` : `REJECTED ${g.status}: ${g.message}`}`);
  return { ...r, rows, json: g.json };
}

// Size acceptance. Only a result set larger than the requested size can prove a silent clamp.
for (const size of [1, 100, 101, 200, 500, 1000]) await probeTotal(`rwrd pageSize=${size}`, {}, RWRD, size);

// Filters. Cloudbeds ignores unknown parameters silently, so a filter only counts as
// honoured when a range that cannot match returns fewer rows than the baseline.
await probeTotal("rwrd checkInFrom/To = 2031 (undocumented)", { checkInFrom: FAR.from, checkInTo: FAR.to });
await probeTotal("rwrd reservationCheckInFrom/To = 2031 (undocumented)", { reservationCheckInFrom: FAR.from, reservationCheckInTo: FAR.to });
await probeTotal("rwrd reservationCheckOutFrom/To = 2031", { reservationCheckOutFrom: FAR.from, reservationCheckOutTo: FAR.to });
await probeTotal("rwrd resultsFrom/To = 2031 (booking date)", { resultsFrom: `${FAR.from} 00:00:00`, resultsTo: `${FAR.to} 00:00:00` });
await probeTotal("rwrd modifiedFrom = 2031", { modifiedFrom: `${FAR.from} 00:00:00` });
const stConfirmed = await probeTotal("rwrd status=confirmed (undocumented)", { status: "confirmed" });
params["rwrd status=confirmed (undocumented)"].pageStatuses = [...new Set(stConfirmed.rows.map((r) => r.status))];
const stMulti = await probeTotal("rwrd status=confirmed,checked_in (undocumented)", { status: "confirmed,checked_in" });
params["rwrd status=confirmed,checked_in (undocumented)"].pageStatuses = [...new Set(stMulti.rows.map((r) => r.status))];
const excl = await probeTotal("rwrd excludeStatuses=canceled,no_show", { excludeStatuses: CANCELED.join(",") });
params["rwrd excludeStatuses=canceled,no_show"].pageStatuses = [...new Set(excl.rows.map((r) => r.status))];
const guests = await probeTotal("rwrd includeGuestsDetails=true", { includeGuestsDetails: "true" }, RWRD, 5);

const shapes: Record<string, any> = {
  rwrdRowKeys: keyUnion(baseRows),
  rwrdRow: shape(baseRows.find((r) => Array.isArray(r.rooms) && r.rooms.length > 1) ?? baseRows[0]),
  rwrdRoomKeys: keyUnion(baseRows.flatMap((r) => (Array.isArray(r.rooms) ? r.rooms : []))),
  rwrdGuestKeysDefault: keyUnion(baseRows).filter((k) => GUESTY.test(k)),
  rwrdExtraKeysWithGuestDetails: keyUnion(guests.rows).filter((k) => !keyUnion(baseRows).includes(k)),
};

const listProbe = await probeTotal("getReservations confirmed, window, pageSize=100", { status: "confirmed", checkInFrom: WINDOW.from, checkInTo: WINDOW.to }, "getReservations", 100);
await probeTotal("getReservations confirmed, window, pageSize=500", { status: "confirmed", checkInFrom: WINDOW.from, checkInTo: WINDOW.to }, "getReservations", 500);
const listAllRooms = await probeTotal("getReservations confirmed, window, includeAllRooms", { status: "confirmed", checkInFrom: WINDOW.from, checkInTo: WINDOW.to, includeAllRooms: "true" }, "getReservations", 100);
const guestObjects = (rows: any[]) => rows.flatMap((r) => (r?.guestList && typeof r.guestList === "object" ? Object.values(r.guestList) : []));
shapes.guestListEntryKeysDefault = keyUnion(guestObjects(baseRows));
shapes.guestListEntryKeysWithFlag = keyUnion(guestObjects(guests.rows));
shapes.guestListRowsDefault = baseRows.filter((r) => r?.guestList && Object.keys(r.guestList).length > 0).length;
shapes.listRowKeys = keyUnion(listProbe.rows);
shapes.listRow = shape(listProbe.rows[0] ?? null);
shapes.listRowKeysIncludeAllRooms = keyUnion(listAllRooms.rows);
shapes.listRoomKeysIncludeAllRooms = keyUnion(listAllRooms.rows.flatMap((r) => (Array.isArray(r.rooms) ? r.rooms : [])));
report.params = params;
report.shapes = shapes;
report.phaseA = { calls: calls.length, ms: Date.now() - tA };

console.log("\n  rate-details row keys:", shapes.rwrdRowKeys.join(", "));
console.log("  rate-details room keys:", shapes.rwrdRoomKeys.join(", "));
console.log("  guest-like keys by default:", shapes.rwrdGuestKeysDefault.join(", ") || "none");
console.log("  extra keys with includeGuestsDetails:", shapes.rwrdExtraKeysWithGuestDetails.join(", ") || "none");
console.log(`  guestList entry keys by default (${shapes.guestListRowsDefault}/${baseRows.length} rows carry one):`, shapes.guestListEntryKeysDefault.join(", ") || "none");
console.log("  guestList entry keys with includeGuestsDetails:", shapes.guestListEntryKeysWithFlag.join(", ") || "none");
console.log("  getReservations row keys:", shapes.listRowKeys.join(", "));
console.log("  getReservations includeAllRooms room keys:", shapes.listRoomKeysIncludeAllRooms.join(", ") || "none");
console.log("  multi-room rate-details row shape:", JSON.stringify(shapes.rwrdRow));

function finish() {
  report.calls = calls;
  report.callCounts = calls.reduce((m: Record<string, number>, c) => ((m[c.method] = (m[c.method] ?? 0) + 1), m), {});
  report.headers = { names: [...headerNames].sort(), rateLimit: limitHeaders, throttled429: throttled };
  console.log(`\ncalls: ${JSON.stringify(report.callCounts)}  429s: ${throttled}`);
  console.log(`response header names: ${report.headers.names.join(", ")}`);
  console.log(`rate-limit headers: ${JSON.stringify(limitHeaders)}`);
  if (outPath) { writeFileSync(outPath, JSON.stringify(report, null, 2)); console.log(`wrote ${outPath}`); }
}

if (paramsOnly) { finish(); process.exit(0); }

/* ── B. rate details across the sync window ─────────────────────────────── */

const { parseCloudbedsReservations, parseCloudbedsReservationDetail } = await import("../supabase/functions/_shared/cloudbeds/etl.ts");

const inWindow = (checkIn: unknown) => { const d = toYmd(checkIn); return d != null && d >= WINDOW.from && d <= WINDOW.to; };
const idOf = (r: any) => String(r?.reservationID ?? "");
const dupes = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i);

async function pageAll(method: string, label: string, pageSize: number, extra: Record<string, string>) {
  const t = Date.now();
  const pages: { pageNumber: number; rows: number; bytes: number; ms: number }[] = [];
  const rows: any[] = [];
  let total: number | null = null;
  for (let pageNumber = 1; pageNumber <= 200; pageNumber++) {
    const g = await get(method, { propertyID: PID, pageNumber, pageSize, ...extra }, `${label} p${pageNumber}`);
    if (!g.ok) throw new Error(`${label} page ${pageNumber}: ${g.message}`);
    const chunk: any[] = Array.isArray(g.json.data) ? g.json.data : [];
    total = num(g.json.total) ?? total;
    pages.push({ pageNumber, rows: chunk.length, bytes: g.bytes, ms: g.ms });
    rows.push(...chunk);
    if (chunk.length < pageSize || (total != null && rows.length >= total)) break;
  }
  return { rows, pages, total, calls: pages.length, wallMs: Date.now() - t, bytes: pages.reduce((s, p) => s + p.bytes, 0) };
}

console.log("\nB. getReservationsWithRateDetails over the window");
// The endpoint ignores every check-in filter and `status`. Anything checking in on or
// after the window start also checks out on or after it, so check-out narrows on the
// server and the check-in bound is applied here.
const RWRD_FILTER = { reservationCheckOutFrom: WINDOW.from, excludeStatuses: CANCELED.join(",") };
const main = await pageAll(RWRD, "rwrd window", 100, RWRD_FILTER);
const rwrdActive = main.rows.filter((r) => inWindow(r.reservationCheckIn));
const outside = main.rows.length - rwrdActive.length;
console.log(`  pageSize 100: ${main.calls} call(s), rows per page ${main.pages.map((p) => p.rows).join("/")}, total ${main.total}, ${main.bytes} bytes, ${main.wallMs} ms`);
console.log(`  kept ${rwrdActive.length} with check-in inside the window, dropped ${outside} (in-house before the window or arriving after it)`);
console.log(`  statuses returned: ${JSON.stringify(main.rows.reduce((m: any, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {}))}`);

const small = await pageAll(RWRD, "rwrd window pageSize 10", 10, RWRD_FILTER);
const smallIds = small.rows.map(idOf);
const paginationIntact = dupes(smallIds).length === 0 && new Set(smallIds).size === new Set(main.rows.map(idOf)).size && main.rows.every((r) => smallIds.includes(idOf(r)));
console.log(`  pageSize 10: ${small.calls} calls, rows per page ${small.pages.map((p) => p.rows).join("/")}, duplicates ${dupes(smallIds).length}, same set as pageSize 100: ${paginationIntact}`);

// The unfiltered baseline already holds every reservation, so it is the reference for
// whether the server-side filters kept exactly what they should.
const expectedByFilter = baseRows.filter((r) => !CANCELED.includes(r.status) && (toYmd(r.reservationCheckOut) ?? "") >= WINDOW.from).map(idOf).sort();
const filterExact = JSON.stringify(expectedByFilter) === JSON.stringify(main.rows.map(idOf).sort());
console.log(`  server filters match a client-side filter of the unfiltered pull: ${filterExact}`);

// etl.ts only trusts a room id shaped <reservationID>-<n>; anything else is keyed by position.
const subIdFormats = { prefixed: 0, equalsReservationId: 0, other: 0, rooms: 0, singleRoomEqualsReservationId: 0, singleRoomBookings: 0 };
for (const r of baseRows) {
  const roomsOf: any[] = Array.isArray(r.rooms) ? r.rooms : [];
  if (roomsOf.length === 1) subIdFormats.singleRoomBookings += 1;
  for (const room of roomsOf) {
    const sub = String(room.subReservationID ?? "");
    subIdFormats.rooms += 1;
    if (sub.startsWith(`${idOf(r)}-`)) subIdFormats.prefixed += 1;
    else if (sub === idOf(r)) { subIdFormats.equalsReservationId += 1; if (roomsOf.length === 1) subIdFormats.singleRoomEqualsReservationId += 1; }
    else subIdFormats.other += 1;
  }
}
console.log(`  subReservationID formats across all ${baseRows.length} bookings: ${JSON.stringify(subIdFormats)}`);

/* ── C. getReservations over the same window ─────────────────────────────── */

console.log("\nC. getReservations over the window, one pass per status");
const listRuns: Record<string, any> = {};
const listRows: any[] = [];
const tList = Date.now();
for (const status of ACTIVE) {
  const run = await pageAll("getReservations", `list ${status}`, 100, { status, checkInFrom: WINDOW.from, checkInTo: WINDOW.to });
  listRuns[status] = { calls: run.calls, rowsPerPage: run.pages.map((p) => p.rows), total: run.total, bytes: run.bytes, ms: run.wallMs };
  listRows.push(...run.rows);
  console.log(`  ${status.padEnd(14)} ${run.calls} call(s), rows ${run.pages.map((p) => p.rows).join("/")}, total ${run.total}`);
}
const listWallMs = Date.now() - tList;
console.log(`  ${listRows.length} bookings, ${Object.values(listRuns).reduce((s: number, r: any) => s + r.calls, 0)} calls, ${listWallMs} ms`);

/* ── D. membership ───────────────────────────────────────────────────────── */

console.log("\nD. bookings present in one listing and not the other");
const rwrdIds = new Set(rwrdActive.map(idOf));
const listIds = new Set(listRows.map(idOf));
const brief = (r: any, dates: [string, string]) => ({ id: idOf(r), status: r.status, checkIn: toYmd(r[dates[0]]), checkOut: toYmd(r[dates[1]]) });
const onlyRwrd = rwrdActive.filter((r) => !listIds.has(idOf(r))).map((r) => brief(r, ["reservationCheckIn", "reservationCheckOut"]));
const onlyList = listRows.filter((r) => !rwrdIds.has(idOf(r))).map((r) => {
  const inBase = baseRows.find((b) => idOf(b) === idOf(r));
  return { ...brief(r, ["startDate", "endDate"]), rateDetailsStatus: inBase?.status ?? "absent", rateDetailsCheckIn: toYmd(inBase?.reservationCheckIn), rateDetailsCheckOut: toYmd(inBase?.reservationCheckOut) };
});
const statusDisagree = listRows.filter((r) => rwrdIds.has(idOf(r)) && rwrdActive.find((w) => idOf(w) === idOf(r))?.status !== r.status).map(idOf);
const dateDisagree = listRows.filter((r) => {
  const w = rwrdActive.find((x) => idOf(x) === idOf(r));
  return w && (toYmd(w.reservationCheckIn) !== toYmd(r.startDate) || toYmd(w.reservationCheckOut) !== toYmd(r.endDate));
}).map(idOf);
console.log(`  only in rate details: ${onlyRwrd.length} ${onlyRwrd.length ? JSON.stringify(onlyRwrd) : ""}`);
console.log(`  only in getReservations: ${onlyList.length} ${onlyList.length ? JSON.stringify(onlyList) : ""}`);
console.log(`  duplicates in getReservations union: ${dupes(listRows.map(idOf)).length}; status disagreements: ${statusDisagree.length}; date disagreements: ${dateDisagree.length}`);

/* ── E. incremental: modifiedFrom on both endpoints ─────────────────────── */

console.log("\nE. modifiedFrom, as the incremental sync uses it");
const modStamps = rwrdActive.map((r) => String(r.dateModified ?? "")).filter(Boolean).sort();
const modCut = modStamps[Math.floor(modStamps.length / 2)] ?? null;
let modified: Record<string, any> = { cut: modCut };
if (modCut) {
  const mRwrd = await pageAll(RWRD, "rwrd modifiedFrom", 100, { ...RWRD_FILTER, modifiedFrom: modCut });
  const mRwrdIds = mRwrd.rows.filter((r) => inWindow(r.reservationCheckIn)).map(idOf).sort();
  const mListIds: string[] = [];
  let mListCalls = 0;
  for (const status of ACTIVE) {
    const run = await pageAll("getReservations", `list modifiedFrom ${status}`, 100, { status, checkInFrom: WINDOW.from, checkInTo: WINDOW.to, modifiedFrom: modCut });
    mListCalls += run.calls;
    mListIds.push(...run.rows.map(idOf));
  }
  mListIds.sort();
  const byLocal = rwrdActive.filter((r) => String(r.dateModified) >= modCut).map(idOf).sort();
  const byUtc = rwrdActive.filter((r) => String(r.dateModifiedUTC) >= modCut).map(idOf).sort();
  modified = {
    cut: modCut, rateDetails: mRwrdIds.length, getReservations: mListIds.length, rateDetailsCalls: mRwrd.calls, getReservationsCalls: mListCalls,
    sameSet: JSON.stringify(mRwrdIds) === JSON.stringify(mListIds),
    matchesLocalDateModified: JSON.stringify(mRwrdIds) === JSON.stringify(byLocal),
    matchesUtcDateModified: JSON.stringify(mRwrdIds) === JSON.stringify(byUtc),
  };
  console.log(`  cut ${modCut}: rate details ${mRwrdIds.length} (${mRwrd.calls} call), getReservations ${mListIds.length} (${mListCalls} calls), same set ${modified.sameSet}`);
  console.log(`  rate details set equals dateModified >= cut: local ${modified.matchesLocalDateModified}, UTC ${modified.matchesUtcDateModified}`);
}

/* ── F. field by field against getReservation ───────────────────────────── */

console.log(`\nF. getReservation vs rate details, up to ${skipDetail ? 0 : DETAIL_CAP} bookings`);
const sample: any[] = [];
const addSample = (r: any) => { if (sample.length < DETAIL_CAP && !sample.some((s) => idOf(s) === idOf(r))) sample.push(r); };
const byRoomsDesc = (a: any, b: any) => (b.rooms?.length ?? 0) - (a.rooms?.length ?? 0);
[...rwrdActive].sort(byRoomsDesc).forEach(addSample);
baseRows.filter((r) => CANCELED.includes(r.status) && inWindow(r.reservationCheckIn)).forEach(addSample);
[...baseRows].sort(byRoomsDesc).forEach(addSample);

type Tally = { pass: number; fail: number; na: number; failures: string[] };
const tally: Record<string, Tally> = {};
function mark(check: string, outcome: boolean | null, note: string) {
  const t = (tally[check] ??= { pass: 0, fail: 0, na: 0, failures: [] });
  if (outcome === null) t.na += 1;
  else if (outcome) t.pass += 1;
  else { t.fail += 1; if (t.failures.length < 8) t.failures.push(note); }
}
function rateMap(v: any): Map<string, number> {
  const m = new Map<string, number>();
  if (Array.isArray(v)) for (const e of v) { const d = toYmd(e?.date); const r = num(e?.rate); if (d && r != null) m.set(d, r); }
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { const d = toYmd(k); const r = num(x); if (d && r != null) m.set(d, r); }
  return m;
}
function mapDiff(a: Map<string, number>, b: Map<string, number>): string | null {
  const dates = [...new Set([...a.keys(), ...b.keys()])].sort();
  const bad = dates.filter((d) => !sameMoney(a.get(d) ?? null, b.get(d) ?? null));
  return bad.length === 0 ? null : bad.slice(0, 3).map((d) => `${d} ${a.get(d) ?? "missing"} vs ${b.get(d) ?? "missing"}`).join("; ");
}
const sumMap = (m: Map<string, number>) => Math.round([...m.values()].reduce((s, x) => s + x, 0) * 100) / 100;
const emptyish = (v: unknown) => v == null || v === "" || String(v).startsWith("0000-00-00");

// Rate-details rows reshaped into what parseCloudbedsReservationDetail already reads, so
// the comparison is of the rows MAYA would store, not only of the payloads.
function asDetailShape(w: any) {
  return {
    reservationID: w.reservationID, status: w.status, dateCreated: w.dateCreated,
    assigned: (w.rooms ?? []).map((r: any) => ({ ...r, dailyRates: [...rateMap(r.detailedRoomRates)].map(([date, rate]) => ({ date, rate })) })),
  };
}
const rowKey = (r: any) => `${r.external_reservation_id}:${r.stay_date}`;
const rowSig = (r: any) => JSON.stringify([r.external_room_type_id, r.booking_date, r.booking_window_days, r.current_rate]);

const detailShapeKeys = { top: new Set<string>(), room: new Set<string>(), cancellation: new Set<string>() };
const facts = { compared: 0, detailFailed: 0, multiRoom: 0, maxRooms: 0, unassignedRooms: 0, roomDatesDifferFromBooking: 0, subIdsPrefixed: 0, subIdsTotal: 0, duplicateSubIdsInRooms: 0, canceledCompared: 0, cancellationObjects: 0, detailRowsTotal: 0, rateDetailRowsTotal: 0 };
const tF = Date.now();
for (const w of skipDetail ? [] : sample) {
  const id = idOf(w);
  const g = await get("getReservation", { propertyID: PID, reservationID: id }, "detail");
  if (!g.ok || !g.json?.data) { facts.detailFailed += 1; console.log(`  ${id}: detail failed ${g.message ?? ""}`); continue; }
  const d = g.json.data;
  facts.compared += 1;
  Object.keys(d).forEach((k) => detailShapeKeys.top.add(k));
  const dRooms: any[] = [...(Array.isArray(d.assigned) ? d.assigned : []), ...(Array.isArray(d.unassigned) ? d.unassigned : [])];
  dRooms.forEach((r) => Object.keys(r).forEach((k) => detailShapeKeys.room.add(k)));
  if (d.cancellation && typeof d.cancellation === "object") { facts.cancellationObjects += 1; Object.keys(d.cancellation).forEach((k) => detailShapeKeys.cancellation.add(k)); }
  facts.unassignedRooms += Array.isArray(d.unassigned) ? d.unassigned.length : 0;
  const wRooms: any[] = Array.isArray(w.rooms) ? w.rooms : [];
  if (dRooms.length > 1) facts.multiRoom += 1;
  facts.maxRooms = Math.max(facts.maxRooms, dRooms.length);
  if (CANCELED.includes(w.status)) facts.canceledCompared += 1;

  mark("status", d.status === w.status, `${id}: ${d.status} vs ${w.status}`);
  mark("check-in", toYmd(d.startDate) === toYmd(w.reservationCheckIn), `${id}: ${toYmd(d.startDate)} vs ${toYmd(w.reservationCheckIn)}`);
  mark("check-out", toYmd(d.endDate) === toYmd(w.reservationCheckOut), `${id}: ${toYmd(d.endDate)} vs ${toYmd(w.reservationCheckOut)}`);
  mark("dateCreated", String(d.dateCreated) === String(w.dateCreated), `${id}: differs`);
  mark("total", sameMoney(num(d.total), num(w.total)), `${id}: ${d.total} vs ${w.total}`);
  mark("balance", sameMoney(num(d.balance), num(w.balance)), `${id}: ${d.balance} vs ${w.balance}`);
  for (const k of ["subTotal", "taxesFees", "additionalItems", "grandTotal", "paid"]) {
    const a = num(d.balanceDetailed?.[k]); const b = num(w.balanceDetailed?.[k]);
    mark(`balanceDetailed.${k}`, a == null && b == null ? null : sameMoney(a, b), `${id}: ${a} vs ${b}`);
  }
  mark("dateCancelled", emptyish(d.dateCancelled) && emptyish(w.dateCancelled) ? true : String(d.dateCancelled) === String(w.dateCancelled), `${id}: ${d.dateCancelled} vs ${w.dateCancelled}`);
  mark("room count", dRooms.length === wRooms.length, `${id}: detail ${dRooms.length} vs rate details ${wRooms.length}`);

  const wSubs = wRooms.map((r) => String(r.subReservationID ?? ""));
  facts.duplicateSubIdsInRooms += dupes(wSubs).length;
  facts.subIdsTotal += wSubs.length;
  facts.subIdsPrefixed += wSubs.filter((s) => s.startsWith(`${id}-`)).length;
  const used = new Set<number>();
  const dAgg = new Map<string, number>();
  for (const dr of dRooms) {
    const sub = String(dr.subReservationID ?? "");
    const i = wRooms.findIndex((wr, j) => !used.has(j) && String(wr.subReservationID ?? "") === sub);
    const dm = rateMap(dr.dailyRates);
    for (const [date, rate] of dm) dAgg.set(date, Math.round(((dAgg.get(date) ?? 0) + rate) * 100) / 100);
    if (i === -1) { mark("room paired by subReservationID", false, `${id}: ${sub} missing from rate details`); continue; }
    used.add(i);
    const wr = wRooms[i];
    mark("room paired by subReservationID", true, "");
    mark("room roomTypeID", String(dr.roomTypeID) === String(wr.roomTypeID), `${id}/${sub}: ${dr.roomTypeID} vs ${wr.roomTypeID}`);
    mark("room adults", num(dr.adults) === num(wr.adults), `${id}/${sub}: ${dr.adults} vs ${wr.adults}`);
    mark("room children", num(dr.children) === num(wr.children), `${id}/${sub}: ${dr.children} vs ${wr.children}`);
    const wm = rateMap(wr.detailedRoomRates);
    const diff = mapDiff(dm, wm);
    mark("room per-night rates (dates and amounts)", dm.size === 0 && wm.size === 0 ? null : diff === null, `${id}/${sub}: ${diff}`);
    mark("room roomTotal = sum of rate-details nights", num(dr.roomTotal) == null ? null : sameMoney(num(dr.roomTotal), sumMap(wm)), `${id}/${sub}: ${dr.roomTotal} vs ${sumMap(wm)}`);
    if (toYmd(wr.roomCheckIn) !== toYmd(w.reservationCheckIn) || toYmd(wr.roomCheckOut) !== toYmd(w.reservationCheckOut)) facts.roomDatesDifferFromBooking += 1;
  }
  const wBooking = rateMap(w.detailedRates);
  const bookingDiff = mapDiff(dAgg, wBooking);
  mark("booking detailedRates = sum of detail rooms per night", dAgg.size === 0 && wBooking.size === 0 ? null : bookingDiff === null, `${id}: ${bookingDiff}`);

  // Row-level: what MAYA would store from each source.
  const fromDetail = parseCloudbedsReservationDetail(d).rows;
  const fromRwrd = parseCloudbedsReservationDetail(asDetailShape(w)).rows;
  facts.detailRowsTotal += fromDetail.length;
  facts.rateDetailRowsTotal += fromRwrd.length;
  const a = new Map(fromDetail.map((r) => [rowKey(r), rowSig(r)]));
  const b = new Map(fromRwrd.map((r) => [rowKey(r), rowSig(r)]));
  const rowMismatch = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
  mark("MAYA rows identical (id, night, room type, booking date, window, rate)", fromDetail.length === 0 && fromRwrd.length === 0 ? null : rowMismatch.length === 0, `${id}: ${rowMismatch.length} of ${a.size}/${b.size} rows differ, e.g. ${rowMismatch.slice(0, 2).join(", ")}`);
}
const detailWallMs = Date.now() - tF;

for (const [check, t] of Object.entries(tally)) {
  console.log(`  ${check.padEnd(66)} pass ${String(t.pass).padStart(3)}  fail ${String(t.fail).padStart(3)}  n/a ${String(t.na).padStart(3)}${t.failures.length ? `  ${t.failures.join(" | ")}` : ""}`);
}
if (!skipDetail) {
  console.log(`  facts: ${JSON.stringify(facts)}`);
  console.log(`  detail calls ${detailCalls}, ${detailWallMs} ms (${Math.round(detailWallMs / Math.max(1, detailCalls))} ms each, paced)`);
  console.log(`  getReservation top-level keys: ${[...detailShapeKeys.top].sort().join(", ")}`);
  console.log(`  getReservation room keys: ${[...detailShapeKeys.room].sort().join(", ")}`);
  console.log(`  getReservation cancellation keys: ${[...detailShapeKeys.cancellation].sort().join(", ") || "none"}`);
  console.log(`  rate-details keys getReservation lacks: ${shapes.rwrdRowKeys.filter((k: string) => !detailShapeKeys.top.has(k)).join(", ")}`);
  console.log(`  getReservation keys rate details lacks: ${[...detailShapeKeys.top].filter((k) => !shapes.rwrdRowKeys.includes(k)).sort().join(", ")}`);
}

/* ── G. today's list parser fed rate-details rows unchanged ─────────────── */

const asIs = parseCloudbedsReservations(rwrdActive);
console.log(`\nG. parseCloudbedsReservations(rate-details rows) as the code stands: ${asIs.reservations.length} rows, stats ${JSON.stringify(asIs.stats)}`);

report.phaseB = { subIdFormats, filter: RWRD_FILTER, calls: main.calls, rowsPerPage: main.pages.map((p) => p.rows), total: main.total, bytes: main.bytes, wallMs: main.wallMs, keptInWindow: rwrdActive.length, droppedOutsideWindow: outside, pageSize10: { calls: small.calls, rowsPerPage: small.pages.map((p) => p.rows), intact: paginationIntact }, filterExact, pageMs: main.pages.map((p) => p.ms) };
report.phaseC = { runs: listRuns, bookings: listRows.length, wallMs: listWallMs };
report.phaseD = { onlyRateDetails: onlyRwrd, onlyGetReservations: onlyList, statusDisagree, dateDisagree };
report.phaseE = modified;
report.phaseF = { sampled: sample.length, tally, facts, detailCalls, detailWallMs, detailKeys: { top: [...detailShapeKeys.top].sort(), room: [...detailShapeKeys.room].sort(), cancellation: [...detailShapeKeys.cancellation].sort() } };
report.phaseG = { rows: asIs.reservations.length, stats: asIs.stats };
finish();
