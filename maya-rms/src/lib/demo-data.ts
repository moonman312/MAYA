/**
 * Demo / fallback data used when Supabase is not configured.
 * Mirrors the Python legacy dashboard's in-memory state.
 */

import type {
  ChangelogCycle,
  ChangelogEntry,
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

export function buildChangelog(): ChangelogCycle[] {
  const now = new Date();
  const cycles: ChangelogCycle[] = [];

  for (let i = 0; i < 10; i++) {
    const ts = new Date(now.getTime() - i * 5 * 60_000);
    const hasChanges = i % 3 !== 2; // roughly 2/3 have changes

    const changes: ChangelogEntry[] = [];
    if (hasChanges) {
      const roomType = ROOM_TYPES[i % ROOM_TYPES.length];
      const origRate = roomType.base_rate;
      const pctChange = i % 2 === 0 ? 10 : -5;
      const newRate = Math.round(origRate * (1 + pctChange / 100) * 100) / 100;

      changes.push({
        room_type: roomType.name,
        rule_name: INITIAL_RULES[i % INITIAL_RULES.length].rule_name,
        original_rate: origRate,
        new_rate: newRate,
        change_pct: pctChange,
        occupancy_pct: 60 + i * 4,
        description: `${roomType.name} rate adjusted from $${origRate} to $${newRate} (${pctChange >= 0 ? "+" : ""}${pctChange}%)`,
      });
    }

    cycles.push({
      cycle: 100 - i,
      timestamp: ts.toISOString(),
      has_changes: hasChanges,
      changes,
    });
  }

  return cycles;
}
