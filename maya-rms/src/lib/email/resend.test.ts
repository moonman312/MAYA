/**
 * What the client does under pressure: a 429 gets a short, bounded wait —
 * Retry-After when Resend names one, capped so a webhook holding the request
 * open isn't parked for an hour — and everything else fails fast, because a
 * malformed payload fails identically no matter how patiently it is retried.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isResendConfigured, sendEmail } from "./resend";

const input = {
  to: "gm@driftwood.example",
  subject: "Subject",
  html: "<p>Body</p>",
  text: "Body",
  idempotencyKey: "key-1",
};

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.RESEND_FROM_EMAIL = "MAYA <billing@example.test>";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("sendEmail", () => {
  it("posts once and returns the id", async () => {
    fetchMock.mockResolvedValue(response(200, { id: "email_1" }));
    await expect(sendEmail(input)).resolves.toEqual({ id: "email_1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    // The key is what makes the retried POST safe to repeat.
    expect(init.headers["Idempotency-Key"]).toBe("key-1");
  });

  it("waits out a 429 for the time Resend names, then tries again", async () => {
    fetchMock
      .mockResolvedValueOnce(response(429, { message: "rate limited" }, { "Retry-After": "1" }))
      .mockResolvedValueOnce(response(200, { id: "email_2" }));

    const pending = sendEmail(input);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ id: "email_2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps the wait rather than holding the caller open for an hour", async () => {
    fetchMock
      .mockResolvedValueOnce(response(429, { message: "rate limited" }, { "Retry-After": "3600" }))
      .mockResolvedValueOnce(response(200, { id: "email_3" }));

    const pending = sendEmail(input);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toEqual({ id: "email_3" });
  });

  it("gives up once the retries are spent", async () => {
    fetchMock.mockResolvedValue(response(429, { message: "rate limited" }, { "Retry-After": "1" }));

    const assertion = expect(sendEmail(input)).rejects.toThrow("HTTP 429");
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a failure that would fail identically", async () => {
    fetchMock.mockResolvedValue(response(422, { message: "invalid from address" }));
    await expect(sendEmail(input)).rejects.toThrow("invalid from address");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to run unconfigured instead of posting a broken request", async () => {
    delete process.env.RESEND_API_KEY;
    expect(isResendConfigured()).toBe(false);
    await expect(sendEmail(input)).rejects.toThrow("not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
