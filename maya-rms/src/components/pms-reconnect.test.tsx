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
