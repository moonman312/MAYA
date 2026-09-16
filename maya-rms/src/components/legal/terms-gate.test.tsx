// @vitest-environment jsdom
/**
 * The accept screen sits in front of every page in the app, so the cases that
 * matter are the ones where it must stay out of the way: an unsure or failed
 * answer, the pages that carry their own checkbox, and after acceptance.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRIVACY_VERSION, TERMS_VERSION } from "@/lib/legal/versions";

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const { TermsGate } = await import("./terms-gate");

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let answer: () => Promise<Response>;
let postAnswer: () => Promise<Response>;

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

beforeEach(() => {
  nav.pathname = "/";
  calls = [];
  answer = () => json({ required: true });
  postAnswer = () => json({ ok: true, recorded: true });
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return init?.method === "POST" ? postAnswer() : answer();
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const gets = () => calls.filter((c) => c.init?.method !== "POST");
const dialog = () => screen.queryByRole("dialog");

describe("TermsGate", () => {
  it("covers the page when the server says acceptance is required", async () => {
    render(<TermsGate />);
    await waitFor(() => expect(dialog()).not.toBeNull());
    const button = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("stays out of the way when the server is unsure or unreachable", async () => {
    answer = () => json({ required: false });
    const { unmount } = render(<TermsGate />);
    await waitFor(() => expect(gets()).toHaveLength(1));
    expect(dialog()).toBeNull();
    unmount();

    answer = () => json({ error: "boom" }, 500);
    render(<TermsGate />);
    await waitFor(() => expect(gets()).toHaveLength(2));
    expect(dialog()).toBeNull();
    cleanup();

    answer = () => Promise.reject(new Error("offline"));
    render(<TermsGate />);
    await waitFor(() => expect(gets()).toHaveLength(3));
    expect(dialog()).toBeNull();
  });

  it("never asks on the pages that carry their own checkbox", async () => {
    for (const path of ["/login", "/auth/accept-invite"]) {
      nav.pathname = path;
      render(<TermsGate />);
      await act(async () => {});
      expect(dialog()).toBeNull();
      cleanup();
    }
    expect(gets()).toHaveLength(0);
  });

  it("records a reaccept of the current versions and gets out of the way", async () => {
    render(<TermsGate />);
    await waitFor(() => expect(dialog()).not.toBeNull());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(dialog()).toBeNull());
    const post = calls.find((c) => c.init?.method === "POST");
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      accepted: true,
      context: "reaccept",
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
    });
  });

  it("keeps asking, with the reason, when the save fails", async () => {
    postAnswer = () => json({ error: "The terms have been updated. Reload the page to see them." }, 409);
    render(<TermsGate />);
    await waitFor(() => expect(dialog()).not.toBeNull());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByText(/have been updated/)).not.toBeNull());
    expect(dialog()).not.toBeNull();
  });

  it("asks again after a sign-in page, but not on every navigation", async () => {
    answer = () => json({ required: false });
    const { rerender } = render(<TermsGate />);
    await waitFor(() => expect(gets()).toHaveLength(1));

    nav.pathname = "/account/billing";
    rerender(<TermsGate />);
    await act(async () => {});
    expect(gets()).toHaveLength(1);

    nav.pathname = "/login";
    rerender(<TermsGate />);
    await act(async () => {});
    answer = () => json({ required: true });
    nav.pathname = "/onboarding";
    rerender(<TermsGate />);
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(gets()).toHaveLength(2);
  });
});
