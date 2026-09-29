import { describe, expect, it } from "vitest";
import {
  accountReadyHtml,
  accountReadySubject,
  accountReadyText,
  type AccountReadyInput,
} from "./account-ready-email";

const direct: AccountReadyInput = {
  continueUrl: "https://maya-rms.com/onboarding",
  propertyName: null,
  trialEndsOn: null,
  pmsConnected: false,
};

const marketplace: AccountReadyInput = {
  continueUrl: "https://maya-rms.com/onboarding",
  propertyName: "The Harbour Inn",
  trialEndsOn: "October 6, 2026",
  pmsConnected: true,
};

const everything = (i: AccountReadyInput) => [accountReadySubject(i), accountReadyText(i), accountReadyHtml(i)].join("\n");

describe("account ready email", () => {
  it("names the property once the PMS has given it a name", () => {
    expect(accountReadySubject(direct)).toBe("Your MAYA account is ready");
    expect(accountReadySubject(marketplace)).toBe("The Harbour Inn is ready in MAYA");
    expect(accountReadyText(marketplace)).toContain("The Harbour Inn is set up in MAYA and ready for you.");
  });

  it("only says the subscription started when it has, and gives a trial its date", () => {
    expect(accountReadyText(direct)).toContain("Your subscription has started.");
    const trial = accountReadyText(marketplace);
    expect(trial).toContain("your free trial runs until October 6, 2026. Nothing is charged before then.");
    expect(trial).not.toContain("subscription has started");
  });

  it("points a direct signup at connecting, and tells a Mews owner to reply instead", () => {
    const text = accountReadyText(direct);
    expect(text).toContain("Your next step is to connect your property management system.");
    expect(text).toContain("If you use Mews, reply to this email");
    const connected = accountReadyText(marketplace);
    expect(connected).toContain("MAYA has started reading your booking history");
    expect(connected).not.toContain("Mews");
  });

  it("carries the one link back in, with the lockup from the same origin", () => {
    const html = accountReadyHtml(direct);
    expect(html).toContain('href="https://maya-rms.com/onboarding"');
    expect(html).toContain('src="https://maya-rms.com/brand/maya-lockup-email.png"');
    expect(accountReadyText(direct)).toContain("Pick up where you left off: https://maya-rms.com/onboarding");
  });

  it("escapes a property name, which is the PMS's free text", () => {
    const html = accountReadyHtml({ ...marketplace, propertyName: 'Bed & <b>"Breakfast"</b>' });
    expect(html).toContain("Bed &amp; &lt;b&gt;&quot;Breakfast&quot;&lt;/b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("keeps the plain-text body free of markup", () => {
    expect(accountReadyText(marketplace)).not.toContain("<");
  });

  it("stays in the house voice: no em dashes, and MAYA reads", () => {
    for (const input of [direct, marketplace]) {
      const all = everything(input);
      expect(all).not.toMatch(/—|&mdash;/);
      expect(all).not.toMatch(/\b(learn|know|think|stud|analy[sz])/i);
    }
  });
});
