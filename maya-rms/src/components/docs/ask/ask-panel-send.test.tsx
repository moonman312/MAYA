// @vitest-environment jsdom
/**
 * What the docs helper tells a reader after they press Send: a limit that
 * everybody together used up never blames the reader for it.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SentNote, send } from "./ask-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function answer(status: number, body?: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => (body === undefined ? new Response(null, { status }) : Response.json(body, { status }))),
  );
}

describe("send", () => {
  it("tells the reader's own limit apart from everybody's", async () => {
    answer(429, { limited: "you" });
    expect(await send({ source: "unanswered", question: "q" })).toBe("limited");
    answer(429, { limited: "everyone" });
    expect(await send({ source: "unanswered", question: "q" })).toBe("busy");
    answer(429);
    expect(await send({ source: "unanswered", question: "q" })).toBe("limited");
    answer(204);
    expect(await send({ source: "unanswered", question: "q" })).toBe("sent");
    answer(502);
    expect(await send({ source: "unanswered", question: "q" })).toBe("error");
  });
});

describe("SentNote", () => {
  it("says the helper is busy, not that the reader sent too much, when everybody's limit is used up", () => {
    render(<SentNote state="busy" />);
    const note = screen.getByRole("status").textContent ?? "";
    expect(note).toBe("We can't take questions right now. Email us instead.");
    expect(note).not.toMatch(/from here/);
  });

  it("keeps the reader's own limit worded as theirs", () => {
    render(<SentNote state="limited" />);
    expect(screen.getByRole("status").textContent).toBe("Too many sends from here for now. Email us instead.");
  });
});
