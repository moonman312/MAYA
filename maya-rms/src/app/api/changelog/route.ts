/**
 * GET /api/changelog — recent evaluation cycles as a human-readable change log.
 *
 * With Supabase configured and a resolvable hotel, cycles are rebuilt from
 * evaluation_audit rows (the 10 most recent runs) and narrated via
 * changelog-narrative. A live hotel's rate push problems that need the owner
 * are merged in, one item each: ongoing ones on top, resolved ones where they
 * ended (changelog-push-problems.ts).
 * The demo changelog is served only when Supabase is
 * not configured at all; any failure past that point is a real error and
 * must surface as one — this screen is the audit trail of what the system
 * actually did, so inventing history here is worse than a 500.
 */

import { dbErrorResponse } from "@/lib/api-guards";
import {
  type AuditChangeRow,
  type ChangelogLookups,
  type RuleLookupEntry,
  type RunHeartbeat,
  type RunSummary,
  MAX_RUNS,
  buildCyclesFromAudit,
  buildCyclesFromRuns,
  currencySymbolFor,
  isChangeRow,
  manualOverrideFor,
  topChangeRows,
} from "@/lib/changelog-route-helpers";
import {
  type IncidentAttemptForLog,
  type IncidentCellForLog,
  type IncidentForLog,
  MAX_PUSH_PROBLEMS,
  MAX_TRIES_READ,
  buildPushProblems,
  mergeTimeline,
  oldestShownRun,
} from "@/lib/changelog-push-problems";
import { buildChangelog } from "@/lib/demo-data";
import { isMissingRelationError } from "@/lib/engine/snapshots";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import type { ChangelogPushProblem, RuleCondition } from "@/types/domain";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const AUDIT_ROW_LIMIT = 600;
// Heartbeat rows are one per run and tiny (no JSONB) — a generous cap still
// costs nothing and comfortably covers MAX_RUNS worth of history even at a
// busy property.
const RUN_LOG_LIMIT = 200;

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(buildChangelog());
  }

  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const hotelId = await resolveAccessibleHotelId(supabase);
  if (!hotelId) {
    return NextResponse.json({ error: "No hotel" }, { status: 400 });
  }

  try {
    return NextResponse.json(await buildRealChangelog(supabase, hotelId));
  } catch (error) {
    const { status, message } = dbErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
}

const AUDIT_COLUMNS =
  "evaluation_run_id, stay_date, room_type_id, evaluated_at, base_price, final_price, pre_clamp_price, floor_price, ceiling_price, details";
/** What deciding and ranking a change needs, without the JSONB behind it. */
const RANK_COLUMNS =
  "id, base_price, final_price, application_order:details->application_order, manual_override:details->manual_override";
const PAGE = 1000;

function toChangeRow(r: Record<string, unknown>): AuditChangeRow {
  return {
    evaluation_run_id: String(r.evaluation_run_id),
    stay_date: String(r.stay_date),
    room_type_id: String(r.room_type_id),
    evaluated_at: String(r.evaluated_at),
    base_price: Number(r.base_price),
    final_price: Number(r.final_price),
    pre_clamp_price: Number(r.pre_clamp_price),
    floor_price: Number(r.floor_price),
    ceiling_price: Number(r.ceiling_price),
    details: r.details as AuditChangeRow["details"],
  };
}

/**
 * The newest runs, each read on its own.
 *
 * One read of the newest 600 audit rows used to be the whole change log. A
 * large property writes thousands of rows in a single run, so the newest run
 * filled the budget and every older one showed as "no changes". Here each of
 * the last runs in evaluation_run_log is paged through a narrow select (prices
 * and the two details fields that decide a change), ranked, and only its top
 * entries are read in full. Null when there is no run log to go by.
 */
async function loadRunSummaries(supabase: SupabaseClient, hotelId: string): Promise<RunSummary[] | null> {
  const { data: runs, error: runsErr } = await supabase
    .from("evaluation_run_log")
    .select("evaluation_run_id, evaluated_at")
    .eq("hotel_id", hotelId)
    .order("evaluated_at", { ascending: false })
    .limit(MAX_RUNS);
  if (runsErr || !runs || runs.length === 0) return null;

  const summaries: RunSummary[] = [];
  for (const run of runs) {
    const runId = String(run.evaluation_run_id);
    // A run stamps its heartbeat and every audit row with the same evalTs, so
    // filtering on it too lets these reads use (hotel_id, evaluated_at desc).
    // Nothing indexes evaluation_run_id, and on its own it scanned every audit
    // row the hotel has kept.
    const runAt = String(run.evaluated_at);
    const changeRows: { id: string; base_price: number; final_price: number }[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("evaluation_audit")
        .select(RANK_COLUMNS)
        .eq("hotel_id", hotelId)
        .eq("evaluated_at", runAt)
        .eq("evaluation_run_id", runId)
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      // Thrown as-is so dbErrorResponse can read the pg code (42501 -> 403).
      if (error) throw error;
      const rows = (data ?? []) as unknown as Record<string, unknown>[];
      for (const r of rows) {
        const candidate = {
          base_price: Number(r.base_price),
          final_price: Number(r.final_price),
          details: {
            application_order: r.application_order,
            manual_override: r.manual_override,
          } as unknown as AuditChangeRow["details"],
        };
        if (isChangeRow(candidate as AuditChangeRow)) {
          changeRows.push({ id: String(r.id), base_price: candidate.base_price, final_price: candidate.final_price });
        }
      }
      if (rows.length < PAGE) break;
    }

    const top = topChangeRows(changeRows);
    let topRows: AuditChangeRow[] = [];
    if (top.length > 0) {
      const { data: full, error: fullErr } = await supabase
        .from("evaluation_audit")
        .select(`id, ${AUDIT_COLUMNS}`)
        .eq("hotel_id", hotelId)
        .eq("evaluated_at", runAt)
        .in("id", top.map((t) => t.id));
      if (fullErr) throw fullErr;
      const byId = new Map(((full ?? []) as Record<string, unknown>[]).map((r) => [String(r.id), r]));
      topRows = top.map((t) => byId.get(t.id)).filter((r): r is Record<string, unknown> => !!r).map(toChangeRow);
    }
    summaries.push({
      evaluation_run_id: runId,
      timestamp: String(run.evaluated_at),
      hasChanges: changeRows.length > 0,
      topRows,
    });
  }
  return summaries;
}

async function buildRealChangelog(supabase: SupabaseClient, hotelId: string) {
  const runSummaries = await loadRunSummaries(supabase, hotelId);

  let auditRows: { details: unknown }[] & Record<string, unknown>[] = [];
  if (!runSummaries) {
    // No run log (a database from before it existed): the newest audit rows.
    const { data, error: auditErr } = await supabase
      .from("evaluation_audit")
      .select(AUDIT_COLUMNS)
      .eq("hotel_id", hotelId)
      .order("evaluated_at", { ascending: false })
      .limit(AUDIT_ROW_LIMIT);
    // Thrown as-is so dbErrorResponse can read the pg code (42501 -> 403).
    if (auditErr) throw auditErr;
    auditRows = (data ?? []) as typeof auditRows;
  }

  const [{ data: hotel }, { data: roomTypes }, { data: rules }, { data: runLogRows }] =
    await Promise.all([
      supabase.from("hotels").select("currency").eq("id", hotelId).maybeSingle(),
      loadRoomTypes(supabase, hotelId),
      supabase
        .from("pricing_rules")
        .select(
          `id, name, action_type, action_direction, action_value, is_pickup_rule,
           rule_condition (
             occupancy_operator, occupancy_threshold,
             dta_operator, dta_threshold_days,
             pickup_operator, pickup_threshold, pickup_window_days, pickup_metric,
             booking_speed_operator, booking_speed_level, booking_speed_window_days
           ),
           rule_signal_room_type ( room_type_id ),
           rule_affected_room_type ( room_type_id )`,
        )
        .eq("hotel_id", hotelId),
      supabase
        .from("evaluation_run_log")
        .select("evaluation_run_id, evaluated_at")
        .eq("hotel_id", hotelId)
        .order("evaluated_at", { ascending: false })
        .limit(RUN_LOG_LIMIT),
    ]);

  const roomTypeNames = new Map<string, string>(
    (roomTypes ?? []).map((rt) => [String(rt.id), String(rt.name)]),
  );

  // Before the counts_as_room migration the column is missing and every room
  // type counts, which is what an unset countingRoomTypeIds means.
  const countingRoomTypeIds = (roomTypes ?? []).some((rt) => "counts_as_room" in rt)
    ? new Set(
        (roomTypes ?? [])
          .filter((rt) => (rt as { counts_as_room?: unknown }).counts_as_room !== false)
          .map((rt) => String(rt.id)),
      )
    : undefined;

  const ruleLookup = new Map<string, RuleLookupEntry>();
  const conditionLookup = new Map<string, RuleCondition>();
  const ruleRoomSets = new Map<string, { signal: string[]; affected: string[] }>();
  for (const rule of rules ?? []) {
    const id = String(rule.id);
    const idsOf = (rows: unknown) =>
      Array.isArray(rows) ? rows.map((r) => String((r as { room_type_id: unknown }).room_type_id)) : [];
    ruleRoomSets.set(id, {
      signal: idsOf(rule.rule_signal_room_type),
      affected: idsOf(rule.rule_affected_room_type),
    });
    ruleLookup.set(id, {
      name: String(rule.name),
      action_type: rule.action_type as RuleLookupEntry["action_type"],
      action_direction: rule.action_direction as RuleLookupEntry["action_direction"],
      action_value: Number(rule.action_value),
      is_pickup_rule: Boolean(rule.is_pickup_rule),
    });
    const rc = Array.isArray(rule.rule_condition)
      ? rule.rule_condition[0]
      : rule.rule_condition;
    if (rc) {
      conditionLookup.set(id, {
        occupancy_operator: rc.occupancy_operator ?? null,
        occupancy_threshold:
          rc.occupancy_threshold != null ? Number(rc.occupancy_threshold) : null,
        dta_operator: rc.dta_operator ?? null,
        dta_threshold_days:
          rc.dta_threshold_days != null ? Number(rc.dta_threshold_days) : null,
        pickup_operator: rc.pickup_operator ?? null,
        pickup_threshold:
          rc.pickup_threshold != null ? Number(rc.pickup_threshold) : null,
        pickup_window_days:
          rc.pickup_window_days != null
            ? (Number(rc.pickup_window_days) as 1 | 3 | 7)
            : null,
        pickup_metric: rc.pickup_metric ?? null,
        booking_speed_operator: rc.booking_speed_operator ?? null,
        booking_speed_level: rc.booking_speed_level ?? null,
        booking_speed_window_days:
          rc.booking_speed_window_days != null
            ? (Number(rc.booking_speed_window_days) as 1 | 7 | 30)
            : null,
      });
    }
  }

  const lookups: ChangelogLookups = {
    roomTypeNames,
    rules: ruleLookup,
    conditions: conditionLookup,
    ruleRoomSets,
    countingRoomTypeIds,
    currencySymbol: currencySymbolFor(hotel?.currency ? String(hotel.currency) : null),
    setterNames: await setterNamesFor(
      supabase,
      runSummaries ? runSummaries.flatMap((run) => run.topRows) : auditRows,
    ),
  };

  const cycles = runSummaries
    ? buildCyclesFromRuns(runSummaries, lookups)
    : buildCyclesFromAudit(
        auditRows.map(toChangeRow),
        lookups,
        (runLogRows ?? []).map(
          (r): RunHeartbeat => ({ evaluation_run_id: String(r.evaluation_run_id), evaluated_at: String(r.evaluated_at) }),
        ),
      );
  const problems = await loadPushProblems(supabase, hotelId, roomTypeNames, oldestShownRun(cycles));
  return mergeTimeline(cycles, problems);
}

/**
 * The hotel's rate push incidents the owner is meant to see, newest first,
 * with their cells and newest tries. Live hotels only: nothing is pushed in
 * simulation. Ongoing ones always; resolved ones only if they ended within
 * the runs shown (`since`, the oldest run's instant). Read under the caller's
 * session; RLS only returns incidents marked customer-visible, and the
 * filters below say the same thing. A database without the incident tables
 * yet has nothing to show.
 *
 * Never fails the change log. The problems sit beside the pricing runs, and a
 * read that errors here is logged and shows none rather than hiding the runs.
 */
async function loadPushProblems(
  supabase: SupabaseClient,
  hotelId: string,
  roomTypeNames: Map<string, string>,
  since: string | null,
): Promise<ChangelogPushProblem[]> {
  try {
    return await readPushProblems(supabase, hotelId, roomTypeNames, since);
  } catch (e) {
    const message = e instanceof Error ? e.message : String((e as { message?: unknown } | null)?.message ?? e);
    console.error(JSON.stringify({ fn: "api/changelog", step: "push_problems", hotelId, error: message.slice(0, 300) }));
    return [];
  }
}

async function readPushProblems(
  supabase: SupabaseClient,
  hotelId: string,
  roomTypeNames: Map<string, string>,
  since: string | null,
): Promise<ChangelogPushProblem[]> {
  const { data: settings, error: settingsErr } = await supabase
    .from("hotel_settings")
    .select("simulation_mode")
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (settingsErr) throw settingsErr;
  if (settings?.simulation_mode !== false) return [];

  const visible = () =>
    supabase
      .from("rate_push_incidents")
      .select("id, pms_type, cause, opened_at, attempt_count, attempts_stored, resolved_at, resolution")
      .eq("hotel_id", hotelId)
      .eq("admin_only", false)
      .not("customer_visible_at", "is", null);
  // Two plain reads rather than one with an or(): a timestamp inside or() needs quoting.
  const [ongoingRead, endedRead] = await Promise.all([
    visible().is("resolved_at", null).order("opened_at", { ascending: false }).limit(MAX_PUSH_PROBLEMS),
    since
      ? visible().gte("resolved_at", since).order("opened_at", { ascending: false }).limit(MAX_PUSH_PROBLEMS)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const error = ongoingRead.error ?? endedRead.error;
  if (error) {
    if (isMissingRelationError(error)) return [];
    throw error;
  }
  const incidents = [...(ongoingRead.data ?? []), ...(endedRead.data ?? [])]
    .sort((a, b) => (String(a.opened_at) < String(b.opened_at) ? 1 : String(a.opened_at) > String(b.opened_at) ? -1 : 0))
    .slice(0, MAX_PUSH_PROBLEMS);
  if (incidents.length === 0) return [];

  const ids = incidents.map((i) => String(i.id));
  const cells: IncidentCellForLog[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error: cellsErr } = await supabase
      .from("rate_push_incident_cells")
      .select("incident_id, room_type_id, stay_date, state")
      .in("incident_id", ids)
      .order("incident_id", { ascending: true })
      .order("stay_date", { ascending: true })
      .order("room_type_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (cellsErr) throw cellsErr;
    const rows = (data ?? []) as Record<string, unknown>[];
    for (const r of rows) {
      cells.push({
        incident_id: String(r.incident_id),
        room_type_id: String(r.room_type_id),
        stay_date: String(r.stay_date),
        state: String(r.state),
      });
    }
    if (rows.length < PAGE) break;
  }
  // The newest tries of each, read per incident so each read walks its own
  // (incident_id, attempted_at) index and stops at the cap. The rest are
  // counted on the incident, not listed.
  const attempts: IncidentAttemptForLog[] = [];
  const reads = await Promise.all(
    ids.map((id) =>
      supabase
        .from("rate_push_attempts")
        .select("incident_id, attempted_at, stay_date, room_type_id, phase, outcome, http_status, message")
        .eq("incident_id", id)
        .order("attempted_at", { ascending: false })
        .limit(MAX_TRIES_READ),
    ),
  );
  for (const { data, error: attemptsErr } of reads) {
    if (attemptsErr) throw attemptsErr;
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      attempts.push({
        incident_id: String(r.incident_id),
        attempted_at: String(r.attempted_at),
        stay_date: String(r.stay_date),
        room_type_id: String(r.room_type_id),
        phase: String(r.phase),
        outcome: String(r.outcome),
        http_status: r.http_status != null ? Number(r.http_status) : null,
        message: r.message != null ? String(r.message) : null,
      });
    }
  }

  const shaped: IncidentForLog[] = incidents.map((i) => ({
    id: String(i.id),
    pms_type: String(i.pms_type),
    cause: String(i.cause),
    opened_at: String(i.opened_at),
    attempt_count: Number(i.attempt_count) || 0,
    attempts_stored: Number(i.attempts_stored) || 0,
    resolved_at: i.resolved_at != null ? String(i.resolved_at) : null,
    resolution: i.resolution != null ? String(i.resolution) : null,
  }));
  return buildPushProblems(shaped, cells, attempts, roomTypeNames);
}

/**
 * The hotel's room types with whether each counts as a room, or without it on
 * a database that has not had that column added yet.
 */
async function loadRoomTypes(supabase: SupabaseClient, hotelId: string) {
  const withFlag = await supabase.from("room_types").select("id, name, counts_as_room").eq("hotel_id", hotelId);
  if (!withFlag.error) return withFlag;
  return supabase.from("room_types").select("id, name").eq("hotel_id", hotelId);
}

/**
 * Display names for whoever typed a manual price in these rows, so the
 * narration can say who instead of "a manager". Names are cosmetic: a
 * failed or empty lookup falls back rather than failing the change log.
 *
 * Looked up on the service role: profiles is self-select only under RLS, so
 * through the caller's own client every teammate's price reads "A manager"
 * and only the setter ever sees their own name. The ids here come off audit
 * rows the caller can already read for this hotel, so the service role only
 * turns an id they already hold into a name.
 */
async function setterNamesFor(
  supabase: SupabaseClient,
  auditRows: { details: unknown }[],
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const r of auditRows) {
    const setBy = manualOverrideFor(r.details as AuditChangeRow["details"])?.set_by;
    if (setBy) ids.add(setBy);
  }
  const names = new Map<string, string>();
  if (ids.size === 0) return names;

  const reader = isAdminConfigured() ? createAdminClient() : supabase;
  const { data } = await reader.from("profiles").select("id, full_name").in("id", [...ids]);
  for (const p of data ?? []) {
    const name = typeof p.full_name === "string" ? p.full_name.trim() : "";
    if (name) names.set(String(p.id), name);
  }
  return names;
}
