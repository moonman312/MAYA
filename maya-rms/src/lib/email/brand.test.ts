/**
 * The header takes whatever absolute link the template is already sending and
 * has to land on that deployment's own PNG, never a broken image. So the
 * cases here are the shapes callers really pass: a bare base with and without
 * the trailing slash, a deep link with a query, localhost over http, and the
 * garbage a unit test hands over when it doesn't care about the URL.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMAIL_LOCKUP_HEIGHT,
  EMAIL_LOCKUP_WIDTH,
  emailBrandHeader,
  emailImageOrigin,
} from "./brand";

const IMG = /<img\s[^>]*>/;

function img(html: string): string {
  const match = html.match(IMG);
  expect(match, "expected an <img> in the header").not.toBeNull();
  return match![0];
}

describe("emailImageOrigin", () => {
  it("keeps only the origin", () => {
    expect(emailImageOrigin("https://maya-rms.com")).toBe("https://maya-rms.com");
    expect(emailImageOrigin("https://maya-rms.com/")).toBe("https://maya-rms.com");
    expect(
      emailImageOrigin("https://maya-rms.com/auth/accept-invite?token_hash=abc&type=invite"),
    ).toBe("https://maya-rms.com");
    expect(emailImageOrigin("http://localhost:3000/onboarding/connect")).toBe(
      "http://localhost:3000",
    );
  });

  it("refuses anything that isn't a web origin", () => {
    expect(emailImageOrigin("")).toBeNull();
    expect(emailImageOrigin("u")).toBeNull();
    expect(emailImageOrigin("maya-rms.com/account/billing")).toBeNull();
    expect(emailImageOrigin("ftp://maya-rms.com/")).toBeNull();
    expect(emailImageOrigin("javascript:alert(1)")).toBeNull();
  });
});

describe("emailBrandHeader", () => {
  it("points the image at the same origin as the link, trailing slash or not", () => {
    for (const base of ["https://maya-rms.com", "https://maya-rms.com/"]) {
      expect(img(emailBrandHeader(base))).toContain(
        'src="https://maya-rms.com/brand/maya-lockup-email.png"',
      );
    }
  });

  it("drops the path and query of a deep link", () => {
    const html = emailBrandHeader(
      "https://maya-rms.com/auth/accept-invite?token_hash=abc&type=invite",
    );
    expect(img(html)).toContain('src="https://maya-rms.com/brand/maya-lockup-email.png"');
    expect(html).not.toContain("accept-invite");
  });

  it("keeps http for a local deployment rather than forcing https", () => {
    expect(img(emailBrandHeader("http://localhost:3000/account/billing"))).toContain(
      'src="http://localhost:3000/brand/maya-lockup-email.png"',
    );
  });

  it("carries alt text and explicit dimensions for clients that ignore CSS", () => {
    const tag = img(emailBrandHeader("https://maya-rms.com"));
    expect(tag).toContain('alt="MAYA"');
    expect(tag).toContain(`width="${EMAIL_LOCKUP_WIDTH}"`);
    expect(tag).toContain(`height="${EMAIL_LOCKUP_HEIGHT}"`);
    expect(tag).not.toContain("svg");
  });

  it("falls back to the text wordmark instead of a broken image", () => {
    for (const base of ["", "u", "ftp://maya-rms.com/", "javascript:alert(1)"]) {
      const html = emailBrandHeader(base);
      expect(html).not.toMatch(IMG);
      expect(html).toContain(">MAYA</p>");
      expect(html).not.toContain("javascript:");
    }
  });

  it("is a single cell the templates can drop straight into the card", () => {
    const html = emailBrandHeader("https://maya-rms.com");
    expect(html.match(/<tr>/g)).toHaveLength(1);
    expect(html.match(/<td[\s>]/g)).toHaveLength(1);
    expect(html).toContain('role="presentation"');
  });

  it("declares the aspect ratio of the PNG that is actually served", () => {
    // public/brand/maya-lockup-email.png is a byte copy of this file. Reading
    // IHDR directly keeps the test free of image libraries.
    const png = readFileSync(
      resolve(__dirname, "../../../logos/maya-lockup-transparent@2x.png"),
    );
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(Math.round((EMAIL_LOCKUP_WIDTH * height) / width)).toBe(EMAIL_LOCKUP_HEIGHT);
  });
});
