/**
 * GET /api/changelog — recent evaluation cycles as a human-readable change log.
 *
 * With Supabase configured and a resolvable hotel, cycles are rebuilt from
 * evaluation_audit rows (the 10 most recent runs) and narrated via
 * changelog-narrative. Without Supabase — or on any Supabase failure — the
 * demo changelog is served instead of a 500.
 */

import {
  type AuditChangeRow,
  type ChangelogLookups,
  type RuleLookupEntry,
  buildCyclesFromAudit,
  currencySymbolFor,
} from "@/lib/changelog-route-helpers";
import { buildChangelog } from "@/lib/demo-data";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import type { RuleCondition } from "@/types/domain";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const AUDIT_ROW_LIMIT = 600;

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(buildChangelog());
  }

  try {
    const supabase = createClient(await cookies());
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const hotelId = await resolveAccessibleHotelId(supabase);
    if (!hotelId) {
      return NextResponse.json(buildChangelog());
    }

    return NextResponse.json(await buildRealChangelog(supabase, hotelId));
  } catch {
    return NextResponse.json(buildChangelog());
  }
}

async function buildRealChangelog(supabase: SupabaseClient, hotelId: string) {
  const { data: auditRows, error: auditErr } = await supabase
    .from("evaluation_audit")
    .select(
      "evaluation_run_id, stay_date, room_type_id, evaluated_at, base_price, final_price, pre_clamp_price, floor_price, ceiling_price, details",
    )
    .eq("hotel_id", hotelId)
    .order("evaluated_at", { ascending: false })
    .limit(AUDIT_ROW_LIMIT);

  if (auditErr) throw new Error(auditErr.message);

  const [{ data: hotel }, { data: roomTypes }, { data: rules }] =
    await Promise.all([
      supabase.from("hotels").select("currency").eq("id", hotelId).maybeSingle(),
      supabase.from("room_types").select("id, name").eq("hotel_id", hotelId),
      supabase
        .from("pricing_rules")
        .select(
          `id, name, action_type, action_direction, action_value, is_pickup_rule,
           rule_condition (
             occupancy_operator, occupancy_threshold,
             dta_operator, dta_threshold_days,
             pickup_operator, pickup_threshold, pickup_window_days, pickup_metric
           )`,
        )
        .eq("hotel_id", hotelId),
    ]);

  const roomTypeNames = new Map<string, string>(
    (roomTypes ?? []).map((rt) => [String(rt.id), String(rt.name)]),
  );

  const ruleLookup = new Map<string, RuleLookupEntry>();
  const conditionLookup = new Map<string, RuleCondition>();
  for (const rule of rules ?? []) {
    const id = String(rule.id);
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
      });
    }
  }

  const lookups: ChangelogLookups = {
    roomTypeNames,
    rules: ruleLookup,
    conditions: conditionLookup,
    currencySymbol: currencySymbolFor(hotel?.currency ? String(hotel.currency) : null),
  };

  const rows: AuditChangeRow[] = (auditRows ?? []).map((r) => ({
    evaluation_run_id: String(r.evaluation_run_id),
    stay_date: String(r.stay_date),
    room_type_id: String(r.room_type_id),
    evaluated_at: String(r.evaluated_at),
    base_price: Number(r.base_price),
    final_price: Number(r.final_price),
    pre_clamp_price: Number(r.pre_clamp_price),
    floor_price: Number(r.floor_price),
    ceiling_price: Number(r.ceiling_price),
    details: r.details,
  }));

  return buildCyclesFromAudit(rows, lookups);
}
