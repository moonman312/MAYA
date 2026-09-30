// @vitest-environment jsdom
/**
 * The dashboard opens at the text size on the person's profile even when
 * this browser's cookie holds another one (a size chosen on another device,
 * someone else's cookie on a shared computer). The <head> script only knows
 * the cookie, so the page the server sends carries a fix ahead of the
 * dashboard: nothing of the dashboard is drawn at the old size first.
 */
import { cleanup, render } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEXT_SIZE_COOKIE, TEXT_SIZE_SCRIPT, textSizeFixScript, textSizeFromCookie } from "@/lib/text-size";
import { TextSizeFix } from "@/components/text-size-sync";

const state = vi.hoisted(() => ({ cookie: undefined as string | undefined, saved: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "maya-text-size" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
    getAll: () => [],
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u-1" } } }) },
    rpc: async () => ({ data: false, error: null }),
  }),
}));
vi.mock("@/lib/settings/profile-settings", () => ({ readTextSize: async () => state.saved }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => "h-1" }));
vi.mock("@/lib/deep-links/member-role", () => ({ memberRole: async () => "general_manager" }));
vi.mock("@/lib/admin/god-mode", () => ({ godModeStatus: async () => ({ active: false }) }));
vi.mock("@/components/admin/god-mode-banner-slot", () => ({ GodModeBannerSlot: () => null }));
vi.mock("@/components/dashboard", () => ({
  Dashboard: () => <main id="dashboard">calendar</main>,
}));

const { default: Home } = await import("./page");

const root = () => document.documentElement;
function clearCookie() {
  document.cookie = `${TEXT_SIZE_COOKIE}=; Path=/; Max-Age=0`;
}

async function serverHtml(): Promise<string> {
  const page = await Home({ searchParams: Promise.resolve({}) });
  return renderToString(page);
}

/** The scripts in the sent page, run in order the way the browser parses them. */
function runScriptsIn(html: string) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  for (const s of doc.querySelectorAll("script")) new Function(s.textContent ?? "")();
}

beforeEach(() => {
  clearCookie();
  root().removeAttribute("data-text-size");
  state.cookie = undefined;
  state.saved = null;
});
afterEach(() => {
  cleanup();
  clearCookie();
  root().removeAttribute("data-text-size");
});

describe("the dashboard page when the cookie is out of step with the profile", () => {
  it("sends a fix ahead of the dashboard that sets the profile's size and the cookie", async () => {
    // Chosen Larger on the phone; the laptop's cookie still says Standard.
    state.saved = "larger";
    const html = await serverHtml();
    const fix = html.indexOf("<script>");
    expect(fix).toBeGreaterThanOrEqual(0);
    expect(fix).toBeLessThan(html.indexOf('id="dashboard"'));

    new Function(TEXT_SIZE_SCRIPT)();
    expect(root().hasAttribute("data-text-size")).toBe(false);
    runScriptsIn(html);
    expect(root().getAttribute("data-text-size")).toBe("larger");
    expect(textSizeFromCookie(document.cookie)).toBe("larger");
  });

  it("takes away someone else's size left in the cookie", async () => {
    state.cookie = "larger";
    state.saved = "standard";
    document.cookie = `${TEXT_SIZE_COOKIE}=larger; Path=/`;
    new Function(TEXT_SIZE_SCRIPT)();
    expect(root().getAttribute("data-text-size")).toBe("larger");

    const html = await serverHtml();
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf('id="dashboard"'));
    runScriptsIn(html);
    expect(root().hasAttribute("data-text-size")).toBe(false);
    expect(document.cookie.split("; ").some((c) => c.startsWith(`${TEXT_SIZE_COOKIE}=`))).toBe(false);
  });

  it("sends nothing extra when the cookie already matches, or the profile can't be read", async () => {
    state.cookie = "large";
    state.saved = "large";
    expect(await serverHtml()).not.toContain("<script>");
    state.cookie = undefined;
    state.saved = "standard";
    expect(await serverHtml()).not.toContain("<script>");
    state.cookie = "large";
    state.saved = null;
    expect(await serverHtml()).not.toContain("<script>");
    // A cookie value it doesn't know is the standard size, as in the <head>.
    state.cookie = "huge";
    state.saved = "standard";
    expect(await serverHtml()).not.toContain("<script>");
  });
});

describe("TextSizeFix", () => {
  it("is only in the page the server sends, and taking that page over keeps it quiet", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = renderToString(<TextSizeFix size="large" />);
    expect(html).toContain(textSizeFixScript("large"));

    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.appendChild(host);
    let hydrated: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      hydrated = hydrateRoot(host, <TextSizeFix size="large" />);
    });
    await act(async () => hydrated?.unmount());
    host.remove();

    // Drawn in the browser (the dashboard opened from inside the app), a
    // script would never run, so there is none; TextSizeSync covers it.
    const { container } = render(<TextSizeFix size="large" />);
    expect(container.innerHTML).toBe("");
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("writes a cookie the <head> script reads on the next page", () => {
    for (const size of ["large", "larger", "standard"] as const) {
      new Function(textSizeFixScript(size))();
      root().removeAttribute("data-text-size");
      new Function(TEXT_SIZE_SCRIPT)();
      expect(root().getAttribute("data-text-size")).toBe(size === "standard" ? null : size);
    }
  });
});
