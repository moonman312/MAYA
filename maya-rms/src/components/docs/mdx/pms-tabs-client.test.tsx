// @vitest-environment jsdom
/**
 * The property-system tabs on a docs page: a click switches the tab, and the
 * pick is remembered in this browser. When the browser will not store it
 * (site data blocked), the click still switches the tab.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tabs = [
  { pms: "cloudbeds", label: "Cloudbeds", content: <p>Cloudbeds steps</p> },
  { pms: "mews", label: "Mews", content: <p>Mews steps</p> },
];

// A fresh copy each time, so a pick from one test does not carry into the next.
async function renderTabs() {
  const { PmsTabsClient } = await import("./pms-tabs-client");
  render(<PmsTabsClient tabs={tabs} />);
}

function expectShown(label: string, other: string) {
  expect(screen.getByRole("tab", { name: label }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByText(`${label} steps`).closest("[hidden]")).toBeNull();
  expect(screen.getByText(`${other} steps`).closest("[hidden]")).not.toBeNull();
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PmsTabsClient", () => {
  it("switches the tab and remembers the pick", async () => {
    await renderTabs();
    expectShown("Cloudbeds", "Mews");
    fireEvent.click(screen.getByRole("tab", { name: "Mews" }));
    expectShown("Mews", "Cloudbeds");
    expect(localStorage.getItem("maya-docs-pms")).toBe("mews");
  });

  it("still switches the tab when the browser will not store the pick", async () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    await renderTabs();
    expectShown("Cloudbeds", "Mews");
    fireEvent.click(screen.getByRole("tab", { name: "Mews" }));
    expectShown("Mews", "Cloudbeds");
  });
});
