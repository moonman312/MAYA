"use client";

/**
 * The screenshot reader in the owner's browser: tesseract.js, loaded only
 * when the import opens, its worker, engine and English data served from
 * MAYA itself (public/tesseract, copied there by scripts/copy-ocr-assets.mjs),
 * and a canvas for the cropping, upscaling and greying. The screenshot is
 * decoded and read here and nowhere else: it is never uploaded or kept.
 */

import type { OcrWord } from "./layout";
import type { OcrPass, RgbaImage } from "./read";

/** Where public/tesseract is served. */
function assetBase(): string {
  return `${window.location.origin}/tesseract`;
}

type TesseractWord = { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } };
type TesseractBlock = { paragraphs: { lines: { words: TesseractWord[] }[] }[] };
type Worker = {
  recognize: (image: HTMLCanvasElement, options: object, output: { blocks: boolean }) => Promise<{ data: { blocks: unknown } }>;
  setParameters: (p: Record<string, string>) => Promise<unknown>;
  terminate: () => Promise<unknown>;
};

/** The name of the error a file that isn't an image (or can't be decoded) is read with. */
export const NOT_AN_IMAGE = "NotAnImageError";

export type ScreenshotReader = {
  /** A screenshot's pixels and an OcrPass over it. */
  open(file: Blob): Promise<{ image: RgbaImage; pass: OcrPass }>;
  close(): Promise<void>;
};

function canvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

/** Start the reader: loads tesseract.js and its English data (a few MB, once). */
export async function startScreenshotReader(): Promise<ScreenshotReader> {
  const { createWorker } = await import("tesseract.js");
  const base = assetBase();
  const worker = (await createWorker("eng", 1, {
    workerPath: `${base}/worker.min.js`,
    corePath: `${base}/core`,
    langPath: `${base}/lang`,
    workerBlobURL: false,
    gzip: true,
  })) as unknown as Worker;
  await worker.setParameters({ user_defined_dpi: "300", preserve_interword_spaces: "1" });

  return {
    async open(file: Blob) {
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(file);
      } catch {
        const e = new Error("That file isn't an image this browser can decode.");
        e.name = NOT_AN_IMAGE;
        throw e;
      }
      const whole = canvas(bitmap.width, bitmap.height);
      const ctx = whole.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("No canvas");
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = ctx.getImageData(0, 0, whole.width, whole.height);
      const image: RgbaImage = { width: whole.width, height: whole.height, data: pixels.data };

      const pass: OcrPass = async (region, scale) => {
        const x = region ? Math.round(region.x0) : 0;
        const y = region ? Math.round(region.y0) : 0;
        const w = region ? Math.round(region.x1) - x : whole.width;
        const h = region ? Math.round(region.y1) - y : whole.height;
        const out = canvas(w * scale, h * scale);
        const o = out.getContext("2d", { willReadFrequently: true });
        if (!o) throw new Error("No canvas");
        o.imageSmoothingEnabled = true;
        o.imageSmoothingQuality = "high";
        o.drawImage(whole, x, y, w, h, 0, 0, out.width, out.height);
        // Grey, the way the reader was proven.
        const data = o.getImageData(0, 0, out.width, out.height);
        const d = data.data;
        for (let i = 0; i < d.length; i += 4) {
          const g = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
          d[i] = d[i + 1] = d[i + 2] = g;
        }
        o.putImageData(data, 0, 0);
        const { data: result } = await worker.recognize(out, {}, { blocks: true });
        const blocks = (result.blocks ?? []) as TesseractBlock[];
        return blocks.flatMap((b) =>
          b.paragraphs.flatMap((p) =>
            p.lines.flatMap((l) =>
              l.words.map(
                (word): OcrWord => ({
                  text: word.text,
                  confidence: word.confidence,
                  x0: x + word.bbox.x0 / scale,
                  y0: y + word.bbox.y0 / scale,
                  x1: x + word.bbox.x1 / scale,
                  y1: y + word.bbox.y1 / scale,
                }),
              ),
            ),
          ),
        );
      };
      return { image, pass };
    },
    async close() {
      await worker.terminate();
    },
  };
}
