import { describe, expect, it } from "vitest";
import {
  roomShortfallHtml,
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
