/**
 * The screenshot reader's image work and OCR under Node, for tests and for
 * trying the reader on a screenshot locally: sharp crops, upscales and
 * greys, tesseract.js reads, with the English data from the
 * @tesseract.js-data/eng package (nothing is downloaded). The browser does
 * the same with a canvas (browser-ocr.ts).
 */

import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import type { OcrWord } from "./layout";
import type { OcrPass, RgbaImage } from "./read";

const require = createRequire(import.meta.url);

/** The folder holding eng.traineddata.gz, the data the browser is served too. */
export function engDataDir(): string {
  return path.join(path.dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");
}

type TesseractWord = { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } };
type TesseractBlock = { paragraphs: { lines: { words: TesseractWord[] }[] }[] };

/** One worker for a test file; close() when done. */
export async function nodeOcrWorker() {
  const worker = await createWorker("eng", 1, { langPath: engDataDir(), cacheMethod: "none", gzip: true });
  await worker.setParameters({ user_defined_dpi: "300", preserve_interword_spaces: "1" });
  return {
    /** The screenshot's pixels and an OcrPass over it. */
    async open(input: Buffer): Promise<{ image: RgbaImage; pass: OcrPass }> {
      const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const image: RgbaImage = { width: info.width, height: info.height, data: new Uint8Array(data) };
      const pass: OcrPass = async (region, scale) => {
        let img = sharp(input);
        let ox = 0;
        let oy = 0;
        let w = info.width;
        if (region) {
          ox = Math.round(region.x0);
          oy = Math.round(region.y0);
          w = Math.round(region.x1) - ox;
          img = img.extract({ left: ox, top: oy, width: w, height: Math.round(region.y1) - oy });
        }
        const png = await img.resize({ width: Math.round(w * scale) }).grayscale().png().toBuffer();
        const { data: out } = await worker.recognize(png, {}, { blocks: true });
        const blocks = (out.blocks ?? []) as unknown as TesseractBlock[];
        return blocks.flatMap((b) =>
          b.paragraphs.flatMap((p) =>
            p.lines.flatMap((l) =>
              l.words.map(
                (word): OcrWord => ({
                  text: word.text,
                  confidence: word.confidence,
                  x0: ox + word.bbox.x0 / scale,
                  y0: oy + word.bbox.y0 / scale,
                  x1: ox + word.bbox.x1 / scale,
                  y1: oy + word.bbox.y1 / scale,
                }),
              ),
            ),
          ),
        );
      };
      return { image, pass };
    },
    close: () => worker.terminate(),
  };
}
