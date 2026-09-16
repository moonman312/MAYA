// @vitest-environment jsdom
/**
 * The import now usually starts when the property is claimed, so an owner who
 * has just paid can reach the progress page with the analysis already done.
 * They go straight on to review. Someone who is watching it run still gets the
 * moment where it finishes.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { earlyResultsReady } from "./import-progress";

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

describe("earlyResultsReady", () => {
  it("counts a job waiting in the queue with its early analysis done", () => {
    const stats = { earlyAnalysisAt: "2026-09-16T10:00:00Z" };
    expect(earlyResultsReady({ ...statusWith({ status: "queued", phase: "historical", stats }).job })).toBe(true);
    expect(earlyResultsReady({ ...statusWith({ status: "running", phase: "historical", stats }).job })).toBe(true);
    expect(earlyResultsReady({ ...statusWith({ status: "queued", phase: "discover" }).job })).toBe(false);
    expect(earlyResultsReady({ ...statusWith({ status: "failed", phase: "historical", stats }).job })).toBe(false);
  });
});
