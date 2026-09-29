// @vitest-environment jsdom
/**
 * The reconnect prompt promises that rules, history and settings are
 * untouched. After the retention sweep removed a never-paid property's
 * history, that sentence would be untrue, so the prompt says what does happen:
 * the history comes back once they reconnect.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PmsReconnect } from "./pms-reconnect";

afterEach(cleanup);

const base = {
  hotelId: "hotel-1",
  pmsType: "cloudbeds",
  status: "disconnected",
  authKind: "oauth2_authorization_code",
  displayName: "Cloudbeds",
  canManage: true,
  placement: "banner" as const,
};

describe("PmsReconnect", () => {
  it("keeps its usual promise for a lost connection", () => {
    const view = render(<PmsReconnect {...base} />);
    expect(view.container.textContent).toContain("Your rules, history and settings are all untouched");
  });

  it("does not promise the history is untouched once it was removed", () => {
    const view = render(<PmsReconnect {...base} historyRemoved />);
    const text = view.container.textContent ?? "";
    expect(text).not.toContain("untouched");
    expect(text).toContain("Your rules and settings are still here, and your booking history comes back once you reconnect.");
    expect(text).not.toContain("—");
    expect(view.getByRole("link", { name: "Reconnect Cloudbeds" }).getAttribute("href")).toBe(
      "/api/pms/cloudbeds/connect?hotelId=hotel-1",
    );
  });
});

describe("PmsReconnect for someone who cannot reconnect", () => {
  it("names who can, with no button", () => {
    const view = render(<PmsReconnect {...base} canManage={false} />);
    const text = view.container.textContent ?? "";
    expect(text).toContain("Ask this property's General Manager or Hotel Admin to reconnect it. It takes them one click.");
    expect(text).not.toContain("—");
    expect(view.queryByRole("link")).toBeNull();
  });
});

describe("PmsReconnect on Mews", () => {
  // Nobody at the property can re-enter Mews keys, so no role is told it takes one click.
  it.each(["banner", "panel"] as const)("asks every role to email us for new keys (%s)", (placement) => {
    for (const canManage of [true, false]) {
      const view = render(
        <PmsReconnect
          {...base}
          pmsType="mews"
          authKind="static_tokens"
          displayName="Mews"
          placement={placement}
          canManage={canManage}
        />,
      );
      const text = view.container.textContent ?? "";
      expect(text).toContain("Ask us to re-enter the Mews keys: email info@modern-hospitality-solutions.com.");
      expect(text).not.toContain("one click");
      expect(text).not.toContain("—");
      const mail = view.getByRole("link", { name: "info@modern-hospitality-solutions.com" });
      expect(mail.getAttribute("href")).toMatch(/^mailto:info@modern-hospitality-solutions\.com/);
      expect(view.queryByRole("link", { name: /Reconnect/ })).toBeNull();
      cleanup();
    }
  });

  it("shows nothing on a working Mews connection", () => {
    const view = render(
      <PmsReconnect {...base} pmsType="mews" authKind="static_tokens" displayName="Mews" status="connected" placement="panel" />,
    );
    expect(view.container.textContent).toBe("");
  });
});

describe("PmsReconnect on a Degraded connection", () => {
  // Degraded still reads and sends, so the lost-connection alarm is untrue there.
  it.each([
    ["banner", true],
    ["panel", true],
    ["banner", false],
    ["panel", false],
  ] as const)("shows one calm line in the %s (can reconnect: %s)", (placement, canManage) => {
    const view = render(<PmsReconnect {...base} status="degraded" placement={placement} canManage={canManage} />);
    const text = view.container.textContent ?? "";
    expect(text).toContain("Your Cloudbeds connection needs a refresh soon. Prices are still updating.");
    expect(text).not.toContain("lost its connection");
    expect(text).not.toContain("aren't updating");
    expect(text).not.toContain("—");
    const link = view.queryByRole("link", { name: "Reconnect Cloudbeds" });
    if (canManage) expect(link?.getAttribute("href")).toBe("/api/pms/cloudbeds/connect?hotelId=hotel-1");
    else expect(link).toBeNull();
  });
});
