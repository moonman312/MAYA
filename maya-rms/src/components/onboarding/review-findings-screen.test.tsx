// @vitest-environment jsdom
/**
 * The review screen as a whole: Finish only moves on once the server says the
 * review is marked done, and says why when it isn't.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: () => {}, refresh: () => {} }) }));
vi.mock("@/lib/analytics/track", () => ({ track: () => {}, useTrackOnce: () => {} }));

const { ReviewFindings } = await import("./review-findings");

let completeReply: () => Response | Promise<Response> = () => json({ ok: true, totalRooms: 20 });
let completeCalls = 0;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  push.mockClear();
  completeCalls = 0;
  completeReply = () => json({ ok: true, totalRooms: 20 });
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "/api/onboarding/findings") return json({ findings: [] });
    if (url === "/api/onboarding/status") return json({ connected: true, hotelId: "h1", simulationMode: true });
    if (url === "/api/room-types") return json([]);
    if (url === "/api/onboarding/complete") {
      completeCalls += 1;
      return completeReply();
    }
    return json({});
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function pressFinish() {
  render(<ReviewFindings />);
  const button = await screen.findByRole("button", { name: /Finish/ });
  fireEvent.click(button);
  await waitFor(() => expect(completeCalls).toBe(1));
}

describe("Finish", () => {
  it("goes to the dashboard once the review is marked done", async () => {
    await pressFinish();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
  });

  it("stays and says why when the role can't finish it, with a way to the dashboard", async () => {
    completeReply = () => json({ error: "Only a Revenue Manager or above can finish the review." }, 403);
    await pressFinish();
    await screen.findByText("Only a Revenue Manager or above can finish the review.");
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Go to my dashboard" }).getAttribute("href")).toBe("/");
    expect((screen.getByRole("button", { name: /Finish/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("stays and says so when the save did not go through", async () => {
    completeReply = () => json({ error: "connection reset" }, 500);
    await pressFinish();
    await screen.findByText("connection reset");
    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Go to my dashboard" })).toBeNull();
  });

  it("stays and says so when the server can't be reached", async () => {
    completeReply = () => Promise.reject(new TypeError("Failed to fetch"));
    await pressFinish();
    await screen.findByText("Couldn't finish the review. Try again.");
    expect(push).not.toHaveBeenCalled();
  });
});
