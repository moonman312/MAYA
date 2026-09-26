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
    "exactly actually really kind sort bit lot lots whats whos wheres hows thats theres lets heres"
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
 * A synonym group's token, `syn<n>`. Only the digits tell it apart from a
 * reader's word that starts the same way: "syncing" stems to "sync".
 */
export const isSynonymToken = (t: string) => /^syn\d+$/.test(t);

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
  const s = ` ${tokens.filter((t) => !isSynonymToken(t) && !t.includes("_")).join(" ")} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}
