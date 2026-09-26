// @vitest-environment jsdom
/**
 * Coming back to the docs from the app: the app took the dark class off, and
 * ThemeGuard puts it back after the theme toggle has already drawn itself.
 * The toggle must then offer the light theme, not the dark one.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/docs" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

import { ThemeGuard } from "./theme-guard";
import { ThemeToggle } from "./theme-toggle";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  // The reader's system is set to dark.
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ThemeGuard", () => {
  it("lets a theme toggle that drew itself first show the theme the page ends up in", () => {
    nav.pathname = "/docs";
    // The same order as the root layout: the page, then ThemeGuard.
    render(
      <>
        <ThemeToggle />
        <ThemeGuard />
      </>,
    );
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe("Switch to light theme");
  });
});
