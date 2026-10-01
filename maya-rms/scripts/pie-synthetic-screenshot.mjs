/**
 * Draws a made-up screenshot of Cloudbeds PIE's "Rules and Alerts" page for
 * the screenshot reader's end-to-end test (src/lib/pie-import/ocr-e2e.test.ts):
 * the Minimum and Maximum Price, a PRICE LIMITS BY ACCOMMODATION TYPE table
 * and the rules table, laid out the way PIE lays them out, with made-up
 * names and numbers. It has a rule switched off, a Lower rule, a "today-N"
 * window, a fixed amount, a Manual rule, a Restriction rule and a last row
 * cut off by the bottom edge.
 *
 *   node scripts/pie-synthetic-screenshot.mjs
 *
 * writes src/lib/pie-import/__fixtures__/synthetic-pie.png. The PNG is
 * committed, so the test reads the same pixels on every machine (fonts
 * differ from one to the next); run this again only to change it.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "src", "lib", "pie-import", "__fixtures__", "synthetic-pie.png");

const W = 2000;
const FONT = "Helvetica, Arial, sans-serif";
const INK = "#2b2f38";
const HEAD = "#1f2a44";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const text = (x, y, s, o = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${o.size ?? 16}" font-weight="${o.weight ?? 400}" fill="${o.fill ?? INK}">${esc(s)}</text>`;

/** PIE wraps a description at about 58 characters. */
function wrap(s, max = 58) {
  const lines = [];
  let line = "";
  for (const word of s.split(" ")) {
    if ((line + " " + word).trim().length > max) {
      lines.push(line.trim());
      line = word;
    } else line += ` ${word}`;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

const RULES = [
  { name: "Busy weekends", mode: "Auto", type: "Occupancy", on: true, desc: "Raise rate by 12.00 % when occupancy is greater than 55.00 % and when booking 20-700 days in advance" },
  { name: "Near full", mode: "Auto", type: "Occupancy", on: true, desc: "Raise rate by 8.00 % when occupancy is greater than 82.00 %" },
  { name: "Quiet stretch", mode: "Auto", type: "Occupancy", on: true, desc: "Lower rate by 7.00 % when occupancy is lower than 25.00 % and when booking today-21 days in advance" },
  { name: "Flat bump", mode: "Auto", type: "Occupancy", on: false, desc: "Raise rate by 15.00 when occupancy is greater than 70.00 %" },
  { name: "Suggest only", mode: "Manual", type: "Occupancy", on: true, desc: "Raise rate by 5.00 % when occupancy is greater than 65.00 % and when booking 10-400 days in advance" },
  { name: "Two night stays", mode: "Auto", type: "Restriction", on: true, desc: "Set minimum stay to 2 nights when occupancy is greater than 90.00 %" },
  { name: "Late cut", mode: "Auto", type: "Occupancy", on: false, desc: "Lower rate by 9.00 % when occupancy is lower than 35.00 % and when booking today-3 days in advance" },
];

const LIMITS = [
  ["Garden Room", "$110.00", "$520.00"],
  ["Tree House - ADA", "$240.00", "$1,250.00"],
  ["Loft Suite", "$180.00", "$900.00"],
];

const parts = [`<rect width="${W}" height="2000" fill="#ffffff"/>`];

// Minimum and Maximum Price.
parts.push(text(98, 34, "Minimum Price", { weight: 600, fill: HEAD }), text(214, 34, "*", { fill: "#e0464f" }));
parts.push(text(420, 34, "Maximum Price", { weight: 600, fill: HEAD }), text(538, 34, "*", { fill: "#e0464f" }));
parts.push(text(98, 60, "$95.00"), text(420, 60, "$2,800.00"));
parts.push(`<rect x="740" y="22" width="98" height="46" rx="3" fill="#eeeeee"/>`, text(786, 52, "EDIT", { size: 15 }));

// PRICE LIMITS BY ACCOMMODATION TYPE.
parts.push(text(148, 132, "PRICE LIMITS BY ACCOMMODATION TYPE", { weight: 700, fill: HEAD }));
parts.push(`<rect x="117" y="154" width="1852" height="46" fill="#f2f2f2"/>`);
parts.push(text(129, 184, "ACCOMMODATION TYPE", { weight: 600, fill: HEAD }), text(1132, 184, "MIN", { weight: 600, fill: HEAD }), text(1524, 184, "MAX", { weight: 600, fill: HEAD }));
LIMITS.forEach(([name, min, max], i) => {
  const y = 232 + i * 49;
  parts.push(text(129, y, name), text(1132, y, min), text(1524, y, max));
  parts.push(`<rect x="117" y="${y + 17}" width="1852" height="1" fill="#e3e3e3"/>`);
});

// RULES AND ALERTS.
parts.push(text(97, 470, "RULES AND ALERTS", { size: 21, fill: HEAD }));
parts.push(`<rect x="97" y="496" width="300" height="52" rx="26" fill="#3cc4a0"/>`, text(122, 529, "+ CREATE NEW RULE/ALERT", { size: 17, fill: "#ffffff" }));
parts.push(text(1772, 520, `Showing 1 to ${RULES.length} of ${RULES.length} entries`, { size: 17 }));

const top = 570;
parts.push(`<rect x="97" y="${top}" width="1892" height="48" fill="#f2f2f2"/>`);
const COLS = { active: 194, name: 334, mode: 540, type: 720, desc: 900, start: 1460, end: 1640 };
const hy = top + 30;
parts.push(
  text(COLS.active, hy, "ACTIVE", { weight: 600, fill: HEAD }),
  text(COLS.name, hy, "NAME", { weight: 600, fill: HEAD }),
  text(COLS.mode, hy, "MODE", { weight: 600, fill: HEAD }),
  text(COLS.type, hy, "TYPE", { weight: 600, fill: HEAD }),
  text(COLS.desc, hy, "DESCRIPTION", { weight: 600, fill: HEAD }),
  text(COLS.start, hy, "START DATE", { weight: 600, fill: HEAD }),
  text(COLS.end, hy, "END DATE", { weight: 600, fill: HEAD }),
);

const ROW_H = 77;
RULES.forEach((r, i) => {
  const y0 = top + 48 + i * ROW_H;
  const mid = y0 + ROW_H / 2;
  if (i % 2 === 1) parts.push(`<rect x="97" y="${y0}" width="1892" height="${ROW_H}" fill="#fafafa"/>`);
  parts.push(`<rect x="97" y="${y0 + ROW_H - 1}" width="1892" height="1" fill="#e3e3e3"/>`);
  // The expand box.
  parts.push(`<rect x="110" y="${mid - 10}" width="19" height="19" fill="none" stroke="#555" stroke-width="1.5"/>`);
  // The switch.
  parts.push(`<rect x="181" y="${mid - 23}" width="100" height="46" rx="4" fill="#ffffff" stroke="#e1e1e1"/>`);
  if (r.on) {
    parts.push(`<rect x="181" y="${mid - 23}" width="50" height="46" rx="4" fill="#41b678"/>`);
    parts.push(`<path d="M199 ${mid} l5 5 l10 -10" stroke="#ffffff" stroke-width="3" fill="none"/>`);
  } else {
    parts.push(`<rect x="231" y="${mid - 23}" width="50" height="46" rx="4" fill="#ececec"/>`);
    parts.push(`<circle cx="256" cy="${mid}" r="7" fill="none" stroke="#444" stroke-width="2"/>`, `<path d="M251 ${mid + 5} l10 -10" stroke="#444" stroke-width="2"/>`);
  }
  parts.push(text(COLS.name, mid + 6, r.name), text(COLS.mode, mid + 6, r.mode), text(COLS.type, mid + 6, r.type));
  const lines = wrap(r.desc);
  const first = mid + 6 - (lines.length - 1) * 13;
  lines.forEach((line, k) => parts.push(text(COLS.desc, first + k * 26, line)));
  parts.push(text(COLS.start, mid + 6, "N/A"), text(COLS.end, mid + 6, "N/A"));
  parts.push(`<circle cx="1884" cy="${mid}" r="6" fill="#777"/>`, `<circle cx="1911" cy="${mid}" r="6" fill="#777"/>`);
});

// Cut through the last row's second line of description, as a screenshot of a long page is.
const height = top + 48 + (RULES.length - 1) * ROW_H + 52;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}">${parts.join("")}</svg>`;
mkdirSync(path.dirname(out), { recursive: true });
await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out);
console.log(`wrote ${path.relative(root, out)} (${W}x${height})`);
