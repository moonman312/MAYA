import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "./manifest";

const REPO = resolve(__dirname, "../..");
const inRepo = (...p: string[]) => resolve(REPO, ...p);

/** Width and height straight from the PNG header (IHDR is always first). */
function pngSize(file: string): string {
  const buf = readFileSync(file);
  expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

function sameBytes(a: string, b: string) {
  expect(existsSync(a), a).toBe(true);
  expect(existsSync(b), b).toBe(true);
  expect(readFileSync(a).equals(readFileSync(b)), `${a} differs from ${b}`).toBe(true);
}

describe("manifest", () => {
  const m = manifest();

  it("names the app and paints the dark ground", () => {
    expect(m.name).toBe("MAYA");
    expect(m.short_name).toBe("MAYA");
    expect(m.start_url).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.theme_color).toBe("#020618");
    expect(m.background_color).toBe("#020618");
  });

  it("points every icon at a PNG that exists under public/ at the declared size", () => {
    expect(m.icons?.length).toBeGreaterThan(0);
    for (const icon of m.icons ?? []) {
      const file = inRepo("public", icon.src.replace(/^\//, ""));
      expect(existsSync(file), icon.src).toBe(true);
      expect(icon.type).toBe("image/png");
      expect(pngSize(file)).toBe(icon.sizes);
    }
  });

  it("leaves the tiles un-maskable: the mark has no room for a circular crop", () => {
    for (const icon of m.icons ?? []) expect(icon.purpose).toBeUndefined();
  });
});

describe("app icon files", () => {
  it("are byte copies of the tile the rest of the favicons were cut from", () => {
    // Not logos/nextjs-app/icon.svg: that file is the bare transparent mark,
    // whose near-white edges disappear on a light tab strip. Every other
    // favicon here is the square tile, and the SVG has to match them.
    sameBytes(inRepo("src/app/icon.svg"), inRepo("logos/maya-app-icon-square.svg"));
    sameBytes(inRepo("src/app/apple-icon.png"), inRepo("logos/nextjs-app/apple-icon.png"));
    // Served from public/, not app/: Turbopack decodes app/ icons at build time
    // and its ICO reader rejects PNG-in-ICO entries that aren't RGBA (ours are RGB).
    sameBytes(inRepo("public/favicon.ico"), inRepo("logos/nextjs-app/favicon.ico"));
    expect(pngSize(inRepo("src/app/apple-icon.png"))).toBe("180x180");
  });
});

describe("public/brand", () => {
  const SVGS = [
    "maya-icon.svg",
    "maya-icon-on-light.svg",
    "maya-icon-mono.svg",
    "maya-lockup.svg",
    "maya-lockup-transparent.svg",
    "maya-lockup-on-light.svg",
    "maya-stacked.svg",
    "maya-app-icon.svg",
    "maya-app-icon-sky.svg",
    "maya-app-icon-square.svg",
  ];

  it("mirrors the logos/ set byte for byte", () => {
    for (const f of SVGS) sameBytes(inRepo("public/brand", f), inRepo("logos", f));
    sameBytes(inRepo("public/brand/icon-192.png"), inRepo("logos/nextjs-app/icon-192.png"));
    sameBytes(inRepo("public/brand/icon-512.png"), inRepo("logos/nextjs-app/icon-512.png"));
  });

  it("serves the email lockup as the 2x transparent PNG", () => {
    sameBytes(inRepo("public/brand/maya-lockup-email.png"), inRepo("logos/maya-lockup-transparent@2x.png"));
    expect(pngSize(inRepo("public/brand/maya-lockup-email.png"))).toBe("1392x450");
  });

  it("no longer ships the create-next-app placeholders", () => {
    for (const f of ["file.svg", "globe.svg", "next.svg", "vercel.svg", "window.svg"]) {
      expect(existsSync(inRepo("public", f)), f).toBe(false);
    }
  });
});
