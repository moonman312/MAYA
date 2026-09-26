// @vitest-environment jsdom
/**
 * Someone who arrives from a /go link and already has a session is sent
 * straight on. The browser can hold a session /go cannot confirm (Supabase
 * Auth failing or rate limiting, a deleted user whose token has not run out),
 * and then /go sends them straight back here. The page must go on by itself
 * only once, then show the form, or the two would bounce forever.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }) }));

const { default: LoginPage } = await import("./page");

const assign = vi.fn();

/** Open /login with this query string, as /go's redirect would. */
async function visit(search: string) {
  vi.stubGlobal("location", { ...window.location, search, assign });
  render(<LoginPage />);
  // Let the session check settle.
  await act(async () => {});
  cleanup();
}

beforeEach(() => {
  assign.mockReset();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("login page, arriving from a /go link with a session", () => {
  it("goes straight on once, then shows the form when /go sends them back", async () => {
    await visit("?next=%2Fgo%2Fcalendar");
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/go/calendar");

    await visit("?next=%2Fgo%2Fcalendar");
    await visit("?next=%2Fgo%2Fcalendar");
    expect(assign).toHaveBeenCalledTimes(1);

    vi.stubGlobal("location", { ...window.location, search: "?next=%2Fgo%2Fcalendar", assign });
    render(<LoginPage />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Sign In" })).toBeTruthy();
  });

  it("still goes straight on for a different link, or the same one a minute later", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await visit("?next=%2Fgo%2Fcalendar");
    await visit("?next=%2Fgo%2Frules.new");
    expect(assign.mock.calls).toEqual([["/go/calendar"], ["/go/rules.new"]]);

    now.mockReturnValue(1_000_000 + 61_000);
    await visit("?next=%2Fgo%2Fcalendar");
    expect(assign).toHaveBeenCalledTimes(3);
  });

  it("shows the form rather than risk a loop when it cannot remember the hop", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    await visit("?next=%2Fgo%2Fcalendar");
    await visit("?next=%2Fgo%2Fcalendar");
    expect(assign).not.toHaveBeenCalled();
  });
});
