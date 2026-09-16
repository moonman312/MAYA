import { describe, expect, it } from "vitest";
import {
  renewalNudgeHtml,
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
