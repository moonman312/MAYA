/**
 * The note under Let Me Drive says what the path skips. The history is read
 * on both paths, so it must not say otherwise.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

const { PathChoice } = await import("./path-choice");

describe("PathChoice", () => {
  it("says Let Me Drive skips the guided review, and nothing about skipping the data", () => {
    const text = renderToStaticMarkup(createElement(PathChoice))
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ");
    expect(text).toContain("Straight to your dashboard, with no guided review. For experts only.");
    expect(text).not.toMatch(/analysis|analys/i);
  });
});
