import { describe, expect, it } from "vitest";
import {
  roomShortfallHtml,
  roomShortfallSubject,
  roomShortfallText,
  type RoomShortfallInput,
} from "./room-shortfall-email";

const input: RoomShortfallInput = {
  billingUrl: "https://maya-rms.com/account/billing",
  billedRooms: 24,
  measuredRooms: 31,
  correctionDate: "August 6, 2026",
  daysLeft: 5,
  currentAmount: "$132.00",
  correctedAmount: "$155.00",
  notBilledFor: { guessed: ["Meeting Room"], marked: [] },
};

describe("roomShortfallHtml", () => {
  it("opens with the lockup from the same origin as the billing link", () => {
    const html = roomShortfallHtml(input);
    expect(html).toContain('src="https://maya-rms.com/brand/maya-lockup-email.png"');
    expect(html).toContain('alt="MAYA"');
    expect(html).toContain('href="https://maya-rms.com/account/billing"');
    expect(html).toContain("Set your room count");
  });

  it("keeps the plain-text body free of markup", () => {
    const text = roomShortfallText(input);
    expect(text).not.toContain("<");
    expect(text).not.toContain("/brand/");
    expect(text).toContain(input.billingUrl);
  });
});

describe("the whole email", () => {
  it("has no em dash anywhere, subject included, before and after the grace period", () => {
    for (const daysLeft of [5, 0]) {
      const i = { ...input, daysLeft, notBilledFor: { guessed: ["Meeting Room"], marked: ["Spa"] } };
      const all = [roomShortfallSubject(i), roomShortfallText(i), roomShortfallHtml(i)].join("\n");
      expect(all).not.toMatch(/—|&mdash;/);
    }
  });

  it("reads plainly", () => {
    expect(roomShortfallSubject(input)).toBe("Your MAYA plan covers 24 rooms, and your PMS shows 31");
    const text = roomShortfallText(input);
    expect(text).toContain("adjust your next invoice. Nothing is charged today, and nothing is charged separately.");
    expect(text.trimEnd().endsWith("The MAYA team")).toBe(true);
  });
});
