/**
 * Onboarding import worker — the checkpointed state machine.
 *
 * A job walks: discover -> sync_current -> historical -> analyze -> done.
 *
 *   discover      property profile + room types; backfill blank hotel fields
 *   sync_current  the existing detail-based sync (true nightly rates; powers
 *                 live pricing immediately). It reports the first check-in
 *                 date it covered and history tiles back from there — its
 *                 window is a runtime setting, not something to assume.
 *   historical    slim list-only pull, one year-window at a time going back:
 *                 dates + price only, raw_payload null, checkpointed per page
 *   analyze       cleaning heuristics -> findings; completes the job
 *
 * Every page/step persists its cursor + counters, so a killed invocation
 * resumes exactly where it stopped. The caller (edge function) claims the
 * job via the claim_import_job RPC and hands it here with a time budget.
 *
 * Lease protocol, since three drivers can invoke the worker at once (cron,
 * the self-chain, an app-side kick):
 *   - the claim RPC hands us a lease; every checkpoint extends it and is
 *     fenced on it, so a worker that lost the job to a re-claim cannot write
 *     over the winner's progress;
 *   - a phase that is one opaque call (sync_current, analyze) heartbeats the
 *     lease instead, since it has nothing to checkpoint;
 *   - on budget exhaustion the lease is handed back so the chained
 *     invocation can pick the same job straight up. On an error it is left to
 *     expire — that wait is the retry backoff, and pg_cron is the driver.
 *
 * All external effects are injected via WorkerDeps so the state machine is
 * unit-testable without Deno, Supabase, or a live PMS.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AdapterCursor,
  AdapterReservationRow,
  OnboardingPmsAdapter,
} from "../pms/onboarding-adapter.ts";

export type ImportJobRow = {
  id: string;
  hotel_id: string;
  pms_type: string;
  status: string;
  phase: string;
  window_index: number;
  window_from: string | null;
  window_to: string | null;
  enum_cursor: Record<string, unknown>;
  row_cap: number;
  max_windows: number;
  reservations_enumerated: number;
  rows_upserted: number;
  windows_completed: number;
  oldest_stay_date: string | null;
  newest_stay_date: string | null;
  attempts: number;
  stats: Record<string, unknown>;
  /** Whatever lease is on the row — null only on a job nobody has claimed. */
  lease_expires_at?: string | null;
};

export type WorkerDeps = {
  createAdapter: (
    supabase: SupabaseClient,
    hotelId: string,
    pmsType: string,
  ) => Promise<OnboardingPmsAdapter>;
  /**
   * Detail-accurate sync for the current window (existing pipeline).
   * `coveredFrom` is the oldest check-in date it actually pulled — the
   * historical phase butts up against it instead of guessing at it, which is
   * what left eleven months unimported when the guess was a hardcoded year.
   * Required rather than optional (null = this sync genuinely can't say) so a
   * new wiring has to think about it; omitting it falls back to today, which
   * over-covers rather than leaving another hole.
   */
  runCurrentSync: (
    supabase: SupabaseClient,
    hotelId: string,
    pmsType: string,
  ) => Promise<
    { ok: true; coveredFrom: string | null } | { ok: false; error?: string }
  >;
  /** Cleaning heuristics + findings. Wired in from analysis.ts. */
  analyze: (supabase: SupabaseClient, job: ImportJobRow) => Promise<void>;
  now: () => number;
  todayYmd: () => string;
};

export type StepOutcome = "completed" | "budget_exhausted" | "failed";

const UPSERT_CHUNK = 500;
export const LEASE_SECONDS = 180;
/** Comfortably inside the lease, so one dropped touch isn't fatal. */
const HEARTBEAT_MS = 60_000;
/** Consecutive invocations that moved nothing before we call the job dead. */
const NO_PROGRESS_LIMIT = 50;

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Historical window N: the year ending the day before `anchorYmd`, stepped
 * back N whole years. The anchor is where the current-window sync's own
 * coverage starts, so window 0 sits directly behind it with no gap.
 */
export function historicalWindow(anchorYmd: string, windowIndex: number): {
  from: string;
  to: string;
} {
  return {
    from: addDays(anchorYmd, -365 * (windowIndex + 1)),
    to: addDays(anchorYmd, -365 * windowIndex - 1),
  };
}

/**
 * Where history tiles back from, recorded when sync_current finished. Falling
 * back to today re-covers ground the sync already has, which is the safe
 * direction — the alternative is an unimported hole nothing ever revisits.
 */
function historyAnchor(job: ImportJobRow, deps: WorkerDeps): string {
  const anchor = job.stats.historyAnchor;
  return typeof anchor === "string" ? anchor : deps.todayYmd();
}

/** Decide what follows a finished historical window. */
export function nextAfterWindow(job: {
  window_index: number;
  max_windows: number;
  rows_upserted: number;
  row_cap: number;
  windowRowCount: number;
}): { phase: "historical" | "analyze"; reason: string } {
  if (job.windowRowCount === 0) {
    return { phase: "analyze", reason: "empty_window" };
  }
  if (job.rows_upserted >= job.row_cap) {
    return { phase: "analyze", reason: "row_cap" };
  }
  // Windows are 0-based, so index max_windows-1 is the last one allowed.
  if (job.window_index + 1 >= job.max_windows) {
    return { phase: "analyze", reason: "max_windows" };
  }
  return { phase: "historical", reason: "more_history" };
}

/**
 * `token` is the newest lease expiry we know is on the row, which doubles as
 * the fencing value; null means the row was handed to us without a lease (a
 * freshly inserted job driven straight through processJob), and then nothing
 * is fenced. `lost` is terminal: it is only set once we have established that
 * the row belongs to another worker, never on a single ambiguous write.
 */
type Lease = { token: string | null; lost: boolean };

/** Another worker re-claimed the job; we must stop writing to it. */
class LeaseLostError extends Error {
  constructor() {
    super("import job lease lost to another worker");
  }
}

async function patchJob(
  supabase: SupabaseClient,
  jobId: string,
  patch: Record<string, unknown>,
  lease: Lease,
): Promise<void> {
  const next = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
  let q = supabase
    .from("import_jobs")
    .update({ ...patch, lease_expires_at: next, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  // Fence on the lease: ours is the newest expiry written for this job, so a
  // re-claim (which pushes it further out) locks us out instead of letting two
  // workers overwrite each other's cursors. A job that was never claimed has no
  // expiry to fence on and there is no second writer to fence out.
  if (lease.token) {
    q = q.eq("status", "running").lte("lease_expires_at", lease.token);
  }
  const { data, error } = await q.select("id");
  if (error) throw new Error(`import_jobs update failed: ${error.message}`);
  if (!lease.token) return;
  if ((data ?? []).length === 0) {
    lease.lost = true;
    throw new LeaseLostError();
  }
  lease.token = next;
}

/**
 * Hand the lease back at the end of a burst so the chained invocation can
 * claim the same job immediately. Without this the job sits unclaimable for
 * the rest of its lease and only pg_cron ever resumes it — a 90s burst
 * followed by minutes of dead time.
 */
async function releaseLease(
  supabase: SupabaseClient,
  job: ImportJobRow,
  lease: Lease,
  progressed: boolean,
): Promise<void> {
  if (!lease.token) return;
  const now = new Date().toISOString();
  // Stamp the expiry a full lease into the past, not at our own "now": the
  // claim RPC compares it against the DB clock, and forward skew in this
  // isolate would make the chained claim skip the job we just let go of.
  const patch: Record<string, unknown> = {
    lease_expires_at: new Date(Date.now() - LEASE_SECONDS * 1000).toISOString(),
    updated_at: now,
  };
  if (progressed && Number(job.stats.errorStreak ?? 0) > 0) {
    job.stats = { ...job.stats, errorStreak: 0 };
    patch.stats = job.stats;
  }
  await supabase
    .from("import_jobs")
    .update(patch)
    .eq("id", job.id)
    .eq("status", "running")
    .lte("lease_expires_at", lease.token);
}

/**
 * One lease touch. Zero rows back is ambiguous, and the ambiguity is the whole
 * problem: either a re-claim pushed the expiry past our token, or this write
 * landed and only its response was lost — and in that second case the row
 * holds an expiry no fence of ours would ever match again. So read the row
 * instead of calling the lease lost on the touch alone: an expiry we wrote
 * ourselves is still ours.
 */
async function touchLease(
  supabase: SupabaseClient,
  jobId: string,
  lease: Lease,
): Promise<void> {
  const token = lease.token;
  if (!token || lease.lost) return;
  const next = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
  const { data, error } = await supabase
    .from("import_jobs")
    .update({ lease_expires_at: next, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "running")
    .lte("lease_expires_at", token)
    .select("id");
  if (!error && (data ?? []).length > 0) {
    lease.token = next;
    return;
  }
  const { data: row } = await supabase
    .from("import_jobs")
    .select("status, lease_expires_at")
    .eq("id", jobId)
    .maybeSingle();
  if (!row) return; // the read told us nothing either; the next tick retries
  // Compare as instants, not strings: PostgREST hands timestamptz back with a
  // +00:00 offset and microseconds, we write Z and milliseconds.
  const held = row.lease_expires_at == null ? NaN : Date.parse(String(row.lease_expires_at));
  if (held === Date.parse(next)) {
    lease.token = next; // it landed, only the response didn't
    return;
  }
  if (String(row.status) === "running" && held <= Date.parse(token)) return;
  lease.lost = true;
}

/**
 * Keep the lease alive across a phase that is one opaque call with nothing to
 * checkpoint. If the isolate dies the timer dies with it, so the lease still
 * expires and pg_cron recovers the job — the heartbeat only covers the case
 * where we are alive and simply slower than the lease.
 *
 * Touches are chained, and the last one is awaited before we hand control back
 * so the caller's next checkpoint is fenced on the expiry the row really
 * holds. A touch left in flight across the phase boundary fences one of the
 * two writes out, and whichever loses is expensive: the checkpoint is a whole
 * phase this job would have to redo, the touch would poison every fence after
 * it.
 */
async function withLeaseHeartbeat<T>(
  supabase: SupabaseClient,
  jobId: string,
  lease: Lease,
  run: () => Promise<T>,
): Promise<T> {
  if (!lease.token) return run();
  let inflight: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    inflight = inflight.then(() => touchLease(supabase, jobId, lease)).catch(() => {});
  }, HEARTBEAT_MS);
  let out: T;
  try {
    out = await run();
  } finally {
    clearInterval(timer);
    await inflight;
  }
  // Nothing can abort the call we just awaited, so a lease established as lost
  // mid-phase only takes effect here.
  if (lease.lost) throw new LeaseLostError();
  return out;
}

async function loadRoomTypeMap(
  supabase: SupabaseClient,
  hotelId: string,
): Promise<Map<string, string>> {
  const { data } = await supabase
    .from("room_types")
    .select("id, external_room_type_id")
    .eq("hotel_id", hotelId);
  const map = new Map<string, string>();
  for (const r of data ?? []) {
    if (r.external_room_type_id) map.set(String(r.external_room_type_id), String(r.id));
  }
  return map;
}

async function upsertSlimRows(
  supabase: SupabaseClient,
  hotelId: string,
  roomTypeMap: Map<string, string>,
  rows: AdapterReservationRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const payload = rows.map((r) => ({
    hotel_id: hotelId,
    external_reservation_id: r.external_reservation_id,
    room_type_id: r.external_room_type_id
      ? roomTypeMap.get(r.external_room_type_id) ?? null
      : null,
    stay_date: r.stay_date,
    booking_date: r.booking_date,
    booking_window_days: r.booking_window_days,
    current_rate: r.current_rate,
    raw_payload: null,
  }));
  for (let i = 0; i < payload.length; i += UPSERT_CHUNK) {
    const chunk = payload.slice(i, i + UPSERT_CHUNK);
    const { error } = await supabase
      .from("reservations")
      .upsert(chunk, { onConflict: "hotel_id,external_reservation_id,stay_date" });
    if (error) throw new Error(`reservations upsert failed: ${error.message}`);
  }
  return payload.length;
}

function minYmd(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function maxYmd(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Drive one claimed job forward until it completes or the budget runs out.
 * The job row passed in is mutated to stay in sync with what's persisted.
 */
export async function processJob(
  supabase: SupabaseClient,
  job: ImportJobRow,
  deps: WorkerDeps,
  budgetMs: number,
): Promise<StepOutcome> {
  const start = deps.now();
  const withinBudget = () => deps.now() - start < budgetMs;
  const lease: Lease = { token: job.lease_expires_at ?? null, lost: false };
  let progressed = false;

  try {
    const adapter = await deps.createAdapter(supabase, job.hotel_id, job.pms_type);

    while (withinBudget()) {
      if (job.phase === "discover") {
        await runDiscover(supabase, job, adapter, lease);
        progressed = true;
        continue;
      }
      if (job.phase === "sync_current") {
        const res = await withLeaseHeartbeat(supabase, job.id, lease, () =>
          deps.runCurrentSync(supabase, job.hotel_id, job.pms_type),
        );
        if (!res.ok) throw new Error(res.error ?? "current-window sync failed");
        // Tile history back from where the sync's coverage actually starts.
        // Assuming it always reached a year back left everything between its
        // real window and day -366 unimported, by any phase, forever.
        const anchor = res.coveredFrom ?? deps.todayYmd();
        job.phase = "historical";
        job.window_index = 0;
        const w = historicalWindow(anchor, job.window_index);
        job.window_from = w.from;
        job.window_to = w.to;
        job.enum_cursor = {};
        job.stats = { ...job.stats, currentWindowRows: 0, historyAnchor: anchor };
        await patchJob(supabase, job.id, {
          phase: job.phase,
          window_index: job.window_index,
          window_from: job.window_from,
          window_to: job.window_to,
          enum_cursor: job.enum_cursor,
          stats: job.stats,
        }, lease);
        progressed = true;
        continue;
      }
      if (job.phase === "historical") {
        await runHistoricalStep(supabase, job, adapter, deps, lease);
        progressed = true;
        continue; // page or phase done — the loop picks up whatever is next
      }
      if (job.phase === "analyze") {
        await withLeaseHeartbeat(supabase, job.id, lease, () => deps.analyze(supabase, job));
        await patchJob(supabase, job.id, {
          status: "completed",
          phase: "done",
          finished_at: new Date().toISOString(),
        }, lease);
        await supabase
          .from("pms_connections")
          .update({ last_sync_at: new Date().toISOString() })
          .eq("hotel_id", job.hotel_id)
          .eq("pms_type", job.pms_type);
        return "completed";
      }
      throw new Error(`Unknown phase '${job.phase}'`);
    }

    // Out of budget: everything is checkpointed, so let go of the lease and
    // let the chained invocation carry on from here.
    await releaseLease(supabase, job, lease, progressed);
    return "budget_exhausted";
  } catch (e) {
    if (e instanceof LeaseLostError) {
      // Someone else owns the row now. Writing anything — even last_error —
      // would be writing over their work.
      console.warn(
        JSON.stringify({ fn: "processJob", jobId: job.id, phase: job.phase, event: "lease_lost" }),
      );
      return "budget_exhausted";
    }
    const message = e instanceof Error ? e.message : String(e);
    // attempts counts every claim, healthy ones included, so it cannot decide
    // this: a long import would hard-fail for being long. What matters is
    // consecutive invocations that moved nothing forward.
    const streak = progressed ? 1 : Number(job.stats.errorStreak ?? 0) + 1;
    const failed = streak >= NO_PROGRESS_LIMIT;
    job.stats = { ...job.stats, errorStreak: streak };
    let q = supabase
      .from("import_jobs")
      .update({
        last_error: message,
        stats: job.stats,
        ...(failed
          ? { status: "failed", finished_at: new Date().toISOString() }
          : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    if (lease.token) q = q.eq("status", "running").lte("lease_expires_at", lease.token);
    await q;
    // The lease is deliberately left to run out: that wait is the backoff
    // between retries, and without it the self-chain would burn through the
    // no-progress budget in seconds against an unreachable PMS.
    return failed ? "failed" : "budget_exhausted";
  }
}

async function runDiscover(
  supabase: SupabaseClient,
  job: ImportJobRow,
  adapter: OnboardingPmsAdapter,
  lease: Lease,
): Promise<void> {
  // Backfill hotel fields that are still blank (PMS is the source of truth,
  // but a user-entered name always wins — never overwrite an existing name).
  const profile = await adapter.discoverProperty();
  const { data: hotel } = await supabase
    .from("hotels")
    .select("name, timezone, currency")
    .eq("id", job.hotel_id)
    .maybeSingle();
  const patch: Record<string, unknown> = {};
  if (hotel && !hotel.timezone && profile.timezone) patch.timezone = profile.timezone;
  if (hotel && !hotel.currency && profile.currency) patch.currency = profile.currency;
  if (Object.keys(patch).length > 0) {
    await supabase.from("hotels").update(patch).eq("id", job.hotel_id);
  }

  // Naming and inventory come from the PMS, but is_active is ours: analyze
  // deactivates duplicates and owners deactivate the bookable spaces that
  // aren't sleeping rooms. Listing it here made every re-import a mass
  // re-activation, so it stays out of the payload — new room types take the
  // column default, existing rows keep whatever we decided.
  const roomTypes = await adapter.fetchRoomTypes();
  if (roomTypes.length > 0) {
    const { error } = await supabase.from("room_types").upsert(
      roomTypes.map((rt) => ({
        hotel_id: job.hotel_id,
        external_room_type_id: rt.external_room_type_id,
        name: rt.name,
        display_name: rt.display_name,
        total_rooms: rt.total_rooms,
      })),
      { onConflict: "hotel_id,external_room_type_id" },
    );
    if (error) throw new Error(`room_types upsert failed: ${error.message}`);
  }

  job.phase = "sync_current";
  await patchJob(supabase, job.id, {
    phase: job.phase,
    stats: { ...job.stats, roomTypes: roomTypes.length },
  }, lease);
}

/** One historical list page: upsert it, then checkpoint or advance the phase. */
async function runHistoricalStep(
  supabase: SupabaseClient,
  job: ImportJobRow,
  adapter: OnboardingPmsAdapter,
  deps: WorkerDeps,
  lease: Lease,
): Promise<void> {
  if (!job.window_from || !job.window_to) {
    const w = historicalWindow(historyAnchor(job, deps), job.window_index);
    job.window_from = w.from;
    job.window_to = w.to;
  }

  const cursor =
    job.enum_cursor && Object.keys(job.enum_cursor).length > 0
      ? (job.enum_cursor as AdapterCursor)
      : null;

  const { rows, nextCursor } = await adapter.fetchReservationListPage(
    { from: job.window_from, to: job.window_to },
    cursor,
  );

  const roomTypeMap = await loadRoomTypeMap(supabase, job.hotel_id);
  const upserted = await upsertSlimRows(supabase, job.hotel_id, roomTypeMap, rows);

  const windowRows = Number(job.stats.currentWindowRows ?? 0) + upserted;
  job.rows_upserted += upserted;
  job.reservations_enumerated += rows.length;
  for (const r of rows) {
    job.oldest_stay_date = minYmd(job.oldest_stay_date, r.stay_date);
    job.newest_stay_date = maxYmd(job.newest_stay_date, r.stay_date);
  }
  job.stats = { ...job.stats, currentWindowRows: windowRows };

  if (nextCursor) {
    // Page checkpoint.
    job.enum_cursor = nextCursor;
    await patchJob(supabase, job.id, {
      enum_cursor: job.enum_cursor,
      rows_upserted: job.rows_upserted,
      reservations_enumerated: job.reservations_enumerated,
      oldest_stay_date: job.oldest_stay_date,
      newest_stay_date: job.newest_stay_date,
      stats: job.stats,
    }, lease);
    return;
  }

  // Window finished — decide what's next.
  job.windows_completed += 1;
  const next = nextAfterWindow({
    window_index: job.window_index,
    max_windows: job.max_windows,
    rows_upserted: job.rows_upserted,
    row_cap: job.row_cap,
    windowRowCount: windowRows,
  });

  if (next.phase === "analyze") {
    job.phase = "analyze";
    job.stats = { ...job.stats, historyStopReason: next.reason };
    await patchJob(supabase, job.id, {
      phase: job.phase,
      windows_completed: job.windows_completed,
      rows_upserted: job.rows_upserted,
      reservations_enumerated: job.reservations_enumerated,
      oldest_stay_date: job.oldest_stay_date,
      newest_stay_date: job.newest_stay_date,
      stats: job.stats,
    }, lease);
    return;
  }

  job.window_index += 1;
  const w = historicalWindow(historyAnchor(job, deps), job.window_index);
  job.window_from = w.from;
  job.window_to = w.to;
  job.enum_cursor = {};
  job.stats = { ...job.stats, currentWindowRows: 0 };
  await patchJob(supabase, job.id, {
    window_index: job.window_index,
    window_from: job.window_from,
    window_to: job.window_to,
    enum_cursor: job.enum_cursor,
    windows_completed: job.windows_completed,
    rows_upserted: job.rows_upserted,
    reservations_enumerated: job.reservations_enumerated,
    oldest_stay_date: job.oldest_stay_date,
    newest_stay_date: job.newest_stay_date,
    stats: job.stats,
  }, lease);
}
