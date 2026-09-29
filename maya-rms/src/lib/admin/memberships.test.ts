/**
 * Who gets an invitation email, and what the caller is told about it.
 *
 * The login is created (by generateLink) before the email goes out, so a send
 * that fails leaves a login behind that nobody can set a password for. The
 * retry has to see that login as someone still waiting for a link, not as a
 * colleague who already uses MAYA, or it sends nothing and they are stranded.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email/resend", () => ({ sendEmail }));

const { inviteUserToHotel } = await import("./memberships");

type Login = { id: string; last_sign_in_at: string | null };

function fakeAdmin(state: { login: Login | null }) {
  const generateLink = vi.fn(async ({ type }: { type: string; email: string }) => {
    // Supabase creates the login the first time it is asked for an invite link.
    state.login ??= { id: "user-new", last_sign_in_at: null };
    return {
      data: {
        properties: { hashed_token: `hash-${generateLink.mock.calls.length}`, verification_type: type },
        user: { id: state.login.id },
      },
      error: null,
    };
  });
  const rpc = vi.fn(async () => ({ data: "pending-1", error: null }));
  const from = (table: string) => {
    const api = {
      select: () => api,
      eq: () => api,
      maybeSingle: async () =>
        table === "hotels"
          ? { data: { name: "Driftwood Inn" }, error: null }
          : { data: state.login, error: null },
    };
    return api;
  };
  const client = { from, rpc, auth: { admin: { generateLink } } } as unknown as SupabaseClient;
  return { client, generateLink, rpc };
}

const input = {
  email: "Night.Manager@Driftwood.example ",
  hotelId: "hotel-1",
  role: "viewer" as const,
  inviterEmail: "gm@driftwood.example",
};

beforeEach(() => {
  process.env.MAYA_INVITE_REDIRECT_BASE = "https://maya-rms.example";
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ id: "email-1" });
});

describe("inviteUserToHotel", () => {
  it("emails a set-password link to an address with no login yet", async () => {
    const { client, generateLink, rpc } = fakeAdmin({ login: null });
    const result = await inviteUserToHotel(client, input);

    expect(result).toEqual({ inviteSent: true, pendingId: "pending-1", existingUser: false });
    expect(generateLink).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toBe("night.manager@driftwood.example");
    expect(rpc).toHaveBeenCalledWith("platform_invite_user", expect.objectContaining({ p_email: "night.manager@driftwood.example" }));
  });

  it("adds someone who has signed in before without an email, and says none went out", async () => {
    const { client, generateLink, rpc } = fakeAdmin({
      login: { id: "user-1", last_sign_in_at: "2026-09-01T10:00:00Z" },
    });
    const result = await inviteUserToHotel(client, input);

    expect(result).toEqual({ inviteSent: false, pendingId: "pending-1", existingUser: true });
    expect(generateLink).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("sends a fresh link on the retry after the first email failed", async () => {
    const state = { login: null as Login | null };
    const { client, generateLink, rpc } = fakeAdmin(state);

    sendEmail.mockRejectedValueOnce(new Error("Resend send failed: HTTP 500"));
    await expect(inviteUserToHotel(client, input)).rejects.toThrow("Resend send failed");
    // The login exists now, but the person was never told about it.
    expect(state.login).toEqual({ id: "user-new", last_sign_in_at: null });
    expect(rpc).not.toHaveBeenCalled();

    const retry = await inviteUserToHotel(client, input);
    expect(retry.inviteSent).toBe(true);
    expect(generateLink).toHaveBeenCalledTimes(2);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    // A new link, not the one from the email that never arrived.
    expect(sendEmail.mock.calls[1][0].text).toContain("token_hash=hash-2");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("still sends a link to a login that was invited before but never signed in", async () => {
    const { client, generateLink } = fakeAdmin({ login: { id: "user-2", last_sign_in_at: null } });
    const result = await inviteUserToHotel(client, input);

    expect(result.inviteSent).toBe(true);
    expect(generateLink).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
