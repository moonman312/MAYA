/**
 * Simulation or live, for any moment, and the honest words for each.
 *
 * A property is in one mode at a time (hotel_settings.simulation_mode), but
 * its history mixes them: runs, fires and answers from before it went live
 * were simulated, and stay simulated after it goes live. hotel_mode_history
 * (99_supabase_migration_simulation_history_v1.sql) keeps every switch, so
 * the mode of any event is read off it by the event's own time (modeAt). The
 * database answers the same question with hotel_simulated_at(hotel, at).
 *
 * The words follow three rules (Jake, 2026-09-30):
 *
 *   - Something recorded while simulating never says a price changed or was
 *     sent. It says what would have happened, and that nothing was sent:
 *     "Simulation: the price for Fri Nov 13, Queen would have gone from
 *     $150.00 to $165.00." then "Nothing was sent to Cloudbeds."
 *   - Something recorded live says a price was sent only when MAYA's send
 *     ledger (rate_updates) shows it went; otherwise that it is waiting, could
 *     not be sent, or was held back. Where the ledger can't say any more (a
 *     later price has replaced it), it says nothing about sending.
 *   - Where the mode is not known (history MAYA could not rebuild, or the
 *     history table not there yet) the words are the ones the log always used,
 *     and nothing is claimed about sending.
 *
 * Pure and client-safe: the change log route, the change log's items, the
 * rules' fire log and the simulation strip all read from here.
 */

/** The property systems MAYA sends prices to. Mews and the rest are read-only for now. */
export const PMS_SENDS_PRICES: ReadonlySet<string> = new Set(["cloudbeds", "think"]);

export function pmsSendsPrices(pmsType: string | null | undefined): boolean {
  return pmsType != null && PMS_SENDS_PRICES.has(pmsType);
}

const PMS_DISPLAY: Record<string, string> = {
  cloudbeds: "Cloudbeds",
  mews: "Mews",
  think: "Think Reservations",
  opera: "Opera",
};

/** "Cloudbeds", or "your property system" when there is none to name. */
export function pmsLabel(pmsType: string | null | undefined): string {
  if (!pmsType) return "your property system";
  return PMS_DISPLAY[pmsType] ?? pmsType;
}

/* ── The mode at a moment ─────────────────────────────────────────────── */

export type PriceMode = "simulation" | "live" | "unknown";

/** One row of hotel_mode_history: from `since` (ms; -Infinity for the start of time) until the next. */
export type ModeSpan = { since: number; simulated: boolean | null };

/** The property's history, oldest first. Empty when there is none to read. */
export type ModeTimeline = ModeSpan[];

function instant(v: unknown): number {
  if (typeof v === "number") return v;
  const s = String(v ?? "");
  if (s === "-infinity") return -Infinity;
  if (s === "infinity") return Infinity;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * hotel_mode_history rows as the database returns them (since, simulated,
 * recorded_at), oldest first. Rows at the same instant keep the later
 * recorded one last, as hotel_simulated_at breaks the tie.
 */
export function modeTimelineFrom(rows: readonly { since?: unknown; simulated?: unknown; recorded_at?: unknown }[] | null | undefined): ModeTimeline {
  return (rows ?? [])
    .map((r, i) => ({
      since: instant(r.since),
      recorded: instant(r.recorded_at),
      simulated: typeof r.simulated === "boolean" ? r.simulated : null,
      i,
    }))
    .filter((r) => !Number.isNaN(r.since))
    .sort((a, b) => a.since - b.since || (a.recorded || 0) - (b.recorded || 0) || a.i - b.i)
    .map(({ since, simulated }) => ({ since, simulated }));
}

/** The mode at `at`: the newest row at or before it. "unknown" with no such row, or one that says it is not known. */
export function modeAt(timeline: ModeTimeline | null | undefined, at: string | number | null | undefined): PriceMode {
  if (!timeline || timeline.length === 0 || at == null) return "unknown";
  const t = instant(at);
  if (Number.isNaN(t)) return "unknown";
  let found: ModeSpan | null = null;
  for (const span of timeline) {
    if (span.since <= t) found = span;
    else break;
  }
  if (!found || found.simulated == null) return "unknown";
  return found.simulated ? "simulation" : "live";
}

/* ── Words ────────────────────────────────────────────────────────────── */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Fri Nov 13" for a stay night (YYYY-MM-DD), read as a calendar date. */
export function nightLabel(ymd: string): string {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return ymd;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[dt.getUTCDay()]} ${MONTHS[m - 1]} ${d}`;
}

function money(v: number, sym: string): string {
  return `${sym}${v.toFixed(2)}`;
}

/** Whether two prices are the same to the cent. */
export function sameCents(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

/**
 * The line that heads one night's change.
 *
 *   simulation  "Simulation: the price for Fri Nov 13, Queen would have gone
 *               from $150.00 to $165.00." ("would have been $160.00." when
 *               the two are the same, as a typed price with nothing on it is)
 *   live, unknown
 *               "Queen · stay 2026-11-13: $150.00 up to $165.00 (+10%)", as
 *               the log has always headed a change, in the property's currency.
 */
export function priceMoveHeadline(p: {
  mode: PriceMode;
  stayDate: string | null | undefined;
  roomType: string;
  from: number;
  to: number;
  changePct: number;
  currencySymbol: string;
}): string {
  const sym = p.currencySymbol;
  if (p.mode === "simulation") {
    const what = p.stayDate ? `${nightLabel(p.stayDate)}, ${p.roomType}` : p.roomType;
    return sameCents(p.from, p.to)
      ? `Simulation: the price for ${what} would have been ${money(p.to, sym)}.`
      : `Simulation: the price for ${what} would have gone from ${money(p.from, sym)} to ${money(p.to, sym)}.`;
  }
  const stay = p.stayDate ? ` · stay ${p.stayDate.slice(0, 10)}` : "";
  const way = p.to >= p.from ? "up" : "down";
  return `${p.roomType}${stay}: ${money(p.from, sym)} ${way} to ${money(p.to, sym)} (${p.changePct >= 0 ? "+" : ""}${p.changePct}%)`;
}

/**
 * What became of a live price, as far as the send ledger can tell:
 *
 *   sent      the ledger holds a send at this price
 *   waiting   still to go: not reached by the push yet, on its way, or being
 *             tried again
 *   failed    the push stopped trying at this price
 *   held      the push held it back (a guardrail, or no rate in the PMS to send to)
 *   not_sent  the property system is one MAYA doesn't send prices to (Mews)
 */
export type SendState = "sent" | "waiting" | "failed" | "held" | "not_sent";

/**
 * The line under a change saying where the price went, or null when there is
 * nothing honest to say. In simulation it is always "Nothing was sent to X.";
 * live, it follows `state`; with the mode not known, nothing.
 */
export function sendLine(p: { mode: PriceMode; state: SendState | null; pmsType: string | null | undefined }): string | null {
  const pms = pmsLabel(p.pmsType);
  if (p.mode === "simulation") return `Nothing was sent to ${pms}.`;
  if (p.mode !== "live" || p.state == null) return null;
  switch (p.state) {
    case "sent":
      return `Sent to ${pms}.`;
    case "waiting":
      return `Waiting to be sent to ${pms}.`;
    case "failed":
      return `Couldn't be sent to ${pms}.`;
    case "held":
      return `Held back, not sent to ${pms}.`;
    case "not_sent":
      return `Nothing was sent to ${pms}. MAYA doesn't send prices there yet.`;
  }
}
