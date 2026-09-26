// Nothing internal may reach a docs page or a generated docs index: no HTML
// or JSX comments (where source notes used to hide), no home-directory or
// temp paths, no setting names, no code file names. The loop is the hand-off
// check, unchanged; the list is its list, widened to Linux paths, every
// SETTING_NAME and file names after a folder (so "Next.js" stays words).
//
// Scan page sources and generated text indexes, never rendered HTML: React
// writes <!-- --> between adjacent text nodes, so rendered pages always
// contain "<!--".

// A path starts a line, or follows a space, a quote, a bracket or "=".
const START = String.raw`(?<![^\s("'\`=])`;

export const FORBIDDEN = [
  { name: 'HTML comment', re: /<!--/g },
  { name: 'JSX comment', re: /\{\s*\/\*/g },
  { name: 'home directory path', re: new RegExp(String.raw`\/Users\/|${START}(?:\/home\/|\/root\/|~\/)`, 'g') },
  { name: 'temp path', re: new RegExp(String.raw`\/private\/(?:tmp|var)\/|\/var\/folders\/|${START}\/tmp\/`, 'g') },
  { name: 'setting name', re: /\bMAYA_[A-Z0-9_]*|\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/g },
  { name: 'code file name', re: /\.tsx?\b|\.mjs\b|\.sql\b|[\w-]+\/[\w./-]*\.(?:json|js|md|py)\b/g },
  { name: 'env file', re: /\.env\b/g },
  { name: 'internal folder', re: /\bscratchpad\b|\bworktree\b/gi },
];

export function scanText(text) {
  const hits = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const { name, re } of FORBIDDEN) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        const from = Math.max(0, m.index - 30);
        hits.push({ line: i + 1, col: m.index + 1, name, found: m[0], context: line.slice(from, m.index + m[0].length + 30).trim() });
      }
    }
  });
  return hits;
}
