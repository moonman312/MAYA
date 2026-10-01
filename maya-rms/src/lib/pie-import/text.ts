/**
 * Small text helpers for reading a Cloudbeds PIE screenshot: OCR text tidied
 * for matching, numbers and money read the way PIE prints them, and names
 * compared the way the import matches room types.
 */

/** Letters OCR puts where a digit belongs, inside a number. */
const DIGIT_LOOKALIKES: Record<string, string> = { O: "0", o: "0", Q: "0", D: "0", l: "1", I: "1", "|": "1", S: "5", B: "8" };

/**
 * A token that is plainly a number with one or two look-alike letters in it
 * ("1O.00", "3l.00") read as the number. Anything with fewer digits than
 * look-alikes is left alone, so words are never turned into numbers.
 */
export function fixDigits(token: string): string {
  if (!/\d/.test(token)) return token;
  // A range ("8O-800"): each side on its own.
  if (/^[^-]+-[^-]+$/.test(token)) return token.split("-").map(fixDigits).join("-");
  const chars = [...token];
  const lookalikes = chars.filter((c) => c in DIGIT_LOOKALIKES).length;
  const digits = chars.filter((c) => /\d/.test(c)).length;
  if (lookalikes === 0 || lookalikes > digits || !/^[\dOoQDlI|SB.,]+%?$/.test(token)) return token;
  return chars.map((c) => DIGIT_LOOKALIKES[c] ?? c).join("");
}

/**
 * OCR text with one space between words, straight quotes and plain dashes,
 * and look-alike letters inside numbers fixed. Case is kept.
 */
export function tidy(text: string): string {
  return text
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(fixDigits)
    .join(" ");
}

/** At most one letter different (an OCR slip in a word PIE always prints the same way). */
export function near(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 4) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** The words of PIE's description template, which OCR sometimes misreads by a letter ("Ralse", "cccupancy"). */
const TEMPLATE_WORDS = [
  "raise",
  "lower",
  "increase",
  "decrease",
  "rate",
  "rates",
  // Before "when", so "then" (a misread "than") becomes "than".
  "than",
  "when",
  "occupancy",
  "greater",
  "higher",
  "less",
  "more",
  "equal",
  "booking",
  "days",
  "advance",
  "today",
  "individual",
  "combined",
  "overall",
];

/**
 * A description with its template words read right: a word one letter
 * away from one of them (four letters or more) becomes that word, and "ls"
 * or "1s" becomes "is". Numbers and other words are left as they are.
 */
export function fixTemplateWords(text: string): string {
  return text
    .split(" ")
    .map((token) => {
      if (/^[il1|]s$/i.test(token)) return "is";
      const m = token.match(/^([A-Za-z]+)([.,:;]?)$/);
      if (!m || m[1].length < 4) return token;
      const lower = m[1].toLowerCase();
      if (TEMPLATE_WORDS.includes(lower)) return token;
      const hit = TEMPLATE_WORDS.find((t) => near(lower, t));
      return hit ? `${hit}${m[2]}` : token;
    })
    .join(" ");
}

/**
 * A number as PIE prints it: "10.00", "1,234.50", "3,500", or with a decimal
 * comma ("10,00"). null when it is not one.
 */
export function parseNumber(raw: string): number | null {
  const s = fixDigits(raw.trim());
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ""));
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) return Number(s.replace(/\./g, "").replace(",", "."));
  if (/^\d+,\d{1,2}$/.test(s)) return Number(s.replace(",", "."));
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^\.\d+$/.test(s)) return Number(`0${s}`);
  return null;
}

/** "$1,234.00", "€ 139,00", "139.00": the amount, or null. */
export function parseMoney(raw: string): number | null {
  const s = raw.replace(/^[^\d]*?([$€£¥]|USD|EUR|GBP|CAD|AUD|MXN)\s*/i, "").replace(/[^\d.,OolI]+$/, "").trim();
  if (!/\d/.test(s)) return null;
  return parseNumber(s);
}

/** Whether a word reads as money (a currency sign, or two decimals). */
export function looksLikeMoney(raw: string): boolean {
  const s = raw.trim();
  return /^[$€£¥]\s*\d/.test(s) || /^\d{1,3}(,\d{3})*\.\d{2}$/.test(s) || /^\d+\.\d{2}$/.test(s);
}

/**
 * A room type name the way the import compares them: case folded, trimmed,
 * one space between words, plain dashes with no space around them.
 */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function ymd(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * A date in PIE's START DATE or END DATE column. "N/A" (or nothing) is
 * none. Slashed dates are read month first, as Cloudbeds prints them in the
 * US; `ambiguous` says when day first would read differently.
 */
export function parsePieDate(raw: string | null | undefined):
  | { kind: "none" }
  | { kind: "date"; date: string; ambiguous: boolean }
  | { kind: "unreadable" } {
  const all = tidy(raw ?? "");
  // "N/A", and OCR's "NIA", "N|A", "N1A", "INJA": a few letters and no digit
  // is never a date.
  if (all === "" || /^-+$/.test(all) || /\bn\s*[/|il1]\s*a\b/i.test(all) || /^n\s*a$/i.test(all)) return { kind: "none" };
  if (!/\d/.test(all) && all.replace(/[^A-Za-z]/g, "").length <= 5) return { kind: "none" };
  // The date itself, without stray marks OCR found beside it.
  const found =
    all.match(/\d{4}-\d{1,2}-\d{1,2}/) ??
    all.match(/\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/) ??
    all.match(/[A-Za-z]{3,9}\.? \d{1,2},? \d{4}/) ??
    all.match(/\d{1,2} [A-Za-z]{3,9}\.?,? \d{4}/);
  const s = (found ? found[0] : all).replace(/[.,]$/, "");
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const date = ymd(Number(m[1]), Number(m[2]), Number(m[3]));
    return date ? { kind: "date", date, ambiguous: false } : { kind: "unreadable" };
  }
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    const monthFirst = ymd(y, a, b);
    const dayFirst = ymd(y, b, a);
    if (monthFirst) return { kind: "date", date: monthFirst, ambiguous: dayFirst !== null && dayFirst !== monthFirst };
    if (dayFirst) return { kind: "date", date: dayFirst, ambiguous: false };
    return { kind: "unreadable" };
  }
  m = s.match(/^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/);
  if (m) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    const date = month > 0 ? ymd(Number(m[3]), month, Number(m[2])) : null;
    return date ? { kind: "date", date, ambiguous: false } : { kind: "unreadable" };
  }
  m = s.match(/^(\d{1,2}) ([A-Za-z]{3,9})\.?,? (\d{4})$/);
  if (m) {
    const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    const date = month > 0 ? ymd(Number(m[3]), month, Number(m[1])) : null;
    return date ? { kind: "date", date, ambiguous: false } : { kind: "unreadable" };
  }
  return { kind: "unreadable" };
}
