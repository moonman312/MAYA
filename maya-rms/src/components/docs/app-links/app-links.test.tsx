// @vitest-environment jsdom
/**
 * Links into MAYA on the docs: none in the HTML anyone is sent, and after the
 * page loads, only for a reader signed in to MAYA in this browser.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ signedIn: false }));
vi.mock("./session", () => ({ useSignedIn: () => session.signedIn, hasSessionCookie: () => session.signedIn }));

import { AppLinkClient, OpenInMayaClient, SignedInOnly } from "./app-link";
import { AppLink, OpenInMaya, docsAppHref } from "./server";

afterEach(() => {
  cleanup();
  session.signedIn = false;
});

describe("signed out", () => {
  it("shows the same words and no link, in the page's HTML and after it loads", () => {
    const html = renderToString(<AppLinkClient href="/go/rules.list">Rules</AppLinkClient>);
    expect(html).toBe("Rules");
    render(
      <>
        <AppLink to="rules.list">Rules</AppLink>
        <OpenInMaya to="rules.new" name="Nearly full" occupancy="gt85" direction="increase" percent="10" words="Open the rule builder with this rule filled in" />
        <SignedInOnly otherwise={<span>Join the waitlist</span>}>
          <span>Open MAYA</span>
        </SignedInOnly>
      </>,
    );
    expect(screen.getByText("Rules").closest("a")).toBeNull();
    expect(screen.queryByText("Open the rule builder with this rule filled in")).toBeNull();
    expect(screen.getByText("Join the waitlist")).toBeTruthy();
    expect(screen.queryByText("Open MAYA")).toBeNull();
    expect(document.querySelectorAll("a").length).toBe(0);
  });
});

describe("signed in", () => {
  it("links the words to /go in a new tab, with the arrow and words for screen readers", () => {
    session.signedIn = true;
    render(
      <AppLink to="rules.list" q="filter=enabled">
        Enabled
      </AppLink>,
    );
    const a = screen.getByText("Enabled").closest("a")!;
    expect(a.getAttribute("href")).toBe("/go/rules.list?filter=enabled");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener");
    expect(a.textContent).toContain("(opens in MAYA)");
  });

  it("shows a recipe's button with its pre-fill, and says nothing is saved until the owner clicks", () => {
    session.signedIn = true;
    render(
      <OpenInMaya
        to="rules.new"
        percent="10"
        direction="increase"
        occupancy="gt85"
        name="Nearly full"
        words="Open the rule builder with this rule filled in"
      />,
    );
    const a = screen.getByText("Open the rule builder with this rule filled in").closest("a")!;
    expect(a.getAttribute("href")).toBe("/go/rules.new?name=Nearly+full&occupancy=gt85&direction=increase&percent=10");
    expect(screen.getByText("Nothing is saved until you click Add Rule.")).toBeTruthy();
  });

  it("says nothing about saving for a button that only opens a place", () => {
    session.signedIn = true;
    render(<OpenInMaya to="changelog" view="all" words="Open the Change Log on Show All Cycles" />);
    expect(screen.getByText("Open the Change Log on Show All Cycles").closest("a")!.getAttribute("href")).toBe("/go/changelog?view=all");
    expect(screen.queryByText(/Nothing is saved/)).toBeNull();
  });

  it("never renders a link the registry would change, or one to a place the docs cannot open", () => {
    session.signedIn = true;
    expect(docsAppHref("rules.new", { percent: "90" })).toBeNull();
    expect(docsAppHref("calendar.day", { date: "2026-10-03" })).toBeNull();
    expect(docsAppHref("rules.new", { hotel: "0b0c8a6e-3c1d-4d8e-9f2a-6a1b2c3d4e5f" })).toBeNull();
    expect(docsAppHref("nope", {})).toBeNull();
    render(<AppLink to="rules.new" percent="90">Words</AppLink>);
    expect(screen.getByText("Words").closest("a")).toBeNull();
  });
});
