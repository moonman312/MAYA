// @vitest-environment jsdom
/**
 * The docs search box. When no page matches, a keyboard reader can still
 * reach "Ask the docs helper" and "Email us": the results stay open while
 * focus moves onto them, and Enter in the box asks the helper. And when the
 * search index fails to load, the next try loads it again.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const index = vi.hoisted(() => ({
  loads: 0,
  failures: 0,
  load() {
    index.loads++;
    if (index.failures > 0) {
      index.failures--;
      throw new Error("offline");
    }
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
  it("says so, and loads it on the next try", async () => {
    // A fresh copy of the search box and the index, neither loaded yet.
    vi.resetModules();
    vi.doMock("@/lib/docs/generated/index.json", () => index.load());
    const { DocsSearch: FreshSearch } = await import("./search");
    index.failures = 1;
    const loadsBefore = index.loads;
    render(
      <>
        <FreshSearch />
        <button type="button">Elsewhere</button>
      </>,
    );
    const input = screen.getByRole("combobox");
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "booking" } });
    await screen.findByText(/could not load/);

    act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
    await pause();
    act(() => input.focus());
    expect(await screen.findByText("Booking speed")).toBeTruthy();
    expect(screen.queryByText(/could not load|Loading the search/)).toBeNull();
    expect(index.loads - loadsBefore).toBe(2);
  });
});
