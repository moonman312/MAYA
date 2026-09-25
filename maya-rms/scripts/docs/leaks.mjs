// Nothing internal may reach a docs page or a generated docs index: no HTML
// or JSX comments (where source notes used to hide), no home-directory or
// temp paths, no setting names, no code file names. The list and the loop
// are the hand-off check, unchanged.
//
// Scan page sources and generated text indexes, never rendered HTML: React
// writes <!-- --> between adjacent text nodes, so rendered pages always
// contain "<!--".

export const FORBIDDEN = [
  { name: 'HTML comment', re: /<!--/g },
  { name: 'JSX comment', re: /\{\s*\/\*/g },
  { name: 'home directory path', re: /\/Users\//g },
  { name: 'temp path', re: /\/private\/(?:tmp|var)\//g },
  { name: 'setting name', re: /\bMAYA_[A-Z0-9_]*/g },
  { name: 'code file name', re: /\.tsx?\b|\.mjs\b|\.sql\b/g },
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
