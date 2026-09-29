// @vitest-environment jsdom
/**
 * The God Mode button: first use enrols an authenticator (QR code, key, a
 * code to confirm), later uses only ask for the code; a verified code is
 * followed by one POST that opens the window; every refusal is a plain
 * sentence and the dialog stays put.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Factor = { id: string; factor_type: string; status: "verified" | "unverified" };

const mfa = vi.hoisted(() => ({
  factors: { all: [] as Factor[], totp: [] as Factor[] },
  listError: null as { message: string } | null,
  enrollError: null as { message: string } | null,
  verifyError: null as { message: string } | null,
  calls: [] as { fn: string; args: unknown }[],
}));
const nav = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    auth: {
      mfa: {
        listFactors: async () => {
          mfa.calls.push({ fn: "listFactors", args: null });
          return mfa.listError ? { data: null, error: mfa.listError } : { data: mfa.factors, error: null };
        },
        unenroll: async (args: unknown) => {
          mfa.calls.push({ fn: "unenroll", args });
          return { data: null, error: null };
        },
        enroll: async (args: unknown) => {
          mfa.calls.push({ fn: "enroll", args });
          if (mfa.enrollError) return { data: null, error: mfa.enrollError };
          return {
            data: { id: "factor-new", type: "totp", totp: { qr_code: "data:image/svg+xml;utf-8,<svg/>", secret: "ABCD1234EFGH", uri: "otpauth://x" } },
            error: null,
          };
        },
        challengeAndVerify: async (args: unknown) => {
          mfa.calls.push({ fn: "challengeAndVerify", args });
          return mfa.verifyError ? { data: null, error: mfa.verifyError } : { data: { access_token: "t" }, error: null };
        },
      },
    },
  }),
}));

const { GodModeButton, plainMfaError } = await import("./god-mode-button");
const { GOD_MODE_CHANGED_EVENT } = await import("./god-mode-banner");

let posts: { url: string; init?: RequestInit }[] = [];
let postAnswer: () => Promise<Response>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

beforeEach(() => {
  mfa.factors = { all: [], totp: [] };
  mfa.listError = null;
  mfa.enrollError = null;
  mfa.verifyError = null;
  mfa.calls = [];
  nav.refresh = vi.fn();
  posts = [];
  postAnswer = () => json({ ok: true, active: true, sessionId: "s-1" });
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    posts.push({ url, init });
    return postAnswer();
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openDialog() {
  render(<GodModeButton />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "God Mode" }));
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeNull());
}

async function typeCode(code: string) {
  fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: code } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Turn on God Mode" }));
  });
}

describe("GodModeButton", () => {
  it("enrols an authenticator on first use: QR code, key, then the code opens the window", async () => {
    const changed = vi.fn();
    window.addEventListener(GOD_MODE_CHANGED_EVENT, changed);
    await openDialog();
    await waitFor(() => expect(screen.queryByAltText("QR code for your authenticator app")).not.toBeNull());
    expect((screen.getByAltText("QR code for your authenticator app") as HTMLImageElement).src).toBe("data:image/svg+xml;utf-8,<svg/>");
    expect(document.body.textContent).toContain("ABCD1234EFGH");
    expect(mfa.calls.map((c) => c.fn)).toEqual(["listFactors", "enroll"]);
    expect(mfa.calls[1].args).toEqual({ factorType: "totp", friendlyName: "MAYA God Mode", issuer: "MAYA" });

    await typeCode("123 456");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mfa.calls[2]).toEqual({ fn: "challengeAndVerify", args: { factorId: "factor-new", code: "123456" } });
    expect(posts).toEqual([{ url: "/api/admin/god-mode", init: { method: "POST" } }]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    window.removeEventListener(GOD_MODE_CHANGED_EVENT, changed);
  });

  it("only asks for the code when an authenticator is already enrolled", async () => {
    mfa.factors = {
      all: [{ id: "factor-1", factor_type: "totp", status: "verified" }],
      totp: [{ id: "factor-1", factor_type: "totp", status: "verified" }],
    };
    await openDialog();
    await waitFor(() => expect(screen.queryByLabelText("Authenticator code")).not.toBeNull());
    expect(screen.queryByAltText("QR code for your authenticator app")).toBeNull();
    expect(mfa.calls.map((c) => c.fn)).toEqual(["listFactors"]);
    await typeCode("654321");
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(mfa.calls[1]).toEqual({ fn: "challengeAndVerify", args: { factorId: "factor-1", code: "654321" } });
  });

  it("clears an enrolment abandoned halfway before enrolling again", async () => {
    mfa.factors = { all: [{ id: "factor-old", factor_type: "totp", status: "unverified" }], totp: [] };
    await openDialog();
    await waitFor(() => expect(mfa.calls.map((c) => c.fn)).toEqual(["listFactors", "unenroll", "enroll"]));
    expect(mfa.calls[1].args).toEqual({ factorId: "factor-old" });
  });

  it("says so for a wrong code, and sends nothing to the server", async () => {
    mfa.factors = { all: [], totp: [{ id: "factor-1", factor_type: "totp", status: "verified" }] };
    mfa.verifyError = { message: "Invalid TOTP code entered" };
    await openDialog();
    await waitFor(() => expect(screen.queryByLabelText("Authenticator code")).not.toBeNull());
    await typeCode("000000");
    await waitFor(() => expect(document.body.textContent).toContain("That code didn't work. Try the next one from your authenticator app."));
    expect(posts).toEqual([]);
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });

  it("wants six digits before it asks the authenticator anything", async () => {
    mfa.factors = { all: [], totp: [{ id: "factor-1", factor_type: "totp", status: "verified" }] };
    await openDialog();
    await waitFor(() => expect(screen.queryByLabelText("Authenticator code")).not.toBeNull());
    await typeCode("12");
    expect(document.body.textContent).toContain("Enter the 6-digit code from your authenticator app.");
    expect(mfa.calls.map((c) => c.fn)).toEqual(["listFactors"]);
  });

  it("shows the server's refusal in its own words", async () => {
    mfa.factors = { all: [], totp: [{ id: "factor-1", factor_type: "totp", status: "verified" }] };
    postAnswer = () => json({ error: "Only MAYA staff can turn on God Mode." }, 403);
    await openDialog();
    await waitFor(() => expect(screen.queryByLabelText("Authenticator code")).not.toBeNull());
    await typeCode("111111");
    await waitFor(() => expect(document.body.textContent).toContain("Only MAYA staff can turn on God Mode."));
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("says when authenticator codes are not switched on for the project", async () => {
    mfa.enrollError = { message: "MFA enroll is disabled for TOTP" };
    await openDialog();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Authenticator codes aren't switched on for this project yet. In Supabase, turn on Authentication, Multi-Factor Authentication, TOTP.",
      ),
    );
  });
});

describe("plainMfaError", () => {
  it("turns Supabase's messages into plain sentences and leaves the rest as they are", () => {
    expect(plainMfaError("Invalid TOTP code entered")).toBe("That code didn't work. Try the next one from your authenticator app.");
    expect(plainMfaError("MFA factor with the friendly name already exists")).toContain("already exists");
    expect(plainMfaError("network down")).toBe("network down");
    expect(plainMfaError(undefined)).toBe("Something went wrong. Try again.");
  });
});
