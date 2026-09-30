// @vitest-environment jsdom
/**
 * The code step for a developer or sales login: the first visit enrols an
 * authenticator (QR code and key) under its own name, later visits only ask
 * for the code, and a verified code goes on to the Command Center. A wrong
 * code stays put.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Factor = { id: string; factor_type: string; status: "verified" | "unverified" };

const mfa = vi.hoisted(() => ({
  factors: { all: [] as Factor[], totp: [] as Factor[] },
  verifyError: null as { message: string } | null,
  calls: [] as { fn: string; args: unknown }[],
}));
const nav = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    auth: {
      mfa: {
        listFactors: async () => (mfa.calls.push({ fn: "listFactors", args: null }), { data: mfa.factors, error: null }),
        unenroll: async (args: unknown) => (mfa.calls.push({ fn: "unenroll", args }), { data: null, error: null }),
        enroll: async (args: unknown) => (
          mfa.calls.push({ fn: "enroll", args }),
          { data: { id: "factor-new", type: "totp", totp: { qr_code: "data:image/svg+xml;utf-8,<svg/>", secret: "KEY123", uri: "otpauth://x" } }, error: null }
        ),
        challengeAndVerify: async (args: unknown) => (
          mfa.calls.push({ fn: "challengeAndVerify", args }),
          mfa.verifyError ? { data: null, error: mfa.verifyError } : { data: {}, error: null }
        ),
      },
    },
  }),
}));

const { StaffCodeStep } = await import("./staff-code-step");

beforeEach(() => {
  mfa.factors = { all: [], totp: [] };
  mfa.verifyError = null;
  mfa.calls = [];
  nav.replace = vi.fn();
  nav.refresh = vi.fn();
});
afterEach(cleanup);

async function typeCode(code: string) {
  fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: code } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Open the Command Center" }));
  });
}

describe("StaffCodeStep", () => {
  it("enrols an authenticator on the first visit, then the code opens the Command Center", async () => {
    render(<StaffCodeStep />);
    await waitFor(() => expect(screen.queryByAltText("QR code for your authenticator app")).not.toBeNull());
    expect(document.body.textContent).toContain("KEY123");
    expect(mfa.calls.map((c) => c.fn)).toEqual(["listFactors", "enroll"]);
    expect(mfa.calls[1].args).toEqual({ factorType: "totp", friendlyName: "MAYA Command Center", issuer: "MAYA" });

    await typeCode("123 456");
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/admin"));
    expect(mfa.calls[2]).toEqual({ fn: "challengeAndVerify", args: { factorId: "factor-new", code: "123456" } });
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("only asks for the code once an authenticator is set up", async () => {
    mfa.factors = { all: [], totp: [{ id: "factor-1", factor_type: "totp", status: "verified" }] };
    render(<StaffCodeStep />);
    await waitFor(() => expect(screen.queryByLabelText("Authenticator code")).not.toBeNull());
    expect(screen.queryByAltText("QR code for your authenticator app")).toBeNull();
    expect(mfa.calls.map((c) => c.fn)).toEqual(["listFactors"]);
  });

  it("stays put on a wrong code, and says so plainly", async () => {
    mfa.factors = { all: [], totp: [{ id: "factor-1", factor_type: "totp", status: "verified" }] };
    mfa.verifyError = { message: "Invalid TOTP code entered" };
    render(<StaffCodeStep />);
    await waitFor(() => expect(screen.queryByLabelText("Authenticator code")).not.toBeNull());
    await typeCode("000000");
    await waitFor(() => expect(document.body.textContent).toContain("That code didn't work. Try the next one from your authenticator app."));
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
