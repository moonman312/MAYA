// @vitest-environment jsdom
/**
 * Help in MAYA opens the docs page about the screen with ?from=<screen>. The
 * docs keep the screen for that tab, take it out of the address, and never
 * keep anything that is not a screen name.
 */
import { afterEach, describe, expect, it } from "vitest";
import registry from "@/lib/deep-links/registry.json";
import { helpHref } from "@/components/deep-links/help-links";
import { helpOrigin, rememberHelpOrigin } from "./help-origin";

afterEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("helpHref", () => {
  it("adds the screen to the docs page about it, before any heading", () => {
    expect(helpHref("calendar")).toBe("/docs/watch/the-calendar?from=calendar");
    expect(helpHref("rules.builder")).toBe("/docs/rules/the-rule-builder?from=rules.builder");
    expect(helpHref("other")).toBe("/docs?from=other");
  });

  it("gives every Help screen a from= the docs accept", () => {
    for (const screen of Object.keys(registry.help.screens)) {
      window.history.replaceState(null, "", helpHref(screen));
      rememberHelpOrigin();
      expect(helpOrigin()).toBe(screen);
    }
  });
});

describe("rememberHelpOrigin", () => {
  it("keeps the screen for this tab and leaves a clean address", () => {
    window.history.replaceState(null, "", "/docs/watch/the-calendar?from=calendar#day-cards");
    rememberHelpOrigin();
    expect(helpOrigin()).toBe("calendar");
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/docs/watch/the-calendar#day-cards");
  });

  it("drops anything that is not a screen name, and leaves other query words alone", () => {
    window.history.replaceState(null, "", "/docs?q=floor&from=%3Cscript%3E");
    rememberHelpOrigin();
    expect(helpOrigin()).toBeNull();
    expect(window.location.search).toBe("?q=floor");
  });

  it("does nothing without from=, so a later docs page keeps the screen", () => {
    window.history.replaceState(null, "", "/docs/rules/the-rule-builder?from=rules.builder");
    rememberHelpOrigin();
    window.history.replaceState(null, "", "/docs/rules/booking-speed");
    rememberHelpOrigin();
    expect(helpOrigin()).toBe("rules.builder");
  });
});
