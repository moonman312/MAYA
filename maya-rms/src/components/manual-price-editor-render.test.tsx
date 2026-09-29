// @vitest-environment jsdom
/**
 * A rate the hotel changed in its PMS shows in the editor like any manual
 * price: it can be cleared, and the Clear button says where it came from.
 *
 * The line under the box follows what became of the price: the send status
 * is read a few times after a save and once on opening a night with a typed
 * price, and a stopped send shows Try again (once per press, managers only)
 * and a link to the sending problem.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManualPriceEditor, REFRESH_AFTER_RETRY_MS, REFRESH_AFTER_SAVE_MS, type SendStatus } from "./manual-price-editor";

afterEach(cleanup);

const base = {
  hotelId: "hotel-1",
  roomTypeId: "rt-1",
  roomTypeName: "King",
  stayDate: "2026-10-05",
  currentPrice: 180,
  pmsName: "Cloudbeds",
  onSaved: () => {},
};

describe("ManualPriceEditor", () => {
  it("offers Clear on a rate changed in the PMS, saying so on hover", () => {
    const view = render(
      <ManualPriceEditor {...base} manualPrice={{ price: 180, set_at: "2026-10-01T12:00:00Z", source: "pms", pms_type: "cloudbeds" }} />,
    );
    const clear = view.getByRole("button", { name: "Clear" });
    expect(clear.getAttribute("title")).toBe("Changed in Cloudbeds. Clear hands the night back to your rules.");
    expect((view.getByLabelText("Manual price for King") as HTMLInputElement).value).toBe("180");

    fireEvent.click(view.getByRole("button", { name: "What a manual price does" }));
    const help = view.getByRole("group", { name: "Setting a price yourself" }).textContent ?? "";
    expect(help).toContain("A rate changed in Cloudbeds is kept the same way, once MAYA's own price has been there for an hour.");
    expect(help).not.toContain("—");
  });

  it("shows the property's currency symbol beside the box, and dollars when none is given", () => {
    const euro = render(<ManualPriceEditor {...base} manualPrice={null} currencySymbol="€" />);
    expect(euro.getByLabelText("Manual price for King").closest("label")?.textContent).toBe("€");
    euro.unmount();
    const plain = render(<ManualPriceEditor {...base} manualPrice={null} />);
    expect(plain.getByLabelText("Manual price for King").closest("label")?.textContent).toBe("$");
  });

  it("keeps a typed price's Clear as it was", () => {
    const view = render(<ManualPriceEditor {...base} manualPrice={{ price: 150, set_at: "2026-10-01T12:00:00Z", source: "maya" }} />);
    expect(view.getByRole("button", { name: "Clear" }).getAttribute("title")).toBeNull();
  });

  it("has no Clear on a night that has passed, and keeps it for tonight", () => {
    const manualPrice = { price: 150, set_at: "2026-10-01T12:00:00Z", source: "maya" as const };
    const past = render(<ManualPriceEditor {...base} manualPrice={manualPrice} hotelToday="2026-10-06" />);
    expect(past.queryByRole("button", { name: "Clear" })).toBeNull();
    cleanup();
    const tonight = render(<ManualPriceEditor {...base} manualPrice={manualPrice} hotelToday="2026-10-05" />);
    expect(tonight.getByRole("button", { name: "Clear" })).toBeTruthy();
  });

  it("shows the property's currency symbol by the amount", () => {
    const view = render(<ManualPriceEditor {...base} manualPrice={null} currencySymbol="€" />);
    expect(view.getByLabelText("Manual price for King").closest("label")?.textContent).toContain("€");
    expect(view.getByLabelText("Manual price for King").closest("label")?.textContent).not.toContain("$");
  });

  it("says a clear on a passed night had nothing to clear", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true, cells: 0, passed: true })));
    vi.stubGlobal("fetch", fetchSpy);
    const view = render(
      <ManualPriceEditor {...base} manualPrice={{ price: 150, set_at: "2026-10-01T12:00:00Z", source: "maya" }} />,
    );
    fireEvent.click(view.getByRole("button", { name: "Clear" }));
    expect((await view.findByRole("status")).textContent).toBe("This night has passed, so there is nothing to clear.");
    vi.unstubAllGlobals();
  });
});

const INCIDENT = "0b0c8a6e-3c1d-4d8e-9f2a-6a1b2c3d4e5f";
const typed = { price: 200, set_at: "2026-10-01T12:00:00Z", source: "maya" as const };

function statusOf(over: Partial<SendStatus> = {}): SendStatus {
  return {
    applicable: true,
    state: "pending",
    retriesLeft: null,
    attempts: null,
    lastAttemptAt: null,
    retryRequested: false,
    pmsType: "cloudbeds",
    pmsName: "Cloudbeds",
    incidentId: null,
    maxAttempts: 10,
    canRetry: true,
    ...over,
  };
}

/**
 * fetch by route: the save answers `nudged`, the status answers the next
 * status in `statuses` (the last one again once they run out), and retry
 * answers `retry`. Counts each call so the timing can be pinned.
 */
function fakeFetch(statuses: SendStatus[], retry: { status?: number; body: unknown } = { body: { ok: true, state: "retrying", alreadyRequested: false } }) {
  const calls: { method: string; url: string }[] = [];
  const queue = [...statuses];
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (url.startsWith("/api/manual-price/send-status?")) {
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      return new Response(JSON.stringify(next));
    }
    if (url === "/api/manual-price/retry") return new Response(JSON.stringify(retry.body), { status: retry.status ?? 200 });
    return new Response(JSON.stringify({ ok: true, cells: 1, suppressedRules: 0, retiredPickups: 0, pausedRules: 0, pushed: "nudged", preview: [] }));
  });
  vi.stubGlobal("fetch", spy);
  const count = (method: string, prefix: string) => calls.filter((c) => c.method === method && c.url.startsWith(prefix)).length;
  return { calls, statusReads: () => count("GET", "/api/manual-price/send-status"), retries: () => count("POST", "/api/manual-price/retry") };
}

const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

async function saveTyped(view: ReturnType<typeof render>) {
  fireEvent.change(view.getByLabelText("Manual price for King"), { target: { value: "200" } });
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await tick();
}

describe("ManualPriceEditor and the send status", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reads the status three times after a save, at the set delays, and then stops", async () => {
    const fetches = fakeFetch([statusOf({ state: "retrying", retriesLeft: 3, attempts: 7 }), statusOf({ state: "sent" })]);
    const view = render(<ManualPriceEditor {...base} manualPrice={null} />);
    await saveTyped(view);
    expect(view.getByRole("status").textContent).toBe("Saved. Sending to Cloudbeds now.");
    expect(fetches.statusReads()).toBe(0);

    await tick(REFRESH_AFTER_SAVE_MS[0]);
    expect(fetches.statusReads()).toBe(1);
    expect(view.getByRole("status").textContent).toBe("Saved. It couldn't be sent yet. MAYA will retry 3 more times.");
    expect(view.queryByRole("button", { name: "Try again" })).toBeNull();

    await tick(REFRESH_AFTER_SAVE_MS[1] - REFRESH_AFTER_SAVE_MS[0]);
    expect(fetches.statusReads()).toBe(2);
    await tick(REFRESH_AFTER_SAVE_MS[2] - REFRESH_AFTER_SAVE_MS[1]);
    expect(fetches.statusReads()).toBe(3);
    expect(view.getByRole("status").textContent).toBe("Sent to Cloudbeds.");

    // No loop: nothing more, however long the card stays open.
    await tick(60 * 60_000);
    expect(fetches.statusReads()).toBe(3);
  });

  it("keeps the save's own line while the status says no more than it did", async () => {
    const fetches = fakeFetch([statusOf({ state: "pending" })]);
    const view = render(<ManualPriceEditor {...base} manualPrice={null} />);
    await saveTyped(view);
    await tick(REFRESH_AFTER_SAVE_MS[0]);
    expect(fetches.statusReads()).toBe(1);
    expect(view.getByRole("status").textContent).toBe("Saved. Sending to Cloudbeds now.");
  });

  it("reads once on opening a night with a typed price, not for a rate changed in the PMS or a night without one", async () => {
    const fetches = fakeFetch([statusOf({ state: "sent" })]);
    const opened = render(<ManualPriceEditor {...base} manualPrice={typed} />);
    await tick();
    expect(fetches.statusReads()).toBe(1);
    expect(opened.getByRole("status").textContent).toBe("Sent to Cloudbeds.");
    await tick(10 * 60_000);
    expect(fetches.statusReads()).toBe(1);
    cleanup();

    render(<ManualPriceEditor {...base} manualPrice={{ ...typed, source: "pms", pms_type: "cloudbeds" }} />);
    render(<ManualPriceEditor {...base} manualPrice={null} />);
    await tick(10 * 60_000);
    expect(fetches.statusReads()).toBe(1);
  });

  it("stops reading when the card closes", async () => {
    const fetches = fakeFetch([statusOf({ state: "sent" })]);
    const view = render(<ManualPriceEditor {...base} manualPrice={null} />);
    await saveTyped(view);
    view.unmount();
    await tick(10 * 60_000);
    expect(fetches.statusReads()).toBe(0);
  });

  it("shows a stopped send with both buttons, sends Try again once for a double click, then follows the retry", async () => {
    const fetches = fakeFetch([
      statusOf({ state: "failed", retriesLeft: 0, attempts: 10, incidentId: INCIDENT }),
      statusOf({ state: "retrying", retriesLeft: 1, retryRequested: true }),
      statusOf({ state: "sent" }),
    ]);
    const view = render(<ManualPriceEditor {...base} manualPrice={typed} />);
    await tick();
    expect(view.getByRole("status").textContent).toBe("This price couldn't be sent to Cloudbeds.");
    const link = view.getByRole("link", { name: "See the error log" });
    expect(link.getAttribute("href")).toBe(`/?tab=changelog&dl=changelog.problem&problem=${INCIDENT}`);

    const tryAgain = view.getByRole("button", { name: "Try again" });
    fireEvent.click(tryAgain);
    fireEvent.click(tryAgain);
    expect(fetches.retries()).toBe(1);
    expect((tryAgain as HTMLButtonElement).disabled).toBe(true);
    await tick();
    expect(fetches.retries()).toBe(1);
    expect(view.getByRole("status").textContent).toBe("Saved. It couldn't be sent yet. MAYA will retry 1 more time.");
    expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(JSON.parse(String((vi.mocked(fetch).mock.calls.find((c) => String(c[0]) === "/api/manual-price/retry")![1] as RequestInit).body))).toEqual({
      hotelId: "hotel-1",
      roomTypeId: "rt-1",
      date: "2026-10-05",
    });

    // Read again at the set delays until the state leaves "retrying".
    expect(fetches.statusReads()).toBe(1);
    await tick(REFRESH_AFTER_RETRY_MS[0]);
    expect(fetches.statusReads()).toBe(2);
    expect(view.getByRole("status").textContent).toBe("Saved. It couldn't be sent yet. MAYA will retry 1 more time.");
    await tick(REFRESH_AFTER_RETRY_MS[1] - REFRESH_AFTER_RETRY_MS[0]);
    expect(fetches.statusReads()).toBe(3);
    expect(view.getByRole("status").textContent).toBe("Sent to Cloudbeds.");
    await tick(REFRESH_AFTER_RETRY_MS[3]);
    expect(fetches.statusReads()).toBe(3);
  });

  it("offers no Try again to someone who cannot type prices, and links to the change log when no problem is shown yet", async () => {
    fakeFetch([statusOf({ state: "failed", retriesLeft: 0, attempts: 1, canRetry: false, incidentId: null })]);
    const view = render(<ManualPriceEditor {...base} manualPrice={typed} />);
    await tick();
    expect(view.getByRole("status").textContent).toBe("This price couldn't be sent to Cloudbeds.");
    expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(view.getByRole("link", { name: "See the error log" }).getAttribute("href")).toBe("/?tab=changelog&dl=changelog");
  });

  it("shows where the night is now when Try again finds nothing left to retry", async () => {
    const fetches = fakeFetch(
      [statusOf({ state: "failed", retriesLeft: 0, attempts: 1 }), statusOf({ state: "sent" })],
      { status: 409, body: { error: "This price has already been sent to Cloudbeds.", state: "sent" } },
    );
    const view = render(<ManualPriceEditor {...base} manualPrice={typed} />);
    await tick();
    fireEvent.click(view.getByRole("button", { name: "Try again" }));
    await tick();
    expect(fetches.statusReads()).toBe(2);
    expect(view.getByRole("status").textContent).toBe("Sent to Cloudbeds.");
    expect(view.queryByRole("alert")).toBeNull();
  });

  it("puts how sending is retried behind the ?, with the server's count", async () => {
    fakeFetch([statusOf({ state: "retrying", retriesLeft: 4, attempts: 6, maxAttempts: 10 })]);
    const view = render(<ManualPriceEditor {...base} manualPrice={typed} />);
    await tick();
    fireEvent.click(view.getByRole("button", { name: "What a manual price does" }));
    const help = view.getByRole("group", { name: "Setting a price yourself" }).textContent ?? "";
    expect(help).toContain("A price Cloudbeds doesn't take is sent again, up to 10 times at that price, then once a day. Try again sends it once more now.");
    expect(help).not.toMatch(/[—–]/);
  });
});
