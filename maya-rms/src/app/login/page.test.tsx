// @vitest-environment jsdom
/**
 * "Forgot password?" on the sign-in page must not tell anyone which addresses
 * have a MAYA account. Whatever Supabase answers (sent, no such account, rate
 * limited, no answer at all), the page shows the same words after the same
 * pause.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AuthApiError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESET_PAUSE_MS } from "@/lib/auth-links";

const auth = vi.hoisted(() => ({
  resetPasswordForEmail: vi.fn(),
  signInWithPassword: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/client", () => ({ createClient: () => ({ auth }) }));

const { default: LoginPage } = await import("./page");

const ADDRESS = "sam@harbour.example";

beforeEach(() => {
  for (const fn of Object.values(auth)) fn.mockReset();
  window.history.replaceState(null, "", "/login");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Opens the reset form from the sign-in form, types the address, sends. */
function askForReset() {
  render(<LoginPage />);
  fireEvent.change(screen.getByPlaceholderText("Email"), { target: { value: ADDRESS } });
  fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
  expect(screen.getByRole("heading", { name: "Reset your password" })).toBeTruthy();
  // The address typed for signing in carries over.
  expect((screen.getByPlaceholderText("Email") as HTMLInputElement).value).toBe(ADDRESS);
  fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
}

const answers: Record<string, () => Promise<unknown>> = {
  "an account, email sent": async () => ({ data: {}, error: null }),
  "no account (Supabase says nothing)": async () => ({ data: {}, error: null }),
  "an account asked twice in a minute": async () => ({
    data: null,
    error: new AuthApiError("For security purposes, you can only request this after 42 seconds.", 429, "over_email_send_rate_limit"),
  }),
  "Supabase down": async () => ({ data: null, error: new AuthApiError("Error sending recovery email", 500, "unexpected_failure") }),
  "no connection": async () => {
    throw new TypeError("Failed to fetch");
  },
  "no answer at all": () => new Promise(() => {}),
};

describe("Forgot password?", () => {
  it("asks Supabase for a link back to this site's own reset page", async () => {
    vi.useFakeTimers();
    auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
    askForReset();
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith(ADDRESS, {
      redirectTo: `${window.location.origin}/auth/reset-password`,
    });
  });

  it("shows the same screen after the same pause, whatever Supabase answers", async () => {
    const seen = new Set<string>();
    for (const [, answer] of Object.entries(answers)) {
      vi.useFakeTimers();
      auth.resetPasswordForEmail.mockImplementation(answer);
      askForReset();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(RESET_PAUSE_MS - 1);
      });
      expect(screen.queryByRole("heading", { name: "Check your email" })).toBeNull();
      expect(screen.getByRole("button", { name: "Sending..." })).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.getByRole("heading", { name: "Check your email" })).toBeTruthy();
      seen.add(document.body.textContent ?? "");

      cleanup();
      vi.useRealTimers();
    }
    expect(seen.size).toBe(1);
    const [only] = [...seen];
    expect(only).toContain(
      `If ${ADDRESS} has a MAYA account, a link to set a new password is on its way. Open it in this browser. The link works once.`,
    );
    expect(only).not.toMatch(/seconds|security purposes|Failed to fetch|recovery email/);
  });

  it("opens straight on the reset form from the reset page's link", () => {
    window.history.replaceState(null, "", "/login?mode=forgot");
    render(<LoginPage />);
    expect(screen.getByRole("heading", { name: "Reset your password" })).toBeTruthy();
  });
});
