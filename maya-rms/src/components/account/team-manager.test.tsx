// @vitest-environment jsdom
/**
 * What the Team page says after "Send invitation": an email is only promised
 * when one really went out. Someone who already uses MAYA is added without
 * one, and the page says so.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamManager } from "@/components/account/team-manager";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let inviteAnswer: () => Promise<Response>;

beforeEach(() => {
  inviteAnswer = async () => json({ ok: true, inviteSent: true, pendingId: "p-1", existingUser: false });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/account/team" && init?.method === "POST") return inviteAnswer();
      return json({ members: [], invites: [], seats: { used: 1, limit: 5, remaining: 4, full: false }, rooms: 20 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function sendTo(address: string) {
  render(<TeamManager />);
  fireEvent.change(await screen.findByLabelText("Their email"), { target: { value: address } });
  fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
}

describe("after Send invitation", () => {
  it("promises an email when one went out", async () => {
    await sendTo("night@harbour.example");
    expect(
      await screen.findByText("Invitation sent to night@harbour.example. They'll get an email with a link to join."),
    ).toBeTruthy();
  });

  it("says they were added, and promises no email, when they already use MAYA", async () => {
    inviteAnswer = async () => json({ ok: true, inviteSent: false, pendingId: "p-1", existingUser: true });
    await sendTo("priya@harbour.example");
    expect(
      await screen.findByText(
        "Added. priya@harbour.example already uses MAYA and will see this property next time they sign in.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Invitation sent/)).toBeNull();
    expect(screen.queryByText(/get an email/)).toBeNull();
  });

  it("shows the server's plain sentence when sending fails", async () => {
    inviteAnswer = async () => json({ error: "Could not send that invitation. Try again in a minute." }, 500);
    await sendTo("night@harbour.example");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not send that invitation. Try again in a minute.",
    );
  });

  it("shows a plain sentence, not the browser's words, when the connection drops", async () => {
    inviteAnswer = async () => {
      throw new TypeError("Failed to fetch");
    };
    await sendTo("night@harbour.example");
    expect((await screen.findByRole("alert")).textContent).toBe("Could not send that invitation.");
  });
});
