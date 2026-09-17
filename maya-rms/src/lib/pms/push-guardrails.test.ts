/**
 * The last check before a price leaves MAYA. The codes are read by failure
 * classification, so their spelling is part of what is tested.
 */
import { describe, expect, it } from "vitest";
import {
  checkPushGuardrails,
  GUARDRAIL,
  GUARDRAIL_ORDER,
  type GuardrailInput,
  ledgerRowNeverSent,
  NO_RATE_TARGET_REASON,
  pushMaxPriceAgeMs,
} from "../../../supabase/functions/_shared/pms/push-guardrails";

const NOW = Date.parse("2026-10-01T12:00:00Z");

function cell(over: Partial<GuardrailInput> = {}): GuardrailInput {
  return {
    stayDate: "2026-10-05",
    price: 150,
    roomType: { isActive: true, floorPrice: 100, ceilingPrice: 300 },
    firstDate: "2026-10-01",
    lastDate: "2026-11-29",
    zeroBase: false,
    computedAtMs: NOW - 60_000,
    evaluatedAtMs: NaN,
    freshAfterMs: NOW - 30 * 60_000,
    ...over,
  };
}

describe("checkPushGuardrails", () => {
  it("lets a good price through", () => {
    expect(checkPushGuardrails(cell())).toBeNull();
    // Exactly on the floor and on the ceiling is inside.
    expect(checkPushGuardrails(cell({ price: 100 }))).toBeNull();
    expect(checkPushGuardrails(cell({ price: 300 }))).toBeNull();
  });

  it("holds back each kind of bad cell under its own stable code", () => {
    expect(checkPushGuardrails(cell({ stayDate: "2026-09-30" }))).toBe("guardrail:outside_window");
    expect(checkPushGuardrails(cell({ stayDate: "2026-11-30" }))).toBe("guardrail:outside_window");
    expect(checkPushGuardrails(cell({ stayDate: "2026-10-05T00:00:00" }))).toBe("guardrail:outside_window");
    expect(checkPushGuardrails(cell({ roomType: { isActive: false, floorPrice: 100, ceilingPrice: 300 } }))).toBe(
      "guardrail:inactive_room_type",
    );
    expect(checkPushGuardrails(cell({ price: 0 }))).toBe("guardrail:invalid_price");
    expect(checkPushGuardrails(cell({ price: -10 }))).toBe("guardrail:invalid_price");
    expect(checkPushGuardrails(cell({ price: NaN }))).toBe("guardrail:invalid_price");
    expect(checkPushGuardrails(cell({ price: Infinity }))).toBe("guardrail:invalid_price");
    expect(checkPushGuardrails(cell({ price: 0.004 }))).toBe("guardrail:invalid_price");
    expect(checkPushGuardrails(cell({ zeroBase: true }))).toBe("guardrail:zero_base");
    expect(checkPushGuardrails(cell({ price: 99.99 }))).toBe("guardrail:below_floor");
    expect(checkPushGuardrails(cell({ price: 300.01 }))).toBe("guardrail:above_ceiling");
    expect(checkPushGuardrails(cell({ computedAtMs: NOW - 31 * 60_000 }))).toBe("guardrail:stale_price");
  });

  it("checks against the defaults too, since nobody has to set a floor or a ceiling", () => {
    const defaults = { isActive: true, floorPrice: 1, ceilingPrice: 99999.99 };
    expect(checkPushGuardrails(cell({ roomType: defaults, price: 1 }))).toBeNull();
    expect(checkPushGuardrails(cell({ roomType: defaults, price: 0.99 }))).toBe("guardrail:below_floor");
    expect(checkPushGuardrails(cell({ roomType: defaults, price: 100000 }))).toBe("guardrail:above_ceiling");
    // PostgREST can hand numerics back as strings.
    expect(checkPushGuardrails(cell({ roomType: { isActive: true, floorPrice: "1.00", ceilingPrice: "99999.99" } }))).toBeNull();
  });

  it("fails closed when the room type's bounds can't be read", () => {
    const rt = (floorPrice: unknown, ceilingPrice: unknown) => ({ isActive: true, floorPrice, ceilingPrice });
    expect(checkPushGuardrails(cell({ roomType: rt(null, 300) }))).toBe("guardrail:invalid_bounds");
    expect(checkPushGuardrails(cell({ roomType: rt(100, undefined) }))).toBe("guardrail:invalid_bounds");
    expect(checkPushGuardrails(cell({ roomType: rt(0, 300) }))).toBe("guardrail:invalid_bounds");
    expect(checkPushGuardrails(cell({ roomType: rt(200, 150) }))).toBe("guardrail:invalid_bounds");
    expect(checkPushGuardrails(cell({ roomType: rt("abc", 300) }))).toBe("guardrail:invalid_bounds");
  });

  it("treats an old row as fresh when a recent evaluation re-derived it", () => {
    const old = NOW - 5 * 86_400_000;
    expect(checkPushGuardrails(cell({ computedAtMs: old, evaluatedAtMs: NOW - 60_000 }))).toBeNull();
    expect(checkPushGuardrails(cell({ computedAtMs: old, evaluatedAtMs: NOW - 45 * 60_000 }))).toBe("guardrail:stale_price");
    expect(checkPushGuardrails(cell({ computedAtMs: NaN, evaluatedAtMs: NaN }))).toBe("guardrail:stale_price");
  });

  it("records the first reason in the documented order when several apply", () => {
    const everything = cell({
      stayDate: "2026-12-25",
      price: -1,
      roomType: { isActive: false, floorPrice: null, ceilingPrice: null },
      zeroBase: true,
      computedAtMs: NaN,
    });
    expect(checkPushGuardrails(everything)).toBe("guardrail:outside_window");
    expect(checkPushGuardrails({ ...everything, stayDate: "2026-10-05" })).toBe("guardrail:inactive_room_type");
    expect(
      checkPushGuardrails({ ...everything, stayDate: "2026-10-05", roomType: { isActive: true, floorPrice: null, ceilingPrice: null } }),
    ).toBe("guardrail:invalid_price");
    expect(GUARDRAIL_ORDER).toEqual([
      "guardrail:outside_window",
      "guardrail:inactive_room_type",
      "guardrail:invalid_price",
      "guardrail:zero_base",
      "guardrail:invalid_bounds",
      "guardrail:below_floor",
      "guardrail:above_ceiling",
      "guardrail:stale_price",
    ]);
  });

  it("keeps every code and the legacy no-target reason spelled as they are stored", () => {
    expect(Object.values(GUARDRAIL).sort()).toEqual([...GUARDRAIL_ORDER].sort());
    expect(NO_RATE_TARGET_REASON).toBe("no rate target for room type");
  });
});

describe("ledgerRowNeverSent", () => {
  it("is true only for a missing row or a skipped row with no attempts", () => {
    expect(ledgerRowNeverSent(null)).toBe(true);
    expect(ledgerRowNeverSent({ status: "skipped", attempts: 0 })).toBe(true);
    expect(ledgerRowNeverSent({ status: "skipped", attempts: 1 })).toBe(false);
    // Rows written before the marker existed may sit over a send.
    expect(ledgerRowNeverSent({ status: "skipped" })).toBe(false);
    expect(ledgerRowNeverSent({ status: "skipped", attempts: null })).toBe(false);
    expect(ledgerRowNeverSent({ status: "sent", attempts: 0 })).toBe(false);
    expect(ledgerRowNeverSent({ status: "failed", attempts: 0 })).toBe(false);
  });
});

describe("pushMaxPriceAgeMs", () => {
  it("is thirty minutes unless MAYA_PUSH_MAX_PRICE_AGE_MINUTES says otherwise", () => {
    expect(pushMaxPriceAgeMs(undefined)).toBe(30 * 60_000);
    expect(pushMaxPriceAgeMs("90")).toBe(90 * 60_000);
    expect(pushMaxPriceAgeMs("0")).toBe(30 * 60_000);
    expect(pushMaxPriceAgeMs("soon")).toBe(30 * 60_000);
  });
});
