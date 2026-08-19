/**
 * Golden-equivalence fixture for evaluateHotel: an in-memory Supabase fake
 * plus one seeded hotel that exercises every engine path in a single run
 * (ladder activate/deactivate/touch, duplicate-affected visits, pickup fire
 * + pre-existing event + past-date retirement, booking-speed blocking,
 * ceiling clamp, write-on-change skips for both published_price and audit).
 *
 * evaluate-golden.test.ts locks current behavior with this fixture; the
 * query-batching refactor must keep that test green unchanged, and may reuse
 * makeEngineSupabaseStub / makeGoldenFixture for its own tests.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type Row = Record<string, unknown>;

export type WriteLogEntry = {
  table: string;
  op: "insert" | "upsert" | "update" | "delete";
  payload: unknown;
};

export type EngineSupabaseStub = {
  supabase: SupabaseClient;
  /** Live table state — read after a run for final-state assertions. */
  tables: Record<string, Row[]>;
  /** Every mutation in execution order. */
  writeLog: WriteLogEntry[];
  /** Executed queries by "table.op" — the efficiency baseline a refactor must beat. */
  queryCounts: Record<string, number>;
};

/** Every table evaluateHotel touches; from() throws on anything else so a refactor's new query surfaces here instead of silently reading []. */
const ENGINE_TABLES = [
  "hotels",
  "room_types",
  "pricing_rules",
  "reservations",
  "stay_date_snapshot",
  "ladder_rule_state",
  "ladder_transition_event",
  "pickup_event",
  "published_price",
  "evaluation_audit",
  "evaluation_run_log",
  "hotel_closed_periods",
  "assumption_challenges",
] as const;

export function makeEngineSupabaseStub(seed: Partial<Record<string, Row[]>>): EngineSupabaseStub {
  const tables: Record<string, Row[]> = {};
  for (const t of ENGINE_TABLES) tables[t] = (seed[t] ?? []).map((r) => ({ ...r }));
  const writeLog: WriteLogEntry[] = [];
  const queryCounts: Record<string, number> = {};
  // Ids are handed out in insertion order because pricing tie-breaks
  // same-applied_at pickup effects on id; seeded rows pre-claim the low ids.
  let nextPickupId = (seed.pickup_event?.length ?? 0) + 1;

  // ISO timestamps and YYYY-MM-DD dates compare correctly as strings as long
  // as each column sticks to one format (the fixture does); numeric-looking
  // values compare as numbers so ordering by an integer id never goes "10" < "2".
  const cmp = (a: unknown, b: unknown): number => {
    if (typeof a === "number" && typeof b === "number") return a - b;
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== "" && String(b).trim() !== "") {
      return na - nb;
    }
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  };

  function from(table: string) {
    const rows = tables[table];
    if (!rows) throw new Error(`stub has no table "${table}" — a new engine query needs a seed here`);

    let op: WriteLogEntry["op"] | "select" = "select";
    let payload: Row | Row[] | null = null;
    let conflictCols: string[] | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let limitN: number | null = null;
    let rangeSpec: { from: number; to: number } | null = null;
    let settled: { data: unknown; error: null } | null = null;

    const matches = (r: Row) => filters.every((f) => f(r));

    // Mutations apply the moment the builder is awaited — the run reads its
    // own writes (ladder states feed pricing, pickup inserts feed
    // assemblePrice, the run-start snapshot feeds metrics), so deferring them
    // would test an engine that doesn't exist. Memoized so a double-await
    // can never double-apply.
    const execute = (): { data: unknown; error: null } => {
      if (settled) return settled;
      const key = `${table}.${op}`;
      queryCounts[key] = (queryCounts[key] ?? 0) + 1;

      if (op === "select") {
        let out = rows.filter(matches);
        if (orders.length > 0) {
          out = [...out].sort((a, b) => {
            for (const o of orders) {
              const c = cmp(a[o.col], b[o.col]);
              if (c !== 0) return o.asc ? c : -c;
            }
            return 0;
          });
        }
        if (rangeSpec) out = out.slice(rangeSpec.from, rangeSpec.to + 1);
        else if (limitN != null) out = out.slice(0, limitN);
        settled = { data: out.map((r) => ({ ...r })), error: null };
        return settled;
      }

      if (op === "insert") {
        const list = Array.isArray(payload) ? payload : [payload as Row];
        for (const p of list) {
          const row: Row = { ...p };
          if (table === "pickup_event" && row.id == null) row.id = String(nextPickupId++);
          rows.push(row);
        }
        writeLog.push({ table, op, payload });
      } else if (op === "upsert") {
        const list = Array.isArray(payload) ? payload : [payload as Row];
        for (const p of list) {
          const existing = conflictCols
            ? rows.find((r) => conflictCols!.every((c) => String(r[c]) === String(p[c])))
            : undefined;
          // PostgREST upsert only touches the columns present in the payload.
          if (existing) Object.assign(existing, p);
          else rows.push({ ...p });
        }
        writeLog.push({ table, op, payload });
      } else if (op === "update") {
        for (const r of rows) {
          if (matches(r)) Object.assign(r, payload as Row);
        }
        writeLog.push({ table, op, payload });
      } else {
        const removed = rows.filter(matches);
        const survivors = rows.filter((r) => !matches(r));
        rows.length = 0;
        rows.push(...survivors);
        // Filters aren't reconstructable by the caller, so the log carries
        // what actually got removed.
        writeLog.push({ table, op: "delete", payload: removed });
      }
      settled = { data: null, error: null };
      return settled;
    };

    const builder = {
      // Column lists are ignored: rows come back whole, and pricing_rules
      // rows carry their embedded resources (rule_condition,
      // rule_signal_room_type, rule_affected_room_type) as plain fields —
      // exactly the shape PostgREST's embed syntax produces.
      select: (_cols?: string) => builder,
      insert: (p: Row | Row[]) => {
        op = "insert";
        payload = p;
        return builder;
      },
      upsert: (p: Row | Row[], opts?: { onConflict?: string }) => {
        op = "upsert";
        payload = p;
        conflictCols = opts?.onConflict ? opts.onConflict.split(",").map((s) => s.trim()) : null;
        return builder;
      },
      update: (p: Row) => {
        op = "update";
        payload = p;
        return builder;
      },
      delete: () => {
        op = "delete";
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters.push((r) => String(r[col]) === String(val));
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        const set = new Set(vals.map(String));
        filters.push((r) => set.has(String(r[col])));
        return builder;
      },
      gte: (col: string, val: unknown) => {
        filters.push((r) => cmp(r[col], val) >= 0);
        return builder;
      },
      lte: (col: string, val: unknown) => {
        filters.push((r) => cmp(r[col], val) <= 0);
        return builder;
      },
      lt: (col: string, val: unknown) => {
        filters.push((r) => cmp(r[col], val) < 0);
        return builder;
      },
      is: (col: string, val: unknown) => {
        filters.push((r) => (val === null ? r[col] == null : r[col] === val));
        return builder;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orders.push({ col, asc: opts?.ascending ?? true });
        return builder;
      },
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      range: (fromIdx: number, toIdx: number) => {
        rangeSpec = { from: fromIdx, to: toIdx };
        return builder;
      },
      maybeSingle: async () => {
        const res = execute();
        const data = res.data as Row[];
        return { data: data[0] ?? null, error: null };
      },
      then: <T>(
        onFulfilled?: (v: { data: unknown; error: null }) => T,
        onRejected?: (e: unknown) => T,
      ) => Promise.resolve(execute()).then(onFulfilled, onRejected),
    };
    return builder;
  }

  return {
    supabase: { from } as unknown as SupabaseClient,
    tables,
    writeLog,
    queryCounts,
  };
}

/* ── The golden hotel ─────────────────────────────────────────── */

export const HOTEL_ID = "h1";
/** 08:00 hotel-local (America/New_York) → localDate 2026-08-19. */
export const EVAL_TS = "2026-08-19T12:00:00Z";
/** Second-run instant for the idempotency pass — same local date. */
export const EVAL_TS_RERUN = "2026-08-19T12:05:00Z";

/** The 5-day horizon evaluateHotel(…, 5) walks from EVAL_TS. */
export const D = {
  d0: "2026-08-19",
  d1: "2026-08-20",
  d2: "2026-08-21",
  d3: "2026-08-22",
  d4: "2026-08-23",
} as const;

/**
 * Baseline snapshots sit 4h before R4's window-start baseline_ts
 * (EVAL_TS − 3d) — inside metrics.ts's 12h freshness window, so pickup
 * computes instead of blocking. The pre-existing d2 event moves that date's
 * baseline_ts to its applied_at (2026-08-18T12:00Z), 52h after these rows —
 * deliberately stale, pinning the stale_baseline_snapshot block.
 */
export const BASELINE_SNAP_TS = "2026-08-16T08:00:00.000Z";
export const SEED_TS = "2026-08-18T12:00:00.000Z";

const nulls = {
  occupancy_operator: null,
  occupancy_threshold: null,
  dta_operator: null,
  dta_threshold_days: null,
  pickup_operator: null,
  pickup_threshold: null,
  pickup_window_days: null,
  pickup_metric: null,
  booking_speed_operator: null,
  booking_speed_level: null,
  booking_speed_window_days: null,
  booking_speed_cooldown_days: null,
};

const links = (ids: string[]) => ids.map((room_type_id) => ({ room_type_id }));

function ruleRow(over: Row): Row {
  return {
    hotel_id: HOTEL_ID,
    is_active: true,
    version: 1,
    start_date: null,
    end_date: null,
    is_annual: false,
    dow_mask: 127,
    is_pickup_rule: false,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    rule_signal_room_type: links(["rtA", "rtB"]),
    rule_affected_room_type: links(["rtA", "rtB"]),
    ...over,
  };
}

function stateRow(over: Row): Row {
  return {
    rule_version: 1,
    is_active: true,
    activated_at: "2026-08-15T12:00:00.000Z",
    deactivated_at: null,
    last_evaluated_at: SEED_TS,
    ...over,
  };
}

function snapRow(stay_date: string, room_type_id: string, booked_units: number, booked_revenue: number): Row {
  return {
    hotel_id: HOTEL_ID,
    snapshot_ts: BASELINE_SNAP_TS,
    stay_date,
    room_type_id,
    sellable_units: room_type_id === "rtA" ? 10 : 8,
    booked_units,
    booked_revenue,
  };
}

export function makeGoldenFixture(): EngineSupabaseStub {
  const reservations: Row[] = [];
  let nextResId = 1;
  const addRes = (
    stay_date: string,
    room_type_id: string,
    n: number,
    rate: number,
    base_rate: number = rate,
    created_at = "2026-08-10T00:00:00.000Z",
  ) => {
    for (let i = 0; i < n; i++) {
      reservations.push({
        id: nextResId++,
        hotel_id: HOTEL_ID,
        stay_date,
        room_type_id,
        base_rate,
        current_rate: rate,
        created_at,
        booking_date: "2026-08-01",
        booking_window_days: 15,
      });
    }
  };

  // Occupancy is combined over the signal set (booked / 18 sellable):
  //   d0 3/18 ≈ .17 (below every ladder threshold), d1 10/18 ≈ .56 (above
  //   both), d2 5/18 ≈ .28 (only R3's .2), d3 11/18 ≈ .61, d4 empty — and
  //   an empty d4 also has no base price, pinning the skip-unpriceable path.
  addRes(D.d0, "rtA", 1, 100, 90, "2026-08-01T00:00:00.000Z"); // stale base_rate — the later reservation must win
  addRes(D.d0, "rtA", 1, 100);
  addRes(D.d0, "rtB", 1, 80);
  addRes(D.d1, "rtA", 6, 100);
  addRes(D.d1, "rtB", 4, 80);
  addRes(D.d2, "rtA", 3, 100);
  addRes(D.d2, "rtB", 2, 80);
  addRes(D.d3, "rtA", 7, 100);
  addRes(D.d3, "rtB", 4, 80);

  return makeEngineSupabaseStub({
    hotels: [{ id: HOTEL_ID, timezone: "America/New_York" }],
    room_types: [
      // rtA's ceiling is chosen between d1's assembled 127.87 and d3's 125:
      // exactly one cell clamps.
      { id: "rtA", hotel_id: HOTEL_ID, name: "Queen", is_active: true, total_rooms: 10, floor_price: 40, ceiling_price: 126 },
      { id: "rtB", hotel_id: HOTEL_ID, name: "King", is_active: true, total_rooms: 8, floor_price: 40, ceiling_price: 200 },
    ],
    pricing_rules: [
      ruleRow({
        id: "r1", name: "High occupancy +10%", priority: 100,
        action_type: "percent", action_direction: "increase", action_value: 10,
        rule_condition: { ...nulls, occupancy_operator: "gt", occupancy_threshold: 0.5 },
      }),
      ruleRow({
        id: "r2", name: "Close-in -5%", priority: 110,
        action_type: "percent", action_direction: "decrease", action_value: 5,
        rule_condition: { ...nulls, dta_operator: "lt", dta_threshold_days: 3 },
      }),
      ruleRow({
        id: "r3", name: "Warm occupancy +$15", priority: 90,
        action_type: "fixed", action_direction: "increase", action_value: 15,
        rule_condition: { ...nulls, occupancy_operator: "gt", occupancy_threshold: 0.2 },
        // Duplicate affected row — the engine visits (rule, date, rtA) twice;
        // the second visit must land as touch, never a second activation.
        rule_affected_room_type: links(["rtA", "rtA"]),
      }),
      ruleRow({
        id: "r4", name: "Pickup surge +7%", priority: 120, is_pickup_rule: true,
        action_type: "percent", action_direction: "increase", action_value: 7,
        rule_condition: { ...nulls, pickup_operator: "gt", pickup_threshold: 2, pickup_window_days: 3, pickup_metric: "room_nights" },
      }),
      ruleRow({
        id: "r5", name: "Booking speed fast +5%", priority: 130, is_pickup_rule: true,
        action_type: "percent", action_direction: "increase", action_value: 5,
        rule_condition: { ...nulls, booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7 },
      }),
      // Disabled: the engine's is_active filter must drop it at load, which
      // is what freezes (not undoes) its pre-seeded active state below.
      ruleRow({
        id: "r6", name: "Paused +$20", priority: 80, is_active: false,
        action_type: "fixed", action_direction: "increase", action_value: 20,
      }),
    ],
    reservations,
    stay_date_snapshot: [
      snapRow(D.d0, "rtA", 2, 200), snapRow(D.d0, "rtB", 1, 80),   // = current → no pickup
      snapRow(D.d1, "rtA", 4, 400), snapRow(D.d1, "rtB", 3, 240),  // 7 → 10 booked = +3 > 2 → R4 fires
      snapRow(D.d2, "rtA", 3, 300), snapRow(D.d2, "rtB", 2, 160),  // unread: d2's baseline blocks as stale
      snapRow(D.d3, "rtA", 7, 700), snapRow(D.d3, "rtB", 4, 320),  // = current → no pickup
      snapRow(D.d4, "rtA", 0, 0), snapRow(D.d4, "rtB", 0, 0),
    ],
    ladder_rule_state: [
      // R1 active on d2 where occupancy has since fallen → deactivate.
      stateRow({ rule_id: "r1", stay_date: D.d2, room_type_id: "rtA", action_kind: "percent", action_direction: "increase", action_value: 10 }),
      stateRow({ rule_id: "r1", stay_date: D.d2, room_type_id: "rtB", action_kind: "percent", action_direction: "increase", action_value: 10 }),
      // R1 active on d3 where occupancy still holds → touch, stays active.
      stateRow({ rule_id: "r1", stay_date: D.d3, room_type_id: "rtA", action_kind: "percent", action_direction: "increase", action_value: 10 }),
      stateRow({ rule_id: "r1", stay_date: D.d3, room_type_id: "rtB", action_kind: "percent", action_direction: "increase", action_value: 10 }),
      // Disabled R6's frozen state: prices d2 rtB, and no pass may touch it.
      stateRow({ rule_id: "r6", stay_date: D.d2, room_type_id: "rtB", action_kind: "fixed", action_direction: "increase", action_value: 20 }),
    ],
    pickup_event: [
      {
        // Past stay date → the end-of-run sweep must set retired_at.
        id: "1", hotel_id: HOTEL_ID, rule_id: "r4", rule_version: 1,
        stay_date: "2026-08-18", affected_room_type_id: "rtA",
        baseline_start_ts: "2026-08-14T12:00:00.000Z", baseline_end_ts: "2026-08-17T12:00:00.000Z",
        signal_booked_units_start: 5, signal_booked_units_end: 8,
        signal_booked_revenue_start: 500, signal_booked_revenue_end: 800,
        applied_at: "2026-08-17T12:00:00.000Z", retired_at: null,
        action_kind: "percent", action_direction: "increase", action_value: 7,
      },
      {
        // Live d2 event: its +7% must apply in pricing, its applied_at
        // becomes d2's pickup baseline_ts, and with units_start 3 < current 5
        // the undone-sweep must leave it alone.
        id: "2", hotel_id: HOTEL_ID, rule_id: "r4", rule_version: 1,
        stay_date: D.d2, affected_room_type_id: "rtA",
        baseline_start_ts: "2026-08-15T12:00:00.000Z", baseline_end_ts: SEED_TS,
        signal_booked_units_start: 3, signal_booked_units_end: 5,
        signal_booked_revenue_start: 300, signal_booked_revenue_end: 460,
        applied_at: SEED_TS, retired_at: null,
        action_kind: "percent", action_direction: "increase", action_value: 7,
      },
    ],
    published_price: [
      // Exactly what the run recomputes for d3/rtA (100 ×1.1 +15 = 125) —
      // pins the write-on-change skip: no upsert, computed_at stays SEED_TS.
      { hotel_id: HOTEL_ID, stay_date: D.d3, room_type_id: "rtA", price: 125, base_price: 100, computed_at: SEED_TS },
    ],
    evaluation_audit: [
      {
        // Matching signature (125.00|ladder:r1,ladder:r3|none) — pins the
        // audit skip. Only the fields loadLastAuditSignatures reads matter.
        evaluation_run_id: "seed-run", hotel_id: HOTEL_ID,
        stay_date: D.d3, room_type_id: "rtA", evaluated_at: SEED_TS,
        base_price: 100, floor_price: 40, ceiling_price: 126,
        ladder_subtotal_delta: 25, pickup_subtotal_delta: 0,
        pre_clamp_price: 125, final_price: 125,
        details: { application_order: ["ladder:r1", "ladder:r3"], clamped_by: "none" },
      },
    ],
    // Closes every date within momentum's ±10-day neighbor radius of the
    // horizon. Without it, momentum's 2-neighbor minimum synthesizes an
    // observation out of thin future air and R5 would classify instead of
    // blocking — with zero history the only honest read is insufficient_data,
    // and this is how the fixture forces the engine down that path.
    hotel_closed_periods: [{ hotel_id: HOTEL_ID, start_date: "2026-08-09", end_date: "2026-09-02" }],
    assumption_challenges: [],
  });
}
