// @vitest-environment jsdom
/**
 * Each person's text size. It is saved on their profile and mirrored in a
 * cookie, and a script in the root layout's <head> puts it on <html> before
 * anything paints, so a page never opens at the wrong size first. The pages
 * built ahead of time (the docs) stay built ahead of time: the server never
 * reads the cookie.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  TEXT_SIZE_COOKIE,
  TEXT_SIZE_SCRIPT,
  applyTextSize,
  currentTextSize,
  syncTextSizeFromProfile,
  textSizeFromCookie,
} from "./text-size";
import { TextSizeSync } from "@/components/text-size-sync";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "font-geist-sans" }),
  Geist_Mono: () => ({ variable: "font-geist-mono" }),
}));
vi.mock("@/components/legal/terms-gate", () => ({ TermsGate: () => null }));
vi.mock("@/components/docs/theme-guard", () => ({ ThemeGuard: () => null }));
vi.mock("@/components/wheel-guard", () => ({ WheelGuard: () => null }));

const root = () => document.documentElement;
function clearCookie() {
  for (const name of [TEXT_SIZE_COOKIE, "other", `not-${TEXT_SIZE_COOKIE}`]) document.cookie = `${name}=; Path=/; Max-Age=0`;
}
/** Runs the <head> script the way the browser does, before the body. */
function runHeadScript() {
  new Function(TEXT_SIZE_SCRIPT)();
}

beforeEach(() => {
  clearCookie();
  root().removeAttribute("data-text-size");
});

afterEach(() => {
  cleanup();
  clearCookie();
  root().removeAttribute("data-text-size");
});

describe("the script in the <head>", () => {
  it("puts the size from the cookie on <html>", () => {
    document.cookie = `${TEXT_SIZE_COOKIE}=larger; Path=/`;
    runHeadScript();
    expect(root().getAttribute("data-text-size")).toBe("larger");
    document.cookie = `other=1; Path=/`;
    document.cookie = `${TEXT_SIZE_COOKIE}=large; Path=/`;
    runHeadScript();
    expect(root().getAttribute("data-text-size")).toBe("large");
  });

  it("leaves a page at the standard size when there is no cookie, or one it does not know", () => {
    root().setAttribute("data-text-size", "larger");
    runHeadScript();
    expect(root().hasAttribute("data-text-size")).toBe(false);
    document.cookie = `${TEXT_SIZE_COOKIE}=huge; Path=/`;
    runHeadScript();
    expect(root().hasAttribute("data-text-size")).toBe(false);
    clearCookie();
    document.cookie = `not-${TEXT_SIZE_COOKIE}=larger; Path=/`;
    runHeadScript();
    expect(root().hasAttribute("data-text-size")).toBe(false);
  });

  it("is in the root layout's <head>, ahead of the body, on every page", async () => {
    const { default: RootLayout } = await import("@/app/layout");
    const html = renderToStaticMarkup(<RootLayout>{<p id="page">page</p>}</RootLayout>);
    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    expect(head).toContain("maya-text-size");
    expect(head).toContain("data-text-size");
    expect(html.indexOf("maya-text-size")).toBeLessThan(html.indexOf('id="page"'));
  });

  it("never makes the server read the cookie, so the docs stay built ahead of time", () => {
    const layout = readFileSync(resolve(__dirname, "../app/layout.tsx"), "utf8");
    expect(layout).not.toMatch(/next\/headers|cookies\(\)/);
    expect(layout).toMatch(/<head>[\s\S]*<TextSizeScript \/>[\s\S]*<\/head>/);
  });

  it("sizes the whole page from the root, as the stylesheet sets it", () => {
    const css = readFileSync(resolve(__dirname, "../app/globals.css"), "utf8").replace(/\s+/g, " ");
    expect(css).toContain('html[data-text-size="large"] { font-size: 112.5%; }');
    expect(css).toContain('html[data-text-size="larger"] { font-size: 125%; }');
  });
});

describe("choosing a size", () => {
  it("shows it at once and keeps it in the cookie for the next page load", () => {
    applyTextSize("large");
    expect(root().getAttribute("data-text-size")).toBe("large");
    expect(textSizeFromCookie(document.cookie)).toBe("large");
    expect(currentTextSize()).toBe("large");
    applyTextSize("standard");
    expect(root().hasAttribute("data-text-size")).toBe(false);
    expect(document.cookie.split("; ").some((c) => c.startsWith(`${TEXT_SIZE_COOKIE}=`))).toBe(false);
    expect(currentTextSize()).toBe("standard");
  });

  it("reads a cookie string", () => {
    expect(textSizeFromCookie(`a=1; ${TEXT_SIZE_COOKIE}=larger; b=2`)).toBe("larger");
    expect(textSizeFromCookie(`${TEXT_SIZE_COOKIE}=big`)).toBe("standard");
    expect(textSizeFromCookie("")).toBe("standard");
  });
});

describe("following the person to another device", () => {
  function profile(text_size: unknown, error: unknown = null) {
    return {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: text_size === undefined ? null : { text_size }, error }) }) }) }),
    } as unknown as SupabaseClient;
  }

  it("brings the saved size to this browser just after sign-in", async () => {
    await syncTextSizeFromProfile(profile("larger"), "u1");
    expect(root().getAttribute("data-text-size")).toBe("larger");
    expect(textSizeFromCookie(document.cookie)).toBe("larger");
  });

  it("clears someone else's size left in the cookie", async () => {
    applyTextSize("larger");
    await syncTextSizeFromProfile(profile("standard"), "u1");
    expect(root().hasAttribute("data-text-size")).toBe(false);
    expect(textSizeFromCookie(document.cookie)).toBe("standard");
  });

  it("leaves the browser as it was when the profile cannot be read", async () => {
    applyTextSize("large");
    await syncTextSizeFromProfile(profile(undefined, { code: "42703", message: "column profiles.text_size does not exist" }), "u1");
    expect(currentTextSize()).toBe("large");
    await syncTextSizeFromProfile(profile("larger"), null);
    expect(currentTextSize()).toBe("large");
  });

  it("puts the dashboard right on its first load when the browser shows another size", () => {
    render(<TextSizeSync saved="large" />);
    expect(root().getAttribute("data-text-size")).toBe("large");
    cleanup();
    applyTextSize("larger");
    render(<TextSizeSync saved={null} />);
    expect(currentTextSize()).toBe("larger");
  });
});
