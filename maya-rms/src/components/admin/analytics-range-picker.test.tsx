// @vitest-environment jsdom
/**
 * The date picker: its buttons are links to the windows (the common ones
 * fetched ahead), a click lights its button at once, and a typed day goes
 * straight to the page without jumping the scroll.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ push: vi.fn(), links: [] as { href: string; prefetch: unknown; scroll: unknown }[] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push }) }));
vi.mock("next/link", () => ({
  default: ({ href, prefetch, scroll, children, onClick, onMouseEnter, ...rest }: Record<string, unknown>) => {
    nav.links.push({ href: String(href), prefetch, scroll });
    return (
      <a
        href={String(href)}
        data-prefetch={String(prefetch)}
        onClick={(e) => {
          e.preventDefault();
          (onClick as (() => void) | undefined)?.();
        }}
        onMouseEnter={onMouseEnter as () => void}
        {...(rest as object)}
      >
        {children as React.ReactNode}
      </a>
    );
  },
  useLinkStatus: () => ({ pending: false }),
}));

const { AnalyticsRangePicker } = await import("./analytics-range-picker");

const TODAY = "2026-09-30";

beforeEach(() => {
  nav.push = vi.fn();
  nav.links = [];
});
afterEach(() => cleanup());

describe("AnalyticsRangePicker", () => {
  it("links each button to its window, fetching the last 7, 30 and 90 days ahead", () => {
    render(<AnalyticsRangePicker from="2026-09-01" to={TODAY} today={TODAY} />);
    const link = (name: string) => screen.getByText(name).closest("a")!;
    expect(link("30d").getAttribute("href")).toBe("/admin/analytics?from=2026-09-01&to=2026-09-30");
    expect(link("7d").getAttribute("data-prefetch")).toBe("true");
    expect(link("90d").getAttribute("data-prefetch")).toBe("true");
    expect(link("This week").getAttribute("data-prefetch")).toBe("false");
    expect(link("30d").getAttribute("aria-current")).toBe("true");
    expect(nav.links.every((l) => l.scroll === false)).toBe(true);
  });

  it("fetches a week ahead once the pointer is on it", () => {
    render(<AnalyticsRangePicker from="2026-09-01" to={TODAY} today={TODAY} />);
    const week = screen.getByText("Last week").closest("a")!;
    fireEvent.mouseEnter(week);
    expect(week.getAttribute("data-prefetch")).toBe("true");
  });

  it("lights the clicked button at once, before the page has moved", () => {
    render(<AnalyticsRangePicker from="2026-09-01" to={TODAY} today={TODAY} />);
    fireEvent.click(screen.getByText("7d"));
    expect(screen.getByText("7d").closest("a")!.getAttribute("aria-current")).toBe("true");
    expect(screen.getByText("30d").closest("a")!.getAttribute("aria-current")).toBeNull();
  });

  it("keeps the test toggle and doesn't jump the scroll for a typed day", () => {
    render(<AnalyticsRangePicker from="2026-09-01" to={TODAY} includeTest today={TODAY} />);
    fireEvent.change(screen.getByLabelText("First day"), { target: { value: "2026-09-10" } });
    expect(nav.push).toHaveBeenCalledWith("/admin/analytics?from=2026-09-10&to=2026-09-30&test=1", { scroll: false });
    expect(screen.getByText("7d").closest("a")!.getAttribute("href")).toBe("/admin/analytics?from=2026-09-24&to=2026-09-30&test=1");
  });
});
