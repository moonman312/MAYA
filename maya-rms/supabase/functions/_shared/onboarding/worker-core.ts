/**
 * Onboarding import worker — the checkpointed state machine.
 *
 * A job walks:
 *   discover -> sync_current -> historical (3 windows) -> analyze_early
 *            -> historical (the rest) -> analyze -> done
 *
 *   discover       property profile + room types; backfill blank hotel fields
 *   sync_current   the live sync over the current window (true nightly rates;
 *                  powers live pricing immediately). Repeated until it reports
 *                  the window covered, resuming from its own checkpoint. It
 *                  reports the first check-in date it covered and history
 *                  tiles back from there — its window is a runtime setting,
 *                  not something to assume.
 *   historical     slim list-only pull, one year-window at a time going back:
 *                  dates + price only, raw_payload null, checkpointed per page
 *   analyze_early  findings and starter rules from the first three years, so
 *                  the owner can review and run rules while older years load
 *   analyze        the same analysis over everything; refines what the early
 *                  pass proposed and completes the job
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
import { proposeCountsAsRoom } from "./analysis.ts";
import { isPaidLiveHotel } from "../billing/entitlement.ts";

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
  created_at?: string;
};

export type CurrentSyncResult =
  | {
      ok: true;
      /**
       * The oldest check-in date it actually pulled — the historical phase
       * butts up against it instead of guessing at it, which is what left
       * eleven months unimported when the guess was a hardcoded year. Required
       * rather than optional (null = this sync genuinely can't say) so a new
       * wiring has to think about it; null falls back to today, which
       * over-covers rather than leaving another hole.
       */
      coveredFrom: string | null;
      /** False when the run stopped before the whole window was read. */
      covered: boolean;
      /**
       * Where an uncovered run will resume from. Compared between runs to tell
       * a sweep that is getting there from one that is stuck. Null when the
       * sync cannot say.
       */
      resumeFrom: string | null;
      /** Room-nights the run read, and the stay nights they span. */
      rows: number;
      oldestStay: string | null;
      newestStay: string | null;
    }
  | { ok: false; error?: string };

export type AnalysisPass = "early" | "final";

export type WorkerDeps = {
  createAdapter: (
    supabase: SupabaseClient,
    hotelId: string,
    pmsType: string,
  ) => Promise<OnboardingPmsAdapter>;
  /** The live sync for the current window (existing pipeline). */
  runCurrentSync: (
    supabase: SupabaseClient,
    hotelId: string,
    pmsType: string,
  ) => Promise<CurrentSyncResult>;
  /** Cleaning heuristics + findings + starter rules. Wired in from analysis.ts. */
  analyze: (supabase: SupabaseClient, job: ImportJobRow, pass: AnalysisPass) => Promise<void>;
  now: () => number;
  todayYmd: () => string;
};

export type StepOutcome = "completed" | "budget_exhausted" | "failed" | "stopped";

/**
 * Why a job must not run. Mirrors import_job_stop_reason in
 * 99_supabase_migration_import_at_claim_v1.sql, which cancels these before it
 * claims; this copy catches a job claimed before the reason appeared, and a
 * deploy that lands ahead of that file.
 */
export type ImportStopReason = "connection_missing" | "disconnected" | "deferred" | "claim_missing";

const STOP_MESSAGES: Record<ImportStopReason, string> = {
  connection_missing: "Stopped: the property has no PMS connection.",
  disconnected: "Stopped: the PMS connection was disconnected.",
  deferred: 'Stopped: the owner chose "Not now" for this property.',
  claim_missing: "Stopped: nobody has claimed this property.",
};

function isMissingColumn(error: { code?: string; message?: string } | null, column: string): boolean {
  return Boolean(error && (error.code === "42703" || (error.message ?? "").includes(column)));
}

/**
 * A paid hotel's import runs while its connection exists. An unpaid one is
 * imported only as a claimed Marketplace property its owner has not put off,
 * which is the only way one gets queued; anything else is not ours to read.
 */
export async function importStopReason(
  supabase: SupabaseClient,
  job: Pick<ImportJobRow, "hotel_id" | "pms_type">,
): Promise<ImportStopReason | null> {
  const { data: conn, error: connErr } = await supabase
    .from("pms_connections")
    .select("status")
    .eq("hotel_id", job.hotel_id)
    .eq("pms_type", job.pms_type)
    .maybeSingle();
  if (connErr) throw new Error(`pms_connections read failed: ${connErr.message}`);
  if (!conn) return "connection_missing";
  if (String(conn.status) === "disconnected") return "disconnected";

  let hotelRes = await supabase
    .from("hotels")
    .select("is_active, setup_deferred_at")
    .eq("id", job.hotel_id)
    .maybeSingle();
  if (hotelRes.error && isMissingColumn(hotelRes.error, "setup_deferred_at")) {
    hotelRes = await supabase.from("hotels").select("is_active").eq("id", job.hotel_id).maybeSingle();
  }
  if (hotelRes.error) throw new Error(`hotels read failed: ${hotelRes.error.message}`);
  const hotel = hotelRes.data as { is_active?: boolean; setup_deferred_at?: string | null } | null;
  if (!hotel) return null;
  // A trial that ended unpaid keeps is_active, so live is not the same as paid.
  if (await isPaidLiveHotel(supabase, job.hotel_id, hotel.is_active)) return null;
  if (hotel.setup_deferred_at) return "deferred";

  const { data: claim, error: claimErr } = await supabase
    .from("pms_marketplace_claims")
    .select("token")
    .eq("hotel_id", job.hotel_id)
    .not("claimed_at", "is", null)
    .limit(1)
    .maybeSingle();
  if (claimErr) throw new Error(`pms_marketplace_claims read failed: ${claimErr.message}`);
  return claim ? null : "claim_missing";
}

const UPSERT_CHUNK = 500;
export const LEASE_SECONDS = 180;
/** Comfortably inside the lease, so one dropped touch isn't fatal. */
const HEARTBEAT_MS = 60_000;
/** Consecutive invocations that moved nothing before we call the job dead. */
const NO_PROGRESS_LIMIT = 50;

/**
 * History windows imported before the early analysis. Three, not two: the
 * engine's comparable dates, Booking Speed's load window and reinforcement's
 * corroboration all stop at three years, so this is the smallest history on
 * which every starter rule and finding works as it will with the full import.
 */
export const EARLY_ANALYSIS_AFTER_WINDOWS = 3;
/**
 * Current-window runs in a row that ended short without moving their
 * checkpoint. One is a slow API; this many means nothing will change by
 * trying again at once, so the job errors and backs off.
 */
const CURRENT_SYNC_STALL_LIMIT = 3;
/** Runs one current window may take when the sync cannot report a checkpoint at all. */
const CURRENT_SYNC_MAX_PASSES = 48;

type CurrentSyncProgress = {
  covered: boolean;
  passes: number;
  stalls: number;
  resumeFrom: string | null;
  rows: number;
};

function currentSyncProgress(stats: Record<string, unknown>): CurrentSyncProgress {
  const raw = (stats.currentSync ?? {}) as Partial<CurrentSyncProgress>;
  return {
    covered: raw.covered === true,
    passes: Number(raw.passes ?? 0) || 0,
    stalls: Number(raw.stalls ?? 0) || 0,
    resumeFrom: typeof raw.resumeFrom === "string" ? raw.resumeFrom : null,
    rows: Number(raw.rows ?? 0) || 0,
  };
}

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

/**
 * Decide what follows a finished historical window.
 *
 * When history is about to stop anyway the final analysis runs straight
 * away; an early pass only earns its place when there are older years still
 * to come.
 */
export function nextAfterWindow(job: {
  window_index: number;
  max_windows: number;
  rows_upserted: number;
  row_cap: number;
  windowRowCount: number;
  earlyAnalysisDone?: boolean;
}): { phase: "historical" | "analyze_early" | "analyze"; reason: string } {
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
  if (!job.earlyAnalysisDone && job.window_index + 1 >= EARLY_ANALYSIS_AFTER_WINDOWS) {
    return { phase: "analyze_early", reason: "early_analysis" };
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
    const stop = await importStopReason(supabase, job);
    if (stop) {
      // Canceled rather than failed: nothing went wrong, and the checkpoint is
      // kept so whatever lifts the reason (a reconnect, showing the property
      // again, a payment) re-queues it and it carries on from here.
      let q = supabase
        .from("import_jobs")
        .update({
          status: "canceled",
          finished_at: new Date().toISOString(),
          lease_expires_at: null,
          last_error: STOP_MESSAGES[stop],
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      if (lease.token) q = q.eq("status", "running").lte("lease_expires_at", lease.token);
      const { error } = await q;
      if (error) throw new Error(`import_jobs update failed: ${error.message}`);
      job.status = "canceled";
      console.log(JSON.stringify({ fn: "processJob", jobId: job.id, hotelId: job.hotel_id, stopped: stop }));
      return "stopped";
    }

    // A current-window pass that was marked started and never marked done
    // means the invocation running it was killed (a wall-clock limit, an
    // out-of-memory crash). Nothing ever reaches the catch below in that
    // case, so without this a sync too big for one invocation retried forever
    // and never counted toward the no-progress limit.
    const unfinished = (job.stats.currentSync as { passStartedAt?: unknown } | undefined)?.passStartedAt;
    if (job.phase === "sync_current" && unfinished) {
      const streak = Number(job.stats.errorStreak ?? 0) + 1;
      const failed = streak >= NO_PROGRESS_LIMIT;
      const { passStartedAt: _dropped, ...rest } = job.stats.currentSync as Record<string, unknown>;
      void _dropped;
      job.stats = { ...job.stats, errorStreak: streak, currentSync: rest };
      console.warn(
        JSON.stringify({ fn: "processJob", jobId: job.id, hotelId: job.hotel_id, event: "current_sync_killed", passStartedAt: unfinished, streak }),
      );
      let q = supabase
        .from("import_jobs")
        .update({
          stats: job.stats,
          last_error: `the current-window sync started at ${String(unfinished)} never finished`,
          ...(failed ? { status: "failed", finished_at: new Date().toISOString() } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      if (lease.token) q = q.eq("status", "running").lte("lease_expires_at", lease.token);
      const { error } = await q;
      if (error) throw new Error(`import_jobs update failed: ${error.message}`);
      if (failed) {
        job.status = "failed";
        return "failed";
      }
    }

    const adapter = await deps.createAdapter(supabase, job.hotel_id, job.pms_type);

    while (withinBudget()) {
      if (job.phase === "discover") {
        await runDiscover(supabase, job, adapter, lease);
        progressed = true;
        continue;
      }
      if (job.phase === "sync_current") {
        // Marked before the pass and replaced when it ends either way, so a
        // marker still here at the next claim can only mean a killed pass.
        job.stats = {
          ...job.stats,
          currentSync: { ...currentSyncProgress(job.stats), passStartedAt: new Date(deps.now()).toISOString() },
        };
        await patchJob(supabase, job.id, { stats: job.stats }, lease);
        const res = await withLeaseHeartbeat(supabase, job.id, lease, () =>
          deps.runCurrentSync(supabase, job.hotel_id, job.pms_type),
        );
        if (!res.ok) throw new Error(res.error ?? "current-window sync failed");
        const before = currentSyncProgress(job.stats);
        const passes = before.passes + 1;
        job.rows_upserted += res.rows;
        job.oldest_stay_date = minYmd(job.oldest_stay_date, res.oldestStay);
        job.newest_stay_date = maxYmd(job.newest_stay_date, res.newestStay);

        if (!res.covered) {
          // Walking on to history here left a partly imported present, with
          // the remainder waiting on a scheduler that only runs for paying
          // hotels. The sync checkpointed where it stopped, so the next run
          // carries on from there; this phase ends only once it says covered.
          const moved = res.resumeFrom === null || res.resumeFrom !== before.resumeFrom;
          const progress: CurrentSyncProgress = {
            covered: false,
            passes,
            stalls: moved ? 0 : before.stalls + 1,
            resumeFrom: res.resumeFrom,
            rows: before.rows + res.rows,
          };
          job.stats = { ...job.stats, currentSync: progress };
          await patchJob(supabase, job.id, {
            rows_upserted: job.rows_upserted,
            oldest_stay_date: job.oldest_stay_date,
            newest_stay_date: job.newest_stay_date,
            stats: job.stats,
          }, lease);
          if (progress.stalls >= CURRENT_SYNC_STALL_LIMIT) {
            throw new Error(
              `current-window sync stopped short ${progress.stalls} runs in a row without moving past ${res.resumeFrom}`,
            );
          }
          if (passes >= CURRENT_SYNC_MAX_PASSES) {
            throw new Error(`current-window sync still not covered after ${passes} runs`);
          }
          if (moved) progressed = true;
          continue;
        }

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
        job.stats = {
          ...job.stats,
          currentWindowRows: 0,
          historyAnchor: anchor,
          currentSync: { covered: true, passes, stalls: 0, resumeFrom: null, rows: before.rows + res.rows },
        };
        await patchJob(supabase, job.id, {
          phase: job.phase,
          window_index: job.window_index,
          window_from: job.window_from,
          window_to: job.window_to,
          enum_cursor: job.enum_cursor,
          rows_upserted: job.rows_upserted,
          oldest_stay_date: job.oldest_stay_date,
          newest_stay_date: job.newest_stay_date,
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
      if (job.phase === "analyze_early") {
        // The next window is already on the row, so all this checkpoint has to
        // do is flip the phase back. Analysis is safe to repeat if it never
        // lands: a re-run refines what the first one wrote instead of adding to it.
        await withLeaseHeartbeat(supabase, job.id, lease, () => deps.analyze(supabase, job, "early"));
        job.phase = "historical";
        job.stats = { ...job.stats, earlyAnalysisAt: new Date().toISOString() };
        await patchJob(supabase, job.id, { phase: job.phase, stats: job.stats }, lease);
        progressed = true;
        continue;
      }
      if (job.phase === "analyze") {
        await withLeaseHeartbeat(supabase, job.id, lease, () => deps.analyze(supabase, job, "final"));
        await patchJob(supabase, job.id, {
          status: "completed",
          phase: "done",
          stats: job.stats,
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
    // This failure is counted here; the next claim must not count it again.
    const marked = job.stats.currentSync as Record<string, unknown> | undefined;
    if (marked && "passStartedAt" in marked) {
      const { passStartedAt: _dropped, ...rest } = marked;
      void _dropped;
      job.stats = { ...job.stats, currentSync: rest };
    }
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
    const rtRows = roomTypes.map((rt) => ({
      hotel_id: job.hotel_id,
      external_room_type_id: rt.external_room_type_id,
      name: rt.name,
      display_name: rt.display_name,
      total_rooms: rt.total_rooms,
    }));
    const { error } = await supabase
      .from("room_types")
      .upsert(rtRows, { onConflict: "hotel_id,external_room_type_id" });
    if (error) throw new Error(`room_types upsert failed: ${error.message}`);
    // Default counts_as_room for types nobody has classified yet. Separate
    // from the upsert for the same reason is_active is kept out of it: the
    // review strip shows this guess and the owner's answer has to survive
    // every later re-import. A first import may propose non-rooms because
    // the strip is about to show them unticked; a refresh of a live hotel is
    // a sync as far as the heuristic is concerned — its guesses stay
    // advisory and the findings ask instead.
    await proposeCountsAsRoom(
      supabase,
      job.hotel_id,
      rtRows,
      job.stats.mode === "refresh" ? "sync" : "import",
    );
  }

  job.phase = "sync_current";
  await patchJob(supabase, job.id, {
    phase: job.phase,
    stats: { ...job.stats, roomTypes: roomTypes.length },
  }, lease);
}

/** The most history rows any job may import, however large the property. */
const ROW_CAP_CEILING = 3_000_000;

/**
 * The cap a job actually runs to. import_jobs.row_cap defaults to 300,000,
 * which a 500-room property fills in about a year and a half of its ten, and
 * nothing sets it per property. So the cap grows with the property: room
 * count x 366 nights x the windows it may import, with half again for
 * multi-room nights and cancellations, never below the stored cap and never
 * above ROW_CAP_CEILING.
 */
export function effectiveRowCap(rowCap: number, countingRooms: number, maxWindows: number): number {
  const derived = Math.ceil(Math.max(0, countingRooms) * 366 * Math.max(1, maxWindows) * 1.5);
  return Math.max(rowCap, Math.min(ROW_CAP_CEILING, derived));
}

/**
 * Rows the historical phase wrote. rows_upserted also counts every
 * current-window pass (see sync_current), and those passes can repeat for a
 * large book, so they must not eat into the history the cap allows.
 */
function historicalRows(job: ImportJobRow): number {
  return Math.max(0, job.rows_upserted - currentSyncProgress(job.stats).rows);
}

/** Rooms the job's property sells, read once per job and kept on its stats. */
async function countingRoomsFor(supabase: SupabaseClient, job: ImportJobRow): Promise<number> {
  if (typeof job.stats.countingRooms === "number") return job.stats.countingRooms;
  let res: { data: unknown[] | null; error: { code?: string; message: string } | null } = await supabase
    .from("room_types")
    .select("total_rooms, counts_as_room")
    .eq("hotel_id", job.hotel_id)
    .eq("is_active", true);
  if (res.error && isMissingColumn(res.error, "counts_as_room")) {
    res = await supabase
      .from("room_types")
      .select("total_rooms")
      .eq("hotel_id", job.hotel_id)
      .eq("is_active", true);
  }
  // A failed read leaves the stored cap as it was.
  if (res.error) return 0;
  let rooms = 0;
  for (const r of (res.data ?? []) as { total_rooms?: unknown; counts_as_room?: unknown }[]) {
    if (r.counts_as_room === false) continue;
    const n = Number(r.total_rooms);
    if (Number.isFinite(n) && n > 0) rooms += n;
  }
  job.stats = { ...job.stats, countingRooms: rooms };
  return rooms;
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
  const rowCap = effectiveRowCap(job.row_cap, await countingRoomsFor(supabase, job), job.max_windows);

  const windowRows = Number(job.stats.currentWindowRows ?? 0) + upserted;
  job.rows_upserted += upserted;
  job.reservations_enumerated += rows.length;
  for (const r of rows) {
    job.oldest_stay_date = minYmd(job.oldest_stay_date, r.stay_date);
    job.newest_stay_date = maxYmd(job.newest_stay_date, r.stay_date);
  }
  job.stats = { ...job.stats, currentWindowRows: windowRows };

  if (nextCursor) {
    job.enum_cursor = nextCursor;
    // The row cap has to bind between pages, not just between windows: an
    // enumeration that never stops handing back cursors — a PMS that ignores
    // the page number, say — otherwise never reaches a window boundary for
    // nextAfterWindow to stop it at, and the self-chain pages forever.
    if (historicalRows(job) >= rowCap) {
      job.phase = "analyze";
      job.stats = { ...job.stats, historyStopReason: "row_cap" };
      await patchJob(supabase, job.id, {
        phase: job.phase,
        enum_cursor: job.enum_cursor,
        rows_upserted: job.rows_upserted,
        reservations_enumerated: job.reservations_enumerated,
        oldest_stay_date: job.oldest_stay_date,
        newest_stay_date: job.newest_stay_date,
        stats: job.stats,
      }, lease);
      return;
    }
    // Page checkpoint.
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
    rows_upserted: historicalRows(job),
    row_cap: rowCap,
    windowRowCount: windowRows,
    earlyAnalysisDone: typeof job.stats.earlyAnalysisAt === "string",
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

  // The early analysis goes in between windows with the next one already
  // queued on the row, so finishing it is a phase flip and nothing else.
  if (next.phase === "analyze_early") job.phase = "analyze_early";
  job.window_index += 1;
  const w = historicalWindow(historyAnchor(job, deps), job.window_index);
  job.window_from = w.from;
  job.window_to = w.to;
  job.enum_cursor = {};
  job.stats = { ...job.stats, currentWindowRows: 0 };
  await patchJob(supabase, job.id, {
    phase: job.phase,
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
