// General questions that name no topic ("how do I use this?", "hi",
// "can I talk to a person?") and the set reply for each. The data is
// content/docs-helper-replies.json, packed into the helper's index by the
// docs build. Pure functions: respond.ts decides when a set reply answers.
//
// A question is compared with every example of every intent, word by word:
// casual spellings fixed ("u" is "you", "dose" is "does"), repeated letters
// squeezed ("helpp"), a word the docs never use allowed one typo ("helo"),
// filler dropped ("um", "so", "please"), then stemmed. The score is a weighted F1 of the shared words, where stop
// words and "light" words (hi, thanks, please) count for little, so a word
// another intent or list knows ("is MAYA AI?" has "maya") keeps it from
// matching "is this AI?". Words no example or list uses are left out of the
// score and returned as the question's own subject (`residual`): a question
// with any is specific, and the docs answer it first.

import { clean, STOP_WORDS, stemWord } from "./normalize.ts";
import type { AskIntent, AskReplies } from "./match.ts";

/** how much a stop word or a light word counts, next to 1 for any other */
const LIGHT = 0.3;
/** stop words that change what a question means: "what can MAYA not do?" is not "what can MAYA do?" */
const NEGATION = new Set(["not", "no", "never", "nothing", "without"]);
/** a quoted phrase is a message pasted from the screen, which the docs explain */
const QUOTED = /["\u201c\u201d][^"\u201c\u201d]*\s[^"\u201c\u201d]*["\u201c\u201d]/;
/** at or above: the question is this intent */
export const INTENT_MATCH = 0.75;
/**
 * at or above, when every word of the question that carries meaning is one
 * of this intent's own words: "can someone explain how to use this" joins
 * two of the page intent's examples and matches neither closely
 */
export const INTENT_COVERED = 0.55;

export interface IntentMatch {
  intent: AskIntent;
  /** 0 to 1, over the words the intents know */
  score: number;
  /** the question's words that are its own subject (stemmed): none of the intent's examples or the lists use them */
  residual: string[];
}

export interface IntentMatcher {
  match(question: string): IntentMatch | null;
  /** the question as the intents read it: [word as typed after fixes, stem] */
  words(question: string): { raw: string; stem: string }[];
}

/** True when a and b are one edit apart (a letter added, dropped, changed, or two swapped). */
export function oneEditApart(a: string, b: string): boolean {
  if (a === b) return false;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** True when b is a with two letters side by side swapped. */
function swapped(a: string, b: string): boolean {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.length === b.length && i + 1 < a.length && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
}

/**
 * `knows(stem)`: true when the docs use the word. Only a word the docs never
 * use is read as a typo of an example's word, so "code" never becomes "come".
 */
export function createIntents(replies: AskReplies, knows: (stem: string) => boolean = () => false): IntentMatcher {
  const fixes = new Map(Object.entries(replies.fixes));
  const filler = new Set(replies.filler ?? []);
  const lightRaw = new Set(replies.light);
  const neutralRaw = new Set(replies.neutral);

  // Every word the examples and lists use, as typed (for typo repair) and as stems.
  const known = new Set<string>([...lightRaw, ...neutralRaw]);
  for (const it of replies.intents) for (const ex of it.examples) for (const w of clean(ex).split(" ")) if (w) known.add(w);
  const knownList = [...known].filter((w) => w.length >= 3);

  function repair(w: string): string[] {
    const fixed = fixes.get(w);
    if (fixed) return fixed.split(" ");
    if (known.has(w) || STOP_WORDS.has(w) || /\d/.test(w)) return [w];
    // "helppp", "hellooo"; a doubled letter is squeezed only when three letters or more are left ("sso" is not "so")
    const doubled = w.replace(/(.)\1+/g, "$1");
    for (const squeezed of [w.replace(/(.)\1{2,}/g, "$1"), doubled.length >= 3 ? doubled : w, w.replace(/(.)\1{2,}/g, "$1$1")]) {
      if (squeezed !== w && (known.has(squeezed) || fixes.has(squeezed))) return repair(squeezed);
    }
    if (w.length >= 4 && !knows(stemWord(w))) {
      // A short word may gain, lose or swap a letter ("helo") but not change one ("cook" is not "cool").
      const near = knownList.filter((k) => oneEditApart(w, k) && (w.length >= 6 || k.length !== w.length || swapped(w, k)));
      if (near.length === 1) return [near[0]];
    }
    return [w];
  }

  function words(question: string): { raw: string; stem: string }[] {
    const out: { raw: string; stem: string }[] = [];
    for (const w of clean(question).split(" ")) {
      if (!w) continue;
      for (const r of repair(w)) if (!filler.has(r)) out.push({ raw: r, stem: stemWord(r) });
    }
    return out;
  }

  const weightOf = (raw: string) => (NEGATION.has(raw) ? 1 : STOP_WORDS.has(raw) || lightRaw.has(raw) ? LIGHT : 1);
  const isStop = (raw: string) => STOP_WORDS.has(raw) && !NEGATION.has(raw);
  const lightStem = new Set([...lightRaw].map(stemWord));
  const neutralStem = new Set([...neutralRaw].map(stemWord));

  type Bag = Map<string, number>;
  const bag = (ws: { raw: string; stem: string }[]): Bag => {
    const b: Bag = new Map();
    for (const w of ws) b.set(w.stem, Math.max(b.get(w.stem) ?? 0, weightOf(w.raw)));
    return b;
  };
  const total = (b: Bag) => [...b.values()].reduce((n, x) => n + x, 0);

  const prepared = replies.intents.map((intent) => {
    const examples = intent.examples.map((e) => bag(words(e))).filter((b) => b.size > 0);
    const vocab = new Set<string>();
    for (const b of examples) for (const k of b.keys()) vocab.add(k);
    return { intent, examples: examples.map((b) => ({ b, w: total(b) })), vocab };
  });
  const anyVocab = new Set<string>([...lightStem, ...neutralStem]);
  for (const p of prepared) for (const k of p.vocab) anyVocab.add(k);

  function f1(q: Bag, qw: number, e: Bag, ew: number): number {
    let shared = 0;
    for (const [k, w] of q) if (e.has(k)) shared += Math.min(w, e.get(k) ?? 0);
    if (!shared) return 0;
    const p = shared / qw;
    const r = shared / ew;
    return (2 * p * r) / (p + r);
  }

  function match(question: string): IntentMatch | null {
    if (QUOTED.test(question)) return null;
    const ws = words(question);
    if (!ws.length) {
      // Only punctuation or symbols ("?", "..."): the reader wants a way in. Only filler ("um"): nothing to go on.
      if (!question.trim() || clean(question)) return null;
      const help = prepared.find((p) => p.intent.id === "help");
      return help ? { intent: help.intent, score: 1, residual: [] } : null;
    }
    // Scored on the words the intents know; a stop word counts even when no example has it.
    const q = bag(ws.filter((w) => anyVocab.has(w.stem) || STOP_WORDS.has(w.raw)));
    if (!q.size) return null;
    const qw = total(q);
    let best: (typeof prepared)[number] | null = null;
    let bestScore = 0;
    // Two or more words that carry meaning, and no word such as "maya" that names a subject ("is MAYA AI?").
    const own = ws.filter((w) => !isStop(w.raw) && !lightStem.has(w.stem) && !neutralStem.has(w.stem));
    const coverable = own.length >= 2 && !ws.some((w) => neutralStem.has(w.stem));
    let covered: (typeof prepared)[number] | null = null;
    let coveredScore = 0;
    for (const p of prepared) {
      let top = 0;
      for (const e of p.examples) top = Math.max(top, f1(q, qw, e.b, e.w));
      if (top > bestScore + 1e-9) {
        bestScore = top;
        best = p;
      }
      if (coverable && top > coveredScore + 1e-9 && own.every((w) => p.vocab.has(w.stem))) {
        coveredScore = top;
        covered = p;
      }
    }
    if ((!best || bestScore < INTENT_MATCH) && covered && coveredScore >= INTENT_COVERED) {
      best = covered;
      bestScore = coveredScore;
    }
    if (!best || bestScore < INTENT_COVERED) return null;
    if (bestScore < INTENT_MATCH && best !== covered) return null;
    const vocab = best.vocab;
    const residual = [
      ...new Set(
        ws
          .filter((w) => !isStop(w.raw) && !lightStem.has(w.stem) && !neutralStem.has(w.stem) && !vocab.has(w.stem))
          .map((w) => w.stem),
      ),
    ];
    return { intent: best.intent, score: Math.round(bestScore * 1000) / 1000, residual };
  }

  return { match, words };
}
