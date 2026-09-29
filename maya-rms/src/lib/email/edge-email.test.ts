/**
 * The edge functions' copies of the email client and the brand header
 * (supabase/functions/_shared/email), which exist only because Deno cannot
 * import from src/. They must behave like the originals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emailBrandHeader } from "./brand";
import { emailBrandHeader as edgeBrandHeader } from "../../../supabase/functions/_shared/email/brand";
import { isResendConfigured, sendEmail } from "../../../supabase/functions/_shared/email/resend";

describe("the edge brand header", () => {
  it("is the app's header, byte for byte", () => {
    for (const base of ["https://maya-rms.com/go/pms?hotel=x", "http://localhost:3000/", "", "javascript:alert(1)"]) {
      expect(edgeBrandHeader(base)).toBe(emailBrandHeader(base));
    }
  });
});

describe("the edge sendEmail", () => {
  const input = {
    to: "gm@harbour.test",
    subject: "Subject",
    html: "<p>Body</p>",
    text: "Body",
    replyTo: "info@modern-hospitality-solutions.com",
    idempotencyKey: "pms-outage:conn-1:1:u1",
  };
  const response = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers });
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_FROM_EMAIL = "MAYA <alerts@example.test>";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
  });

  it("posts one email with the reply-to and the idempotency key", async () => {
    fetchMock.mockResolvedValue(response(200, { id: "email_1" }));
    await expect(sendEmail(input)).resolves.toEqual({ id: "email_1" });
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string; signal: AbortSignal }];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers["Idempotency-Key"]).toBe("pms-outage:conn-1:1:u1");
    expect(init.headers.Authorization).toBe("Bearer re_test");
    expect(JSON.parse(init.body)).toMatchObject({
      from: "MAYA <alerts@example.test>",
      to: ["gm@harbour.test"],
      reply_to: "info@modern-hospitality-solutions.com",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("waits out a 429 and fails fast on anything else", async () => {
    fetchMock
      .mockResolvedValueOnce(response(429, { message: "slow down" }, { "Retry-After": "1" }))
      .mockResolvedValueOnce(response(200, { id: "email_2" }));
    const pending = sendEmail(input);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ id: "email_2" });

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(response(422, { message: "invalid from address" }));
    await expect(sendEmail(input)).rejects.toThrow("invalid from address");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to run unconfigured", async () => {
    delete process.env.RESEND_FROM_EMAIL;
    expect(isResendConfigured()).toBe(false);
    await expect(sendEmail(input)).rejects.toThrow("not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
