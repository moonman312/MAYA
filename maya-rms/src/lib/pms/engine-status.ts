/**
 * What the status page says about the pricing engine, from the database
 * watchdog's rows (pricing_watchdog with p_post false: nothing written or
 * sent). Pure, so the route and its test say the same thing.
 */

export type EngineState = "healthy" | "degraded" | "down" | "unknown";

export type Engine = {
  state: EngineState;
  /** The newest run over the hotels watched, or of any hotel before the watchdog migration. */
  lastRunAt: string | null;
  minutesAgo: number | null;
  /** Hotels the watchdog watches (live or simulating, entitled, not test). Absent before its migration. */
  hotels?: number;
  /** Live hotels with no pricing run for 30 minutes. */
  behind?: number;
  /** Hotels whose daily pass has not finished 2 hours into their day. */
  passLate?: number;
  /** Simulating hotels with no pricing run for 30 minutes. */
  simulatingBehind?: number;
  /** Why the answer is the older reckoning. */
  note?: string;
};

export type WatchdogRow = {
  hotel_id: string;
  mode: string;
  behind: boolean;
  pass_late: boolean;
  last_run_at: string | null;
};

/**
 * The watchdog's verdict over the hotels that count: a live hotel behind is
 * down; a late pass, or a simulating hotel behind, is degraded; no hotel
 * watched at all is unknown.
 */
export function engineFromWatchdog(rows: WatchdogRow[], nowMs: number): Engine {
  const live = rows.filter((r) => r.mode === "live");
  const behind = live.filter((r) => r.behind).length;
  const simulatingBehind = rows.filter((r) => r.mode !== "live" && r.behind).length;
  const passLate = rows.filter((r) => r.pass_late).length;
  const newest = rows.reduce<number | null>((acc, r) => {
    const t = r.last_run_at ? Date.parse(r.last_run_at) : NaN;
    return Number.isFinite(t) && (acc == null || t > acc) ? t : acc;
  }, null);
  const state: EngineState =
    rows.length === 0 ? "unknown" : behind > 0 ? "down" : passLate > 0 || simulatingBehind > 0 ? "degraded" : "healthy";
  return {
    state,
    lastRunAt: newest != null ? new Date(newest).toISOString() : null,
    minutesAgo: newest != null ? Math.round((nowMs - newest) / 60000) : null,
    hotels: rows.length,
    behind,
    passLate,
    simulatingBehind,
    ...(rows.length === 0 ? { note: "no_hotels_watched" } : {}),
  };
}
