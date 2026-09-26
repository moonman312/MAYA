// @vitest-environment jsdom
/**
 * The docs search box. When no page matches, a keyboard reader can still
 * reach "Ask the docs helper" and "Email us": the results stay open while
 * focus moves onto them, and Enter in the box asks the helper.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/docs/generated/index.json", () => ({
  default: {
    pages: [{ u: "/docs/rules/booking-speed", t: "Booking speed", s: "Rules", sum: "How fast nights book.", h: ["Where you set it"], hid: ["where-you-set-it"], k: "" }],
  },
}));

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
