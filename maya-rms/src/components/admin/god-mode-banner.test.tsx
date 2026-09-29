// @vitest-environment jsdom
/**
 * The God Mode banner (only ever rendered for a platform admin, see
 * god-mode-banner-slot): nothing while no window is open, the property and
 * the time left with a window open, a countdown from the window's own
 * expires_at, "ended" and a reload when it runs out, and the way out.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/", refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, useRouter: () => ({ refresh: nav.refresh }) }));

const { GOD_MODE_CHANGED_EVENT, GodModeBanner, timeLeftWords } = await import("./god-mode-banner");

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let answer: () => unknown;
let deleteAnswer: () => { ok: boolean; body: unknown };

const START = Date.parse("2026-09-29T10:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  nav.pathname = "/";
  nav.refresh = vi.fn();
  calls = [];
  answer = () => ({ admin: false });
  deleteAnswer = () => ({ ok: true, body: { ok: true, active: false } });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === "DELETE") {
      const d = deleteAnswer();
      return new Response(JSON.stringify(d.body), { status: d.ok ? 200 : 403 });
    }
    return new Response(JSON.stringify(answer()), { status: 200 });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const on = (minutes: number, hotel: { id: string; name: string } | null = { id: "h9", name: "Harbour Inn" }) => ({
  admin: true,
  active: true,
  expiresAt: new Date(START + minutes * 60_000).toISOString(),
  hotel,
});

/** Lets the fetch settle without moving the clock. */
const settle = () => act(async () => {
  await vi.advanceTimersByTimeAsync(0);
});

describe("GodModeBanner", () => {
  it("renders nothing for an admin with no window open, after one call", async () => {
    answer = () => ({ admin: true, active: false, expiresAt: null, hotel: null });
    render(<GodModeBanner />);
    await settle();
    expect(screen.queryByRole("status")).toBeNull();
    expect(calls).toEqual([{ url: "/api/admin/god-mode", init: { cache: "no-store" } }]);
  });

  it("never asks on the pages that carry no session", async () => {
    nav.pathname = "/login";
    render(<GodModeBanner />);
    await settle();
    expect(calls).toEqual([]);
  });

  it("says it covers every property, names the one on screen, and counts the minutes down from the window's own end", async () => {
    answer = () => on(12);
    render(<GodModeBanner />);
    await settle();
    expect(screen.getByRole("status").textContent).toContain("God Mode is on for all properties, Harbour Inn included: 12 min left");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(screen.getByRole("status").textContent).toContain("11 min left");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 30_000);
    });
    expect(screen.getByRole("status").textContent).toContain("less than a minute left");
  });

  it("says all properties on the Command Center", async () => {
    nav.pathname = "/admin/hotels/h9";
    answer = () => on(30);
    render(<GodModeBanner />);
    await settle();
    expect(screen.getByRole("status").textContent).toContain("God Mode is on for all properties: 30 min left");
  });

  it("says it ended and reloads the page when the time runs out", async () => {
    const reload = vi.fn();
    answer = () => on(1);
    render(<GodModeBanner reload={reload} />);
    await settle();
    expect(screen.getByRole("status").textContent).toContain("1 min left");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(screen.getByRole("status").textContent).toContain("God Mode ended");
    expect(reload).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("ends God Mode from the banner and refreshes the page", async () => {
    answer = () => on(20);
    render(<GodModeBanner />);
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "End God Mode" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls.map((c) => c.init?.method ?? "GET")).toEqual(["GET", "DELETE"]);
    expect(screen.queryByRole("status")).toBeNull();
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it("shows the server's reason when it could not end", async () => {
    answer = () => on(20);
    deleteAnswer = () => ({ ok: false, body: { error: "Only MAYA staff can turn off God Mode." } });
    render(<GodModeBanner />);
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "End God Mode" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("status").textContent).toContain("Only MAYA staff can turn off God Mode.");
  });

  it("looks again when the button says the window changed", async () => {
    render(<GodModeBanner />);
    await settle();
    expect(screen.queryByRole("status")).toBeNull();
    answer = () => on(30, null);
    await act(async () => {
      window.dispatchEvent(new Event(GOD_MODE_CHANGED_EVENT));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("status").textContent).toContain("God Mode is on for all properties: 30 min left");
  });
});

describe("timeLeftWords", () => {
  it("rounds up to whole minutes and says less than a minute under one", () => {
    expect(timeLeftWords(30 * 60_000)).toBe("30 min left");
    expect(timeLeftWords(61_000)).toBe("2 min left");
    expect(timeLeftWords(60_000)).toBe("1 min left");
    expect(timeLeftWords(59_999)).toBe("less than a minute left");
    expect(timeLeftWords(0)).toBe("less than a minute left");
  });
});
