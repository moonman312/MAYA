// @vitest-environment jsdom
/**
 * The Rate Simulator's "Build a test rule" is a second rule builder: it
 * carries the same undo box, ticked on every new rule, and sends what the
 * owner left it at when the rule is saved.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNDO_ON_CANCELLATION_LABEL } from "@/lib/rule-form";
import { RateSimulator } from "./rate-simulator";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubApi(seedExtra: Record<string, unknown> = {}) {
  const posts: Record<string, unknown>[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/room-types")) {
        return json({
          timezone: "UTC",
          ...seedExtra,
          roomTypes: [
            { id: "rt1", name: "Standard", total_rooms: 10, floor_price: 50, ceiling_price: 500, counts_as_room: true, seed_rate: 100 },
          ],
        });
      }
      if (url === "/api/rules/engine") return json([]);
      if (url === "/api/rules" && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return json({ id: "r-new" }, 201);
      }
      return json({ error: "unexpected" }, 500);
    }),
  );
  return posts;
}

describe("the Rate Simulator's test rule", () => {
  it.each([
    { box: "left ticked", untick: false, sent: true },
    { box: "unticked", untick: true, sent: false },
  ])("carries the undo box, ticked to start, and saves it $box", async ({ untick, sent }) => {
    const posts = stubApi();
    render(<RateSimulator activeHotelId="h1" />);
    fireEvent.click(await screen.findByRole("button", { name: "+ Build a test rule" }));
    const box = screen.getByLabelText(UNDO_ON_CANCELLATION_LABEL) as HTMLInputElement;
    expect(box.checked).toBe(true);
    if (untick) fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Save This Rule" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ undo_on_cancellation: sent, is_active: false });
  });
});

describe("the Rate Simulator's amounts", () => {
  it("carry the property's currency symbol, with a cut shown as minus then the symbol", async () => {
    stubApi({ currency: "EUR" });
    const view = render(<RateSimulator activeHotelId="h1" />);
    expect(await screen.findByText(/€50\.00\s*–\s*€500\.00/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Base price for Standard"), { target: { value: "40" } });
    // Held at the floor: 40 becomes 50.
    await waitFor(() => expect(view.container.textContent).toContain("+€10.00"));
    expect(view.container.textContent).not.toMatch(/\$\d/);
  });

  it("stays in dollars when the property's currency is US dollars", async () => {
    stubApi({ currency: "USD" });
    render(<RateSimulator activeHotelId="h1" />);
    expect(await screen.findByText(/\$50\.00\s*–\s*\$500\.00/)).toBeTruthy();
  });

  it("shows a night no rule moves with a short dash in the Change column", async () => {
    stubApi();
    const view = render(<RateSimulator activeHotelId="h1" />);
    await screen.findByText("No rule fires on this night");
    const change = screen.getByText("No rule fires on this night").closest("td")?.previousElementSibling;
    expect(change?.textContent).toBe("–");
    expect(view.container.textContent).not.toContain("—");
  });
});

describe("the Rate Simulator's words", () => {
  it("says the math is the same a real run uses, and never speaks of an engine", async () => {
    stubApi();
    const view = render(<RateSimulator activeHotelId="h1" />);
    await screen.findByText(/Make up a night/);
    const text = view.container.textContent ?? "";
    expect(text).toContain(
      "The math is the same a real run uses, so what you see is what your rules would produce for these numbers.",
    );
    expect(text).toContain(
      "The math is the same a real run uses, and a real run keeps them quiet too when there isn’t enough history to read a pace.",
    );
    expect(text).toContain("The math is the same a real run uses, but this preview simplifies three things:");
    expect(text).toContain("when several event rules match, a real run picks one winner while this adds them all");
    expect(text).not.toMatch(/engine/i);
  });
});
