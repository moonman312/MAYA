// @vitest-environment jsdom
/**
 * The role picker on the Users page: four choices, one PUT per change, and a
 * refusal (God Mode off, the last platform admin) shown in the server's own
 * words with the picker put back.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const { StaffRolePicker } = await import("./staff-role-picker");

let calls: { url: string; init?: RequestInit }[] = [];
let answer: () => Promise<Response>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

beforeEach(() => {
  calls = [];
  nav.refresh = vi.fn();
  answer = () => json({ ok: true, role: "developer", previous: [], changed: true });
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return answer();
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const picker = () => screen.getByLabelText("Staff role for dev@example.com") as HTMLSelectElement;

describe("StaffRolePicker", () => {
  it("offers None, Developer, Sales and Platform admin, set to the person's role", () => {
    render(<StaffRolePicker userId="u-2" role="sales" email="dev@example.com" />);
    expect([...picker().options].map((o) => o.textContent)).toEqual(["None", "Developer", "Sales", "Platform admin"]);
    expect(picker().value).toBe("sales");
  });

  it("sends the new role once and refreshes the page", async () => {
    render(<StaffRolePicker userId="u-2" role="none" email="dev@example.com" />);
    await act(async () => {
      fireEvent.change(picker(), { target: { value: "developer" } });
    });
    await waitFor(() => expect(nav.refresh).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/admin/users/u-2/staff-role");
    expect(calls[0].init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ role: "developer" });
    expect(picker().value).toBe("developer");
  });

  it("puts the last platform admin back and says why", async () => {
    answer = () => json({ error: "MAYA needs at least one platform admin. Make someone else a platform admin first." }, 400);
    render(<StaffRolePicker userId="u-1" role="platform_admin" email="dev@example.com" />);
    await act(async () => {
      fireEvent.change(picker(), { target: { value: "none" } });
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain("MAYA needs at least one platform admin. Make someone else a platform admin first."),
    );
    expect(picker().value).toBe("platform_admin");
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("says God Mode is off when the server does", async () => {
    answer = () => json({ error: "God Mode is off. Turn it on to change who is MAYA staff." }, 403);
    render(<StaffRolePicker userId="u-2" role="none" email="dev@example.com" />);
    await act(async () => {
      fireEvent.change(picker(), { target: { value: "sales" } });
    });
    await waitFor(() => expect(document.body.textContent).toContain("God Mode is off."));
    expect(picker().value).toBe("none");
  });
});
