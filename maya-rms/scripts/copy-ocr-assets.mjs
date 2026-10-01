/**
 * Copies what the PIE import's screenshot reader runs in the browser into
 * public/tesseract, so it is served from MAYA itself and no third-party CDN
 * is asked for anything at runtime:
 *
 *   worker.min.js          tesseract.js's web worker (Apache-2.0)
 *   core/*-lstm.wasm.js    the Tesseract engine built for the browser, in the
 *                          three builds tesseract.js picks from by what the
 *                          browser supports (tesseract.js-core, Apache-2.0)
 *   lang/eng.traineddata.gz  English, the 4.0.0_best_int data
 *                          (@tesseract.js-data/eng; the data is Tesseract's
 *                          tessdata, Apache-2.0)
 *
 * with their licences. Run before `next dev` and `next build` (package.json),
 * and safe to run again: a file already there at the same size is left.
 * public/tesseract is not committed.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const pkg = (name) => path.dirname(require.resolve(`${name}/package.json`));
// The core the installed tesseract.js depends on.
const tesseract = pkg("tesseract.js");
const core = path.dirname(createRequire(path.join(tesseract, "package.json")).resolve("tesseract.js-core/package.json"));
const eng = pkg("@tesseract.js-data/eng");

const files = [
  [path.join(tesseract, "dist", "worker.min.js"), "worker.min.js"],
  [path.join(tesseract, "LICENSE.md"), "LICENSE-tesseract.js.md"],
  [path.join(core, "LICENSE"), "core/LICENSE-tesseract.js-core.txt"],
  ...["tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"].map((f) => [path.join(core, f), `core/${f}`]),
  [path.join(eng, "4.0.0_best_int", "eng.traineddata.gz"), "lang/eng.traineddata.gz"],
];

const out = path.join(root, "public", "tesseract");
let copied = 0;
for (const [from, to] of files) {
  const target = path.join(out, to);
  if (!existsSync(from)) throw new Error(`copy-ocr-assets: ${from} is missing. Run npm install.`);
  if (existsSync(target) && statSync(target).size === statSync(from).size) continue;
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(from, target);
  copied++;
}
console.log(`copy-ocr-assets: ${copied} copied, ${files.length - copied} already there (public/tesseract)`);
