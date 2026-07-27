/**
 * Onboarding import worker — the checkpointed state machine.
 *
 * A job walks: discover -> sync_current -> historical -> analyze -> done.
 *
 *   discover      property profile + room types; backfill blank hotel fields
 *   sync_current  the existing detail-based sync for the last 365d + future
 *                 (true nightly rates; powers live pricing immediately)
 *   historical    slim list-only pull, one year-window at a time going back:
 *                 dates + price only, raw_payload null, checkpointed per page
 *   analyze       cleaning heuristics -> findings; completes the job
 *
 * Every page/step persists its cursor + counters, so a killed invocation
 * resumes exactly where it stopped. The caller (edge function) claims the
 * job via the claim_import_job RPC and hands it here with a time budget.
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
};

export type WorkerDeps = {
  createAdapter: (
    supabase: SupabaseClient,
    hotelId: string,
    pmsType: string,
  ) => Promise<OnboardingPmsAdapter>;
  /** Detail-accurate sync for the current window (existing pipeline). */
  runCurrentSync: (
    supabase: SupabaseClient,
    hotelId: string,
    pmsType: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Cleaning heuristics + findings. Wired in from analysis.ts. */
  analyze: (supabase: SupabaseClient, job: ImportJobRow) => Promise<void>;
  now: () => number;
  todayYmd: () => string;
};

export type StepOutcome = "completed" | "budget_exhausted" | "failed";

const UPSERT_CHUNK = 500;
const LEASE_SECONDS = 180;

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Historical window N (N >= 1): the year ending where window N-1 began. */
export function historicalWindow(todayYmd: string, windowIndex: number): {
  from: string;
  to: string;
} {
  return {
    from: addDays(todayYmd, -365 * (windowIndex + 1)),
    to: addDays(todayYmd, -365 * windowIndex - 1),
  };
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
  if (job.window_index + 1 > job.max_windows) {
    return { phase: "analyze", reason: "max_windows" };
  }
  return { phase: "historical", reason: "more_history" };
}

async function patchJob(
  supabase: SupabaseClient,
  jobId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from("import_jobs")
    .update({
      ...patch,
      lease_expires_at: new Date(Date.now() + LEASE_SECONDS * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);
  if (error) throw new Error(`import_jobs update failed: ${error.message}`);
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

  try {
    const adapter = await deps.createAdapter(supabase, job.hotel_id, job.pms_type);

    while (withinBudget()) {
      if (job.phase === "discover") {
        await runDiscover(supabase, job, adapter);
        continue;
      }
      if (job.phase === "sync_current") {
        const res = await deps.runCurrentSync(supabase, job.hotel_id, job.pms_type);
        if (!res.ok) throw new Error(res.error ?? "current-window sync failed");
        job.phase = "historical";
        job.window_index = 1;
        const w = historicalWindow(deps.todayYmd(), 1);
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
          stats: job.stats,
        });
        continue;
      }
      if (job.phase === "historical") {
        const done = await runHistoricalStep(supabase, job, adapter, deps);
        if (done) continue; // phase advanced
        continue; // page done, loop for next page
      }
      if (job.phase === "analyze") {
        await deps.analyze(supabase, job);
        await patchJob(supabase, job.id, {
          status: "completed",
          phase: "done",
          finished_at: new Date().toISOString(),
        });
        await supabase
          .from("pms_connections")
          .update({ last_sync_at: new Date().toISOString() })
          .eq("hotel_id", job.hotel_id)
          .eq("pms_type", job.pms_type);
        return "completed";
      }
      throw new Error(`Unknown phase '${job.phase}'`);
    }

    // Out of budget: everything is checkpointed; leave running for re-claim.
    return "budget_exhausted";
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const noProgressLimit = 50;
    const failed = job.attempts >= noProgressLimit;
    await supabase
      .from("import_jobs")
      .update({
        last_error: message,
        ...(failed
          ? { status: "failed", finished_at: new Date().toISOString() }
          : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    return failed ? "failed" : "budget_exhausted";
  }
}

async function runDiscover(
  supabase: SupabaseClient,
  job: ImportJobRow,
  adapter: OnboardingPmsAdapter,
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

  const roomTypes = await adapter.fetchRoomTypes();
  if (roomTypes.length > 0) {
    const { error } = await supabase.from("room_types").upsert(
      roomTypes.map((rt) => ({
        hotel_id: job.hotel_id,
        external_room_type_id: rt.external_room_type_id,
        name: rt.name,
        display_name: rt.display_name,
        is_active: true,
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
  });
}

/** One historical list page. Returns true when the phase advanced. */
async function runHistoricalStep(
  supabase: SupabaseClient,
  job: ImportJobRow,
  adapter: OnboardingPmsAdapter,
  deps: WorkerDeps,
): Promise<boolean> {
  if (!job.window_from || !job.window_to) {
    const w = historicalWindow(deps.todayYmd(), job.window_index);
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
    });
    return false;
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
    });
    return true;
  }

  job.window_index += 1;
  const w = historicalWindow(deps.todayYmd(), job.window_index);
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
  });
  return true;
}
