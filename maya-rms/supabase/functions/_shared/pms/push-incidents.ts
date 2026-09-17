/**
 * Rate push incidents: why rates are not landing, condensed.
 *
 * A rejected rate used to leave a console line per cell per tick and nothing
 * else. Here every failure a push run sees is filed under its cause
 * (push-failure.ts): one open incident per hotel, PMS and cause collects the
 * cells it affects and the tries made at them, and closes once none of its
 * cells is still failing for that reason. A cell closes one of three ways,
 * and the incident records whichever covered most of them:
 *
 *   landed      the PMS took the price
 *   superseded  a new price replaced it, or it now fails for another reason
 *   stopped     it is no longer pushed: out of the window, no longer
 *               published, or the hotel stopped pushing (the sweep)
 *
 * Who hears about it. An owner sees an incident, and MAYA raises a critical
 * alert, only when it needs a person: its cause is known and critical, or a
 * cell has failed for two hours over at least five tries. Anything that lands
 * on a retry before then stays in the admin analytics and nowhere else.
 * Guardrail holds are MAYA's own decisions and are never shown to owners; the
 * ones that mean MAYA published a bad row raise a warning.
 *
 * Cost. pushRatesForHotel calls this with what the run already knows. When no
 * cell failed and the ledger it read shows nothing failing or held back,
 * nothing here touches the database. Otherwise: one read of the hotel's open
 * incidents, one of their open cells, a read of recently closed ones only
 * when a cause has no open incident, and at most three writes.
 *
 * Never throws. Recording runs after the rates went out; a failure here is
 * logged and the push result stands.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { raiseAlert, type Alert } from "./alerting.ts";
import { causeFacts, pmsName, type PushFailure, type PushPhase } from "./push-failure.ts";

export const INCIDENTS_TABLE = "rate_push_incidents";
export const INCIDENT_CELLS_TABLE = "rate_push_incident_cells";
export const ATTEMPTS_TABLE = "rate_push_attempts";

/** Tries kept per incident. Past this they are counted on the incident, not stored. */
export const MAX_STORED_ATTEMPTS = 500;
/** A retrying cause reaches the owner once a cell has failed this long... */
export const ESCALATE_AFTER_MS = 2 * 60 * 60_000;
/** ...over at least this many tries. */
export const ESCALATE_AFTER_ATTEMPTS = 5;
/**
 * An incident closed this recently is reopened rather than a new one opened.
 * A Cloudbeds send counts as landed when its job is still running at the end
 * of the run, and the job can turn out rejected on a later tick, within the
 * hour pushRatesForHotel keeps asking about it.
 */
export const REOPEN_WITHIN_MS = 60 * 60_000;

export type AttemptOutcome = "failed" | "rejected" | "skipped" | "unconfirmed" | "landed";

/** A cell as the run left it. Cells the run did not see at all are no longer being pushed. */
export type RunCell = { stayDate: string; roomTypeId: string; price: number } & (
  | {
      state: "landed";
      /** Set when this run sent it; absent when the ledger already had the price as sent. */
      sent?: { at: string; phase: PushPhase; jobReference: string | null };
    }
  | { state: "failing"; failure: PushFailure }
  /** Not attempted this run (the deadline): left as it was. */
  | { state: "waiting" }
);

/** A failure this run produced: a refused send, a rejected or unconfirmed job, or a newly recorded skip. */
export type RunFailure = {
  stayDate: string;
  roomTypeId: string;
  price: number;
  at: string;
  phase: PushPhase;
  outcome: Exclude<AttemptOutcome, "landed">;
  httpStatus: number | null;
  message: string | null;
  jobReference: string | null;
  failure: PushFailure;
};

export type PushRunRecord = {
  hotelId: string;
  pmsType: string;
  nowMs: number;
  /** By `${stayDate}|${roomTypeId}`. */
  cells: Map<string, RunCell>;
  failures: RunFailure[];
  /** The ledger this run read holds a failed or held-back cell, so an incident may be open. */
  mayHaveOpen: boolean;
};

export type IncidentRecordSummary = {
  opened: number;
  reopened: number;
  resolved: number;
  escalated: number;
  attemptsStored: number;
};

type IncidentRow = {
  id: string;
  hotel_id: string;
  pms_type: string;
  cause: string;
  known: boolean;
  severity: string;
  admin_only: boolean;
  opened_at: string;
  last_attempt_at: string | null;
  attempt_count: number;
  attempts_stored: number;
  cells_landed: number;
  cells_superseded: number;
  cells_stopped: number;
  customer_visible_at: string | null;
  alerted_at: string | null;
  resolved_at: string | null;
  resolution: string | null;
};

type CellRow = {
  incident_id: string;
  hotel_id: string;
  room_type_id: string;
  stay_date: string;
  price: number;
  state: "open" | "landed" | "superseded" | "stopped";
  attempts: number;
  first_attempt_at: string;
  last_attempt_at: string;
  closed_at: string | null;
};

type Working = {
  row: IncidentRow;
  cells: Map<string, CellRow>;
  dirty: boolean;
  dirtyCells: Set<string>;
};

const INCIDENT_COLUMNS =
  "id, hotel_id, pms_type, cause, known, severity, admin_only, opened_at, last_attempt_at, attempt_count, attempts_stored, cells_landed, cells_superseded, cells_stopped, customer_visible_at, alerted_at, resolved_at, resolution";
const CELL_COLUMNS =
  "incident_id, hotel_id, room_type_id, stay_date, price, state, attempts, first_attempt_at, last_attempt_at, closed_at";

export type RecordDeps = {
  alert?: (supabase: SupabaseClient, alert: Alert) => Promise<{ sent: boolean; reason?: string }>;
  newId?: () => string;
};

export async function recordPushIncidents(
  supabase: SupabaseClient,
  run: PushRunRecord,
  deps: RecordDeps = {},
): Promise<IncidentRecordSummary | { error: string } | null> {
  if (!run.mayHaveOpen && run.failures.length === 0) return null;
  try {
    return await record(supabase, run, deps);
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    console.error(
      JSON.stringify({
        fn: "recordPushIncidents",
        hotelId: run.hotelId,
        pmsType: run.pmsType,
        error,
        event: "rate_push_incident_write_failed",
      }),
    );
    return { error };
  }
}

const cellKey = (stayDate: string, roomTypeId: string) => `${stayDate}|${roomTypeId}`;
const toMoney = (n: number) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readAll(makeQuery: () => any, label: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await makeQuery().range(from, from + 999);
    if (error) throw new Error(`${label}: ${error.message}`);
    const rows = (data ?? []) as Record<string, unknown>[];
    out.push(...rows);
    if (rows.length < 1000 || from > 100_000) return out;
  }
}

function incidentRow(r: Record<string, unknown>): IncidentRow {
  return {
    id: String(r.id),
    hotel_id: String(r.hotel_id),
    pms_type: String(r.pms_type),
    cause: String(r.cause),
    known: r.known === true,
    severity: String(r.severity),
    admin_only: r.admin_only === true,
    opened_at: String(r.opened_at),
    last_attempt_at: r.last_attempt_at != null ? String(r.last_attempt_at) : null,
    attempt_count: Number(r.attempt_count) || 0,
    attempts_stored: Number(r.attempts_stored) || 0,
    cells_landed: Number(r.cells_landed) || 0,
    cells_superseded: Number(r.cells_superseded) || 0,
    cells_stopped: Number(r.cells_stopped) || 0,
    customer_visible_at: r.customer_visible_at != null ? String(r.customer_visible_at) : null,
    alerted_at: r.alerted_at != null ? String(r.alerted_at) : null,
    resolved_at: r.resolved_at != null ? String(r.resolved_at) : null,
    resolution: r.resolution != null ? String(r.resolution) : null,
  };
}

function cellRow(r: Record<string, unknown>): CellRow {
  return {
    incident_id: String(r.incident_id),
    hotel_id: String(r.hotel_id),
    room_type_id: String(r.room_type_id),
    stay_date: String(r.stay_date).slice(0, 10),
    price: Number(r.price),
    state: String(r.state) as CellRow["state"],
    attempts: Number(r.attempts) || 0,
    first_attempt_at: String(r.first_attempt_at),
    last_attempt_at: String(r.last_attempt_at),
    closed_at: r.closed_at != null ? String(r.closed_at) : null,
  };
}

/** Whichever way most of its cells closed; landed wins a tie, then superseded. */
export function resolutionOf(counts: { cells_landed: number; cells_superseded: number; cells_stopped: number }) {
  const { cells_landed: landed, cells_superseded: superseded, cells_stopped: stopped } = counts;
  if (landed >= superseded && landed >= stopped && landed > 0) return "landed";
  if (superseded >= stopped && superseded > 0) return "superseded";
  return "stopped";
}

const COUNTER = { landed: "cells_landed", superseded: "cells_superseded", stopped: "cells_stopped" } as const;

async function record(
  supabase: SupabaseClient,
  run: PushRunRecord,
  deps: RecordDeps,
): Promise<IncidentRecordSummary> {
  const now = new Date(run.nowMs).toISOString();
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const alert = deps.alert ?? raiseAlert;
  const summary: IncidentRecordSummary = { opened: 0, reopened: 0, resolved: 0, escalated: 0, attemptsStored: 0 };

  const incidents = new Map<string, Working>();
  const openByCause = new Map<string, Working>();
  const openRows = await readAll(
    () =>
      supabase
        .from(INCIDENTS_TABLE)
        .select(INCIDENT_COLUMNS)
        .eq("hotel_id", run.hotelId)
        .eq("pms_type", run.pmsType)
        .is("resolved_at", null)
        .order("opened_at", { ascending: true }),
    "open incidents",
  );
  for (const r of openRows) {
    const w: Working = { row: incidentRow(r), cells: new Map(), dirty: false, dirtyCells: new Set() };
    incidents.set(w.row.id, w);
    openByCause.set(w.row.cause, w);
  }

  // A cause with nothing open may have closed moments ago on a send whose
  // job has now come back rejected.
  const reopenable = new Map<string, Working>();
  const unopened = [...new Set(run.failures.map((f) => f.failure.cause))].filter((c) => !openByCause.has(c));
  if (unopened.length > 0) {
    const recent = await readAll(
      () =>
        supabase
          .from(INCIDENTS_TABLE)
          .select(INCIDENT_COLUMNS)
          .eq("hotel_id", run.hotelId)
          .eq("pms_type", run.pmsType)
          .in("cause", unopened)
          .gte("resolved_at", new Date(run.nowMs - REOPEN_WITHIN_MS).toISOString())
          .order("resolved_at", { ascending: false }),
      "recent incidents",
    );
    for (const r of recent) {
      const cause = String(r.cause);
      if (!reopenable.has(cause)) {
        reopenable.set(cause, { row: incidentRow(r), cells: new Map(), dirty: false, dirtyCells: new Set() });
      }
    }
  }

  const openIds = [...incidents.keys()];
  const cellRows =
    openIds.length > 0
      ? await readAll(
          () =>
            supabase
              .from(INCIDENT_CELLS_TABLE)
              .select(CELL_COLUMNS)
              .in("incident_id", openIds)
              .eq("state", "open")
              .order("stay_date", { ascending: true })
              .order("room_type_id", { ascending: true }),
          "open incident cells",
        )
      : [];
  const reopenIds = [...reopenable.values()].map((w) => w.row.id);
  if (reopenIds.length > 0) {
    cellRows.push(
      ...(await readAll(
        () =>
          supabase
            .from(INCIDENT_CELLS_TABLE)
            .select(CELL_COLUMNS)
            .in("incident_id", reopenIds)
            .order("stay_date", { ascending: true })
            .order("room_type_id", { ascending: true }),
        "recent incident cells",
      )),
    );
  }
  const byId = new Map<string, Working>([...incidents, ...[...reopenable.values()].map((w) => [w.row.id, w] as const)]);
  // Which open incident each open cell is failing under.
  const owner = new Map<string, Working>();
  for (const r of cellRows) {
    const c = cellRow(r);
    const w = byId.get(c.incident_id);
    if (!w) continue;
    const key = cellKey(c.stay_date, c.room_type_id);
    w.cells.set(key, c);
    if (c.state === "open" && w.row.resolved_at == null) owner.set(key, w);
  }

  const attemptRows: Record<string, unknown>[] = [];
  const storeAttempt = (w: Working, a: Omit<RunFailure, "failure" | "outcome"> & { outcome: AttemptOutcome }) => {
    w.row.attempt_count += 1;
    if (!w.row.last_attempt_at || a.at > w.row.last_attempt_at) w.row.last_attempt_at = a.at;
    w.dirty = true;
    if (w.row.attempts_stored >= MAX_STORED_ATTEMPTS) return;
    w.row.attempts_stored += 1;
    attemptRows.push({
      id: newId(),
      incident_id: w.row.id,
      hotel_id: run.hotelId,
      attempted_at: a.at,
      stay_date: a.stayDate,
      room_type_id: a.roomTypeId,
      price: toMoney(a.price),
      phase: a.phase,
      outcome: a.outcome,
      http_status: a.httpStatus,
      // The vendor's words about the call, or a skip's reason code. Never guest data.
      message: a.message != null ? String(a.message).slice(0, 300) : null,
      job_reference: a.jobReference,
    });
  };
  const closeCell = (w: Working, key: string, state: "landed" | "superseded" | "stopped", at: string) => {
    const c = w.cells.get(key);
    if (!c || c.state !== "open") return;
    c.state = state;
    c.closed_at = at;
    w.row[COUNTER[state]] += 1;
    w.dirty = true;
    w.dirtyCells.add(key);
    if (owner.get(key) === w) owner.delete(key);
  };

  // ── This run's failures, oldest first ─────────────────────────────────────
  const touched = new Set<string>();
  const failures = [...run.failures].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const f of failures) {
    const key = cellKey(f.stayDate, f.roomTypeId);
    const cause = f.failure.cause;
    let w = openByCause.get(cause);
    if (!w) {
      const old = reopenable.get(cause);
      if (old) {
        reopenable.delete(cause);
        old.row.resolved_at = null;
        old.row.resolution = null;
        old.dirty = true;
        w = old;
        summary.reopened += 1;
      } else {
        w = {
          row: {
            id: newId(),
            hotel_id: run.hotelId,
            pms_type: run.pmsType,
            cause,
            known: f.failure.known,
            severity: f.failure.severity,
            admin_only: f.failure.adminOnly,
            opened_at: f.at,
            last_attempt_at: null,
            attempt_count: 0,
            attempts_stored: 0,
            cells_landed: 0,
            cells_superseded: 0,
            cells_stopped: 0,
            customer_visible_at: null,
            alerted_at: null,
            resolved_at: null,
            resolution: null,
          },
          cells: new Map(),
          dirty: true,
          dirtyCells: new Set(),
        };
        summary.opened += 1;
      }
      incidents.set(w.row.id, w);
      openByCause.set(cause, w);
    }

    // Failing for this cause means it is no longer failing for another.
    const previous = owner.get(key);
    if (previous && previous !== w) closeCell(previous, key, "superseded", f.at);

    let c = w.cells.get(key);
    if (!c) {
      c = {
        incident_id: w.row.id,
        hotel_id: run.hotelId,
        room_type_id: f.roomTypeId,
        stay_date: f.stayDate,
        price: toMoney(f.price),
        state: "open",
        attempts: 0,
        first_attempt_at: f.at,
        last_attempt_at: f.at,
        closed_at: null,
      };
      w.cells.set(key, c);
    } else if (c.state !== "open") {
      w.row[COUNTER[c.state]] = Math.max(0, w.row[COUNTER[c.state]] - 1);
      c.state = "open";
      c.closed_at = null;
    }
    c.price = toMoney(f.price);
    c.attempts += 1;
    if (f.at > c.last_attempt_at) c.last_attempt_at = f.at;
    w.dirtyCells.add(key);
    owner.set(key, w);
    touched.add(key);
    if (f.failure.severity === "critical") w.row.severity = "critical";
    storeAttempt(w, f);
  }

  // ── Open cells this run did not fail ──────────────────────────────────────
  for (const w of incidents.values()) {
    if (w.row.resolved_at != null) continue;
    for (const [key, c] of w.cells) {
      if (c.state !== "open" || touched.has(key)) continue;
      const seen = run.cells.get(key);
      if (!seen) {
        closeCell(w, key, "stopped", now);
      } else if (seen.state === "failing") {
        if (seen.failure.cause !== w.row.cause) closeCell(w, key, "superseded", now);
      } else if (seen.state === "landed") {
        const at = seen.sent?.at ?? now;
        if (seen.sent && toMoney(seen.price) === c.price) {
          storeAttempt(w, {
            stayDate: c.stay_date,
            roomTypeId: c.room_type_id,
            price: seen.price,
            at,
            phase: seen.sent.phase,
            outcome: "landed",
            httpStatus: null,
            message: null,
            jobReference: seen.sent.jobReference,
          });
        }
        closeCell(w, key, toMoney(seen.price) === c.price ? "landed" : "superseded", at);
      }
    }
  }

  // ── Close, escalate ───────────────────────────────────────────────────────
  const alerts: { w: Working; alert: Alert }[] = [];
  for (const w of incidents.values()) {
    if (w.row.resolved_at != null) continue;
    const open = [...w.cells.values()].filter((c) => c.state === "open");
    if (open.length === 0) {
      w.row.resolved_at = now;
      w.row.resolution = resolutionOf(w.row);
      w.dirty = true;
      summary.resolved += 1;
      continue;
    }
    const facts = causeFacts(w.row.cause);
    if (w.row.admin_only) {
      if (facts.mayaBug && !w.row.alerted_at) alerts.push({ w, alert: alertFor(run, w, open, "warn") });
      continue;
    }
    if (!w.row.customer_visible_at) {
      const critical = w.row.known && w.row.severity === "critical";
      const stuck = open.some(
        (c) => c.attempts >= ESCALATE_AFTER_ATTEMPTS && Date.parse(c.first_attempt_at) <= run.nowMs - ESCALATE_AFTER_MS,
      );
      if (critical || stuck) {
        w.row.customer_visible_at = now;
        w.dirty = true;
        summary.escalated += 1;
      }
    }
    if (w.row.customer_visible_at && !w.row.alerted_at && !facts.alertedElsewhere) {
      alerts.push({ w, alert: alertFor(run, w, open, "critical") });
    }
  }
  for (const { w, alert: a } of alerts) {
    const res = await alert(supabase, a);
    if (res.sent || res.reason === "deduped") {
      w.row.alerted_at = now;
      w.dirty = true;
    }
  }

  // ── Write: incidents first, the rest refer to them ────────────────────────
  const everyone = new Set([...incidents.values(), ...byId.values()]);
  const incidentWrites = [...everyone].filter((w) => w.dirty).map((w) => ({ ...w.row, updated_at: now }));
  if (incidentWrites.length > 0) {
    const { error } = await supabase.from(INCIDENTS_TABLE).upsert(incidentWrites, { onConflict: "id" });
    if (error) throw new Error(`incidents write: ${error.message}`);
  }
  const cellWrites: CellRow[] = [];
  for (const w of everyone) {
    for (const key of w.dirtyCells) {
      const c = w.cells.get(key);
      if (c) cellWrites.push(c);
    }
  }
  for (let i = 0; i < cellWrites.length; i += 500) {
    const { error } = await supabase
      .from(INCIDENT_CELLS_TABLE)
      .upsert(cellWrites.slice(i, i + 500), { onConflict: "incident_id,room_type_id,stay_date" });
    if (error) throw new Error(`incident cells write: ${error.message}`);
  }
  for (let i = 0; i < attemptRows.length; i += 500) {
    const { error } = await supabase.from(ATTEMPTS_TABLE).insert(attemptRows.slice(i, i + 500));
    if (error) throw new Error(`attempts write: ${error.message}`);
  }
  summary.attemptsStored = attemptRows.length;
  return summary;
}

/** The root cause and its reach. Never the vendor's own text: that is in the attempts. */
function alertFor(run: PushRunRecord, w: Working, open: CellRow[], severity: "warn" | "critical"): Alert {
  const facts = causeFacts(w.row.cause);
  const nights = new Set(open.map((c) => c.stay_date)).size;
  const roomTypes = new Set(open.map((c) => c.room_type_id)).size;
  const name = pmsName(run.pmsType);
  return {
    severity,
    key: `rate_push:${w.row.cause}:${run.hotelId}`,
    title:
      severity === "critical"
        ? `Rates not reaching ${name}: ${w.row.cause.replace(/_/g, " ")}`
        : `Rates held back by a guardrail: ${w.row.cause.replace(/^guardrail_/, "").replace(/_/g, " ")}`,
    detail: `${facts.adminDescription} ${nights} night${nights === 1 ? "" : "s"}, ${roomTypes} room type${roomTypes === 1 ? "" : "s"}, ${w.row.attempt_count} tr${w.row.attempt_count === 1 ? "y" : "ies"} since ${w.row.opened_at}.`,
    hotelId: run.hotelId,
  };
}
