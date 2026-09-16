import { describe, expect, it } from "vitest";
import { inviteEmailHtml, inviteEmailText, type InviteEmailInput } from "./invite-email";

const input: InviteEmailInput = {
  acceptUrl: "https://maya-rms.com/auth/accept-invite?token_hash=abc&type=invite",
  hotelName: "Driftwood Inn",
  role: "revenue_manager",
  inviterEmail: "gm@driftwood.example",
};

describe("inviteEmailHtml", () => {
  it("opens with the lockup from the same origin as the accept link", () => {
    const html = inviteEmailHtml(input);
    expect(html).toContain('src="https://maya-rms.com/brand/maya-lockup-email.png"');
    expect(html).toContain('alt="MAYA"');
    // The logo replaces the old text label, so the header shouldn't carry both.
    expect(html).not.toContain("text-transform:uppercase");
    expect(html).toContain(
      'href="https://maya-rms.com/auth/accept-invite?token_hash=abc&amp;type=invite"',
    );
  });

  it("keeps the plain-text body free of markup", () => {
    const text = inviteEmailText(input);
    expect(text).not.toContain("<");
    expect(text).not.toContain("/brand/");
    expect(text).toContain(input.acceptUrl);
  });
});
