/**
 * An in-memory stand-in for rule_fire_log (and the rule_fires it reads), from
 * 99_supabase_migration_rule_fire_log_v1.sql, written straight from the SQL
 * so the fire log route can run against fakeSupabase. The SQL itself is
 * checked in PGlite (rule-fire-log-migration-sql.test.ts); rule_fire_counts'
 * model is ruleFireCounts in engine/scale-rpc-model.test.ts, over the same
 * window.
 */
import { describe, expect, it } from "vitest";
import type { FakeRow } from "@/lib/engine/fake-supabase.test";
import { inFireWindow } from "@/lib/engine/scale-rpc-model.test";

type Fire = { kind: string; event_id: string; rule_id: string; fired_at: string; stay_date: string; room_type_id: string; sort_key: string; row: FakeRow };

const ms = (v: unknown) => Date.parse(String(v));

/** rule_fires(p_hotel_id, p_rule_id) */
export function ruleFires(tables: Record<string, FakeRow[]>, hotelId: unknown, ruleId: unknown = null): Fire[] {
  const out: Fire[] = [];
  for (const e of tables.ladder_transition_event ?? []) {
    if (e.hotel_id !== hotelId || e.transition !== "activate" || !inFireWindow(e.transitioned_at)) continue;
    if (ruleId != null && e.rule_id !== ruleId) continue;
    const stay = String(e.stay_date).slice(0, 10);
    out.push({
      kind: "ladder",
      event_id: String(e.id),
      rule_id: String(e.rule_id),
      fired_at: String(e.transitioned_at),
      stay_date: stay,
      room_type_id: String(e.room_type_id),
      sort_key: `${stay}|${e.room_type_id}|ladder|${e.id}`,
      row: e,
    });
  }
  for (const p of tables.pickup_event ?? []) {
    if (p.hotel_id !== hotelId || p.retired_reason === "self_cancelled" || !inFireWindow(p.applied_at)) continue;
    if (ruleId != null && p.rule_id !== ruleId) continue;
    const stay = String(p.stay_date).slice(0, 10);
    out.push({
      kind: "pickup",
      event_id: String(p.id),
      rule_id: String(p.rule_id),
      fired_at: String(p.applied_at),
      stay_date: stay,
      room_type_id: String(p.affected_room_type_id),
      sort_key: `${stay}|${p.affected_room_type_id}|pickup|${p.id}`,
      row: p,
    });
  }
  return out;
}

/** rule_fire_log(p_hotel_id, p_rule_id, p_before_at, p_before_key, p_limit) */
export function ruleFireLog(tables: Record<string, FakeRow[]>, a: Record<string, unknown>): FakeRow[] {
  const beforeAt = a.p_before_at != null ? ms(a.p_before_at) : null;
  const beforeKey = String(a.p_before_key ?? "");
  const limit = Math.max(1, Math.min(Number(a.p_limit ?? 25), 101));
  const page = ruleFires(tables, a.p_hotel_id, a.p_rule_id)
    .filter((f) => beforeAt == null || ms(f.fired_at) < beforeAt || (ms(f.fired_at) === beforeAt && f.sort_key > beforeKey))
    .sort((x, y) => ms(y.fired_at) - ms(x.fired_at) || (x.sort_key < y.sort_key ? -1 : x.sort_key > y.sort_key ? 1 : 0))
    .slice(0, limit);
  const audit = (tables.evaluation_audit ?? []).filter((r) => r.hotel_id === a.p_hotel_id);
  const cell = (f: Fire) => audit.filter((r) => String(r.stay_date).slice(0, 10) === f.stay_date && String(r.room_type_id) === f.room_type_id);
  return page.map((f) => {
    const rows = cell(f);
    const at = ms(f.fired_at);
    const own = rows.find((r) => ms(r.evaluated_at) === at) ?? null;
    const before = rows.filter((r) => ms(r.evaluated_at) < at).sort((x, y) => ms(y.evaluated_at) - ms(x.evaluated_at))[0] ?? null;
    const newer = rows.filter((r) => ms(r.evaluated_at) > at).sort((x, y) => ms(x.evaluated_at) - ms(y.evaluated_at))[0] ?? null;
    const details = (own?.details ?? null) as Record<string, unknown> | null;
    const won = ((details?.pickup_candidates ?? []) as Record<string, unknown>[]).find((c) => c.rule_id === a.p_rule_id && c.outcome === "won");
    const e = f.row;
    let endedAt: unknown = null;
    let endedReason: unknown = null;
    if (f.kind === "ladder") {
      const next = (tables.ladder_transition_event ?? [])
        .filter(
          (x) =>
            x.hotel_id === a.p_hotel_id &&
            x.rule_id === a.p_rule_id &&
            String(x.stay_date).slice(0, 10) === f.stay_date &&
            String(x.room_type_id) === f.room_type_id &&
            ms(x.transitioned_at) > at,
        )
        .sort((x, y) => ms(x.transitioned_at) - ms(y.transitioned_at))[0];
      if (next) {
        endedAt = next.transitioned_at;
        endedReason = next.transition === "deactivate" ? "came_off" : "replaced";
      }
    } else {
      endedAt = e.retired_at ?? null;
      endedReason = e.retired_reason ?? null;
    }
    const state =
      f.kind === "ladder"
        ? (tables.ladder_rule_state ?? []).find(
            (s) =>
              s.rule_id === a.p_rule_id &&
              String(s.stay_date).slice(0, 10) === f.stay_date &&
              String(s.room_type_id) === f.room_type_id &&
              ms(s.activated_at) === at &&
              s.suppressed_at != null,
          )
        : undefined;
    const stops = (tables.rule_repeat_alert_nights ?? [])
      .filter(
        (r) =>
          r.rule_id === a.p_rule_id &&
          r.hotel_id === a.p_hotel_id &&
          String(r.stay_date).slice(0, 10) === f.stay_date &&
          r.choice === "stop" &&
          ms(r.chosen_at) > at,
      )
      .map((r) => String(r.chosen_at))
      .sort((x, y) => ms(x) - ms(y));
    return {
      kind: f.kind,
      event_id: f.event_id,
      sort_key: f.sort_key,
      fired_at: f.fired_at,
      stay_date: f.stay_date,
      room_type_id: f.room_type_id,
      rule_version: e.rule_version ?? 1,
      action_kind: e.action_kind,
      action_direction: e.action_direction,
      action_value: e.action_value,
      fire_seq: f.kind === "pickup" ? (e.fire_seq ?? null) : null,
      metrics: f.kind === "ladder" ? (e.metrics_snapshot ?? null) : ((won?.metrics as unknown) ?? null),
      own_numbers:
        f.kind === "pickup"
          ? {
              units_start: e.signal_booked_units_start ?? null,
              units_end: e.signal_booked_units_end ?? null,
              window_bookings: e.window_bookings_at_fire ?? null,
              window_expected: e.window_expected_at_fire ?? null,
            }
          : null,
      price_before: before?.final_price ?? null,
      price_after: own?.final_price ?? null,
      clamped_by: details?.clamped_by ?? null,
      newer_row_at: newer?.evaluated_at ?? null,
      ended_at: endedAt,
      ended_reason: endedReason,
      suppressed_at: state?.suppressed_at ?? null,
      stopped_at: stops[0] ?? null,
    };
  });
}

/** An rpc handler for fakeSupabase: rule_fire_log from the fake's own tables, or null for any other function. */
export function ruleFireLogRpc(fn: string, args: unknown, tables: Record<string, FakeRow[]>): unknown {
  return fn === "rule_fire_log" ? ruleFireLog(tables, args as Record<string, unknown>) : null;
}

describe("rule_fire_log model", () => {
  const H = "h1";
  const R = "r1";
  const tables: Record<string, FakeRow[]> = {
    ladder_transition_event: [
      { id: "l1", hotel_id: H, rule_id: R, stay_date: "2027-01-02", room_type_id: "q", transition: "activate", transitioned_at: new Date().toISOString() },
      { id: "l2", hotel_id: H, rule_id: R, stay_date: "2027-01-01", room_type_id: "q", transition: "activate", transitioned_at: new Date().toISOString() },
      { id: "l3", hotel_id: H, rule_id: R, stay_date: "2027-01-03", room_type_id: "q", transition: "activate", transitioned_at: "2020-01-01T00:00:00Z" },
    ],
    pickup_event: [{ id: "p1", hotel_id: H, rule_id: R, stay_date: "2027-01-01", affected_room_type_id: "q", applied_at: "2020-01-01T00:00:00Z" }],
  };

  it("leaves out fires older than 90 days, and orders a run's fires by night", () => {
    const rows = ruleFireLog(tables, { p_hotel_id: H, p_rule_id: R, p_limit: 10 });
    expect(rows.map((r) => r.event_id)).toEqual(["l2", "l1"]);
  });

  it("pages on the instant and the sort key together", () => {
    const [first] = ruleFireLog(tables, { p_hotel_id: H, p_rule_id: R, p_limit: 1 });
    const next = ruleFireLog(tables, { p_hotel_id: H, p_rule_id: R, p_limit: 1, p_before_at: first.fired_at, p_before_key: first.sort_key });
    expect(next.map((r) => r.event_id)).toEqual(["l1"]);
  });
});
