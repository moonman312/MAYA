// @vitest-environment jsdom
/**
 * The docs helper keeps the conversation in the tab's session storage, as
 * places in the docs index. A docs deploy changes the index, so a saved
 * conversation must never break the panel or point at the wrong passage.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "@/lib/docs/generated/ask-manifest.json";
import type { AskWire } from "@/lib/docs/ask/match";
import { AskProvider, useAsk } from "./ask-context";
import { AskPanel } from "./ask-panel";

vi.mock("next/navigation", () => ({ usePathname: () => "/docs/a" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// Two pages, one passage each.
const wire: AskWire = {
  v: 2,
  p: [
    ["/docs/a", "Page A", "alpha"],
    ["/docs/b", "Page B", "beta"],
  ],
  s: [
    [0, "", "In plain words"],
    [1, "sec-b", "Section B"],
  ],
  e: [
    [0, "Alpha passage."],
    [1, "Beta passage."],
  ],
  q: [["what is alpha", 0, 0]],
  y: [],
};

const turn = (id: number, question: string, answer: { entry: number; page: number } | null, also: { entry: number; page: number }[] = []) => ({
  id,
  question,
  confidence: "high",
  answer,
  also,
});

function Opener() {
  const { openAsk } = useAsk();
  useEffect(() => openAsk(), [openAsk]);
  return null;
}

function openPanel() {
  render(
    <AskProvider enabled defaultStarters={["what is alpha"]}>
      <Opener />
      <AskPanel />
    </AskProvider>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(wire)));
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a saved conversation", () => {
  it("shows no passage or link the index does not have, and never breaks the panel", async () => {
    sessionStorage.setItem(
      "maya-docs-ask-v2",
      JSON.stringify({
        file: manifest.file,
        turns: [
          // An "Also see" past the end of the index.
          turn(1, "first", { entry: 0, page: 0 }, [{ entry: 5, page: 3 }]),
          // A passage that exists on a page that does not.
          turn(2, "second", { entry: 1, page: 7 }),
          // A passage and a page that both exist, but the passage is on the other page.
          turn(3, "third", { entry: 1, page: 0 }, [{ entry: 0, page: 1 }]),
        ],
      }),
    );
    openPanel();
    await screen.findByText("Alpha passage.");
    expect(screen.queryByText("Also see")).toBeNull();
    expect(screen.queryByText("Beta passage.")).toBeNull();
    expect(screen.getAllByText("The docs don't cover that yet.")).toHaveLength(2);
    const hrefs = [...document.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs.filter((h) => h?.startsWith("/docs/") && h !== "/docs/help/about-these-docs")).toEqual(["/docs/a"]);
  });

  it("starts over when it was asked against another index", async () => {
    sessionStorage.setItem("maya-docs-ask-v2", JSON.stringify({ file: "/docs-index.0000000000.json", turns: [turn(1, "first", { entry: 0, page: 0 })] }));
    // Saved before the index was recorded with it.
    sessionStorage.setItem("maya-docs-ask", JSON.stringify([turn(2, "second", { entry: 0, page: 0 })]));
    openPanel();
    await waitFor(() => expect(screen.getByRole("button", { name: "what is alpha" }).hasAttribute("disabled")).toBe(false));
    expect(screen.getByText("Try one of these")).toBeTruthy();
    expect(screen.queryByText("first")).toBeNull();
    expect(screen.queryByText("second")).toBeNull();
    expect(screen.queryByText("Alpha passage.")).toBeNull();
  });
});
