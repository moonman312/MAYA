// @vitest-environment jsdom
/**
 * The docs helper's index downloads in the background: only after the page
 * has loaded and the browser is idle, never on data saver or 2G, once per
 * visit, and shared with the panel so opening it mid-download makes no
 * second request. A failed background download stays quiet until the reader
 * opens the panel, and opening retries.
 */
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "@/lib/docs/generated/ask-manifest.json";
import { AskProvider, useAsk } from "./ask-context";
import { AskPanel } from "./ask-panel";
import { prefetchHelper, resetHelperLoad } from "./helper-load";

vi.mock("next/navigation", () => ({ usePathname: () => "/docs/rules/booking-window" }));
vi.mock("@/lib/docs/ask/match", async (orig) => ({
  ...(await orig<typeof import("@/lib/docs/ask/match")>()),
  expandIndex: () => ({ pages: [], entries: [], questions: [] }),
}));
vi.mock("@/lib/docs/ask/respond", async (orig) => ({
  ...(await orig<typeof import("@/lib/docs/ask/respond")>()),
  createHelper: () => ({ respond: () => null }),
}));

let readyState: DocumentReadyState = "loading";
let idle: { cb: () => void; opts?: IdleRequestOptions }[] = [];
let fetchMock: ReturnType<typeof vi.fn>;
let answers: (() => Promise<Response>)[] = [];

const ok = () => Promise.resolve(Response.json({}));
const broken = () => Promise.resolve(new Response(null, { status: 503 }));

function helperRequests() {
  return fetchMock.mock.calls.filter(([url]) => url === manifest.file).length;
}

function runIdle() {
  const due = idle;
  idle = [];
  for (const i of due) i.cb();
}

function pageLoads() {
  readyState = "complete";
  window.dispatchEvent(new Event("load"));
}

beforeEach(() => {
  resetHelperLoad();
  readyState = "loading";
  idle = [];
  answers = [];
  vi.spyOn(document, "readyState", "get").mockImplementation(() => readyState);
  vi.stubGlobal("requestIdleCallback", (cb: () => void, opts?: IdleRequestOptions) => idle.push({ cb, opts }));
  vi.stubGlobal("cancelIdleCallback", () => {});
  fetchMock = vi.fn(async (url: string) => {
    if (url !== manifest.file) return new Response(null, { status: 204 });
    return (answers.shift() ?? ok)();
  });
  vi.stubGlobal("fetch", fetchMock);
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function OpenButton() {
  const { openAsk, closeAsk } = useAsk();
  return (
    <>
      <button onClick={() => openAsk()}>open</button>
      <button onClick={() => closeAsk()}>shut</button>
    </>
  );
}

function Panel({ openNow = false }: { openNow?: boolean }) {
  function Opener() {
    const { openAsk } = useAsk();
    useEffect(() => {
      if (openNow) openAsk();
    }, [openAsk]);
    return null;
  }
  return (
    <AskProvider enabled defaultStarters={["What is booking speed?"]}>
      <Opener />
      <OpenButton />
      <AskPanel />
    </AskProvider>
  );
}

const flush = () => act(async () => {});

describe("background download", () => {
  it("waits for the page to load, then for the browser to be idle", async () => {
    render(<Panel />);
    await flush();
    expect(idle).toHaveLength(0);
    expect(helperRequests()).toBe(0);

    pageLoads();
    expect(idle).toHaveLength(1);
    expect(idle[0].opts?.timeout).toBeGreaterThan(0);
    expect(helperRequests()).toBe(0);

    runIdle();
    await flush();
    expect(helperRequests()).toBe(1);
  });

  it("falls back to a short timer after load where there is no idle callback", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("requestIdleCallback", undefined);
      readyState = "complete";
      const stop = prefetchHelper();
      expect(helperRequests()).toBe(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(helperRequests()).toBe(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is skipped on data saver and on 2G; the panel still loads it when opened", async () => {
    for (const connection of [{ saveData: true }, { effectiveType: "2g" }, { effectiveType: "slow-2g" }]) {
      resetHelperLoad();
      fetchMock.mockClear();
      vi.stubGlobal("navigator", { ...navigator, connection });
      readyState = "complete";
      prefetchHelper();
      runIdle();
      await flush();
      expect(helperRequests()).toBe(0);
    }
    render(<Panel openNow />);
    await flush();
    expect(helperRequests()).toBe(1);
  });

  it("makes one request when the panel opens mid-download", async () => {
    let finish!: (r: Response) => void;
    answers.push(() => new Promise<Response>((res) => (finish = res)));
    readyState = "complete";
    render(<Panel />);
    await flush();
    runIdle();
    await flush();
    expect(helperRequests()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect(await screen.findByText("Getting the docs ready…")).toBeTruthy();
    await act(async () => finish(Response.json({})));
    expect(screen.queryByText("Getting the docs ready…")).toBeNull();
    expect(helperRequests()).toBe(1);
  });

  it("keeps a failed download quiet until the panel opens, and opening retries", async () => {
    answers.push(broken);
    readyState = "complete";
    render(<Panel />);
    await flush();
    runIdle();
    await flush();
    expect(helperRequests()).toBe(1);
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "open" }));
    await flush();
    expect(helperRequests()).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "What is booking speed?" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("runs once per visit, across client-side navigation between docs pages", async () => {
    readyState = "complete";
    const first = render(<Panel />);
    await flush();
    runIdle();
    await flush();
    expect(helperRequests()).toBe(1);
    first.unmount();

    // the next docs page mounts the helper again: no second background download
    render(<Panel />);
    await flush();
    expect(idle).toHaveLength(0);
    runIdle();
    await flush();
    expect(helperRequests()).toBe(1);
  });

  it("a failed background download is not repeated on the next page", async () => {
    answers.push(broken);
    readyState = "complete";
    const first = render(<Panel />);
    await flush();
    runIdle();
    await flush();
    first.unmount();
    render(<Panel />);
    await flush();
    runIdle();
    await flush();
    expect(helperRequests()).toBe(1);
  });
});
