// @vitest-environment jsdom
/**
 * A link inside an answer's passage closes the docs helper, as the "From:"
 * link under it does. On a phone the helper covers the whole screen, so a
 * link that left it open would change the page out of sight.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, type MouseEvent, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "@/lib/docs/generated/ask-manifest.json";
import type { AskWire } from "@/lib/docs/ask/match";
import { AskProvider, useAsk } from "./ask-context";
import { AskPanel } from "./ask-panel";

vi.mock("next/navigation", () => ({ usePathname: () => "/docs/a" }));
vi.mock("next/link", () => ({
  default: ({ href, children, onClick, ...rest }: { href: string; children: ReactNode; onClick?: (e: MouseEvent) => void }) => (
    <a
      href={href}
      onClick={(e) => {
        // Next routes in place; jsdom cannot navigate.
        e.preventDefault();
        onClick?.(e);
      }}
      {...rest}
    >
      {children}
    </a>
  ),
}));

const wire: AskWire = {
  v: 2,
  p: [
    ["/docs/a", "Page A", "alpha"],
    ["/docs/b", "Page B", "beta"],
  ],
  s: [
    [0, "", "In plain words"],
    [1, "", "In plain words"],
  ],
  e: [
    [0, "Alpha passage, see [Page B](@1) or [email us](mailto:help@example.com)."],
    [1, "Beta passage."],
  ],
  q: [["what is alpha", 0, 0]],
  y: [],
};

function Opener() {
  const { open, openAsk } = useAsk();
  useEffect(() => openAsk(), [openAsk]);
  return <p data-testid="open">{String(open)}</p>;
}

beforeEach(() => {
  sessionStorage.clear();
  sessionStorage.setItem(
    "maya-docs-ask-v2",
    JSON.stringify({
      file: manifest.file,
      turns: [{ id: 1, question: "what is alpha", confidence: "high", answer: { entry: 0, page: 0 }, also: [] }],
    }),
  );
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(wire)));
  Element.prototype.scrollIntoView = vi.fn();
  render(
    <AskProvider enabled defaultStarters={[]}>
      <Opener />
      <AskPanel />
    </AskProvider>,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a link in an answer's passage", () => {
  it("closes the helper when it goes to a docs page", async () => {
    const link = await screen.findByRole("link", { name: "Page B" });
    expect(link.getAttribute("href")).toBe("/docs/b");
    expect(screen.getByTestId("open").textContent).toBe("true");
    fireEvent.click(link);
    expect(screen.getByTestId("open").textContent).toBe("false");
  });

  it("leaves the helper open for an email link, which does not change the page", async () => {
    const link = await screen.findByRole("link", { name: "email us" });
    link.addEventListener("click", (e) => e.preventDefault());
    fireEvent.click(link);
    expect(screen.getByTestId("open").textContent).toBe("true");
  });
});
