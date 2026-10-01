/**
 * PIE's rule description, read back into its parts. PIE writes every
 * occupancy rule from one fixed template:
 *
 *   "Raise rate by 10.00 % when occupancy is greater than 31.00 %"
 *   "Lower rate by 10.00 % when occupancy is lower than 20.00 % and when
 *    booking today-28 days in advance"
 *
 * The parser is tolerant of what OCR does to it (spacing, a misread digit,
 * a decimal comma) and also takes a fixed amount (no "%", or a currency
 * sign), "less than", "or equal to" and "equal to", and wording that names
 * the room types an occupancy is measured on. It never guesses: a part it
 * cannot read makes the description unreadable, and a description that
 * stops early (the screenshot cut it off) is marked incomplete.
 */

import { parseNumber, tidy } from "./text";

export type OccupancyOp = "gt" | "lt" | "gte" | "lte" | "eq";

/**
 * Whose occupancy the rule reads. PIE's default is the whole property
 * ("Overall"); a rule can instead read each listed room type on its own
 * (individual) or the listed ones together (combined).
 */
export type PieScope =
  | { kind: "overall" }
  | { kind: "individual" | "combined"; names: string[] };

export type PieDescription = {
  direction: "raise" | "lower";
  kind: "percent" | "fixed";
  /** The amount as PIE shows it: a percent, or an amount of the property's currency. */
  amount: number;
  occupancyOp: OccupancyOp;
  /** Percent, 0 to 100. */
  threshold: number;
  scope: PieScope;
  /** "booking A-B days in advance", inclusive; "today" is 0. */
  window: { from: number; to: number } | null;
};

export type DescriptionRead =
  | { ok: true; rule: PieDescription; complete: boolean }
  | {
      ok: false;
      /**
       * not_rate: it is not a "Raise/Lower rate by" rule at all.
       * unreadable: it is, but a part could not be read.
       * cut: it stops before the template's end.
       */
      reason: "not_rate" | "unreadable" | "cut";
      direction?: "raise" | "lower";
    };

const HEAD = /^(raise|lower|increase|decrease)\s+(?:the\s+)?rates?\s+b[yv]\b\s*/i;
const AMOUNT = /^([$€£¥]\s*)?(\d[\d.,]*)\s*(%|percent\b)?\s*/i;
const OCC_OPS: [RegExp, OccupancyOp][] = [
  [/^(?:greater|more|higher)\s+than\s+or\s+equal\s+to\b/i, "gte"],
  [/^(?:lower|less)\s+than\s+or\s+equal\s+to\b/i, "lte"],
  [/^(?:at\s+least)\b/i, "gte"],
  [/^(?:at\s+most)\b/i, "lte"],
  [/^(?:greater|more|higher)\s+than\b/i, "gt"],
  [/^(?:above|over)\b/i, "gt"],
  [/^(?:lower|less)\s+than\b/i, "lt"],
  [/^(?:below|under)\b/i, "lt"],
  [/^(?:equal\s+to|equals?)\b/i, "eq"],
];

/** Room type names in scope wording: "Loft Suite, Garden Room and Suites". */
function splitNames(raw: string): string[] {
  return raw
    .replace(/^(?:the\s+)?(?:room\s+types?|accommodation\s+types?|accommodations?)\s*:?\s*/i, "")
    .split(/\s*,\s*|\s+and\s+|\s*&\s*|\s*;\s*/i)
    .map((s) => s.replace(/^["']|["']$/g, "").trim())
    .filter((s) => s.length > 0);
}

/** The words between "rate by N" and "when", if any: "for Loft Suite, Suites". */
function scopeBeforeWhen(raw: string): string[] | null {
  const m = raw.match(/^(?:for|on|of)\s+(.+)$/i);
  return m ? splitNames(m[1]) : null;
}

/**
 * Read one description. `text` is the description cell's OCR text, in
 * reading order.
 */
export function parseDescription(text: string): DescriptionRead {
  let s = tidy(text).replace(/^[^A-Za-z]+/, "");
  const head = s.match(HEAD);
  if (!head) return { ok: false, reason: "not_rate" };
  const direction = /^(raise|increase)/i.test(head[1]) ? "raise" : "lower";
  s = s.slice(head[0].length);

  const amt = s.match(AMOUNT);
  if (!amt) return { ok: false, reason: s.trim() === "" ? "cut" : "unreadable", direction };
  const amount = parseNumber(amt[2].replace(/[.,]$/, ""));
  if (amount === null || !(amount > 0)) return { ok: false, reason: "unreadable", direction };
  const kind: PieDescription["kind"] = amt[3] && !amt[1] ? "percent" : "fixed";
  s = s.slice(amt[0].length);

  // Anything before "when" names room types ("for Loft Suite").
  const when = s.search(/\bwhen\b/i);
  if (when < 0) return { ok: false, reason: s.trim() === "" || /^(for|on|of)\b/i.test(s) ? "cut" : "unreadable", direction };
  const beforeWhen = s.slice(0, when).trim();
  const namedBefore = beforeWhen ? scopeBeforeWhen(beforeWhen) : null;
  if (beforeWhen && !namedBefore) return { ok: false, reason: "unreadable", direction };
  s = s.slice(when).replace(/^when\s+/i, "");

  // "[the] [overall|individual|combined] [room type] occupancy [of|for|in NAMES] is"
  const occ = s.match(/^(?:the\s+)?(?:(overall|individual|combined)\s+)?(?:room\s+type\s+|accommodation\s+)?occupancy\b\s*/i);
  if (!occ) return { ok: false, reason: s.trim() === "" ? "cut" : "unreadable", direction };
  const scopeWord = occ[1]?.toLowerCase() as "overall" | "individual" | "combined" | undefined;
  s = s.slice(occ[0].length);
  const is = s.search(/\bis\b/i);
  if (is < 0) return { ok: false, reason: "cut", direction };
  const between = s.slice(0, is).trim();
  let names: string[] = namedBefore ?? [];
  if (between) {
    const m = between.match(/^(?:of|for|in|across)\s+(.+)$/i);
    if (!m) return { ok: false, reason: "unreadable", direction };
    names = [...names, ...splitNames(m[1])];
  }
  s = s.slice(is).replace(/^is\s*/i, "");

  let op: OccupancyOp | null = null;
  for (const [re, o] of OCC_OPS) {
    const m = s.match(re);
    if (m) {
      op = o;
      s = s.slice(m[0].length).trim();
      break;
    }
  }
  if (!op) return { ok: false, reason: s.trim() === "" || /^(greater|lower|less|more|equal)\b/i.test(s) ? "cut" : "unreadable", direction };

  const th = s.match(/^(\d[\d.,]*)\s*(%)?\s*/);
  if (!th) return { ok: false, reason: s.trim() === "" ? "cut" : "unreadable", direction };
  const threshold = parseNumber(th[1].replace(/[.,]$/, ""));
  if (threshold === null || threshold < 0 || threshold > 100) return { ok: false, reason: "unreadable", direction };
  const hasPercent = th[2] === "%";
  s = s.slice(th[0].length);

  const scope: PieScope =
    scopeWord === "individual" || scopeWord === "combined"
      ? { kind: scopeWord, names }
      : names.length > 0
        ? { kind: "combined", names }
        : { kind: "overall" };

  // The rest: nothing (or stray marks), or the booking window.
  const rest = s.replace(/^[^A-Za-z0-9]+/, "").trim();
  let window: PieDescription["window"] = null;
  let complete = hasPercent;
  if (rest !== "" && /[A-Za-z]/.test(rest)) {
    const w = rest.match(/^and\s+when\s+booking\s+(t[o0]day|\d+)\s*(?:-|to)\s*(\d+)\s+days?\s+in\s+advance\b(.*)$/i);
    if (w) {
      const from = /^t/i.test(w[1]) ? 0 : Number(w[1]);
      const to = Number(w[2]);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) return { ok: false, reason: "unreadable", direction };
      window = { from, to };
      if (/[A-Za-z]{2,}/.test(w[3])) return { ok: false, reason: "unreadable", direction };
    } else if (/^and\b/i.test(rest)) {
      // More of the template was coming ("and when booking ..."), but it
      // stops, or what follows can't be read: never imported as it stands.
      complete = false;
    } else {
      return { ok: false, reason: "unreadable", direction };
    }
  }

  return {
    ok: true,
    complete,
    rule: { direction, kind, amount, occupancyOp: op, threshold, scope, window },
  };
}

