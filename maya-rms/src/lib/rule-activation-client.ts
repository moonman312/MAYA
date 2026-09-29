/**
 * The browser's half of the activation popup: asking POST /api/rules/preview
 * which nights a rule is about to change (in parts, so the nearest months
 * paint first), and the calendar the popup draws from the answer.
 */

export type RuleIntent = "create" | "edit" | "enable";

export type PreviewRequest = {
  intent: RuleIntent;
  ruleId: string;
  /** What the rule builder saves, for a new rule or an edit. */
  draft?: Record<string, unknown>;
};

/** What the popup shows: complete once every part has answered. */
export type CalendarPreview = {
  today: string;
  lastNight: string;
  affected: string[];
  roomTypesChanged: Record<string, number>;
  touched: string[];
  fingerprint: string;
  kind: "standard" | "event";
  /** Longest part, ms, and nights run, for the analytics event. */
  ms: number;
  nightsChecked: number;
  /** The parts answered so far and in all. */
  done: number;
  parts: number;
};

export type PreviewOutcome =
  | { status: "ready"; preview: CalendarPreview }
  | { status: "not_needed" }
  | { status: "unavailable" }
  /**
   * `refused`: the save would be refused too (a role, the 40-rule cap, a
   * setting): nothing to try again. `detail`: the server's own words, when
   * they say more than the popup's line (too many checks at once).
   */
  | { status: "error"; message: string; refused?: boolean; detail?: string };

/** The popup's line when the days could not be worked out (an error or a time-out): Jake's words, 2026-09-29. */
export const DAYS_NOT_CALCULATED = "We weren't able to calculate how many days would be affected by this rule.";

/**
 * How long the popup waits for each part of a preview. The route gives up
 * at 60 seconds (maxDuration) and its time-out answers first; this catches
 * a request that never answers at all (a stalled connection), so the popup
 * shows DAYS_NOT_CALCULATED instead of "Checking your calendar…" for good.
 */
export const PREVIEW_PART_TIME_LIMIT_MS = 75_000;

/** `run` with an abort signal, given up (and aborted) after `ms`. */
async function withinTimeLimit<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("no answer in time"));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), limit]);
  } finally {
    clearTimeout(timer);
  }
}

const DAY_MS = 86_400_000;

export function addDays(ymd: string, n: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Today's date where the browser is: only to split the window before the hotel's own date comes back. */
export function browserToday(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * The parts a preview is asked in. A standard rule's whole window is quick
 * (its ladder part alone decides where to look), so one request. A booking
 * speed or pickup count rule runs the engine over every night it could act
 * on: three requests at once, the nearest two months first, so the popup
 * fills in as they land. The first part starts at the hotel's today and the
 * last runs to the window's end, whatever the browser's date. Near nights
 * cost the engine more than far ones (more bookings to count), so the parts
 * are 60, 120 and 216 nights (a 200-room hotel with 33 rules on a dev Mac,
 * with the day's booking history kept: 0.7, 0.8 and 0.4 s; three equal parts
 * of 132 made the first 1.4 s).
 */
export function previewParts(kind: "standard" | "event", today: string): { from?: string; to?: string }[] {
  if (kind === "standard") return [{}];
  return [{ to: addDays(today, 59) }, { from: addDays(today, 60), to: addDays(today, 179) }, { from: addDays(today, 180) }];
}

/** Whether a builder draft (or a rule's saved conditions) counts bookings: booking speed or pickup. */
export function draftKind(draft: Record<string, unknown> | undefined, conditions?: Record<string, unknown>): "standard" | "event" {
  const c = (draft?.condition ?? {}) as Record<string, unknown>;
  if (c.booking_speed_operator || c.pickup_operator) return "event";
  if (conditions && ("booking_speed" in conditions || "pickup_rate" in conditions)) return "event";
  return "standard";
}

type PartAnswer = {
  needsActivation?: boolean;
  today?: string;
  lastNight?: string;
  affected?: string[];
  roomTypesChanged?: Record<string, number>;
  touched?: string[];
  fingerprint?: string;
  kind?: "standard" | "event";
  ms?: number;
  nightsChecked?: number;
  error?: string;
};

/**
 * Ask for the preview, in parts, calling `onPart` as each lands with what is
 * known so far (never a count: the popup shows the number only once every
 * part has answered). Parts that disagree on the fingerprint (something
 * changed between them) are asked again once. A part that has not answered
 * in full within PREVIEW_PART_TIME_LIMIT_MS is stopped, and the days could
 * not be worked out.
 */
export async function fetchRulePreview(
  request: PreviewRequest,
  kind: "standard" | "event",
  onPart: (partial: CalendarPreview) => void = () => {},
  fetchImpl: typeof fetch = fetch,
  today: string = browserToday(),
): Promise<PreviewOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const parts = previewParts(kind, today);
    const answers: PartAnswer[] = [];
    // Filled in by the parts as they answer.
    const got: { partial: CalendarPreview | null; failure: PreviewOutcome | null } = { partial: null, failure: null };
    await Promise.all(
      parts.map(async (part) => {
        let res: Response;
        let body: PartAnswer;
        try {
          [res, body] = await withinTimeLimit(PREVIEW_PART_TIME_LIMIT_MS, async (signal) => {
            const r = await fetchImpl("/api/rules/preview", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...request, ...part }),
              signal,
            });
            return [r, (await r.json().catch(() => ({}))) as PartAnswer] as const;
          });
        } catch {
          // A lost connection, or no answer in time.
          got.failure ??= { status: "error", message: DAYS_NOT_CALCULATED };
          return;
        }
        if (res.status === 501) {
          got.failure ??= { status: "unavailable" };
          return;
        }
        if (!res.ok) {
          const refused = res.status >= 400 && res.status < 500 && res.status !== 429;
          got.failure ??= refused
            ? { status: "error", message: body.error || DAYS_NOT_CALCULATED, refused: true }
            : {
                status: "error",
                message: DAYS_NOT_CALCULATED,
                ...(res.status === 429 && body.error ? { detail: body.error } : {}),
              };
          return;
        }
        if (body.needsActivation === false) {
          got.failure ??= { status: "not_needed" };
          return;
        }
        answers.push(body);
        got.partial = merge(answers, parts.length);
        onPart(got.partial);
      }),
    );
    if (got.failure) return got.failure;
    const fingerprints = new Set(answers.map((a) => a.fingerprint));
    if (fingerprints.size === 1 && got.partial) return { status: "ready", preview: got.partial };
  }
  return { status: "error", message: DAYS_NOT_CALCULATED };
}

function merge(answers: PartAnswer[], parts: number): CalendarPreview {
  const first = answers[0];
  const affected = [...new Set(answers.flatMap((a) => a.affected ?? []))].sort();
  const touched = [...new Set(answers.flatMap((a) => a.touched ?? []))].sort();
  return {
    today: first.today ?? "",
    lastNight: first.lastNight ?? "",
    affected,
    roomTypesChanged: Object.assign({}, ...answers.map((a) => a.roomTypesChanged ?? {})),
    touched,
    fingerprint: first.fingerprint ?? "",
    kind: first.kind ?? "standard",
    ms: Math.max(...answers.map((a) => a.ms ?? 0)),
    nightsChecked: answers.reduce((n, a) => n + (a.nightsChecked ?? 0), 0),
    done: answers.length,
    parts,
  };
}

/**
 * "41 days will be affected by this rule." with "1 day" for one, and "0
 * prices will be affected by this rule." when nothing would change (Jake,
 * 2026-09-29: the popup then only turns the rule on).
 */
export function affectedSentence(days: number): string {
  if (days === 0) return "0 prices will be affected by this rule.";
  return `${days} ${days === 1 ? "day" : "days"} will be affected by this rule.`;
}

export type MonthBlock = {
  /** YYYY-MM */
  key: string;
  label: string;
  /** Blank cells before the 1st, Sunday first (as the Calendar tab). */
  lead: number;
  /** Every day of the month, with whether it is in the pricing window. */
  days: { date: string; inWindow: boolean }[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The month blocks from the hotel's today to the window's last night: every
 * month the window reaches, the first and last partly outside it (Jake's
 * twelve months, with the one or two more the 396-night window reaches, so
 * every counted day can be seen). The first block and each January name
 * their year.
 */
export function monthBlocks(today: string, lastNight: string): MonthBlock[] {
  const out: MonthBlock[] = [];
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  const endKey = lastNight.slice(0, 7);
  for (let guard = 0; guard < 30; guard++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    const first = `${key}-01`;
    const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const days = Array.from({ length: count }, (_, i) => {
      const date = addDays(first, i);
      return { date, inWindow: date >= today && date <= lastNight };
    });
    out.push({ key, label: out.length === 0 || m === 1 ? `${MONTHS[m - 1]} ${y}` : MONTHS[m - 1], lead, days });
    if (key >= endKey) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

const LONG_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function longDate(ymd: string, withYear: boolean): string {
  const d = Number(ymd.slice(8, 10));
  const m = LONG_MONTHS[Number(ymd.slice(5, 7)) - 1];
  return withYear ? `${d} ${m} ${ymd.slice(0, 4)}` : `${d} ${m}`;
}

/** The affected nights as runs of days, for screen readers: "28 September to 2 October 2026, 10 October 2026". */
export function dateRanges(days: readonly string[]): string {
  const sorted = [...new Set(days)].sort();
  const runs: [string, string][] = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last && addDays(last[1], 1) === d) last[1] = d;
    else runs.push([d, d]);
  }
  return runs
    .map(([a, b]) => {
      if (a === b) return longDate(a, true);
      // "3 to 4 October 2026", "28 September to 2 October 2026", "30 December 2026 to 2 January 2027".
      const from = a.slice(0, 7) === b.slice(0, 7) ? String(Number(a.slice(8, 10))) : longDate(a, a.slice(0, 4) !== b.slice(0, 4));
      return `${from} to ${longDate(b, true)}`;
    })
    .join(", ");
}

/** A day's hover line: "Mon 5 Oct 2026: prices change on 2 room types". */
export function dayTitle(date: string, roomTypes: number | undefined): string {
  const dt = new Date(`${date}T12:00:00Z`);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getUTCDay()];
  const head = `${wd} ${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  if (!roomTypes) return head;
  return `${head}: prices change on ${roomTypes} room ${roomTypes === 1 ? "type" : "types"}`;
}
