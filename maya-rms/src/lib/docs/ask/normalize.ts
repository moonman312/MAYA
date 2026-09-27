// Turning a question (or a docs passage) into the words the matcher compares:
// lower case, no punctuation, synonyms added, stop words dropped, the rest
// stemmed. Numbers and property system names are kept.

import { stem } from "./porter.ts";

export const STOP_WORDS = new Set(
  (
    "a an the is are was were be been being am do does did doing done have has had having " +
    "i me my mine myself we us our ours you your yours it its itself they them their theirs " +
    "he she him her his this that these those what which who whom whose why how when where there here " +
    "of to in on at for with from by about as into onto than then so if or and but nor " +
    "can could would should will shall may might must just also any some all each every very too " +
    "much many more most other such only own same still ever get gets got getting want wants need needs " +
    "please hi hello thanks thank ok okay im ive id dont doesnt didnt isnt arent wasnt werent cant couldnt " +
    "wont wouldnt shouldnt hasnt havent hadnt s t d ll re ve m not no yes " +
    "someone something anything thing things way ways " +
    "mean means meaning meant happen happens happened happening work works use using used " +
    "see seeing say said look looks looking like go going goes gone come comes possible able " +
    "exactly actually really kind sort bit lot lots whats whos wheres hows thats theres lets heres " +
    "sorry excuse pardon um umm uh er erm specific specifically particular particularly certain"
  ).split(" "),
);

export interface SynonymTable {
  /** normalised phrase (one or more words) -> synonym group ids */
  phrases: Map<string, number[]>;
  /** the longest phrase, in words */
  longest: number;
}

/** Lower case, apostrophes dropped, everything but letters, digits, $ and % turned into spaces. */
export function clean(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’'`]/g, "")
    .replace(/&/g, " and ")
    // "12/20 rooms" on a day card stays one token
    .replace(/(\d)\/(\d)/g, "$1of$2")
    .replace(/[^a-z0-9$%]+/g, " ")
    .trim();
}

/** "and I don't know why": the reader's aside, not the subject. The "why" stays. */
const ASIDE = /\b(?:(?:and|but) )?(?:i|we) (?:dont|do not|didnt|did not|cant|can not|cannot) (?:know|understand|tell|see|work out|figure out) why\b/g;

/** The question cleaned, with asides such as "and I don't know why" cut down to "why". */
export function dropAsides(text: string): string {
  return clean(text).replace(ASIDE, "why").replace(/\bidk why\b/g, "why");
}

export function buildSynonymTable(groups: string[][]): SynonymTable {
  const phrases = new Map<string, number[]>();
  let longest = 1;
  groups.forEach((group, id) => {
    for (const term of group) {
      const key = clean(term);
      if (!key) continue;
      const list = phrases.get(key) ?? [];
      if (!list.includes(id)) list.push(id);
      phrases.set(key, list);
      longest = Math.max(longest, key.split(" ").length);
    }
  });
  return { phrases, longest };
}

const stemCache = new Map<string, string>();
export function stemWord(word: string): string {
  let s = stemCache.get(word);
  if (s === undefined) {
    s = /^[a-z]+$/.test(word) ? stem(word) : word;
    if (stemCache.size < 50000) stemCache.set(word, s);
  }
  return s;
}

/**
 * The tokens for a piece of text. Every synonym phrase found adds a
 * `syn<n>` token for its group, next to the words themselves, so a match on
 * the reader's own word still counts for more than a match on a synonym.
 */
export function tokenize(text: string, synonyms?: SynonymTable, options: { pairs?: boolean } = {}): string[] {
  const words = clean(text).split(" ").filter(Boolean);
  const out: string[] = [];
  if (synonyms) {
    for (let i = 0; i < words.length; i++) {
      for (let n = Math.min(synonyms.longest, words.length - i); n >= 1; n--) {
        const ids = synonyms.phrases.get(words.slice(i, i + n).join(" "));
        if (ids) for (const id of ids) out.push(`syn${id}`);
      }
    }
  }
  let prev: string | null = null;
  for (const w of words) {
    if (STOP_WORDS.has(w)) continue;
    if (w.length === 1 && !/[0-9$%]/.test(w)) continue;
    const s = stemWord(w);
    out.push(s);
    // Word pairs ("click_day", "held_back") reward the reader's phrase.
    if (options.pairs && prev) out.push(`${prev}_${s}`);
    prev = s;
  }
  return out;
}

/** Character trigrams of the joined tokens, for the question bank's fuzzy pass. */
export function trigrams(tokens: string[]): Set<string> {
  const s = ` ${tokens.filter((t) => !t.startsWith("syn") && !t.includes("_")).join(" ")} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

/** The edit distance between a and b (letters added, dropped, changed, or two side by side swapped), or max + 1 once it is over max. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push([i]);
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      if (i === 0) {
        rows[0].push(j);
        continue;
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, rows[i - 2][j - 2] + 1);
      rows[i].push(v);
      if (v < low) low = v;
    }
    if (i > 0 && low > max) return max + 1;
  }
  return Math.min(rows[a.length][b.length], max + 1);
}

/**
 * Spelling for the docs' own words. A question word of five letters or more
 * that the docs never use, one letter off a word they do use (two for nine
 * letters or more) and starting with the same letter, reads as that word:
 * "boking" is "booking", "calender" is "calendar". The first letter and the
 * length keep ordinary words from turning into docs words ("cook" stays).
 * A five-letter word may gain, lose or swap a letter ("windo", "delet") but
 * not change one, since that turns too many names into docs words ("paris"
 * is not "parts"). A letter on the end is another word, not a slip ("pasta"
 * is not "past"), unless it is a plural s ("motels") or repeats the one
 * before ("bookingg"). Ties go to the word the docs use most.
 */
/** True when b is a with two letters side by side swapped. */
function swapped(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i + 1 < a.length && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
}

export function createSpeller(counts: Map<string, number>): (text: string) => string {
  const byStart = new Map<string, string[]>();
  for (const w of counts.keys()) {
    if (w.length < 4 || STOP_WORDS.has(w)) continue;
    const list = byStart.get(w[0]) ?? [];
    list.push(w);
    byStart.set(w[0], list);
  }
  const cache = new Map<string, string>();
  const fix = (w: string): string => {
    if (w.length < 5 || counts.has(w) || STOP_WORDS.has(w) || !/^[a-z]+$/.test(w)) return w;
    const hit = cache.get(w);
    if (hit !== undefined) return hit;
    const max = w.length >= 9 ? 2 : 1;
    let best = w;
    let bestD = max + 1;
    let bestN = 0;
    for (const c of byStart.get(w[0]) ?? []) {
      if (Math.abs(c.length - w.length) > max) continue;
      const d = editDistance(w, c, max);
      if (d > max) continue;
      if (w.length < 6 && c.length === w.length && !swapped(w, c)) continue;
      if (extraLastLetter(w, c)) continue;
      const n = counts.get(c) ?? 0;
      if (d < bestD || (d === bestD && n > bestN)) {
        best = c;
        bestD = d;
        bestN = n;
      }
    }
    if (cache.size < 5000) cache.set(w, best);
    return best;
  };
  return (text: string) =>
    clean(text)
      .split(" ")
      .map((w) => (w ? fix(w) : w))
      .join(" ");
}

/** True when a is b with one more letter on the end, other than a plural s or a repeat of the letter before it. */
function extraLastLetter(a: string, b: string): boolean {
  const last = a[a.length - 1];
  return a.length === b.length + 1 && a.startsWith(b) && last !== "s" && last !== b[b.length - 1];
}

/**
 * For each word of the text (stemmed), the synonym groups of every phrase it
 * is part of: "max rate" gives "max" and "rate" the ceiling group, so a page
 * that says "ceiling" covers them both.
 */
export function synonymCover(text: string, synonyms: SynonymTable): Map<string, number[]> {
  const words = clean(text).split(" ").filter(Boolean);
  const out = new Map<string, number[]>();
  for (let i = 0; i < words.length; i++) {
    for (let n = Math.min(synonyms.longest, words.length - i); n >= 1; n--) {
      const ids = synonyms.phrases.get(words.slice(i, i + n).join(" "));
      if (!ids) continue;
      for (const w of words.slice(i, i + n)) {
        if (STOP_WORDS.has(w)) continue;
        const s = stemWord(w);
        const list = out.get(s) ?? [];
        for (const id of ids) if (!list.includes(id)) list.push(id);
        out.set(s, list);
      }
    }
  }
  return out;
}
