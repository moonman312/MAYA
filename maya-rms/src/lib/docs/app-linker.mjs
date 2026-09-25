// The docs' automatic links into MAYA: a remark plugin, run when a page is
// rendered (app/docs/[section]/[page]/page.tsx).
//
// Every <Ui> label that names a place in MAYA (app-labels.json) gets `to` and
// `q` attributes, which the Ui component turns into a link only signed-in
// readers see. Listed phrases in plain text ("change log", "PMS tab") become
// <AppLink> the same way. The words themselves never change, so a visitor
// reads exactly the page they always did.
//
// Never linked: headings (the title, the table of contents and breadcrumbs
// repeat them), anything already a link, code, <Related>, <OpenInMaya>, an
// existing <AppLink>, a <Ui off>, a <Ui> that already names its own `to`, a
// table's header row, and attribute strings (callout and example titles).
// One clutter guard: the same place links at most PER_BLOCK times in one
// paragraph or table cell.

export const PER_BLOCK = 1;

const NO_DESCENT = new Set(["heading", "link", "linkReference", "inlineCode", "code", "definition", "html"]);
const LEAVE_ALONE = new Set(["Related", "OpenInMaya", "AppLink"]);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasAttr(node, name) {
  return (node.attributes || []).some((a) => a.type === "mdxJsxAttribute" && a.name === name);
}

function textOf(node) {
  if (!node) return "";
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (Array.isArray(node.children)) return node.children.map(textOf).join("");
  return "";
}

function jsxAttr(name, value) {
  return { type: "mdxJsxAttribute", name, value };
}

/** The dictionary entry for a label on a page: page override, section override, then the label list. */
export function entryFor(dict, page, label) {
  const section = `${String(page).split("/")[0]}/*`;
  for (const o of [dict.pages?.[page], dict.pages?.[section]]) {
    if (o && Object.prototype.hasOwnProperty.call(o, label)) return o[label];
  }
  return dict.labels?.[label] ?? null;
}

export function createAppLinker(dict) {
  const phrases = Object.keys(dict.phrases ?? {}).sort((a, b) => b.length - a.length);
  const phraseRe = phrases.length
    ? new RegExp(`(?<![\\p{L}\\p{N}])(${phrases.map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`, "gu")
    : null;

  return function remarkAppLinks(options = {}) {
    const page = options.page ?? "";

    return function transform(tree) {
      let used = new Map();

      function take(entry) {
        const key = `${entry.to}?${entry.q ?? ""}`;
        const n = used.get(key) ?? 0;
        if (n >= PER_BLOCK) return false;
        used.set(key, n + 1);
        return true;
      }

      function linkUi(node) {
        if (hasAttr(node, "to") || hasAttr(node, "off")) return;
        const entry = entryFor(dict, page, textOf(node).replace(/\s+/g, " ").trim());
        if (!entry || !take(entry)) return;
        node.attributes = [...(node.attributes || []), jsxAttr("to", entry.to)];
        if (entry.q) node.attributes.push(jsxAttr("q", entry.q));
      }

      function splitPhrases(textNode) {
        if (!phraseRe) return [textNode];
        const value = textNode.value;
        const out = [];
        let last = 0;
        for (const m of value.matchAll(phraseRe)) {
          const entry = dict.phrases[m[1]];
          if (!entry || !take(entry)) continue;
          if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
          const attributes = [jsxAttr("to", entry.to)];
          if (entry.q) attributes.push(jsxAttr("q", entry.q));
          out.push({ type: "mdxJsxTextElement", name: "AppLink", attributes, children: [{ type: "text", value: m[1] }] });
          last = m.index + m[1].length;
        }
        if (!out.length) return [textNode];
        if (last < value.length) out.push({ type: "text", value: value.slice(last) });
        return out;
      }

      function walkChildren(node, skip) {
        if (!Array.isArray(node.children)) return;
        const next = [];
        for (const child of node.children) {
          if (child.type === "text" && !skip) next.push(...splitPhrases(child));
          else {
            walk(child, skip);
            next.push(child);
          }
        }
        node.children = next;
      }

      function walk(node, skip) {
        if (NO_DESCENT.has(node.type)) return;
        if (node.type === "table") {
          (node.children || []).forEach((row, i) => walk(row, skip || i === 0));
          return;
        }
        const block = node.type === "paragraph" || node.type === "tableCell";
        const outer = used;
        if (block) used = new Map();
        if (node.type === "mdxJsxTextElement" || node.type === "mdxJsxFlowElement") {
          if (node.name === "Ui") {
            if (!skip) linkUi(node);
          } else if (!LEAVE_ALONE.has(node.name)) {
            walkChildren(node, skip);
          }
        } else {
          walkChildren(node, skip);
        }
        if (block) used = outer;
      }

      walk(tree, false);
    };
  };
}
