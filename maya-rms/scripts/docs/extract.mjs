// Turns one docs page body (MDX) into what the indexes need: its headings
// with the same ids the page renders, its sections as plain passages, its
// links, and any problems a reader would trip over.
//
// Passages are "markdown-lite": paragraphs split by blank lines, "- " list
// items, **bold**, [text](/docs/...) links and "| a | b |" table rows. The
// docs helper renders exactly that and nothing more.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMdx from "remark-mdx";
import remarkGfm from "remark-gfm";
import fs from "node:fs";
import GithubSlugger from "github-slugger";
import { fallbackFor, WIDGET_NAMES } from "../../src/lib/docs/widget-fallbacks.mjs";
import { createLinks } from "../../src/lib/deep-links/core.mjs";

// The app's own link registry: a docs link into MAYA is checked with the same
// parser /go uses, so the docs can never show a link the app reads differently.
const appLinks = createLinks(JSON.parse(fs.readFileSync(new URL("../../src/lib/deep-links/registry.json", import.meta.url), "utf8")));

const parser = unified().use(remarkParse).use(remarkMdx).use(remarkGfm);

export const PMS_LABELS = { cloudbeds: "Cloudbeds", thinkreservations: "ThinkReservations", mews: "Mews" };
export const CALLOUT_LABELS = {
  "good-to-know": "Good to know",
  careful: "Careful",
  example: "Example",
  "not-yet": "Not yet",
};
const LAYOUT_COMPONENTS = new Set([
  "InPlainWords", "Callout", "Ui", "Example", "PmsTabs", "PmsTab", "Steps", "Step", "Figure", "Related", "Group",
  "AppLink", "OpenInMaya",
]);
export const KNOWN_COMPONENTS = new Set([...LAYOUT_COMPONENTS, ...WIDGET_NAMES]);

// Links the helper may keep as links; everything else keeps only its words.
// Links into MAYA are never kept: the helper shows the same words to everyone.
const KEEP_LINK = /^(\/docs(\/|#|$)|\/support(#|$)|https:\/\/www\.get-maya\.com\/(privacy|terms)(#|$)|mailto:|#)/;

/**
 * Problems with a link into MAYA written in a page: an unknown place, one the
 * docs cannot open (it needs the property's own night or id), or any value
 * the app would change or drop. `extra` is the attributes other than `to`.
 */
export function appLinkProblems(to, extra) {
  if (typeof to !== "string" || !to) return ["needs to=\"<destination>\""];
  if (!appLinks.isDestination(to)) return [`to="${to}" is not a place in MAYA (see src/lib/deep-links/registry.json)`];
  if (!appLinks.destination(to).docsLinkable) return [`to="${to}" needs the property's own night or id, which the docs never have`];
  const params = {};
  for (const [k, v] of Object.entries(extra)) {
    if (k === "q" && typeof v === "string") for (const [qk, qv] of new URLSearchParams(v)) params[qk] = qv;
    else if (k !== "q") params[k] = typeof v === "string" ? v : String(v);
  }
  const parsed = appLinks.parseLink(to, params, { source: "docs" });
  return parsed.problems.map((p) => `to="${to}": ${p} is not something this link can carry`);
}

export function parseMdx(body) {
  return parser.parse(body);
}

function attr(node, name) {
  const a = (node.attributes || []).find((x) => x.type === "mdxJsxAttribute" && x.name === name);
  if (!a) return undefined;
  if (a.value === null || a.value === undefined) return true;
  if (typeof a.value === "string") return a.value;
  // {12} style expression: keep plain numbers and strings only
  const v = String(a.value.value).trim();
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^(['"]).*\1$/.test(v)) return v.slice(1, -1);
  return v;
}

function attrs(node) {
  const out = {};
  for (const a of node.attributes || []) if (a.type === "mdxJsxAttribute") out[a.name] = attr(node, a.name);
  return out;
}

// Attributes of <AppLink> and <OpenInMaya> that are not values for the link,
// as in paramsOf (src/components/docs/app-links/server.tsx).
const NOT_LINK_VALUES = new Set(["to", "children", "off", "words"]);

/**
 * The words in a {…} value that is only a quoted string, as {"Nearly full"}
 * or {'enabled'}: the page gets those words just as if they were written
 * name="Nearly full". Anything else in braces (a number, a name, a
 * `template`, "a" + "b") gives undefined: the build does not work out what
 * it comes to.
 */
function quotedWords(value) {
  const body = value?.data?.estree?.body ?? [];
  const e = body.length === 1 && body[0].type === "ExpressionStatement" ? body[0].expression : undefined;
  return e?.type === "Literal" && typeof e.value === "string" ? e.value : undefined;
}

/**
 * Problems with a link into MAYA, read the way the page renders it: only
 * words reach the link, written out or quoted in braces, so a bare attribute
 * (true) or any other {…} value (a number, say) would be dropped from it.
 * `attributes` defaults to all of the node's.
 */
function linkProblems(node, attributes = node.attributes || []) {
  const out = [];
  const extra = {};
  for (const a of attributes) {
    const words = typeof a.value === "string" ? a.value : quotedWords(a.value);
    if (a.type !== "mdxJsxAttribute") out.push("a {…} attribute would be dropped from the link; write each value out");
    else if (NOT_LINK_VALUES.has(a.name)) continue;
    else if (words !== undefined) extra[a.name] = words;
    else out.push(`${a.name}${a.value ? "={…}" : ""} would be dropped from the link; write ${a.name}="..."`);
  }
  return [...out, ...appLinkProblems(attr(node, "to"), extra)];
}

/** Problems with a <Ui>: it hands only `to` and `q` to its link, and `off` keeps the linker away. */
function uiProblems(node) {
  const all = node.attributes || [];
  const out = all
    .filter((a) => a.type !== "mdxJsxAttribute" || !["to", "q", "off"].includes(a.name))
    .map((a) => `takes only to=, q= and off; ${a.type === "mdxJsxAttribute" ? a.name : "{…}"} would be dropped`);
  if (attr(node, "to") === undefined) return out;
  return [...out, ...linkProblems(node, all.filter((a) => a.type === "mdxJsxAttribute" && a.name === "q"))];
}

/**
 * Plain text of a node, the way a heading id is worked out from it: every
 * space as written, and a line break as the new line it renders as.
 */
export function toText(node) {
  if (!node) return "";
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (node.type === "break") return "\n";
  if (Array.isArray(node.children)) return node.children.map(toText).join("");
  return "";
}

function cleanSpaces(s) {
  return s.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
}

/**
 * Walks a page and returns { headings, sections, links, components, problems }.
 * `ctx.path` is the page's own path ("rules/booking-speed").
 */
export function extractPage(body, ctx = {}) {
  const tree = parseMdx(body);
  const slugger = new GithubSlugger();
  const problems = [];
  const links = [];
  const components = [];
  const headings = [];
  const where = (node) => (node && node.position ? node.position.start.line : 0);
  const problem = (node, message) => problems.push({ line: where(node) + (ctx.lineOffset || 0), message });

  // Heading ids first, in document order over every heading, as rehype-slug
  // does: from the words exactly as written, so "Foo  bar" is foo--bar there
  // and here. Also where each [words][ref] link goes: its "[ref]: url" line,
  // the first one when there are two, as the page renders it.
  const idFor = new Map();
  const defined = new Map();
  (function visit(node) {
    if (node.type === "heading") idFor.set(node, slugger.slug(toText(node)));
    if (node.type === "definition" && !defined.has(node.identifier)) defined.set(node.identifier, node.url);
    if (Array.isArray(node.children)) node.children.forEach(visit);
  })(tree);

  function inline(nodes) {
    let md = "";
    for (const n of nodes || []) {
      switch (n.type) {
        case "text":
          md += n.value;
          break;
        case "inlineCode":
          md += n.value;
          break;
        case "break":
          md += "\n";
          break;
        case "strong": {
          const inner = inline(n.children);
          md += inner.startsWith("**") && inner.endsWith("**") ? inner : `**${inner}**`;
          break;
        }
        case "emphasis":
        case "delete":
          md += inline(n.children);
          break;
        case "link":
        case "linkReference": {
          // [words][ref] renders as a link too, so it gets the same checks.
          const url = n.type === "link" ? n.url : (defined.get(n.identifier) ?? "");
          links.push({ url, line: where(n) + (ctx.lineOffset || 0) });
          const text = inline(n.children);
          md += KEEP_LINK.test(url) ? `[${text.replace(/\*\*/g, "")}](${url})` : text;
          break;
        }
        case "image":
          md += n.alt || "";
          break;
        case "mdxJsxTextElement": {
          components.push(n.name);
          if (n.name === "AppLink") for (const p of linkProblems(n)) problem(n, `<AppLink> ${p}`);
          if (n.name === "Ui") for (const p of uiProblems(n)) problem(n, `<Ui> ${p}`);
          if (n.name === "OpenInMaya") problem(n, "<OpenInMaya ... /> goes on a line of its own, self-closing, not inside a sentence");
          if (n.name === "Ui") {
            const inner = inline(n.children);
            md += inner ? `**${inner.replace(/\*\*/g, "")}**` : "";
          } else if (!KNOWN_COMPONENTS.has(n.name || "")) {
            problem(n, `unknown component <${n.name}>`);
            md += inline(n.children);
          } else {
            md += inline(n.children);
          }
          break;
        }
        case "mdxTextExpression":
          problem(n, "a {…} expression in the text (write the words out, or escape the brace as \\{)");
          break;
        default:
          if (Array.isArray(n.children)) md += inline(n.children);
          else if (typeof n.value === "string") md += n.value;
      }
    }
    return md;
  }

  // A block: { md, lead? } where lead is the bold words a paragraph or list item opens with.
  function leadOf(children) {
    const first = (children || []).find((c) => !(c.type === "text" && c.value.trim() === ""));
    if (!first) return undefined;
    if (first.type === "strong") return cleanSpaces(toText(first)).replace(/[.:]$/, "");
    if (first.type === "mdxJsxTextElement" && first.name === "Ui") return undefined;
    return undefined;
  }

  function listItemMd(item, marker) {
    const parts = [];
    for (const child of item.children || []) {
      if (child.type === "paragraph") parts.push(inline(child.children));
      else if (child.type === "list") parts.push(listMd(child).map((l) => "  " + l).join("\n"));
      else parts.push(blocksMd(child).map((b) => b.md).join("\n"));
    }
    const text = parts.join("\n").trim();
    return `${marker} ${text}`;
  }

  function listMd(list) {
    return (list.children || []).map((item, i) =>
      listItemMd(item, list.ordered ? `${(list.start || 1) + i}.` : "-"),
    );
  }

  function tableMd(table) {
    const rows = (table.children || []).map(
      (row) => "| " + (row.children || []).map((cell) => inline(cell.children).replace(/\|/g, "/").replace(/\n/g, " ")).join(" | ") + " |",
    );
    if (rows.length > 1) {
      const cols = (table.children[0].children || []).length;
      rows.splice(1, 0, "|" + Array(cols).fill("---").join("|") + "|");
    }
    return rows.join("\n");
  }

  // Returns a list of blocks for one flow node.
  function blocksMd(node) {
    switch (node.type) {
      case "paragraph": {
        const md = cleanSpaces(inline(node.children));
        return md ? [{ md, lead: leadOf(node.children) }] : [];
      }
      case "heading":
        // Only reached for headings nested inside components.
        return [{ md: `**${cleanSpaces(inline(node.children)).replace(/\*\*/g, "")}**` }];
      case "list": {
        const items = listMd(node).map((md, i) => ({ md, lead: leadOf(node.children[i].children?.[0]?.children), item: true }));
        return items;
      }
      case "table":
        return [{ md: tableMd(node), table: true }];
      case "blockquote":
        return (node.children || []).flatMap(blocksMd);
      case "thematicBreak":
        return [];
      case "code":
        return [{ md: node.value }];
      case "html":
        problem(node, "raw HTML in a page (use a component instead)");
        return [];
      case "mdxjsEsm":
        problem(node, "import or export in a page (the docs take no code)");
        return [];
      case "mdxFlowExpression":
        problem(node, "a {…} expression or comment in a page");
        return [];
      case "mdxJsxFlowElement":
        return componentBlocks(node);
      default:
        if (Array.isArray(node.children)) return node.children.flatMap(blocksMd);
        return [];
    }
  }

  function childBlocks(node) {
    // A component written on one line holds inline content, not paragraphs.
    const kids = node.children || [];
    const inlineKids = kids.every((k) => !["paragraph", "list", "table", "heading", "mdxJsxFlowElement", "blockquote", "code"].includes(k.type));
    if (inlineKids && kids.length) {
      const md = cleanSpaces(inline(kids));
      return md ? [{ md, lead: leadOf(kids) }] : [];
    }
    return kids.flatMap(blocksMd);
  }

  function prefixFirst(blocks, prefix) {
    if (!blocks.length) return [{ md: prefix.trim() }];
    const [first, ...rest] = blocks;
    // A list or table keeps its shape: the label goes on a line of its own.
    if (first.item || first.table) return [{ md: prefix.trim() }, ...blocks];
    return [{ ...first, md: prefix + first.md, lead: undefined }, ...rest];
  }

  function componentBlocks(node) {
    const name = node.name || "";
    components.push(name);
    if (!KNOWN_COMPONENTS.has(name)) {
      problem(node, `unknown component <${name}>`);
      return childBlocks(node);
    }
    switch (name) {
      case "InPlainWords":
        return childBlocks(node).map((b) => ({ ...b, ipw: true, lead: undefined }));
      case "Callout": {
        const kind = attr(node, "kind");
        const label = CALLOUT_LABELS[kind];
        if (!label) problem(node, `<Callout kind="${kind}"> is not one of ${Object.keys(CALLOUT_LABELS).join(", ")}`);
        const title = attr(node, "title");
        const head = `**${label || "Note"}${title ? `: ${title}` : ""}** · `;
        return prefixFirst(childBlocks(node), head).map((b) => ({ ...b, callout: true }));
      }
      case "Example": {
        const title = attr(node, "title");
        if (!title) problem(node, "<Example> needs a title");
        return [{ md: `**Example: ${title || ""}**`, callout: true }, ...childBlocks(node).map((b) => ({ ...b, lead: undefined }))];
      }
      case "PmsTabs":
        return (node.children || []).flatMap((child) => {
          if (child.type === "mdxJsxFlowElement" && child.name === "PmsTab") return componentBlocks(child);
          if (child.type === "paragraph" && toText(child).trim() === "") return [];
          problem(child, "<PmsTabs> should hold only <PmsTab> elements");
          return blocksMd(child);
        });
      case "PmsTab": {
        const pms = attr(node, "pms");
        const label = PMS_LABELS[pms];
        if (!label) problem(node, `<PmsTab pms="${pms}"> is not cloudbeds, thinkreservations or mews`);
        return prefixFirst(childBlocks(node), `**${label || pms}:** `);
      }
      case "Steps": {
        let n = 0;
        return (node.children || []).flatMap((child) => {
          if (child.type === "mdxJsxFlowElement" && child.name === "Step") {
            n++;
            components.push("Step");
            const title = attr(child, "title");
            const inner = childBlocks(child);
            if (title) return [{ md: `**${n}. ${title}**` }, ...inner.map((b) => ({ ...b, lead: undefined }))];
            return prefixFirst(inner, `${n}. `);
          }
          // <Step>…</Step> lines written without blank lines between them
          // arrive as one paragraph of inline steps.
          if (child.type === "paragraph") {
            const inlineSteps = (child.children || []).filter((k) => k.type === "mdxJsxTextElement" && k.name === "Step");
            const rest = (child.children || []).filter(
              (k) => !(k.type === "mdxJsxTextElement" && k.name === "Step") && !(k.type === "text" && k.value.trim() === ""),
            );
            if (inlineSteps.length && !rest.length) {
              return inlineSteps.flatMap((step) => {
                n++;
                components.push("Step");
                const title = attr(step, "title");
                const md = cleanSpaces(inline(step.children));
                return title ? [{ md: `**${n}. ${title}**` }, { md }] : [{ md: `${n}. ${md}` }];
              });
            }
            if (toText(child).trim() === "") return [];
          }
          problem(child, "<Steps> should hold only <Step> elements");
          return blocksMd(child);
        });
      }
      case "Step":
        problem(node, "<Step> outside <Steps>");
        return childBlocks(node);
      case "Group":
        return childBlocks(node);
      case "Related": {
        const kids = childBlocks(node);
        const count = kids.filter((b) => b.item).length;
        if (count > 3) problem(node, `<Related> lists ${count} links; three at most`);
        return [];
      }
      case "Figure": {
        const alt = attr(node, "alt");
        const caption = attr(node, "caption");
        if (!alt) problem(node, "<Figure> needs alt text");
        return [{ md: [alt, caption].filter(Boolean).join(". ") }];
      }
      case "Ui":
        for (const p of uiProblems(node)) problem(node, `<Ui> ${p}`);
        return [{ md: `**${cleanSpaces(inline(node.children))}**` }];
      case "AppLink": {
        for (const p of linkProblems(node)) problem(node, `<AppLink> ${p}`);
        return childBlocks(node);
      }
      case "OpenInMaya": {
        // A button only signed-in readers see: no words for search or the helper.
        const words = attr(node, "words");
        for (const p of linkProblems(node)) problem(node, `<OpenInMaya> ${p}`);
        if (typeof words !== "string" || !words.trim()) problem(node, '<OpenInMaya> needs words="...": the owner doing something');
        if ((node.children || []).length) problem(node, "<OpenInMaya> takes its words in words=\"...\" and closes itself: <OpenInMaya ... />");
        return [];
      }
      default: {
        const sentence = fallbackFor(name, attrs(node));
        return sentence ? [{ md: sentence, widget: name }] : [];
      }
    }
  }

  // Top level: split into sections at H2 and H3.
  const sections = [];
  let current = { depth: 1, title: "In plain words", anchor: "", blocks: [] };
  sections.push(current);
  let firstFlow = null;
  for (const node of tree.children) {
    if (node.type === "mdxjsEsm" || node.type === "mdxFlowExpression" || node.type === "html") {
      blocksMd(node);
      continue;
    }
    if (!firstFlow) firstFlow = node;
    if (node.type === "heading" && (node.depth === 2 || node.depth === 3)) {
      const text = cleanSpaces(toText(node));
      const id = idFor.get(node);
      headings.push({ depth: node.depth, text, id });
      current = { depth: node.depth, title: text, anchor: id, blocks: [] };
      sections.push(current);
      continue;
    }
    if (node.type === "heading" && node.depth === 1) {
      problem(node, "a # heading in the body (the title is the page's only H1; start at ##)");
    }
    current.blocks.push(...blocksMd(node));
  }

  if (!firstFlow || firstFlow.type !== "mdxJsxFlowElement" || firstFlow.name !== "InPlainWords") {
    problem(firstFlow, "the first thing on the page must be <InPlainWords>");
  }

  const ipw = sections[0].blocks.filter((b) => b.ipw).map((b) => b.md).join("\n\n");
  return { headings, sections, links, components, problems, ipw, allIds: [...idFor.values()] };
}

/** Markdown-lite to plain words: what search, reading time and matching read. */
export function mdToPlain(md) {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/^\|?-{3,}.*$/gm, "")
    .replace(/\|/g, " ")
    .replace(/^\s*(?:-|\d+\.)\s+/gm, "")
    .replace(/\\([<>{}*_[\]()#`|!])/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function wordCount(text) {
  const m = text.match(/[A-Za-z0-9$%€£][A-Za-z0-9$%€£'.,:/-]*/g);
  return m ? m.length : 0;
}
