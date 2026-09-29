// @vitest-environment jsdom
/**
 * The page a "Forgot password?" email lands on. It redeems the link the way
 * the invitation page does (token_hash through verifyOtp, a PKCE code through
 * exchangeCodeForSession), says plainly when the link can't be used, and then
 * sets the new password.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AuthApiError, AuthPKCECodeVerifierMissingError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../../../middleware";
import { isAcceptanceExemptPath } from "@/lib/legal/versions";

const auth = vi.hoisted(() => ({
  verifyOtp: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  getSession: vi.fn(),
  getUser: vi.fn(),
  signOut: vi.fn(),
  updateUser: vi.fn(),
}));
const client = vi.hoisted(() => ({ createdAt: [] as string[] }));
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/client", () => ({
  createClient: () => {
    // Where the address stood when the client was made: the browser client
    // redeems any code it finds there on its own.
    client.createdAt.push(window.location.href);
    return { auth };
  },
}));

const { default: ResetPasswordPage } = await import("./page");

function open(search: string) {
  window.history.replaceState(null, "", `/auth/reset-password${search}`);
  render(<ResetPasswordPage />);
}

beforeEach(() => {
  for (const fn of [...Object.values(auth), router.replace, router.refresh]) fn.mockReset();
  client.createdAt = [];
  auth.getSession.mockResolvedValue({ data: { session: null } });
  auth.getUser.mockResolvedValue({ data: { user: { id: "u-1", email: "sam@harbour.example" } } });
  auth.verifyOtp.mockResolvedValue({ data: {}, error: null });
  auth.exchangeCodeForSession.mockResolvedValue({ data: {}, error: null });
  auth.updateUser.mockResolvedValue({ data: {}, error: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("redeeming the link", () => {
  it("redeems a token_hash link with verifyOtp and opens the form", async () => {
    open("?token_hash=abc&type=recovery");
    expect(await screen.findByLabelText("New password")).toBeTruthy();
    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: "abc", type: "recovery" });
    expect(screen.getByText("sam@harbour.example")).toBeTruthy();
    // The one-time link doesn't stay in the address bar.
    expect(window.location.search).toBe("");
  });

  it("signs out whoever else was signed in before redeeming a token_hash link", async () => {
    auth.getSession.mockResolvedValue({ data: { session: { user: { id: "someone-else" } } } });
    open("?token_hash=abc&type=recovery");
    await screen.findByLabelText("New password");
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(auth.signOut.mock.invocationCallOrder[0]).toBeLessThan(auth.verifyOtp.mock.invocationCallOrder[0]);
  });

  it("redeems a code itself, with the code already out of the address when the client starts", async () => {
    open("?code=pkce-123");
    expect(await screen.findByLabelText("New password")).toBeTruthy();
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("pkce-123");
    expect(client.createdAt.every((href) => !href.includes("code="))).toBe(true);
    // Signing out first would throw away the verifier the code needs.
    expect(auth.signOut).not.toHaveBeenCalled();
  });
});

describe("a link that can't be used", () => {
  const EXPIRED =
    "This link has expired or was already used. If you set your new password already, sign in. If not, ask for a new link.";

  it("says so when it expired or was used, with a way to sign in or ask again", async () => {
    auth.verifyOtp.mockResolvedValue({
      data: {},
      error: new AuthApiError("Email link is invalid or has expired", 403, "otp_expired"),
    });
    open("?token_hash=abc&type=recovery");
    expect((await screen.findByRole("alert")).textContent).toBe(EXPIRED);
    expect(screen.getByRole("link", { name: "sign in" }).getAttribute("href")).toBe("/login");
    expect(screen.getByRole("link", { name: "ask for a new link" }).getAttribute("href")).toBe("/login?mode=forgot");
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  it("says the same when Supabase refused it before it got here", async () => {
    open("?error=access_denied&error_code=otp_expired");
    expect((await screen.findByRole("alert")).textContent).toBe(EXPIRED);
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("says the same with nothing to redeem, even for someone already signed in", async () => {
    open("");
    expect((await screen.findByRole("alert")).textContent).toBe(EXPIRED);
    expect(auth.getUser).not.toHaveBeenCalled();
  });

  it("asks for the browser that requested it when a code is opened elsewhere", async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ data: {}, error: new AuthPKCECodeVerifierMissingError() });
    open("?code=pkce-123");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Open this link in the browser where you asked for it. Or ask for a new link from this one.",
    );
  });
});

describe("setting the new password", () => {
  async function fill(password: string, confirm = password) {
    open("?token_hash=abc&type=recovery");
    fireEvent.change(await screen.findByLabelText("New password"), { target: { value: password } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: confirm } });
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
  }

  it("saves it and goes on to the app, on this site", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await fill("harbour-lights-9");
    expect(await screen.findByText("Your new password is set. Taking you to MAYA…")).toBeTruthy();
    expect(auth.updateUser).toHaveBeenCalledWith({ password: "harbour-lights-9" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(router.replace).toHaveBeenCalledWith("/");
  });

  it("checks the two boxes match before asking Supabase", async () => {
    await fill("harbour-lights-9", "harbour-lights-8");
    expect(await screen.findByText("Passwords don't match.")).toBeTruthy();
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("puts Supabase's refusal in plain words", async () => {
    auth.updateUser.mockResolvedValue({
      data: {},
      error: new AuthApiError("New password should be different from the old password.", 422, "same_password"),
    });
    await fill("harbour-lights-9");
    expect(await screen.findByText("That's the password you have now. Choose a different one.")).toBeTruthy();
  });
});

describe("the page itself", () => {
  it("is open to someone signed out, and the Terms screen never covers it", () => {
    // The middleware only refreshes a session; it turns nobody away.
    expect(new RegExp(`^${config.matcher[0]}$`).test("/auth/reset-password")).toBe(true);
    expect(isAcceptanceExemptPath("/auth/reset-password")).toBe(true);
  });
});
