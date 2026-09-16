import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MayaLockup, MayaMark } from "./logo";

const REPO = resolve(__dirname, "../../..");
const ICON_SVG = readFileSync(resolve(REPO, "logos/maya-icon.svg"), "utf8");
const LOCKUP_SVG = readFileSync(resolve(REPO, "logos/maya-lockup-transparent.svg"), "utf8");

/**
 * Every attribute pair inside the source SVG, minus the root <svg> tag and the
 * three we rewrite on purpose (the mask id, its url(#) reference, xmlns).
 * React emits SVG attributes in SVG's own spelling, so a source pair like
 * stroke-width="9.00" should appear in the rendered markup character for
 * character.
 */
function sourcePairs(svg: string): string[] {
  const body = svg.replace(/^<svg[^>]*>/, "");
  const pairs: string[] = [];
  for (const m of body.matchAll(/([A-Za-z-]+)="([^"]*)"/g)) {
    const [pair, name] = m;
    if (name === "id" || name === "mask" || name === "xmlns") continue;
    pairs.push(pair);
  }
  return pairs;
}

function maskIds(html: string): string[] {
  return [...html.matchAll(/<mask id="([^"]+)"/g)].map((m) => m[1]);
}

function attr(html: string, name: string): string | undefined {
  return html.match(new RegExp(`<svg[^>]*\\s${name}="([^"]*)"`))?.[1];
}

describe("MayaMark", () => {
  it("renders an accessible svg named MAYA at 24 px by default", () => {
    const html = renderToStaticMarkup(<MayaMark />);
    expect(html.startsWith("<svg")).toBe(true);
    expect(attr(html, "role")).toBe("img");
    expect(attr(html, "viewBox")).toBe("0 0 512 512");
    expect(attr(html, "width")).toBe("24");
    expect(attr(html, "height")).toBe("24");
    expect(attr(html, "aria-label")).toBe("MAYA");
  });

  it("honours size, className and title", () => {
    const html = renderToStaticMarkup(<MayaMark size={40} className="h-10 w-10" title="MAYA home" />);
    expect(attr(html, "width")).toBe("40");
    expect(attr(html, "height")).toBe("40");
    expect(attr(html, "class")).toBe("h-10 w-10");
    expect(attr(html, "aria-label")).toBe("MAYA home");
  });

  it("keeps the brand colours as literal hex, not currentColor", () => {
    const html = renderToStaticMarkup(<MayaMark />);
    expect(html).toContain('stroke="#F1F5F9"');
    expect(html).toContain('fill="#00A6F4"');
    expect(html).not.toContain("currentColor");
  });

  it("carries every attribute of logos/maya-icon.svg over verbatim", () => {
    const html = renderToStaticMarkup(<MayaMark />);
    for (const pair of sourcePairs(ICON_SVG)) expect(html).toContain(pair);
    expect(html).toContain('transform="scale(2.56)"');
  });
});

describe("MayaLockup", () => {
  const RATIO = 695.31 / 225;

  it("renders an accessible svg named MAYA at 32 px high by default", () => {
    const html = renderToStaticMarkup(<MayaLockup />);
    expect(attr(html, "role")).toBe("img");
    expect(attr(html, "viewBox")).toBe("0 0 695.31 225.0");
    expect(attr(html, "height")).toBe("32");
    expect(Number(attr(html, "width"))).toBeCloseTo(32 * RATIO, 1);
    expect(attr(html, "aria-label")).toBe("MAYA");
  });

  it("never paints a browser tooltip on hover", () => {
    const html = renderToStaticMarkup(<MayaLockup />);
    expect(html).not.toContain("<title");
  });

  it("derives width from height at the source aspect ratio", () => {
    const html = renderToStaticMarkup(<MayaLockup height={45} className="shrink-0" title="MAYA" />);
    expect(attr(html, "height")).toBe("45");
    expect(Number(attr(html, "width")) / 45).toBeCloseTo(RATIO, 3);
    expect(attr(html, "class")).toBe("shrink-0");
  });

  it("keeps the brand colours and paints no ground of its own", () => {
    const html = renderToStaticMarkup(<MayaLockup />);
    expect(html).toContain('stroke="#F1F5F9"');
    expect(html).toContain('fill="#F1F5F9"');
    expect(html).toContain('fill="#00A6F4"');
    expect(html).not.toContain("#020618");
    expect(html).not.toContain("currentColor");
  });

  it("carries every attribute of logos/maya-lockup-transparent.svg over verbatim", () => {
    const html = renderToStaticMarkup(<MayaLockup />);
    for (const pair of sourcePairs(LOCKUP_SVG)) expect(html).toContain(pair);
    expect(html).toContain('transform="translate(40,40)"');
    expect(html).toContain('transform="translate(211.00,62.50)"');
  });
});

describe("mask ids", () => {
  it("are minted per instance so two logos on one page never share a mask", () => {
    const html = renderToStaticMarkup(
      <div>
        <MayaMark />
        <MayaMark />
        <MayaLockup />
        <MayaLockup />
      </div>,
    );
    const ids = maskIds(html);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) {
      expect(html).toContain(`mask="url(#${id})"`);
      expect(html.split(`id="${id}"`)).toHaveLength(2);
    }
    expect(html).not.toContain("ko31");
    expect(html).not.toContain("ko36");
    expect(html).not.toContain("ko37");
  });

  it("are legal inside url(#) without escaping", () => {
    const html = renderToStaticMarkup(<MayaMark />);
    for (const id of maskIds(html)) expect(id).toMatch(/^[A-Za-z][\w-]*$/);
  });
});
