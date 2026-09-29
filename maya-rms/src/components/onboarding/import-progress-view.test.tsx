// @vitest-environment jsdom
/**
 * The import now usually starts when the property is claimed, so an owner who
 * has just paid can reach the progress page with the analysis already done.
 * They go straight on to review. Someone who is watching it run still gets the
 * moment where it finishes.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { earlyResultsReady, stoppedLabel } from "./import-progress";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ children, href }: { children: React.ReactNode; href: string }) =>
      React.createElement("a", { href }, children),
  };
});

const { ImportProgressView } = await import("./import-progress-view");

type Job = { status: string; phase: string; stats?: Record<string, unknown> };

function statusWith(job: Job, proposedFindings = 2) {
  return {
    connected: true,
    job: {
      windows_completed: 3,
      rows_upserted: 12000,
      oldest_stay_date: "2023-09-01",
      newest_stay_date: "2027-09-01",
      last_error: null,
      finished_at: null,
      ...job,
    },
    proposedFindings,
  };
}

let responses: unknown[] = [];

beforeEach(() => {
  router.push.mockReset();
  router.replace.mockReset();
  responses = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const body = responses.length > 1 ? responses.shift() : responses[0];
      return { ok: true, json: async () => body } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ImportProgressView", () => {
  it("goes straight to review when the analysis finished before they arrived", async () => {
    responses = [statusWith({ status: "completed", phase: "done" })];
    render(<ImportProgressView />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/onboarding/review"));
    expect(router.push).not.toHaveBeenCalled();
  });

  it("goes straight to review when early results were ready before they arrived", async () => {
    responses = [statusWith({ status: "running", phase: "historical", stats: { earlyAnalysisAt: "2026-09-16T10:00:00Z" } })];
    render(<ImportProgressView />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/onboarding/review"));
  });

  it("says the booking history is being read while it runs", async () => {
    responses = [statusWith({ status: "running", phase: "historical" }, 0)];
    const view = render(<ImportProgressView />);
    await waitFor(() =>
      expect(view.getByRole("heading", { level: 1 }).textContent).toBe("We're reading your booking history"),
    );
  });

  it("shows an en dash, not an em dash, for a tile with nothing in it yet", async () => {
    const early = statusWith({ status: "running", phase: "discover" }, 0);
    responses = [{ ...early, job: { ...early.job, oldest_stay_date: null, newest_stay_date: null } }];
    const view = render(<ImportProgressView />);
    await waitFor(() => expect(view.container.textContent).toContain("Years covered"));
    expect(view.getByText("Years covered").parentElement?.textContent).toContain("–");
    expect(view.getByText("Oldest stay").parentElement?.textContent).toContain("–");
    expect(view.container.textContent).not.toContain("—");
  });

  it("still shows the moment it finishes to someone watching it run", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    responses = [
      statusWith({ status: "running", phase: "sync_current" }),
      statusWith({ status: "completed", phase: "done" }),
    ];
    render(<ImportProgressView />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(router.replace).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(router.push).toHaveBeenCalledWith("/onboarding/review");
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("a paid property with no connection left", () => {
  it("shows the reconnect prompt instead of a progress bar that would never move", async () => {
    responses = [
      {
        ...statusWith({ status: "canceled", phase: "discover" }),
        hotelId: "hotel-1",
        reconnect: {
          pmsType: "cloudbeds",
          authKind: "oauth2_authorization_code",
          displayName: "Cloudbeds",
          canManage: true,
          historyRemoved: true,
        },
      },
    ];
    const view = render(<ImportProgressView />);
    const link = await view.findByRole("link", { name: "Reconnect Cloudbeds" });
    expect(link.getAttribute("href")).toBe("/api/pms/cloudbeds/connect?hotelId=hotel-1");
    expect(view.getByRole("heading", { level: 1 }).textContent).toBe("Reconnect Cloudbeds to continue");
    expect(view.container.textContent).toContain("your booking history comes back once you reconnect");
    expect(view.container.textContent).not.toContain("reading your booking history");
    expect(view.container.textContent).not.toContain("Room-nights");
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("earlyResultsReady", () => {
  it("counts a job waiting in the queue with its early analysis done", () => {
    const stats = { earlyAnalysisAt: "2026-09-16T10:00:00Z" };
    expect(earlyResultsReady({ ...statusWith({ status: "queued", phase: "historical", stats }).job })).toBe(true);
    expect(earlyResultsReady({ ...statusWith({ status: "running", phase: "historical", stats }).job })).toBe(true);
    expect(earlyResultsReady({ ...statusWith({ status: "queued", phase: "discover" }).job })).toBe(false);
    expect(earlyResultsReady({ ...statusWith({ status: "failed", phase: "historical", stats }).job })).toBe(false);
  });
});

describe("a stopped import says what happens next, and only that", () => {
  const NOW = new Date(2026, 8, 29, 10, 0).getTime();
  const failed = (stop?: Record<string, unknown>) =>
    statusWith({ status: "failed", phase: "historical", stats: stop ? { stop } : {} }).job;
  const at = (ms: number) => new Date(ms).toISOString();

  it("names the retry it booked, and says we were told when the alert got through", () => {
    const retryAt = new Date(2026, 8, 29, 11, 0).getTime();
    const label = stoppedLabel(failed({ count: 1, retryAt: at(retryAt), alerted: true }), NOW);
    const time = new Date(retryAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    expect(label).toBe(`Import paused. We've been told, and it tries again by itself around ${time}.`);
  });

  it("names the day when the retry is not today", () => {
    const retryAt = new Date(2026, 8, 30, 9, 0).getTime();
    const label = stoppedLabel(failed({ count: 3, retryAt: at(retryAt), alerted: true }), NOW);
    expect(label).toContain(new Date(retryAt).toLocaleDateString(undefined, { weekday: "short" }));
  });

  it("never claims we were told when the alert did not get through", () => {
    const retryAt = new Date(2026, 8, 29, 11, 0).getTime();
    expect(stoppedLabel(failed({ count: 1, retryAt: at(retryAt), alerted: false }), NOW)).not.toContain("told");
    expect(stoppedLabel(failed({ count: 4, retryAt: null, alerted: false }), NOW)).toBe(
      "Import stopped. Email us and we'll restart it.",
    );
    // Stopped before the worker recorded anything: nobody was told.
    expect(stoppedLabel(failed(), NOW)).toBe("Import stopped. Email us and we'll restart it.");
  });

  it("promises no retry once the worker has given up", () => {
    expect(stoppedLabel(failed({ count: 4, retryAt: null, alerted: true }), NOW)).toBe("Import stopped. We've been told.");
  });

  it("says a retry that is due is moments away", () => {
    expect(stoppedLabel(failed({ count: 1, retryAt: at(NOW - 30_000), alerted: true }), NOW)).toContain(
      "tries again by itself in a minute or two",
    );
  });

  it("shows on the progress bar with the amber dot, under a heading that no longer says it is reading", async () => {
    responses = [statusWith({ status: "failed", phase: "historical", stats: { stop: { count: 4, retryAt: null, alerted: true } } }, 0)];
    const view = render(<ImportProgressView />);
    await waitFor(() => expect(view.container.textContent).toContain("Import stopped. We've been told."));
    expect(view.container.querySelector(".bg-amber-500")).toBeTruthy();
    expect(view.container.querySelector(".animate-ping")).toBeNull();
    expect(view.getByRole("heading", { level: 1 }).textContent).toBe("Your import has stopped");
    expect(view.container.textContent).toContain("Everything read so far is kept.");
  });

  it("calls a stop with a retry booked a pause", async () => {
    const retryAt = new Date(Date.now() + 60 * 60_000).toISOString();
    responses = [statusWith({ status: "failed", phase: "historical", stats: { stop: { count: 1, retryAt, alerted: true } } }, 0)];
    const view = render(<ImportProgressView />);
    await waitFor(() => expect(view.getByRole("heading", { level: 1 }).textContent).toBe("Your import is paused"));
    expect(view.container.textContent).toContain("Import paused. We've been told, and it tries again by itself around");
  });
});
