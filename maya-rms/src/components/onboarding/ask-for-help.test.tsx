// @vitest-environment jsdom
/**
 * "Get suggestions from my data" on the Rules tab. On Mews it used to spin for
 * a couple of hours while a read with nothing to read retried, then turn back
 * into the button without a word. Now the button is off where there is no
 * history to read, and a read that gives up always says so.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ children, href }: { children: React.ReactNode; href: string }) =>
      React.createElement("a", { href }, children),
  };
});

const { AskForHelp, gaveUpLine } = await import("./ask-for-help");

type Job = Record<string, unknown>;

function job(over: Job): Job {
  return {
    status: "completed",
    phase: "done",
    windows_completed: 3,
    rows_upserted: 12000,
    oldest_stay_date: "2023-09-01",
    newest_stay_date: "2026-09-01",
    last_error: null,
    started_at: "2026-09-01T10:00:00Z",
    finished_at: "2026-09-01T12:00:00Z",
    stats: {},
    ...over,
  };
}

function statusWith(over: Record<string, unknown> = {}) {
  return {
    connected: true,
    pmsType: "cloudbeds",
    pmsName: "Cloudbeds",
    historyImport: true,
    state: { questions: {}, questions_completed_at: null, review_completed_at: "2026-09-01T13:00:00Z" },
    job: job({}),
    proposedFindings: 0,
    ...over,
  };
}

let status: unknown = null;
let refresh: { ok: boolean; body: unknown } = { ok: true, body: { ok: true, jobId: "job-2" } };
const posts: string[] = [];

beforeEach(() => {
  status = statusWith();
  refresh = { ok: true, body: { ok: true, jobId: "job-2" } };
  posts.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        posts.push(url);
        return { ok: refresh.ok, json: async () => refresh.body } as Response;
      }
      return { ok: true, json: async () => status } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AskForHelp on a property system with no history import", () => {
  it("switches the button off with a short note, and never starts a read", async () => {
    status = statusWith({ pmsType: "mews", pmsName: "Mews", historyImport: false, job: null });
    const view = render(<AskForHelp />);
    await waitFor(() =>
      expect(view.container.textContent).toContain("Not available for Mews yet. MAYA can't read its booking history."),
    );
    const button = view.getByRole("button", { name: /Get suggestions from my data/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(view.queryByText("Here's exactly what happens")).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it("leaves the button on where history can be read", async () => {
    const view = render(<AskForHelp />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const button = view.getByRole("button", { name: /Get suggestions from my data/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(view.container.textContent).not.toContain("Not available");
  });
});

describe("AskForHelp when a read gives up", () => {
  it("says the last read stopped, instead of quietly showing the button again", async () => {
    status = statusWith({ job: job({ status: "failed", phase: "historical", stats: { stop: { count: 4, retryAt: null, alerted: true } } }) });
    const view = render(<AskForHelp />);
    await waitFor(() => expect(view.container.textContent).toContain("Your last read stopped. We've been told."));
    // The button stays, so a new read can be started.
    expect(view.getByRole("button", { name: /Get suggestions from my data/ })).toBeTruthy();
  });

  it("says when a paused read tries again", async () => {
    const retryAt = new Date(Date.now() + 60 * 60_000);
    status = statusWith({
      job: job({ status: "failed", phase: "historical", stats: { stop: { count: 1, retryAt: retryAt.toISOString(), alerted: true } } }),
    });
    const view = render(<AskForHelp />);
    await waitFor(() =>
      expect(view.container.textContent).toContain("Your last read paused. We've been told, and it tries again by itself around"),
    );
  });

  it("stops showing the waiting dot once the read it started gives up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = render(<AskForHelp />);
    fireEvent.click(await view.findByRole("button", { name: /Get suggestions from my data/ }));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Sounds good, read it" }));
    });
    expect(posts).toEqual(["/api/onboarding/refresh"]);
    // Until the status shows the new read, the press itself holds the dot.
    await waitFor(() => expect(view.container.textContent).toContain("Reading your history…"));

    status = statusWith({ job: job({ status: "running", phase: "historical", started_at: "2026-09-29T10:00:00Z", finished_at: null }) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(view.container.textContent).toContain("Reading your history…");

    status = statusWith({
      job: job({
        status: "failed",
        phase: "historical",
        started_at: "2026-09-29T10:00:00Z",
        finished_at: "2026-09-29T12:30:00Z",
        stats: { stop: { count: 4, retryAt: null, alerted: false } },
      }),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    await waitFor(() => expect(view.container.textContent).not.toContain("Reading your history…"));
    expect(view.container.textContent).toContain("Your last read stopped. Email us and we'll restart it.");
  });

  it("shows the result of the read it started once that read is done", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = render(<AskForHelp />);
    fireEvent.click(await view.findByRole("button", { name: /Get suggestions from my data/ }));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Sounds good, read it" }));
    });
    status = statusWith({
      state: { questions: {}, questions_completed_at: null, review_completed_at: null },
      job: job({ started_at: "2026-09-29T10:00:00Z", finished_at: "2026-09-29T11:00:00Z" }),
      proposedFindings: 3,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    await waitFor(() => expect(view.getByRole("link").textContent).toBe("3 suggestions ready →"));
  });
});

describe("gaveUpLine", () => {
  it("names a connection that went away", () => {
    expect(
      gaveUpLine(job({ status: "canceled", last_error: "Stopped: the PMS connection was disconnected." }) as never),
    ).toBe("Your last read stopped because your property system is no longer connected.");
    expect(gaveUpLine(job({ status: "canceled", last_error: "Stopped: something else." }) as never)).toBe(
      "Your last read stopped before it finished.",
    );
  });

  it("says nothing about a read that finished or is still going", () => {
    expect(gaveUpLine(job({ status: "completed" }) as never)).toBeNull();
    expect(gaveUpLine(job({ status: "running" }) as never)).toBeNull();
    expect(gaveUpLine(null)).toBeNull();
  });
});
