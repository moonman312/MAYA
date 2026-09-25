// @vitest-environment jsdom
/**
 * Arriving from a link: the address, the highlight, and the promise that a
 * link only opens and fills in.
 */
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDashboardUrl } from "./use-dashboard-url";
import { flashWhenReady } from "./flash";
import { ArrivalFlash, readArrivalOnce } from "./arrival-bits";
import { arrivalFlashTarget } from "@/lib/deep-links/flash-target";

function at(url: string) {
  window.history.replaceState(null, "", url);
}

beforeEach(() => {
  at("/");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useDashboardUrl", () => {
  it("opens on the tab and place the address names", () => {
    at("/?tab=rules&panel=builder&filter=enabled");
    const { result } = renderHook(() => useDashboardUrl(window.location.search));
    expect(result.current.tab).toBe("rules");
    expect(result.current.ruleFormOpen).toBe(true);
    expect(result.current.ruleFilter).toBe("enabled");
  });

  it("pushes a new screen, replaces a change within one, and back returns to the last screen", async () => {
    const { result } = renderHook(() => useDashboardUrl(""));
    const length = window.history.length;
    act(() => result.current.setTab("rules"));
    expect(window.location.search).toBe("?tab=rules");
    expect(window.history.length).toBe(length + 1);
    act(() => result.current.setRuleFilter("disabled"));
    expect(window.location.search).toBe("?tab=rules&filter=disabled");
    expect(window.history.length).toBe(length + 1);
    act(() => result.current.setTab("changelog"));
    act(() => result.current.setChangesOnly((v) => !v));
    expect(window.location.search).toBe("?tab=changelog&view=all");
    await act(async () => {
      window.history.back();
      await new Promise((r) => window.addEventListener("popstate", r, { once: true }));
    });
    expect(result.current.tab).toBe("rules");
    expect(result.current.ruleFilter).toBe("disabled");
  });

  it("lets two setters in one handler compose, and a month change closes the night", () => {
    at("/?date=2026-12-05");
    const { result } = renderHook(() => useDashboardUrl(window.location.search));
    expect(result.current.selectedDay).toBe(5);
    act(() => {
      result.current.setMonth(1);
      result.current.setYear((y) => y + 1);
    });
    expect(window.location.search).toBe("?month=2027-01");
    expect(result.current.selectedDay).toBeNull();
  });

  it("restores how a tab was left when coming back to it", () => {
    const { result } = renderHook(() => useDashboardUrl(""));
    act(() => result.current.setTab("rules"));
    act(() => result.current.setRuleFilter("enabled"));
    act(() => result.current.setTab("pms"));
    act(() => result.current.setTab("rules"));
    expect(window.location.search).toBe("?tab=rules&filter=enabled");
  });
});

describe("readArrivalOnce", () => {
  it("takes everything that applies once out of the address and keeps the place", () => {
    at("/?tab=rules&panel=builder&dl=rules.new&name=Nearly+full&occupancy=gt85&direction=increase&percent=10");
    const a = readArrivalOnce();
    expect(a.dest).toBe("rules.new");
    expect(a.params).toEqual({ name: "Nearly full", occupancy: "gt85", direction: "increase", percent: "10" });
    expect(window.location.search).toBe("?tab=rules&panel=builder");
    // a refresh now fills nothing
    expect(readArrivalOnce().dest).toBeNull();
  });
});

describe("flashWhenReady", () => {
  it("waits for a place that loads late, rings it and moves focus to it, not into a field", async () => {
    const stop = flashWhenReady("rules.builder", { timeoutMs: 2000 });
    const box = document.createElement("div");
    box.setAttribute("data-deeplink", "rules.builder");
    const input = document.createElement("input");
    box.appendChild(input);
    document.body.appendChild(box);
    await waitFor(() => expect(box.hasAttribute("data-dl-flash")).toBe(true));
    expect(document.activeElement).toBe(box);
    stop();
    box.remove();
  });

  it("leaves a link's place in the tab order alone", async () => {
    const link = document.createElement("a");
    link.href = "/account/billing/restart";
    link.textContent = "Restart your subscription";
    link.setAttribute("data-deeplink", "billing.restart");
    document.body.appendChild(link);
    const stop = flashWhenReady("billing.restart", { timeoutMs: 2000 });
    await waitFor(() => expect(link.hasAttribute("data-dl-flash")).toBe(true));
    expect(document.activeElement).toBe(link);
    expect(link.hasAttribute("tabindex")).toBe(false);
    expect(link.tabIndex).toBe(0);
    stop();
    link.remove();
  });

  it("lets a plain box hold focus only until focus moves on", async () => {
    const box = document.createElement("section");
    box.setAttribute("data-deeplink", "billing.room-count");
    const next = document.createElement("button");
    document.body.append(box, next);
    const stop = flashWhenReady("billing.room-count", { timeoutMs: 2000 });
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(box.getAttribute("tabindex")).toBe("-1");
    next.focus();
    expect(box.hasAttribute("tabindex")).toBe(false);
    stop();
    box.remove();
    next.remove();
  });

  it("never takes a selector from anywhere but its id, and gives up quietly", async () => {
    vi.useFakeTimers();
    const evil = document.createElement("div");
    evil.setAttribute("data-deeplink", "x");
    document.body.appendChild(evil);
    flashWhenReady('x"],[data-deeplink="x', { timeoutMs: 50 });
    vi.advanceTimersByTime(100);
    expect(evil.hasAttribute("data-dl-flash")).toBe(false);
    evil.remove();
  });
});

describe("ArrivalFlash", () => {
  it("highlights the part of a page a link named, records the arrival, and cleans the address", async () => {
    at("/account/billing?focus=room-count&dl=billing.room-count");
    render(
      <>
        <section data-deeplink="billing.room-count">Room count</section>
        <ArrivalFlash flashIds={{ "room-count": "billing.room-count" }} />
      </>,
    );
    await waitFor(() => expect(screen.getByText("Room count").hasAttribute("data-dl-flash")).toBe(true));
    expect(window.location.search).toBe("");
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("/api/events");
    expect(JSON.parse(String((calls[0][1] as RequestInit).body))).toMatchObject({ event: "deeplink.opened", properties: { dest: "billing.room-count", filled: false } });
  });
});

describe("arrivalFlashTarget", () => {
  it("names the registry's place, or one checked row", () => {
    const id = "0b0c8a6e-3c1d-4d8e-9f2a-6a1b2c3d4e5f";
    expect(arrivalFlashTarget({ dest: "rules.new", params: {}, focus: "room-types" })).toBe("rules.builder.room-types");
    expect(arrivalFlashTarget({ dest: "suggestions", params: {}, focus: "suggestions" })).toBe("rules.suggestions");
    expect(arrivalFlashTarget({ dest: "room-types", params: { roomType: id }, focus: null })).toBe(`pms.room-type:${id}`);
    expect(arrivalFlashTarget({ dest: "floors", params: {}, focus: "guardrails" })).toBe("simulator.guardrails");
    expect(arrivalFlashTarget({ dest: null, params: {}, focus: null })).toBeNull();
  });
});
