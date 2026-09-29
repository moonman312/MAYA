// @vitest-environment jsdom
/**
 * The five questions: a floor or ceiling a room type could not take keeps the
 * card up with the server's words, and the ceiling card names no one.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }) }));

const { StrategyQuestions } = await import("./strategy-questions");

let answerReplies: Array<() => Response> = [];
let answerBodies: unknown[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  answerReplies = [];
  answerBodies = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/onboarding/status") {
      return json({ connected: true, hotelId: "h1", hotelName: "The Harbour Inn", currency: "USD" });
    }
    if (url === "/api/onboarding/answers") {
      answerBodies.push(JSON.parse(String(init?.body)));
      return (answerReplies.shift() ?? (() => json({ ok: true })))();
    }
    return json({});
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function toFloorCard() {
  render(<StrategyQuestions />);
  await waitFor(() => expect(screen.getByDisplayValue("The Harbour Inn")).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Looks right" }));
  fireEvent.change(screen.getByPlaceholderText("e.g. 35"), { target: { value: "35" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(screen.getByText(/Picture a Tuesday in your slowest month/)).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "I'll just type my floor" }));
}

describe("the floor and ceiling cards", () => {
  it("keeps the floor card up and says which room type kept its own number", async () => {
    const said =
      "Your floor of $200 wasn't saved for Deluxe King: its ceiling is $150, and a floor can't be above the ceiling.";
    answerReplies = [() => json({ ok: true }), () => json({ error: said }, 409)];
    await toFloorCard();

    fireEvent.change(screen.getByPlaceholderText("e.g. 79"), { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByText(said)).not.toBeNull());
    expect(screen.getByText("What's your true floor?")).not.toBeNull();
    expect(answerBodies.at(-1)).toEqual({ floor: 200 });
  });

  it("moves on to the ceiling card, which names no one", async () => {
    await toFloorCard();
    fireEvent.change(screen.getByPlaceholderText("e.g. 79"), { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(screen.getByText("Now the fun one: the biggest concert of the year is next door.")).not.toBeNull(),
    );
  });
});

describe("the first four questions", () => {
  it("use no em dash, the ladder's reminder and a failed save included", async () => {
    answerReplies = [() => new Response("", { status: 500 })];
    const seen: string[] = [];
    render(<StrategyQuestions />);
    const name = await screen.findByDisplayValue("The Harbour Inn");
    expect(screen.getByText("We pulled this from your property system. Fix it if it's off. Whatever you type wins.")).not.toBeNull();

    fireEvent.change(name, { target: { value: "Harbour Inn Kinsale" } });
    fireEvent.click(screen.getByRole("button", { name: "Looks right" }));
    await screen.findByText("Couldn't save that. Try again.");
    seen.push(document.body.textContent ?? "");

    fireEvent.click(screen.getByRole("button", { name: "Looks right" }));
    await screen.findByText("Ballpark: what does it cost you to turn over a room?");
    seen.push(document.body.textContent ?? "");

    fireEvent.change(screen.getByPlaceholderText("e.g. 35"), { target: { value: "35" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(/Picture a Tuesday in your slowest month/);
    fireEvent.click(screen.getByRole("button", { name: "Too low" }));
    fireEvent.click(screen.getByRole("button", { name: "Too low" }));
    await screen.findByText(/^Remember: this is a night that would otherwise earn \$0\./);
    seen.push(document.body.textContent ?? "");

    fireEvent.click(screen.getByRole("button", { name: /^I'd take/ }));
    await screen.findByText("Now the fun one: the biggest concert of the year is next door.");
    seen.push(document.body.textContent ?? "");

    for (const text of seen) expect(text).not.toContain("—");
  });
});
