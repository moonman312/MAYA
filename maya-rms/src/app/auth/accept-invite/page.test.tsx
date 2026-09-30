// @vitest-environment jsdom
/**
 * An invitation link that no longer works has to say what to do next, and the
 * advice has to be something the person can actually do: sign in if they set
 * a password already, or email us for a new link.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  verifyOtp: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  getSession: vi.fn(),
  getUser: vi.fn(),
  signOut: vi.fn(),
}));
const nav = vi.hoisted(() => ({ search: "", textSize: null as string | null }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    auth,
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: nav.textSize ? { text_size: nav.textSize } : null, error: null }) }),
      }),
    }),
  }),
}));

const { default: AcceptInvitePage } = await import("./page");

const EXPIRED =
  "This link has expired or was already used. If you set your password already, sign in. If not, email us for a new link.";

function open(search: string) {
  nav.search = search;
  window.history.replaceState(null, "", `/auth/accept-invite${search}`);
  render(<AcceptInvitePage />);
}

beforeEach(() => {
  for (const fn of Object.values(auth)) fn.mockReset();
  nav.textSize = null;
  document.documentElement.removeAttribute("data-text-size");
  document.cookie = "maya-text-size=; Path=/; Max-Age=0";
  auth.getSession.mockResolvedValue({ data: { session: null } });
  auth.getUser.mockResolvedValue({ data: { user: { id: "u-1", email: "night@inn.example" } } });
  auth.verifyOtp.mockResolvedValue({ data: {}, error: null });
});
afterEach(() => {
  cleanup();
});

describe("the person's text size", () => {
  it("is brought from their profile to this browser once the link is redeemed, clearing someone else's", async () => {
    document.documentElement.setAttribute("data-text-size", "larger");
    document.cookie = "maya-text-size=larger; Path=/";
    nav.textSize = "standard";
    open("?token_hash=abc&type=invite");
    await screen.findByLabelText("Password");
    expect(document.documentElement.hasAttribute("data-text-size")).toBe(false);
    expect(document.cookie).not.toContain("maya-text-size=larger");
  });
});

describe("an invitation link that no longer works", () => {
  it("says so, with a sign-in link and a way to ask us for a new one", async () => {
    auth.verifyOtp.mockResolvedValue({
      data: {},
      error: new AuthApiError("Email link is invalid or has expired", 403, "otp_expired"),
    });
    open("?token_hash=abc&type=invite");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(EXPIRED);
    expect(screen.getByRole("link", { name: "sign in" }).getAttribute("href")).toBe("/login");
    expect(screen.getByRole("link", { name: "email us" }).getAttribute("href")).toMatch(
      /^mailto:info@modern-hospitality-solutions\.com/,
    );
    // Supabase's own words never reach the page.
    expect(alert.textContent).not.toContain("invalid or has expired");
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("says the same when Supabase already refused the link on its own page", async () => {
    open("?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");
    expect((await screen.findByRole("alert")).textContent).toBe(EXPIRED);
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it("says the same when the link carries nothing to redeem and nobody is signed in", async () => {
    auth.getUser.mockResolvedValue({ data: { user: null } });
    open("");
    expect((await screen.findByRole("alert")).textContent).toBe(EXPIRED);
  });

  it("asks for a reload, not a new link, when the check got no answer", async () => {
    auth.verifyOtp.mockResolvedValue({ data: {}, error: new AuthRetryableFetchError("Failed to fetch", 0) });
    open("?token_hash=abc&type=invite");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "We couldn't check this link just now. Reload the page to try again.",
    );
  });
});

describe("an invitation link that works", () => {
  it("opens the set-password form", async () => {
    open("?token_hash=abc&type=invite");
    expect(await screen.findByLabelText("Password")).toBeTruthy();
    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: "abc", type: "invite" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
