// Reading a docs page file: the frontmatter, the body, and the trailing notes
// some hand-off copies still carry. Plain JavaScript so the build script
// (scripts/docs-build.mjs) and the site share one copy under any Node version.

/**
 * Splits a page file into its frontmatter text and body.
 * The frontmatter is the block between the first two `---` lines.
 */
export function splitFrontmatter(raw) {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { frontmatter: null, body: text, bodyLine: 1 };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: null, body: text, bodyLine: 1 };
  const after = text.indexOf("\n", end + 4);
  const frontmatter = text.slice(4, end);
  const body = after === -1 ? "" : text.slice(after + 1);
  const bodyLine = frontmatter.split("\n").length + 3;
  return { frontmatter, body, bodyLine };
}

/**
 * Removes source notes left at the foot of a page: one or more trailing
 * `<!-- ... -->` or `{/* ... *\/}` blocks. Notes anywhere else stay, so the
 * leak scan still catches them.
 */
export function stripTrailingNotes(body) {
  let out = body.replace(/\s+$/, "");
  for (;;) {
    if (out.endsWith("-->")) {
      const start = out.lastIndexOf("<!--");
      if (start === -1) break;
      out = out.slice(0, start).replace(/\s+$/, "");
      continue;
    }
    if (/\*\/\s*\}$/.test(out)) {
      const start = out.search(/\{\s*\/\*(?![\s\S]*\{\s*\/\*)/);
      if (start === -1) break;
      out = out.slice(0, start).replace(/\s+$/, "");
      continue;
    }
    break;
  }
  return out + "\n";
}

function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return v;
}

function splitFlowList(inner) {
  const items = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      if (ch === quote) {
        if (quote === "'" && inner[i + 1] === "'") {
          cur += "'";
          i++;
        } else quote = null;
      }
      continue;
    }
    if ((ch === "'" || ch === '"') && cur.trim() === "") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ",") {
      items.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== "") items.push(cur);
  return items.map(unquote).filter((s) => s !== "");
}

function scalar(value) {
  const v = value.trim();
  if (v.startsWith("[") && v.endsWith("]")) return splitFlowList(v.slice(1, -1));
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === "true") return true;
  if (v === "false") return false;
  return unquote(v);
}

/**
 * The value on a `key: value` line. A quoted value runs to its own closing
 * quote, so a # inside it is kept, and a " # comment" may follow it. An
 * unquoted value may not hold " # ": YAML reads the rest as a comment, which
 * would cut the value short without a word.
 */
function lineValue(rest, lineNo) {
  const v = rest.trim();
  const q = v[0];
  if (q !== '"' && q !== "'") {
    if (/\s#(\s|$)/.test(v)) throw new Error(`frontmatter line ${lineNo}: " # " would cut the value short; put the value in quotes`);
    return v;
  }
  for (let i = 1; i < v.length; i++) {
    if (q === '"' && v[i] === "\\") i++;
    else if (q === "'" && v[i] === "'" && v[i + 1] === "'") i++;
    else if (v[i] === q) {
      if (/^(\s+#.*)?$/.test(v.slice(i + 1))) return v.slice(0, i + 1);
      break;
    }
  }
  throw new Error(`frontmatter line ${lineNo}: a value that starts with a quote must end with it`);
}

// A list item may end with {#anchor}: the heading (and passage) that
// answers it, as in `- Can I get a refund? {#refunds}`.
const ITEM_REF = /^(.*?)\s*\{#([^{}]*)\}\s*$/;

/**
 * Splits a list item into its words and the {#anchor} after them, if any.
 * `parseFrontmatter` keeps the anchor on the item, so this is the one place
 * that takes it off.
 */
export function splitRef(item) {
  const m = item.match(ITEM_REF);
  return m ? { text: m[1], ref: m[2].trim() } : { text: item, ref: null };
}

/**
 * Parses the small YAML subset the docs frontmatter uses: `key: value`
 * lines (the value is the rest of the line, so a colon inside a summary is
 * fine, and " # " needs quotes around it), `[a, b]` lists, and `- item` lists
 * under a key. A list item may end
 * with {#anchor} after its quotes; it is kept on the unquoted item. Throws
 * with the line number on anything else.
 */
export function parseFrontmatter(text) {
  const data = {};
  let listKey = null;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.trim() === "" || /^\s*#/.test(line)) return;
    const item = line.match(/^\s+-\s+(.*)$/) || line.match(/^-\s+(.*)$/);
    if (item && listKey) {
      const { text: words, ref } = splitRef(item[1]);
      data[listKey].push(ref === null ? unquote(words) : `${unquote(words)} {#${ref}}`);
      return;
    }
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_]*):(?:\s+(.*))?$/);
    if (!kv) throw new Error(`frontmatter line ${i + 2}: can't read "${line.trim()}"`);
    const [, key, rest] = kv;
    if (rest === undefined || rest.trim() === "") {
      data[key] = [];
      listKey = key;
      return;
    }
    listKey = null;
    data[key] = scalar(lineValue(rest, i + 2));
  });
  return data;
}

/** Sets `readingTime: n` in a page file, keeping every other byte as it was. */
export function withReadingTime(raw, minutes) {
  const { frontmatter } = splitFrontmatter(raw);
  if (frontmatter === null) return raw;
  const line = `readingTime: ${minutes}`;
  let next;
  if (/^readingTime:.*$/m.test(frontmatter)) {
    next = frontmatter.replace(/^readingTime:.*$/m, () => line);
  } else if (/^order:.*$/m.test(frontmatter)) {
    next = frontmatter.replace(/^(order:.*)$/m, (m) => `${m}\n${line}`);
  } else {
    next = `${frontmatter}\n${line}`;
  }
  if (next === frontmatter) return raw;
  const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  return text.replace(`---\n${frontmatter}\n---`, () => `---\n${next}\n---`);
}
