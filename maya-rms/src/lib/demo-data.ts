/**
 * Demo / fallback data used when Supabase is not configured.
 * Mirrors the Python legacy dashboard's in-memory state.
 */

import { narrateChange } from "@/lib/changelog-narrative";
import type {
  ChangelogCycle,
  ChangelogEntry,
  ChangelogQuietChecks,
  RuleCondition,
  RuleConfig,
  SimulationReservation,
} from "@/types/domain";

/* ── Room types ────────────────────────────────────────────────── */

export const ROOM_TYPES: { name: string; base_rate: number; total_rooms: number }[] = [
  { name: "Standard", base_rate: 175, total_rooms: 40 },
  { name: "Deluxe", base_rate: 245, total_rooms: 30 },
  { name: "Suite", base_rate: 395, total_rooms: 15 },
];

/* ── Sample reservations for the rate simulator ────────────────── */

export const SAMPLE_RESERVATIONS: SimulationReservation[] = [
  { room_type: "Standard", occupancy_percentage: 85, booking_window: 30, pickup_rate: 3, current_rate: 175 },
  { room_type: "Deluxe", occupancy_percentage: 50, booking_window: 10, pickup_rate: 1, current_rate: 245 },
  { room_type: "Suite", occupancy_percentage: 95, booking_window: 5, pickup_rate: 8, current_rate: 395 },
];

/* ── Seed rules (in-memory fallback) ──────────────────────────── */

export const INITIAL_RULES: RuleConfig[] = [
  {
    id: "1",
    rule_name: "High Occupancy Surge",
    conditions: { occupancy_percentage: ">80" },
    action: { adjust_rate_percent: 10 },
    room_types: [],
    enabled: true,
  },
  {
    id: "2",
    rule_name: "Last-Minute Premium",
    conditions: { booking_window: "<3", occupancy_percentage: ">50" },
    action: { adjust_rate_percent: 15 },
    room_types: ["Standard", "Deluxe"],
    enabled: true,
  },
  {
    id: "3",
    rule_name: "Suite Peak Surcharge",
    conditions: { occupancy_percentage: ">70", pickup_rate: ">5" },
    action: { adjust_rate_dollars: 50 },
    room_types: ["Suite"],
    enabled: true,
  },
  {
    id: "4",
    rule_name: "Early Bird Discount",
    conditions: { booking_window: ">45" },
    action: { adjust_rate_percent: -5 },
    room_types: [],
    enabled: false,
  },
];

/* ── Demo changelog builder ───────────────────────────────────── */

/** Runs in the demo change log, one every five minutes back from now. */
export const DEMO_RUNS = 64;
/** The runs (0 is the newest) that changed a price; the rest were quiet checks. */
export const DEMO_CHANGED_RUNS = [3, 4, 9, 17, 18, 26, 31, 40, 52, 58];

/**
 * The demo change log, in the shape the real one has: the runs that changed
 * a price in full, and each stretch of quiet checks between them as one line.
 */
export function buildChangelog(): (ChangelogCycle | ChangelogQuietChecks)[] {
  const now = Date.now();
  const at = (run: number) => new Date(now - run * 5 * 60_000).toISOString();
  const items: (ChangelogCycle | ChangelogQuietChecks)[] = [];
  let quietSince: number | null = null;
  const endQuiet = (oldest: number) => {
    if (quietSince == null) return;
    items.push({
      kind: "quiet_checks",
      id: `demo-quiet-${quietSince}`,
      timestamp: at(quietSince),
      first_at: at(oldest),
      checks: oldest - quietSince + 1,
    });
    quietSince = null;
  };

  for (let run = 0; run < DEMO_RUNS; run++) {
    const k = DEMO_CHANGED_RUNS.indexOf(run);
    if (k < 0) {
      quietSince ??= run;
      continue;
    }
    endQuiet(run - 1);

    const roomType = ROOM_TYPES[k % ROOM_TYPES.length];
    const origRate = roomType.base_rate;
    const pctChange = k % 2 === 0 ? 10 : -5;
    const newRate = Math.round(origRate * (1 + pctChange / 100) * 100) / 100;
    const ruleName = INITIAL_RULES[k % INITIAL_RULES.length].rule_name;
    const occupancyPct = 60 + k * 4;
    const occupancy = occupancyPct / 100;

    // Plausible trigger: increases fire above a threshold the occupancy
    // clears, decreases below one it stays under.
    const condition: RuleCondition =
      pctChange >= 0
        ? {
            occupancy_operator: "gt",
            occupancy_threshold: Math.round((occupancy - 0.1) * 20) / 20,
          }
        : {
            occupancy_operator: "lt",
            occupancy_threshold: Math.min(1, Math.round((occupancy + 0.1) * 20) / 20),
          };

    const narrative = narrateChange({
      room_type: roomType.name,
      base_price: origRate,
      final_price: newRate,
      applications: [
        {
          rule_name: ruleName,
          condition,
          action: {
            kind: "percent",
            direction: pctChange >= 0 ? "increase" : "decrease",
            value: Math.abs(pctChange),
          },
          metrics: { occupancy },
          is_pickup: false,
        },
      ],
    });

    const change: ChangelogEntry = {
      room_type: roomType.name,
      rule_name: ruleName,
      original_rate: origRate,
      new_rate: newRate,
      change_pct: pctChange,
      occupancy_pct: occupancyPct,
      narrative,
      description: narrative.join(" "),
    };
    items.push({
      cycle: DEMO_CHANGED_RUNS.length - k,
      timestamp: at(run),
      has_changes: true,
      changes: [change],
    });
  }
  endQuiet(DEMO_RUNS - 1);

  return items;
}
