import { describe, expect, it } from "vitest";
import {
  redactCloudbedsPayload,
  redactMewsPayload,
  REDACTION_ALLOWLIST_UNION,
} from "./redact";

describe("redactCloudbedsPayload", () => {
  it("keeps structural fields and drops guest PII", () => {
    const room = {
      subReservationID: "12345-1",
      roomTypeID: "540123",
      roomTypeName: "Deluxe King",
      startDate: "2026-07-01",
      endDate: "2026-07-04",
      adults: 2,
      children: 0,
      sourceName: "Booking.com",
      // PII that must never survive:
      guestName: "Jane Doe",
      guestEmail: "jane@example.com",
      guestPhone: "+1 555 0100",
      guestAddress: "1 Main St",
      specialRequests: "allergic to feathers",
      cardToken: "tok_abc",
      // nested structures already parsed into columns:
      dailyRates: [{ date: "2026-07-01", rate: 200 }],
    };

    const out = redactCloudbedsPayload(room);

    expect(out).toEqual({
      subReservationID: "12345-1",
      roomTypeID: "540123",
      roomTypeName: "Deluxe King",
      startDate: "2026-07-01",
      endDate: "2026-07-04",
      adults: 2,
      children: 0,
      sourceName: "Booking.com",
      _redacted: true,
    });
    expect(JSON.stringify(out)).not.toContain("Jane");
    expect(JSON.stringify(out)).not.toContain("example.com");
  });

  it("drops nested objects even for allowlisted keys", () => {
    const out = redactCloudbedsPayload({ status: { nested: "object" } });
    expect(out).toEqual({ _redacted: true });
  });
});

describe("redactMewsPayload", () => {
  it("keeps structural fields and drops customer references", () => {
    const raw = {
      Id: "res-1",
      State: "Confirmed",
      SpaceCategoryId: "cat-9",
      StartUtc: "2026-07-01T15:00:00Z",
      EndUtc: "2026-07-04T10:00:00Z",
      CreatedUtc: "2026-06-20T09:00:00Z",
      AdultCount: 2,
      // must never survive:
      CustomerId: "cust-777",
      CompanyId: "co-1",
      AssignedResourceLocked: false,
      Notes: "VIP guest, birthday",
    };

    const out = redactMewsPayload(raw);

    expect(out).toEqual({
      Id: "res-1",
      State: "Confirmed",
      SpaceCategoryId: "cat-9",
      StartUtc: "2026-07-01T15:00:00Z",
      EndUtc: "2026-07-04T10:00:00Z",
      CreatedUtc: "2026-06-20T09:00:00Z",
      AdultCount: 2,
      _redacted: true,
    });
    expect(out.CustomerId).toBeUndefined();
  });
});

describe("REDACTION_ALLOWLIST_UNION", () => {
  it("never contains guest-identifying keys", () => {
    const forbidden = /guest(name|email|phone|address)|customer|email|phone|address|card|payment|note/i;
    for (const key of REDACTION_ALLOWLIST_UNION) {
      // guestCount is the one allowed "guest" key — a count, not an identity
      if (key === "guestCount") continue;
      expect(key).not.toMatch(forbidden);
    }
  });
});
