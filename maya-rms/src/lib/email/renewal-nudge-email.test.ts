import { describe, expect, it } from "vitest";
import {
  renewalNudgeHtml,
  renewalNudgeSubject,
  renewalNudgeText,
  type RenewalNudgeInput,
} from "./renewal-nudge-email";

const input: RenewalNudgeInput = {
  resumeUrl: "https://maya-rms.com/onboarding/connect",
  billingUrl: "https://maya-rms.com/account/billing",
  amount: "$132.00",
  chargeDate: "Thursday, August 6",
  billingInterval: "month",
  roomCount: 24,
  perRoom: "$5.00",
  isFirstCharge: true,
};

describe("renewalNudgeHtml", () => {
  it("opens with the lockup from the same origin as the resume link", () => {
    const html = renewalNudgeHtml(input);
    expect(html).toContain('src="https://maya-rms.com/brand/maya-lockup-email.png"');
    expect(html).toContain('alt="MAYA"');
    expect(html).toContain('href="https://maya-rms.com/onboarding/connect"');
    expect(html).toContain('href="https://maya-rms.com/account/billing"');
    expect(html).toContain("Machine Assisted Yield Automation");
  });

  it("still renders when a caller hands over something that isn't a URL", () => {
    const html = renewalNudgeHtml({ ...input, resumeUrl: "u", billingUrl: "u/account/billing" });
    expect(html).not.toContain("<img");
    expect(html).toContain(">MAYA</p>");
  });

  it("keeps the plain-text body free of markup", () => {
    const text = renewalNudgeText(input);
    expect(text).not.toContain("<");
    expect(text).not.toContain("/brand/");
    expect(text).toContain(input.resumeUrl);
  });
});

describe("a property on Mews", () => {
  // Mews is connected by us, so "two minutes" and the connect button are no
  // use to it. The email cannot tell which system a never-connected property
  // uses, so it says what a Mews property does instead, in every copy.
  it("is told we connect it, and to reply or write to us", () => {
    const text = renewalNudgeText(input);
    expect(text).toContain(
      "On Mews? We connect it for you. Reply to this email or write to info@modern-hospitality-solutions.com and we'll set it up with you.",
    );
    const html = renewalNudgeHtml(input);
    expect(html).toContain("On Mews? We connect it for you.");
    expect(html).toContain('href="mailto:info@modern-hospitality-solutions.com?subject=Connect%20Mews"');
  });

  it("is not promised a two-minute connect in the subject", () => {
    for (const isFirstCharge of [true, false]) {
      const subject = renewalNudgeSubject({ ...input, isFirstCharge });
      expect(subject).not.toMatch(/two minutes/i);
      expect(subject).toContain("isn't connected to your PMS yet");
      expect(subject).not.toContain("\u2014");
    }
  });

  it("says what stopped in the owner's terms, without dashes", () => {
    const text = renewalNudgeText(input);
    expect(text).toContain("so your rules haven't been able to run");
    expect(text).not.toMatch(/price anything|once it can see/);
    expect(renewalNudgeHtml(input)).not.toMatch(/matters &mdash;/);
  });
});

describe("the whole email", () => {
  it("has no em dash anywhere, in either charge or period", () => {
    for (const isFirstCharge of [true, false]) {
      for (const billingInterval of ["month", "year"] as const) {
        const i = { ...input, isFirstCharge, billingInterval };
        const all = [renewalNudgeSubject(i), renewalNudgeText(i), renewalNudgeHtml(i)].join("\n");
        expect(all).not.toMatch(/—|&mdash;/);
      }
    }
  });

  it("says the room count sentence and the sign-off plainly", () => {
    const text = renewalNudgeText(input);
    expect(text).toContain("If 24 isn't right, connect first. That opens your billing page");
    expect(text.trimEnd().endsWith("The MAYA team")).toBe(true);
    expect(renewalNudgeHtml(input)).toContain("$5.00 per room, per month, $132.00 in total.");
  });
});
