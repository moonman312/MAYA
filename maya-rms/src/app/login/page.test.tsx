// @vitest-environment jsdom
/**
 * The sign-in page. "Forgot password?" must not tell anyone which addresses
 * have a MAYA account: whatever Supabase answers (sent, no such account, rate
 * limited, no answer at all), the page shows the same words after the same
 * pause.
 *
 * Creating an account asks Supabase to send the confirmation link back here,
 * and the page finishes the round trip: it redeems the link's code (finishing
 * a Cloudbeds Marketplace claim if one is waiting in this browser), says so
 * plainly when the link can't be used, and offers the link again to someone
 * who tries to sign in before confirming. With confirmation off, sign-up still
 * goes straight on.
 */
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AuthApiError, AuthPKCECodeVerifierMissingError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESEND_COOLDOWN_MS, RESET_PAUSE_MS } from "@/lib/auth-links";
import { CLAIM_KEY, MARKETPLACE_CLAIM_TTL_MS } from "@/lib/pms/claim-ticket";

const auth = vi.hoisted(() => ({
  resetPasswordForEmail: vi.fn(),
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  resend: vi.fn(),
  getSession: vi.fn(),
}));
const client = vi.hoisted(() => ({ createdAt: [] as string[], textSize: null as string | null }));
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/client", () => ({
  createClient: () => {
    // Where the address stood when the client was made: the browser client
    // redeems any code it finds there on its own.
    client.createdAt.push(window.location.href);
    return {
      auth,
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: client.textSize ? { text_size: client.textSize } : null, error: null }) }),
        }),
      }),
    };
  },
}));

const { default: LoginPage } = await import("./page");

const ADDRESS = "sam@harbour.example";
const REDIRECT = () => `${window.location.origin}/login?confirmed=1`;
const fetchMock = vi.fn();

/**
 * Node's own localStorage (no methods without a file behind it) shadows
 * jsdom's in this environment, so each test gets a plain in-memory one.
 */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (i: number) => [...items.keys()][i] ?? null,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, String(v)),
    removeItem: (k: string) => void items.delete(k),
    clear: () => items.clear(),
  };
}

beforeEach(() => {
  for (const fn of [...Object.values(auth), router.replace, router.refresh, fetchMock]) fn.mockReset();
  client.createdAt = [];
  client.textSize = null;
  document.documentElement.removeAttribute("data-text-size");
  document.cookie = "maya-text-size=; Path=/; Max-Age=0";
  auth.getSession.mockResolvedValue({ data: { session: null } });
  auth.exchangeCodeForSession.mockResolvedValue({ data: {}, error: null });
  auth.resend.mockResolvedValue({ data: {}, error: null });
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("localStorage", memoryStorage());
  sessionStorage.clear();
  window.history.replaceState(null, "", "/login");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Lets pending promises (and any timers due now) run. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function open(path: string, strict = false) {
  window.history.replaceState(null, "", path);
  render(strict ? <StrictMode><LoginPage /></StrictMode> : <LoginPage />);
}

function storedTicket(): { token: string; at: number } | null {
  const raw = localStorage.getItem(CLAIM_KEY);
  return raw ? (JSON.parse(raw) as { token: string; at: number }) : null;
}

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

/** Fills the create form and submits it. */
async function createAccount() {
  fireEvent.change(screen.getByPlaceholderText("Email"), { target: { value: ADDRESS } });
  fireEvent.change(screen.getByPlaceholderText("Choose a password"), { target: { value: "harbour-view" } });
  fireEvent.change(screen.getByPlaceholderText("Confirm password"), { target: { value: "harbour-view" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Create Account" }));
  await settle();
}

/** Fills the sign-in form and submits it. */
async function signIn() {
  fireEvent.change(screen.getByPlaceholderText("Email"), { target: { value: ADDRESS } });
  fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "harbour-view" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
  await settle();
}

const sendAgain = () => screen.getByRole("button", { name: "Send the link again" }) as HTMLButtonElement;

const NEW_USER = { id: "u-1", email: ADDRESS, identities: [{ id: "i-1" }] };

describe("creating an account", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("asks Supabase to send the confirmation link back to this page", async () => {
    auth.signUp.mockResolvedValue({ data: { user: NEW_USER, session: null }, error: null });
    open("/login?mode=signup");
    await createAccount();
    expect(auth.signUp).toHaveBeenCalledWith({
      email: ADDRESS,
      password: "harbour-view",
      options: expect.objectContaining({ emailRedirectTo: REDIRECT() }),
    });
    expect(auth.signUp.mock.calls[0][0].options.data).toBeTruthy();
  });

  it("goes straight on when Supabase signs them in at once, as with confirmation off", async () => {
    auth.signUp.mockResolvedValue({ data: { user: NEW_USER, session: { access_token: "t" } }, error: null });
    open("/login?mode=signup");
    await createAccount();
    expect(router.replace).toHaveBeenCalledWith("/");
    expect(screen.queryByRole("heading", { name: "Check your email" })).toBeNull();
  });

  it("finishes a Cloudbeds claim first when signed in at once", async () => {
    auth.signUp.mockResolvedValue({ data: { user: NEW_USER, session: { access_token: "t" } }, error: null });
    open("/login?claim=ticket-1");
    await createAccount();
    expect(fetchMock).toHaveBeenCalledWith("/api/pms/marketplace/claim", expect.objectContaining({
      body: JSON.stringify({ token: "ticket-1" }),
    }));
    expect(router.replace).toHaveBeenCalledWith("/onboarding");
    expect(storedTicket()).toBeNull();
  });

  it("says where the link went, and offers it again once Supabase's minute is up", async () => {
    auth.signUp.mockResolvedValue({ data: { user: NEW_USER, session: null }, error: null });
    open("/login?mode=signup");
    await createAccount();

    expect(screen.getByRole("heading", { name: "Check your email" })).toBeTruthy();
    expect(document.body.textContent).toContain(
      `A confirmation link is on its way to ${ADDRESS}. Open it to finish signing up.`,
    );
    expect(document.body.textContent).not.toContain("Cloudbeds");
    // Sign-up just sent one, so the button waits out the minute.
    expect(sendAgain().disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESEND_COOLDOWN_MS);
    });
    expect(sendAgain().disabled).toBe(false);

    fireEvent.click(sendAgain());
    await settle();
    expect(auth.resend).toHaveBeenCalledWith({
      type: "signup",
      email: ADDRESS,
      options: { emailRedirectTo: REDIRECT() },
    });
    expect(screen.getByRole("status").textContent).toBe("Sent. Check your inbox.");
    expect(sendAgain().disabled).toBe(true);
  });

  it("keeps the Cloudbeds line on the check-email screen for a claim", async () => {
    auth.signUp.mockResolvedValue({ data: { user: NEW_USER, session: null }, error: null });
    open("/login?claim=ticket-1");
    await createAccount();
    expect(document.body.textContent).toContain(
      "Open it to finish signing up. Your Cloudbeds property is saved and will be waiting.",
    );
    expect(storedTicket()?.token).toBe("ticket-1");
  });
});

describe("back from the confirmation link", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("redeems the code, finishes the claim waiting in this browser, then goes on", async () => {
    localStorage.setItem(CLAIM_KEY, JSON.stringify({ token: "ticket-1", at: Date.now() }));
    open("/login?confirmed=1&code=pkce-123");
    await settle();

    expect(auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("pkce-123");
    // Out of the address before any client could redeem it on its own.
    expect(client.createdAt.every((href) => !href.includes("code="))).toBe(true);
    expect(window.location.search).toBe("");
    expect(fetchMock).toHaveBeenCalledWith("/api/pms/marketplace/claim", expect.objectContaining({
      body: JSON.stringify({ token: "ticket-1" }),
    }));
    expect(auth.exchangeCodeForSession.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0],
    );
    expect(router.replace).toHaveBeenCalledWith("/onboarding");
    expect(storedTicket()).toBeNull();
  });

  it("goes home when no claim is waiting", async () => {
    open("/login?confirmed=1&code=pkce-123");
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith("/");
  });

  it("brings their text size from the profile to this browser before going on", async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ data: { user: { id: "u-1" } }, error: null });
    client.textSize = "large";
    open("/login?confirmed=1&code=pkce-123");
    await settle();
    expect(document.documentElement.getAttribute("data-text-size")).toBe("large");
    expect(document.cookie).toContain("maya-text-size=large");
    expect(router.replace).toHaveBeenCalledWith("/");
  });

  it("redeems once under Strict Mode", async () => {
    open("/login?confirmed=1&code=pkce-123", true);
    await settle();
    expect(auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledTimes(1);
  });

  it("asks for a sign-in when this browser can't redeem the code", async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ data: {}, error: new AuthPKCECodeVerifierMissingError() });
    open("/login?confirmed=1&code=pkce-123");
    await settle();
    expect(screen.getByRole("heading", { name: "Sign in to MAYA" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Your email is confirmed. Sign in to continue.");
    expect(router.replace).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("says the same when the exchange gets no answer", async () => {
    auth.exchangeCodeForSession.mockRejectedValue(new TypeError("Failed to fetch"));
    open("/login?confirmed=1&code=pkce-123");
    await settle();
    expect(screen.getByRole("status").textContent).toBe("Your email is confirmed. Sign in to continue.");
    expect((screen.getByRole("button", { name: "Sign In" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says the same with no code at all", async () => {
    open("/login?confirmed=1");
    await settle();
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("Your email is confirmed. Sign in to continue.");
    expect(window.location.search).toBe("");
  });

  const EXPIRED = "That link has expired or was already used. Try signing in.";
  const DESCRIPTION = "Email link is invalid or has expired";

  it("says the link has run out when Supabase refused it in the query", async () => {
    open(`/login?confirmed=1&error=access_denied&error_code=otp_expired&error_description=${encodeURIComponent(DESCRIPTION)}`);
    await settle();
    expect(screen.getByRole("status").textContent).toBe(EXPIRED);
    expect(document.body.textContent).not.toContain(DESCRIPTION);
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("says the same when the refusal is in the fragment", async () => {
    open(`/login?confirmed=1#error=access_denied&error_code=otp_expired&error_description=${encodeURIComponent(DESCRIPTION)}`);
    await settle();
    expect(screen.getByRole("status").textContent).toBe(EXPIRED);
    expect(document.body.textContent).not.toContain(DESCRIPTION);
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
  });
});

describe("the Cloudbeds claim ticket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("waits in localStorage, so the confirmation link can finish it in a new tab", async () => {
    open("/login?claim=ticket-1");
    expect(storedTicket()).toEqual({ token: "ticket-1", at: Date.now() });
    cleanup();

    // A new tab shares localStorage but not sessionStorage.
    sessionStorage.clear();
    open("/login?confirmed=1&code=pkce-123");
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("/api/pms/marketplace/claim", expect.objectContaining({
      body: JSON.stringify({ token: "ticket-1" }),
    }));
    expect(router.replace).toHaveBeenCalledWith("/onboarding");
  });

  it("is dropped once it is older than a claim can be valid", async () => {
    localStorage.setItem(CLAIM_KEY, JSON.stringify({ token: "ticket-1", at: Date.now() - MARKETPLACE_CLAIM_TTL_MS - 1 }));
    open("/login");
    expect(screen.getByText("Welcome back.")).toBeTruthy();
    expect(storedTicket()).toBeNull();
  });

  it("is still read from sessionStorage once, for a tab open across the deploy", () => {
    sessionStorage.setItem(CLAIM_KEY, "ticket-old");
    open("/login");
    expect(screen.getByText("Your Cloudbeds property is connected. Sign in to finish setting it up.")).toBeTruthy();
    expect(sessionStorage.getItem(CLAIM_KEY)).toBeNull();
    expect(storedTicket()?.token).toBe("ticket-old");
  });

  it("is forgotten when the claim is refused for good, and kept when it may pass", async () => {
    localStorage.setItem(CLAIM_KEY, JSON.stringify({ token: "ticket-1", at: Date.now() }));
    auth.signInWithPassword.mockResolvedValue({ data: {}, error: null });
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "Could not finish connecting your property." }) });
    open("/login");
    await signIn();
    expect(screen.getByText("Could not finish connecting your property.")).toBeTruthy();
    expect(storedTicket()?.token).toBe("ticket-1");

    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "That connection link has expired. Reconnect the app from the Cloudbeds Marketplace." }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    await settle();
    expect(screen.getByText("That connection link has expired. Reconnect the app from the Cloudbeds Marketplace.")).toBeTruthy();
    expect(storedTicket()).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("leaves the page working when storage is blocked", () => {
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    for (const store of [localStorage, sessionStorage]) {
      for (const method of ["getItem", "setItem", "removeItem"] as const) {
        vi.spyOn(store, method).mockImplementation(blocked);
      }
    }
    open("/login?claim=ticket-1");
    expect(screen.getByRole("heading", { name: "Create your MAYA account" })).toBeTruthy();
  });
});

describe("signing in before confirming", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    auth.signInWithPassword.mockResolvedValue({
      data: {},
      error: new AuthApiError("Email not confirmed", 400, "email_not_confirmed"),
    });
  });

  it("says so in plain words and sends the link again, then rests a minute", async () => {
    open("/login");
    await signIn();
    expect(document.body.textContent).toContain("Confirm your email first. The link is in your inbox.");
    expect(document.body.textContent).not.toContain("Email not confirmed");
    expect(router.replace).not.toHaveBeenCalled();

    fireEvent.click(sendAgain());
    await settle();
    expect(auth.resend).toHaveBeenCalledWith({
      type: "signup",
      email: ADDRESS,
      options: { emailRedirectTo: REDIRECT() },
    });
    expect(screen.getByRole("status").textContent).toBe("Sent. Check your inbox.");

    expect(sendAgain().disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESEND_COOLDOWN_MS - 1);
    });
    expect(sendAgain().disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(sendAgain().disabled).toBe(false);
  });

  it("words Supabase's rate limit plainly and waits it out", async () => {
    auth.resend.mockResolvedValue({
      data: null,
      error: new AuthApiError("For security purposes, you can only request this after 42 seconds.", 429, "over_email_send_rate_limit"),
    });
    open("/login");
    await signIn();
    fireEvent.click(sendAgain());
    await settle();
    expect(screen.getByRole("status").textContent).toBe("Too many emails for now. Wait a minute, then try again.");
    expect(document.body.textContent).not.toMatch(/security purposes|42 seconds/);
    expect(sendAgain().disabled).toBe(true);
  });

  it("words any other failure plainly and lets them try again", async () => {
    auth.resend.mockResolvedValue({
      data: null,
      error: new AuthApiError("Error sending confirmation email", 500, "unexpected_failure"),
    });
    open("/login");
    await signIn();
    fireEvent.click(sendAgain());
    await settle();
    expect(screen.getByRole("status").textContent).toBe("Could not send the link. Try again in a moment.");
    expect(document.body.textContent).not.toContain("Error sending confirmation email");
    expect(sendAgain().disabled).toBe(false);
  });

  it("still shows Supabase's words for a wrong password", async () => {
    auth.signInWithPassword.mockResolvedValue({
      data: {},
      error: new AuthApiError("Invalid login credentials", 400, "invalid_credentials"),
    });
    open("/login");
    await signIn();
    expect(screen.getByText("Invalid login credentials")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send the link again" })).toBeNull();
  });
});
