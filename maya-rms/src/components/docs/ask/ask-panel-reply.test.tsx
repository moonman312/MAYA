// @vitest-environment jsdom
/**
 * The docs helper panel on the real index: a set reply for a general
 * question, a page-aware reply for "how does this work?", somewhere to go
 * when there is no answer, and one anonymous count per question asked that
 * never carries the question.
 */
import fs from "node:fs";
import path from "node:path";
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "@/lib/docs/generated/ask-manifest.json";
import { AskProvider, useAsk } from "./ask-context";
import { AskPanel } from "./ask-panel";

vi.mock("next/navigation", () => ({ usePathname: () => "/docs/rules/booking-window" }));

const wire = fs.readFileSync(path.join(process.cwd(), "public", manifest.file), "utf8");
let tallies: Record<string, unknown>[] = [];
let feedback: Record<string, unknown>[] = [];

beforeEach(() => {
  tallies = [];
  feedback = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === manifest.file) return new Response(wire, { status: 200, headers: { "content-type": "application/json" } });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url === "/api/docs-ask/tally") tallies.push(body);
      if (url === "/api/docs-ask/feedback") feedback.push(body);
      return new Response(null, { status: 204 });
    }),
  );
  // jsdom has no layout
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function Opener() {
  const { openAsk } = useAsk();
  useEffect(() => openAsk(), [openAsk]);
  return null;
}

async function openPanel() {
  render(
    <AskProvider enabled defaultStarters={["What is booking speed?"]}>
      <Opener />
      <AskPanel />
    </AskProvider>,
  );
  const box = await screen.findByLabelText("Your question");
  await waitFor(() => expect((screen.getByRole("button", { name: "What is booking speed?" }) as HTMLButtonElement).disabled).toBe(false), {
    timeout: 30_000,
  });
  return box as HTMLTextAreaElement;
}

async function ask(box: HTMLTextAreaElement, q: string) {
  fireEvent.change(box, { target: { value: q } });
  fireEvent.keyDown(box, { key: "Enter" });
  return screen.findByRole("article", { name: `Answer to: ${q}` });
}

describe("the docs helper panel", () => {
  it("answers how does this work about the page the reader is on, and counts it without the question", async () => {
    const box = await openPanel();
    const reply = await ask(box, "how does this work?");
    expect(reply.textContent).toMatch(/You're reading Booking window, in Rules/);
    expect(reply.textContent).toMatch(/On this page/);
    expect(tallies).toEqual([{ outcome: "canned", section: "rules", appArea: "" }]);
  }, 60_000);

  it("gives a greeting its set reply and a docs question its passage, one count each", async () => {
    const box = await openPanel();
    const hi = await ask(box, "hi");
    expect(hi.textContent).toMatch(/^hiHello\./);
    const docs = await ask(box, "what is booking speed?");
    expect(docs.textContent).toMatch(/From:\s*Booking speed/);
    expect(tallies.map((t) => t.outcome)).toEqual(["canned", "answered"]);
  }, 60_000);

  it("with no answer, offers the closest pages or places to start, and Send still works", async () => {
    const box = await openPanel();
    const q = "purple elephant dancing";
    const reply = await ask(box, q);
    expect(reply.textContent).toMatch(/No clear answer in the docs\./);
    expect(reply.textContent).toMatch(/Good places to start/);
    expect(tallies).toEqual([{ outcome: "none", section: "rules", appArea: "" }]);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(feedback).toHaveLength(1));
    expect(feedback[0]).toMatchObject({ source: "unanswered", question: q });
    expect(JSON.stringify(tallies)).not.toMatch(/elephant/);
  }, 60_000);

  it("counts the MAYA screen Help was opened from, and says so on that page", async () => {
    sessionStorage.setItem("maya-docs-from", "simulator");
    const box = await openPanel();
    await ask(box, "whats this");
    expect(tallies).toEqual([{ outcome: "canned", section: "rules", appArea: "simulator" }]);
  }, 60_000);
});
