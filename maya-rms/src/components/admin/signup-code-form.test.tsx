// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignupCodeForm } from "./signup-code-form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Opens the form, types a code, ticks the box if asked, creates it; returns what was sent and the page. */
async function create(tick: boolean, answer: Record<string, unknown>) {
  const fetchSpy = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => ({ ok: true, json: async () => answer }) as Response);
  vi.stubGlobal("fetch", fetchSpy);
  const view = render(<SignupCodeForm />);
  fireEvent.click(view.getByRole("button", { name: "+ New code" }));
  fireEvent.change(view.getByPlaceholderText("DRIFTWOOD"), { target: { value: "walkthrough" } });
  const box = view.getByRole("checkbox", { name: "Test property (left out of analytics)" }) as HTMLInputElement;
  expect(box.checked).toBe(false);
  if (tick) fireEvent.click(box);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Create code" }));
  });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body)) as Record<string, unknown>;
  return { body, view };
}

describe("SignupCodeForm: the test-property checkbox", () => {
  it("sends a ticked box as a test-property code, and says so once made", async () => {
    const { body, view } = await create(true, { code: "WALKTHROUGH", grants: "14 days free", testProperty: true });
    expect(body).toMatchObject({ code: "WALKTHROUGH", kind: "trial", test_property: true });
    expect(view.container.textContent).toContain("WALKTHROUGH: 14 days free (test property)");
  });

  it("sends an unticked box as an ordinary code", async () => {
    const { body, view } = await create(false, { code: "WALKTHROUGH", grants: "14 days free", testProperty: false });
    expect(body.test_property).toBe(false);
    expect(view.container.textContent).not.toContain("test property");
  });
});
