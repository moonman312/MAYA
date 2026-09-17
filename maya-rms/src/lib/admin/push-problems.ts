import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingRelationError } from "@/lib/engine/snapshots";
import { causeFacts, pmsName } from "../../../supabase/functions/_shared/pms/push-failure";

/**
 * The "Rate push problems" panel: how often each reason a rate did not reach
 * the PMS came up in the range, how it ended, and which hotels have one open
 * right now.
 *
 * Read with the service role from rate_push_incidents (see
 * 99_supabase_migration_push_guardrails_v1.sql, section 3) and aggregated
 * here, the way analytics.ts does the revenue half. Test properties are left
 * out unless the page's toggle includes them. A deployment ahead of its
 * migration has no incident tables yet, and the panel says so in one line.
 */

export type PushIncidentRow = {
  id: string;
  hotel_id: string;
  pms_type: string;
  cause: string;
  opened_at: string;
  attempt_count: number;
  customer_visible_at: string | null;
  resolved_at: string | null;
  resolution: string | null;
};

export type PushProblemCause = {
  cause: string;
  /** False when the classifier could not name the root cause. */
  known: boolean;
  /** A guardrail: MAYA's own hold, never shown to owners. */
  guardrail: boolean;
  /** A guardrail that should not fire unless MAYA published a bad row. */
  mayaBug: boolean;
  description: string;
  incidents: number;
  attempts: number;
  hotels: number;
  /** Closed with every cell landing before an owner was ever shown it. */
  resolvedByRetry: number;
  escalated: number;
  open: number;
  /** Median hours from opening to the cells landing, over incidents that closed that way. */
  medianHoursToLand: number | null;
  /** Unknown causes only: what the PMS actually said, most frequent first. */
  sampleMessages: string[];
};

export type OpenPushProblem = {
  incidentId: string;
  hotelId: string;
  hotelName: string;
  pms: string;
  cause: string;
  known: boolean;
  openedAt: string;
  attempts: number;
  shownToOwner: boolean;
};

export type PushProblemAnalytics =
  | { available: false; reason: string }
  | { available: true; causes: PushProblemCause[]; open: OpenPushProblem[] };

const INCIDENT_COLUMNS =
  "id, hotel_id, pms_type, cause, opened_at, attempt_count, customer_visible_at, resolved_at, resolution";
/** Unknown-cause messages read per range, and shown per cause. */
const SAMPLE_READ_LIMIT = 1000;
const SAMPLES_SHOWN = 5;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Per cause, most incidents first; unknown causes lead a tie so they get taught. */
export function aggregatePushProblems(
  incidents: PushIncidentRow[],
  messagesByIncident: Map<string, string[]> = new Map(),
): PushProblemCause[] {
  const byCause = new Map<string, PushIncidentRow[]>();
  for (const i of incidents) {
    const list = byCause.get(i.cause) ?? [];
    list.push(i);
    byCause.set(i.cause, list);
  }
  const rows: PushProblemCause[] = [];
  for (const [cause, list] of byCause) {
    const facts = causeFacts(cause);
    const landedHours = list
      .filter((i) => i.resolution === "landed" && i.resolved_at)
      .map((i) => (Date.parse(String(i.resolved_at)) - Date.parse(i.opened_at)) / 3_600_000)
      .filter((h) => Number.isFinite(h) && h >= 0);
    const counts = new Map<string, number>();
    if (!facts.known) {
      for (const i of list) {
        for (const m of messagesByIncident.get(i.id) ?? []) counts.set(m, (counts.get(m) ?? 0) + 1);
      }
    }
    rows.push({
      cause,
      known: facts.known,
      guardrail: facts.adminOnly,
      mayaBug: facts.mayaBug,
      description: facts.adminDescription,
      incidents: list.length,
      attempts: list.reduce((sum, i) => sum + (Number(i.attempt_count) || 0), 0),
      hotels: new Set(list.map((i) => i.hotel_id)).size,
      resolvedByRetry: list.filter((i) => i.resolution === "landed" && !i.customer_visible_at).length,
      escalated: list.filter((i) => i.customer_visible_at).length,
      open: list.filter((i) => !i.resolved_at).length,
      medianHoursToLand: median(landedHours),
      sampleMessages: [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, SAMPLES_SHOWN)
        .map(([m]) => m),
    });
  }
  return rows.sort((a, b) => b.incidents - a.incidents || Number(a.known) - Number(b.known) || (a.cause < b.cause ? -1 : 1));
}

async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string; code?: string } | null }>,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export async function loadPushProblemAnalytics(
  admin: SupabaseClient,
  from: string,
  to: string,
  includeTest: boolean,
): Promise<PushProblemAnalytics> {
  try {
    const hotels = await pageAll<{ id: string; name: string; is_test: boolean | null }>((a, z) => {
      let q = admin.from("hotels").select("id, name, is_test");
      if (!includeTest) q = q.eq("is_test", false);
      return q.order("id", { ascending: true }).range(a, z);
    });
    const nameById = new Map(hotels.map((h) => [String(h.id), String(h.name)]));

    const inRange = (
      await pageAll<PushIncidentRow>((a, z) =>
        admin
          .from("rate_push_incidents")
          .select(INCIDENT_COLUMNS)
          .gte("opened_at", `${from}T00:00:00Z`)
          .lt("opened_at", `${nextDay(to)}T00:00:00Z`)
          .order("opened_at", { ascending: true })
          .order("id", { ascending: true })
          .range(a, z),
      )
    ).filter((i) => nameById.has(String(i.hotel_id)));

    const openNow = (
      await pageAll<PushIncidentRow>((a, z) =>
        admin
          .from("rate_push_incidents")
          .select(INCIDENT_COLUMNS)
          .is("resolved_at", null)
          .order("opened_at", { ascending: true })
          .order("id", { ascending: true })
          .range(a, z),
      )
    ).filter((i) => nameById.has(String(i.hotel_id)));

    const messages = new Map<string, string[]>();
    const unknownIds = inRange.filter((i) => !causeFacts(i.cause).known).map((i) => i.id).slice(0, 200);
    if (unknownIds.length > 0) {
      const { data, error } = await admin
        .from("rate_push_attempts")
        .select("incident_id, message")
        .in("incident_id", unknownIds)
        .not("message", "is", null)
        .order("attempted_at", { ascending: false })
        .limit(SAMPLE_READ_LIMIT);
      if (error) throw error;
      for (const r of (data ?? []) as { incident_id: string; message: string | null }[]) {
        if (!r.message) continue;
        const list = messages.get(String(r.incident_id)) ?? [];
        list.push(String(r.message));
        messages.set(String(r.incident_id), list);
      }
    }

    return {
      available: true,
      causes: aggregatePushProblems(inRange, messages),
      open: openNow.map((i) => ({
        incidentId: i.id,
        hotelId: i.hotel_id,
        hotelName: nameById.get(String(i.hotel_id)) ?? i.hotel_id,
        pms: pmsName(i.pms_type),
        cause: i.cause,
        known: causeFacts(i.cause).known,
        openedAt: i.opened_at,
        attempts: Number(i.attempt_count) || 0,
        shownToOwner: i.customer_visible_at != null,
      })),
    };
  } catch (e) {
    if (isMissingRelationError(e)) {
      return { available: false, reason: "Run 99_supabase_migration_push_guardrails_v1.sql to see rate push problems." };
    }
    throw e instanceof Error ? e : new Error(`rate push problems: ${(e as { message?: string }).message ?? String(e)}`);
  }
}
