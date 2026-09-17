/**
 * The cause a failed push is filed under decides whether the cell is retried,
 * whether the owner hears about it, and what they are told. The codes are
 * stored, so their spelling is part of what is tested.
 */
import { describe, expect, it } from "vitest";
import {
  causeFacts,
  classifyPushFailure,
  describePushCause,
  isIncidentSkipReason,
  JOB_UNCONFIRMED_MESSAGE,
  MAX_PUSH_ATTEMPTS,
  parseVendorError,
  PUSH_CAUSES,
  type PushFailureInput,
  RETRY_AFTER_GIVING_UP_MS,
  retryDecision,
  SEND_IN_PROGRESS_MESSAGE,
} from "../../../supabase/functions/_shared/pms/push-failure";
import { GUARDRAIL, NO_RATE_TARGET_REASON } from "../../../supabase/functions/_shared/pms/push-guardrails";
import { REVOCATION_PHRASES } from "../../../supabase/functions/_shared/pms/connection-health";

const send = (message: string, httpStatus: number | null = null, over: Partial<PushFailureInput> = {}): PushFailureInput => ({
  pms: "cloudbeds",
  phase: "send",
  message,
  httpStatus,
  ...over,
});

describe("classifyPushFailure", () => {
  const table: Array<[string, PushFailureInput, string, boolean, "transient" | "critical", string]> = [
    // Seen live from Cloudbeds as HTTP 200 success:false, which the client reports as 400.
    [
      "an uninstalled app",
      send("Cloudbeds patchRate failed (400): Application is not available to be connected"),
      "auth_revoked",
      true,
      "critical",
      "hold",
    ],
    // A write refused after this tick's read worked: held, the connection left up.
    ["a bare 401", send("Cloudbeds patchRate failed (401): Unauthorized", 401), "missing_write_permission", true, "critical", "hold"],
    ["a bare 401 from Think", send("Think /v1/hotels/1/rate_types/2/daily failed (401): Unauthorized", 401, { pms: "think" }), "missing_write_permission", true, "critical", "hold"],
    ["token wording on a write", send("Cloudbeds patchRate failed (200): Invalid token"), "missing_write_permission", true, "critical", "hold"],
    [
      "a 401 again on new credentials",
      send("Cloudbeds patchRate failed (401): Unauthorized", 401, { freshCredentialsRefused: true }),
      "auth_revoked",
      true,
      "critical",
      "hold",
    ],
    [
      "a Think write refused on new credentials, or in not-connected wording",
      send("Think /v1/x failed (401): invalid_grant", 401, { pms: "think", freshCredentialsRefused: true }),
      "missing_write_permission",
      true,
      "critical",
      "hold",
    ],
    [
      "a missing scope, in the wording Cloudbeds used for taxes",
      send("Cloudbeds patchRate failed (400): Scope required for this call was not granted by property."),
      "missing_write_permission",
      true,
      "critical",
      "hold",
    ],
    ["a 403 on the write", send("Think /v1/x failed (403): Forbidden", 403, { pms: "think" }), "missing_write_permission", true, "critical", "hold"],
    ["a derived rate", send("Cloudbeds patchRate failed (400): Rate is derived and cannot be updated"), "rate_plan_not_updatable", true, "critical", "hold"],
    ["a rate id that is gone", send("Cloudbeds patchRate failed (400): Invalid rateID"), "rate_not_found", true, "transient", "reresolve"],
    ["a 404 from Think", send("Think /v1/x failed (404): no such rate type", 404, { pms: "think" }), "rate_not_found", true, "transient", "reresolve"],
    ["a night that is over", send("Cloudbeds patchRate failed (400): startDate cannot be in the past"), "stay_date_past", true, "transient", "hold"],
    ["a value under the PMS minimum", send("Cloudbeds patchRate failed (400): Rate must be greater than 10"), "value_rejected", true, "critical", "hold"],
    ["a 429", send("Cloudbeds patchRate failed (429): Too many requests"), "throttled", true, "transient", "quiet"],
    ["a 503", send("Cloudbeds patchRate failed (503): Service Unavailable"), "pms_unavailable", true, "transient", "quiet"],
    ["an HTML 502 page mentioning not found", send("Cloudbeds patchRate non-JSON (502): <html>Not Found</html>"), "pms_unavailable", true, "transient", "quiet"],
    ["a timeout with no status", send("AbortError: The signal has been aborted"), "pms_unavailable", true, "transient", "quiet"],
    ["a dropped connection", send("TypeError: fetch failed"), "pms_unavailable", true, "transient", "quiet"],
    ["an HTML 404 page", send("Cloudbeds patchRate non-JSON (404): <html>Not Found</html>"), "unknown", false, "transient", "quiet"],
    ["wording nobody has taught it", send("Cloudbeds patchRate failed (400): Something odd happened"), "unknown", false, "transient", "quiet"],
    [
      "a job the queue refused, in words it does not know",
      { pms: "cloudbeds", phase: "job", message: "rate closed" },
      "unknown",
      false,
      "transient",
      "quiet",
    ],
    ["a job never reported on", { pms: "cloudbeds", phase: "job", message: JOB_UNCONFIRMED_MESSAGE }, "job_unconfirmed", true, "transient", "quiet"],
    ["a send whose outcome was never written", send(SEND_IN_PROGRESS_MESSAGE), "job_unconfirmed", true, "transient", "quiet"],
    // Dates, checked before the generic comparisons.
    [
      "a start date the PMS wants no earlier than today",
      send("Cloudbeds patchRate failed (400): startDate must be greater than or equal to today"),
      "stay_date_past",
      true,
      "transient",
      "hold",
    ],
    ["an interval MAYA built backwards", send("Cloudbeds patchRate failed (400): endDate must be greater than startDate"), "unknown", false, "transient", "quiet"],
    // A malformed value is MAYA's request, not the hotel's rate rule.
    ["a price with too many decimals", send("Cloudbeds patchRate failed (400): rate allows at most 2 decimal places"), "unknown", false, "transient", "quiet"],
    ["a price that is not a number", send("Cloudbeds patchRate failed (400): rate must be a number"), "unknown", false, "transient", "quiet"],
    ["an update over the PMS maximum", send("Cloudbeds patchRate failed (400): rate update must be less than 5000"), "value_rejected", true, "critical", "hold"],
  ];

  it.each(table)("files %s under its cause", (_label, input, cause, known, severity, retry) => {
    const f = classifyPushFailure(input);
    expect(f).toMatchObject({ cause, known, severity, retry, adminOnly: false });
  });

  it("makes a missing rate critical on the second try, after the targets were re-read", () => {
    const first = classifyPushFailure(send("Cloudbeds patchRate failed (400): Invalid rateID", null, { attempt: 1 }));
    const second = classifyPushFailure(send("Cloudbeds patchRate failed (400): Invalid rateID", null, { attempt: 2 }));
    expect(first).toMatchObject({ severity: "transient", retry: "reresolve", dropTargets: true });
    expect(second).toMatchObject({ severity: "critical", retry: "hold" });
  });

  it("leaves connection health to alert a revoked grant", () => {
    expect(classifyPushFailure(send("", 401, { freshCredentialsRefused: true })).alertedElsewhere).toBe(true);
    expect(classifyPushFailure(send("", 401)).alertedElsewhere).toBe(false);
    expect(classifyPushFailure(send("", 403)).alertedElsewhere).toBe(false);
  });

  it("takes a grant as gone on exactly the wording connection health does, and never for Think", () => {
    for (const phrase of REVOCATION_PHRASES) {
      expect(classifyPushFailure(send(`Cloudbeds patchRate failed (400): ${phrase}`)).cause).toBe("auth_revoked");
      expect(classifyPushFailure(send(`Think /v1/x failed (400): ${phrase}`, 400, { pms: "think" })).cause).toBe("missing_write_permission");
    }
    // A 401 on new credentials only counts as one when it is a 401.
    expect(classifyPushFailure(send("Cloudbeds patchRate failed (503): down", 503, { freshCredentialsRefused: true })).cause).toBe("pms_unavailable");
  });

  it("only drops the target cache for causes that can mean the ids are stale", () => {
    expect(classifyPushFailure(send("", 503)).dropTargets).toBe(false);
    expect(classifyPushFailure(send("", 429)).dropTargets).toBe(false);
    expect(classifyPushFailure(send("Rate must be greater than 10", 400)).dropTargets).toBe(false);
    expect(classifyPushFailure(send("rate not found", 400)).dropTargets).toBe(true);
    expect(classifyPushFailure(send("huh", 400)).dropTargets).toBe(true);
  });

  it("files every guardrail code as an admin-only cause that is re-checked, not retried", () => {
    // A price under a floor raised after it was published, or over a ceiling
    // lowered since, is expected until the re-price lands: not a bug.
    const bugs = new Set<string>([GUARDRAIL.invalidPrice, GUARDRAIL.invalidBounds, GUARDRAIL.stalePrice]);
    for (const code of Object.values(GUARDRAIL)) {
      const f = classifyPushFailure({ pms: "cloudbeds", phase: "guardrail", message: code });
      expect(f.cause).toBe(code.replace("guardrail:", "guardrail_"));
      expect(f).toMatchObject({ known: true, adminOnly: true, retry: "recheck", mayaBug: bugs.has(code) });
      expect(isIncidentSkipReason(code)).toBe(true);
    }
  });

  it("tells apart the reasons a room type has no rate to send to", () => {
    const gap = (targetGap: PushFailureInput["targetGap"]) =>
      classifyPushFailure({ pms: "cloudbeds", phase: "guardrail", message: NO_RATE_TARGET_REASON, targetGap });
    expect(gap("derived_only")).toMatchObject({ cause: "rate_plan_not_updatable", severity: "critical", retry: "recheck", adminOnly: false });
    expect(gap("no_base_rate").cause).toBe("no_base_rate");
    expect(gap(null).cause).toBe("no_base_rate");
    // A catalog read that failed or came back empty says nothing about the room type.
    expect(gap("catalog_unavailable")).toMatchObject({ cause: "pms_unavailable", severity: "transient", adminOnly: false });
    expect(gap("not_in_catalog")).toMatchObject({ cause: "rate_not_found", severity: "critical" });
    expect(isIncidentSkipReason(NO_RATE_TARGET_REASON)).toBe(true);
    expect(isIncidentSkipReason("something else")).toBe(false);
  });

  it("knows every cause it can produce", () => {
    for (const cause of PUSH_CAUSES) expect(causeFacts(cause).cause).toBe(cause);
    expect(causeFacts("from a newer deploy")).toMatchObject({ cause: "unknown", known: false });
  });
});

describe("parseVendorError", () => {
  it("splits our clients' prefix from the vendor's words", () => {
    expect(parseVendorError("Cloudbeds patchRate failed (400): Invalid rateID")).toEqual({ status: 400, text: "Invalid rateID", nonJson: false });
    expect(parseVendorError("Think /v1/hotels/9/rate_types/2/daily non-JSON (500): <html>")).toEqual({ status: 500, text: "<html>", nonJson: true });
    expect(parseVendorError("rate closed")).toEqual({ status: null, text: "rate closed", nonJson: false });
  });
});

describe("describePushCause", () => {
  it("names the room types and says what the owner can do, without em dashes", () => {
    const one = describePushCause("rate_plan_not_updatable", "cloudbeds", ["Deluxe King"]);
    expect(one.title).toBe("Cloudbeds won't let MAYA change Deluxe King rates because that rate follows another rate plan");
    expect(one.action).toContain("Cloudbeds");
    expect(describePushCause("rate_plan_not_updatable", "cloudbeds", ["Deluxe King", "Queen"]).title).toBe(
      "Cloudbeds won't let MAYA change Deluxe King and Queen rates because those rates follow another rate plan",
    );
    expect(describePushCause("pms_unavailable", "think", ["A", "B", "C"])).toEqual({
      title: "Think Reservations isn't responding, so rates for 3 room types haven't updated yet",
      action: null,
    });
    for (const cause of PUSH_CAUSES) {
      const { title, action } = describePushCause(cause, "cloudbeds", ["Deluxe King"]);
      expect(title).not.toMatch(/[—–]/);
      expect(action ?? "").not.toMatch(/[—–]/);
    }
  });
});

describe("retryDecision", () => {
  const NOW = Date.parse("2026-09-17T12:00:00Z");
  const quiet = { retry: "quiet" as const };
  const hold = { retry: "hold" as const };

  it("keeps retrying a cause that clears on its own until the tries run out", () => {
    expect(retryDecision({ failure: quiet, attempts: MAX_PUSH_ATTEMPTS - 1, lastAttemptAtMs: NOW - 60_000, nowMs: NOW })).toBe("retry");
    expect(retryDecision({ failure: quiet, attempts: MAX_PUSH_ATTEMPTS, lastAttemptAtMs: NOW - 60_000, nowMs: NOW })).toBe("exhausted");
  });

  it("tries a cell that gave up again once a day has passed, instead of never", () => {
    expect(
      retryDecision({ failure: quiet, attempts: 14, lastAttemptAtMs: NOW - RETRY_AFTER_GIVING_UP_MS + 60_000, nowMs: NOW }),
    ).toBe("exhausted");
    expect(retryDecision({ failure: quiet, attempts: 14, lastAttemptAtMs: NOW - RETRY_AFTER_GIVING_UP_MS, nowMs: NOW })).toBe("retry");
  });

  it("holds a known critical cause from the first failure, for a day", () => {
    expect(retryDecision({ failure: hold, attempts: 1, lastAttemptAtMs: NOW - 5 * 60_000, nowMs: NOW })).toBe("held");
    expect(retryDecision({ failure: hold, attempts: 1, lastAttemptAtMs: NOW - RETRY_AFTER_GIVING_UP_MS - 1, nowMs: NOW })).toBe("retry");
  });

  it("ends a grant problem's hold once the connection was re-authorized after the last try", () => {
    const scope = classifyPushFailure(send("Cloudbeds patchRate failed (403): scope required for this call was not granted", 403));
    const revoked = classifyPushFailure(send("Cloudbeds patchRate failed (400): Application is not available to be connected"));
    const value = classifyPushFailure(send("Cloudbeds patchRate failed (400): Rate must be greater than 10"));
    const tried = NOW - 10 * 60_000;
    for (const failure of [scope, revoked]) {
      expect(retryDecision({ failure, attempts: 1, lastAttemptAtMs: tried, nowMs: NOW })).toBe("held");
      expect(retryDecision({ failure, attempts: 1, lastAttemptAtMs: tried, nowMs: NOW, reauthorizedAtMs: tried - 60_000 })).toBe("held");
      expect(retryDecision({ failure, attempts: 1, lastAttemptAtMs: tried, nowMs: NOW, reauthorizedAtMs: NOW - 5 * 60_000 })).toBe("retry");
    }
    // A reconnect says nothing about a rate rule set inside the PMS.
    expect(retryDecision({ failure: value, attempts: 1, lastAttemptAtMs: tried, nowMs: NOW, reauthorizedAtMs: NOW - 5 * 60_000 })).toBe("held");
  });

  it("retries a row with no time on it rather than holding it forever", () => {
    expect(retryDecision({ failure: hold, attempts: 3, lastAttemptAtMs: NaN, nowMs: NOW })).toBe("retry");
  });
});
