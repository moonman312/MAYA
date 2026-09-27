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

function stubApi() {
  const posts: Record<string, unknown>[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/room-types")) {
        return json({
          timezone: "UTC",
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
