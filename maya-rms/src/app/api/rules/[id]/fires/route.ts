import { NOT_READY_YET, dbErrorResponse } from "@/lib/api-guards";
import { currencySymbolFor, measuredRoomTypeNames } from "@/lib/changelog-route-helpers";
import { isMissingFunctionError } from "@/lib/engine/snapshots";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { loadModeTimeline, loadPmsType, sendFactsFor } from "@/lib/price-mode-load";
import { ruleFireCounts } from "@/lib/rule-fire-counts";
import {
  FIRE_LOG_DAYS,
  FIRE_LOG_MIGRATION,
  FIRE_LOG_PAGE,
  buildFireItem,
  decodeCursor,
  encodeCursor,
  ledgerCells,
  type FireLogRow,
  type FireLogRule,
  type RuleFireLogResponse,
} from "@/lib/rule-fire-log";
import { hotelToday } from "@/lib/simulator";
import type { RuleCondition } from "@/types/domain";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

type Params = { params: Promise<{ id: string }> };

const RULE_COLUMNS = `id, name, is_active, version,
  rule_condition (
    occupancy_operator, occupancy_threshold,
    dta_operator, dta_threshold_days,
    pickup_operator, pickup_threshold, pickup_window_days, pickup_metric,
    booking_speed_operator, booking_speed_level, booking_speed_window_days
  ),
  rule_signal_room_type ( room_type_id ),
  rule_affected_room_type ( room_type_id )`;

let loggedMissing = false;

/**
 * GET /api/rules/:id/fires: one page of a rule's fire log, newest first, for
 * the popup behind the rules list's "12×" (src/lib/rule-fire-log.ts).
 * `?older=` is the cursor the page before handed out. The first page also
 * carries the rule's count from rule_fire_counts, which reads the same fires
 * as the log, so the popup can put the list's number right if a fire landed
 * since the list loaded.
 *
 * Read under the caller's session, like the count: anyone the property is
 * accessible to (its members, a platform admin viewing it). The popup has
 * nothing to change, so a read-only role sees it as everyone does. The send
 * ledger is read with the service role, as the change log reads it, once
 * the rule was found on the caller's property.
 */
export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  if (!isSupabaseConfigured()) {
    // Demo mode: the counts are empty, so nothing opens this.
    const empty: RuleFireLogResponse = { rule: { id, name: "", enabled: true }, total: 0, days: FIRE_LOG_DAYS, fires: [], older: null };
    return NextResponse.json(empty);
  }

  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const hotelId = await resolveAccessibleHotelId(supabase);
  if (!hotelId) return NextResponse.json({ error: "No hotel" }, { status: 400 });

  const olderParam = new URL(req.url).searchParams.get("older");
  const before = olderParam ? decodeCursor(olderParam) : null;
  if (olderParam && !before) return NextResponse.json({ error: "That page link isn't valid." }, { status: 400 });

  try {
    const { data: ruleRow, error: ruleErr } = await supabase
      .from("pricing_rules")
      .select(RULE_COLUMNS)
      .eq("id", id)
      .eq("hotel_id", hotelId)
      .maybeSingle();
    if (ruleErr) throw ruleErr;
    if (!ruleRow) return NextResponse.json({ error: "Rule not found." }, { status: 404 });

    const [log, hotelRead, roomRead, modeTimeline, pmsType, counts] = await Promise.all([
      supabase.rpc("rule_fire_log", {
        p_hotel_id: hotelId,
        p_rule_id: id,
        p_before_at: before?.at ?? null,
        p_before_key: before?.key ?? null,
        p_limit: FIRE_LOG_PAGE + 1,
      }),
      supabase.from("hotels").select("currency, timezone").eq("id", hotelId).maybeSingle(),
      loadRoomTypes(supabase, hotelId),
      loadModeTimeline(supabase, hotelId, "api/rules/fires"),
      loadPmsType(supabase, hotelId),
      before ? Promise.resolve(null) : ruleFireCounts(supabase, hotelId),
    ]);
    if (log.error) {
      if (!isMissingFunctionError(log.error)) throw log.error;
      if (!loggedMissing) {
        loggedMissing = true;
        console.error(
          JSON.stringify({
            fn: "api/rules/fires",
            schema: "pre-migration",
            message: `rule_fire_log does not exist yet. Run ${FIRE_LOG_MIGRATION}.`,
            migration: FIRE_LOG_MIGRATION,
          }),
        );
      }
      return NextResponse.json({ error: NOT_READY_YET }, { status: 503 });
    }

    const rows = (log.data ?? []) as FireLogRow[];
    const page = rows.slice(0, FIRE_LOG_PAGE);
    const last = page[page.length - 1];
    const older = rows.length > FIRE_LOG_PAGE && last ? encodeCursor({ at: String(last.fired_at), key: String(last.sort_key) }) : null;

    const hotel = hotelRead.data as { currency?: unknown; timezone?: unknown } | null;
    const timezone = String(hotel?.timezone ?? "UTC");
    const roomTypes = (roomRead.data ?? []) as { id: unknown; name: unknown; counts_as_room?: unknown }[];
    const roomTypeNames = new Map(roomTypes.map((r) => [String(r.id), String(r.name)]));
    // Before the counts_as_room migration every room type counts, as in the change log.
    const countingRoomTypeIds = roomTypes.some((r) => "counts_as_room" in r)
      ? new Set(roomTypes.filter((r) => r.counts_as_room !== false).map((r) => String(r.id)))
      : undefined;
    const now = new Date();
    const sendFacts = await sendFactsFor(
      { hotelId, pmsType, today: hotelToday(timezone, now), now },
      ledgerCells(page, modeTimeline),
      "api/rules/fires",
    );

    const rule = shapeRule(ruleRow as unknown as Record<string, unknown>, roomTypeNames, countingRoomTypeIds);
    const body: RuleFireLogResponse = {
      rule: { id: rule.id, name: rule.name, enabled: rule.enabled },
      total: counts ? (counts[id] ?? 0) : null,
      days: FIRE_LOG_DAYS,
      fires: page.map((row) =>
        buildFireItem(row, {
          rule,
          roomTypeNames,
          currencySymbol: currencySymbolFor(hotel?.currency ? String(hotel.currency) : null),
          timezone,
          modeTimeline,
          pmsType,
          sendFacts,
          now,
        }),
      ),
      older,
    };
    return NextResponse.json(body);
  } catch (error) {
    const { status, message } = dbErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
}

/** The rule as the log words it: its condition now, and what it measures when that is not what it changes. */
function shapeRule(row: Record<string, unknown>, roomTypeNames: Map<string, string>, countingRoomTypeIds?: Set<string>): FireLogRule {
  const idsOf = (rows: unknown) =>
    Array.isArray(rows) ? rows.map((r) => String((r as { room_type_id: unknown }).room_type_id)) : [];
  const rc = (Array.isArray(row.rule_condition) ? row.rule_condition[0] : row.rule_condition) as Record<string, unknown> | null | undefined;
  const n = (v: unknown) => (v != null ? Number(v) : null);
  const condition: RuleCondition | null = rc
    ? {
        occupancy_operator: (rc.occupancy_operator as RuleCondition["occupancy_operator"]) ?? null,
        occupancy_threshold: n(rc.occupancy_threshold),
        dta_operator: (rc.dta_operator as RuleCondition["dta_operator"]) ?? null,
        dta_threshold_days: n(rc.dta_threshold_days),
        pickup_operator: (rc.pickup_operator as RuleCondition["pickup_operator"]) ?? null,
        pickup_threshold: n(rc.pickup_threshold),
        pickup_window_days: n(rc.pickup_window_days) as RuleCondition["pickup_window_days"],
        pickup_metric: (rc.pickup_metric as RuleCondition["pickup_metric"]) ?? null,
        booking_speed_operator: (rc.booking_speed_operator as RuleCondition["booking_speed_operator"]) ?? null,
        booking_speed_level: rc.booking_speed_level != null ? String(rc.booking_speed_level) : null,
        booking_speed_window_days: n(rc.booking_speed_window_days) as RuleCondition["booking_speed_window_days"],
      }
    : null;
  const id = String(row.id);
  const measured = measuredRoomTypeNames(id, {
    ruleRoomSets: new Map([[id, { signal: idsOf(row.rule_signal_room_type), affected: idsOf(row.rule_affected_room_type) }]]),
    roomTypeNames,
    countingRoomTypeIds,
  });
  return {
    id,
    name: String(row.name ?? ""),
    enabled: row.is_active !== false,
    version: Number(row.version ?? 1),
    condition,
    measured,
  };
}

/** The property's room types, with whether each counts as a room where the column exists yet. */
async function loadRoomTypes(supabase: ReturnType<typeof createClient>, hotelId: string) {
  const withFlag = await supabase.from("room_types").select("id, name, counts_as_room").eq("hotel_id", hotelId);
  if (!withFlag.error) return withFlag;
  return supabase.from("room_types").select("id, name").eq("hotel_id", hotelId);
}
