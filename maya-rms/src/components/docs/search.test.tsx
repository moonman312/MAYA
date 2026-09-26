// @vitest-environment jsdom
/**
 * The docs search box. When no page matches, a keyboard reader can still
 * reach "Ask the docs helper" and "Email us": the results stay open while
 * focus moves onto them, and Enter in the box asks the helper. And when the
 * search index fails to load, the search says so and offers to reload the
 * page, because the built site will not fetch the index again on its own.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const index = vi.hoisted(() => ({
  offline: false,
  load() {
    if (index.offline) throw new Error("offline");
    return {
      default: {
        pages: [{ u: "/docs/rules/booking-speed", t: "Booking speed", s: "Rules", sum: "How fast nights book.", h: ["Where you set it"], hid: ["where-you-set-it"], k: "" }],
      },
    };
  },
}));
vi.mock("@/lib/docs/generated/index.json", () => index.load());

import { AskProvider, useAsk } from "./ask/ask-context";
import { DocsSearch } from "./search";

afterEach(cleanup);

function AskState() {
  const { open, draft } = useAsk();
  return <p data-testid="ask">{open ? `asked: ${draft}` : "closed"}</p>;
}

function renderSearch() {
  render(
    <AskProvider enabled defaultStarters={[]}>
      <DocsSearch />
      <AskState />
      <button type="button">Elsewhere</button>
    </AskProvider>,
  );
  return screen.getByRole("combobox");
}

// Longer than the search waits after a blur before it closes.
const pause = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 200)));

async function searchFor(input: HTMLElement, query: string) {
  act(() => input.focus());
  fireEvent.change(input, { target: { value: query } });
  await screen.findByText(/No page matches/);
}

describe("when no page matches", () => {
  it("stays open while Tab moves from the box to the helper button", async () => {
    const input = renderSearch();
    await searchFor(input, "zzqxv");
    const ask = screen.getByRole("button", { name: "Ask the docs helper" });
    act(() => ask.focus());
    await pause();
    expect(document.activeElement).toBe(ask);
    expect(ask.closest("[hidden]")).toBeNull();
    expect(ask.closest('[role="listbox"]')).toBeNull();
    fireEvent.click(ask);
    expect(screen.getByTestId("ask").textContent).toBe("asked: zzqxv");
  });

  it("closes once focus leaves the search", async () => {
    const input = renderSearch();
    await searchFor(input, "zzqxv");
    act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
    await pause();
    expect(screen.getByText(/No page matches/).closest("[hidden]")).not.toBeNull();
  });

  it("asks the helper when Enter is pressed in the box", async () => {
    const input = renderSearch();
    await searchFor(input, "zzqxv");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("ask").textContent).toBe("asked: zzqxv");
  });
});

describe("when the search index fails to load", () => {
  afterEach(() => {
    index.offline = false;
    vi.unstubAllGlobals();
  });

  it("says so and offers to reload the page, and does not pretend to try again", async () => {
    // A fresh copy of the search box and the index, neither loaded yet. The
    // index stays out of reach for the whole test, as it does in the built
    // site, where the bundler keeps a file that failed and never fetches it
    // again: a later focus or keystroke cannot bring it back.
    vi.resetModules();
    vi.doMock("@/lib/docs/generated/index.json", () => index.load());
    const { DocsSearch: FreshSearch } = await import("./search");
    index.offline = true;
    render(
      <>
        <FreshSearch />
        <button type="button">Elsewhere</button>
      </>,
    );
    const input = screen.getByRole("combobox");
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "booking" } });
    expect((await screen.findByText(/could not load/)).textContent).toMatch(/reload the page/);
    expect(screen.queryByText(/type again/)).toBeNull();

    // Coming back to the box and typing more keeps the message, rather than
    // going back to "Loading" as if the search were trying again.
    act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
    await pause();
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "booking speed" } });
    expect(screen.queryByText(/Loading the search/)).toBeNull();
    await pause();
    expect(screen.getByText(/could not load/)).toBeTruthy();
    expect(screen.queryByText(/Loading the search/)).toBeNull();

    // Tab reaches the reload button without closing the results, and it
    // reloads the page.
    const reloadButton = screen.getByRole("button", { name: "Reload the page" });
    act(() => reloadButton.focus());
    await pause();
    expect(reloadButton.closest("[hidden]")).toBeNull();
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    fireEvent.click(reloadButton);
    expect(reload).toHaveBeenCalledOnce();
  });
});
