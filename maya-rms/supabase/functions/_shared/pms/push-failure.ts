/**
 * Why a rate did not reach the PMS, as a cause someone can act on.
 *
 * A push fails in one of three places: the send itself (an HTTP error, or
 * Cloudbeds' success:false), the vendor's job queue afterwards (patchRate
 * accepted, getRateJobs later reports the update failed), or before sending
 * at all (a guardrail, or no rate to send to). Each of those surfaces
 * vendor text or a reason code; this maps them to one stable cause code and
 * decides three things from it: whether the push keeps retrying the cell,
 * whether the owner should ever hear about it, and what to tell them.
 *
 * THE CAUSE CODES ARE A CONTRACT. rate_push_incidents.cause stores them and
 * the admin analytics groups by them. Never rename or reuse one; add one.
 *
 * Vendor wording is matched on lowercased keywords, conservatively: text that
 * matches nothing is `unknown` with known=false, and the admin panel lists
 * samples of it so the lists below can be taught. Where a phrase has been
 * seen live it says so; everything else is a guess at wording nobody has
 * confirmed yet, and is marked as one.
 *
 * Plain module with type-only imports of its own: shared by the Deno edge
 * functions and the Next app.
 */

import { GUARDRAIL, NO_RATE_TARGET_REASON } from "./push-guardrails.ts";

export type PushPhase = "send" | "job" | "guardrail";
export type PushSeverity = "transient" | "critical";

/**
 * What the push does with a cell after this failure.
 *   quiet      sent again every tick, up to MAX_PUSH_ATTEMPTS at one price,
 *              then once a day
 *   reresolve  the rate target cache is dropped and the cell sent once more;
 *              a second failure is critical
 *   hold       not sent again until its price or its rate target changes, a
 *              day has passed (a fix made inside the PMS is invisible here),
 *              or, for a grant problem, the connection is re-authorized
 *   recheck    never sent: the guardrail or target lookup runs again next tick
 */
export type PushRetryPolicy = "quiet" | "reresolve" | "hold" | "recheck";

export const PUSH_CAUSES = [
  "auth_revoked",
  "missing_write_permission",
  "rate_plan_not_updatable",
  "no_base_rate",
  "rate_not_found",
  "stay_date_past",
  "value_rejected",
  "throttled",
  "pms_unavailable",
  "job_unconfirmed",
  "guardrail_outside_window",
  "guardrail_inactive_room_type",
  "guardrail_invalid_price",
  "guardrail_zero_base",
  "guardrail_invalid_bounds",
  "guardrail_below_floor",
  "guardrail_above_ceiling",
  "guardrail_stale_price",
  "unknown",
  "zero_rate_unsupported",
] as const;

export type PushCause = (typeof PUSH_CAUSES)[number];

/**
 * What the last catalog read said about a room type that has no rate target.
 * `catalog_unavailable`: this run could not read the catalog, or it came back
 * empty, so nothing is known about the room type. That is a PMS hiccup, not a
 * missing base rate.
 */
export type TargetGap = "derived_only" | "no_base_rate" | "not_in_catalog" | "catalog_unavailable";

/**
 * The ledger text for a job the vendor never reported on. Written by
 * reconcileJobOutcomes and read back here, so it is a contract too.
 */
export const JOB_UNCONFIRMED_MESSAGE = "rate job never confirmed";

/**
 * The ledger text written over a cell just before its send, and replaced by
 * the outcome once the PMS answers. A row still saying this means the run
 * died or its outcome write failed, so nobody knows whether the rate landed.
 * A contract like the one above.
 */
export const SEND_IN_PROGRESS_MESSAGE = "send in progress";

/** Sends a failing cell gets at one price before it waits a day. */
export const MAX_PUSH_ATTEMPTS = 10;
/** How long a cell that gave up, or is held, waits before one more try. */
export const RETRY_AFTER_GIVING_UP_MS = 24 * 60 * 60_000;

export type PushFailureInput = {
  pms: string;
  phase: PushPhase;
  /** The HTTP status when there was one; read from the message prefix otherwise. */
  httpStatus?: number | null;
  /** Vendor text as recorded (our client's "X failed (400): " prefix is fine), or the skip reason. */
  message?: string | null;
  /** Which try at this price this was, from 1. */
  attempt?: number;
  /** For a "no rate target" skip: what the catalog read said about the room type. */
  targetGap?: TargetGap | null;
  /**
   * The send was refused with 401, sent again on credentials minted after
   * that refusal (a different token), and refused with 401 again.
   */
  freshCredentialsRefused?: boolean;
};

export type PushFailure = {
  cause: PushCause;
  /** False only for `unknown`: the root cause is not known. */
  known: boolean;
  severity: PushSeverity;
  retry: PushRetryPolicy;
  /** Guardrail holds are MAYA's own decisions: counted for admins, never shown to owners. */
  adminOnly: boolean;
  /** Connection health already alerts this condition; recording it must not alert twice. */
  alertedElsewhere: boolean;
  /** A guardrail that should never fire unless MAYA published a bad row: worth a warning. */
  mayaBug: boolean;
  /** The target cache may be what is wrong, so the next send re-resolves it. */
  dropTargets: boolean;
  /**
   * The fix is a new grant, so a reconnect after the last try ends a hold at
   * once instead of after a day.
   */
  clearedByReconnect: boolean;
  /** The root cause for the owner, with generic wording for the rooms. */
  customerSentence: string;
  /** The root cause for an admin reading the analytics panel or an alert. */
  adminDescription: string;
};

type Words = {
  pms: string;
  /** "Deluxe King", "Deluxe King and Queen", "3 room types". */
  rooms: string;
  /** "Deluxe King rates", "rates for 3 room types". */
  roomsRates: string;
  plural: boolean;
};

type CatalogEntry = {
  known: boolean;
  severity: PushSeverity;
  retry: PushRetryPolicy;
  adminOnly?: boolean;
  alertedElsewhere?: boolean;
  mayaBug?: boolean;
  dropTargets?: boolean;
  clearedByReconnect?: boolean;
  sentence: (w: Words) => string;
  action: (w: Words) => string | null;
  admin: string;
};

const thisOrThese = (w: Words) => (w.plural ? "these room types" : "this room type");

const CATALOG: Record<PushCause, CatalogEntry> = {
  auth_revoked: {
    known: true,
    severity: "critical",
    retry: "hold",
    alertedElsewhere: true,
    clearedByReconnect: true,
    sentence: (w) => `${w.pms} stopped accepting MAYA's connection, so ${w.roomsRates} can't be changed`,
    action: (w) => `Reconnect ${w.pms} on the PMS tab.`,
    admin:
      "The PMS says the app is no longer connected, or refused a write with 401 again on credentials minted after the first 401. The push marks the connection disconnected, which alerts. Never filed for Think from a push.",
  },
  missing_write_permission: {
    known: true,
    severity: "critical",
    retry: "hold",
    clearedByReconnect: true,
    sentence: (w) => `${w.pms} won't let MAYA change ${w.roomsRates} because MAYA doesn't have permission to update rates`,
    action: (w) => `Give MAYA permission to update rates in ${w.pms}, then reconnect on the PMS tab.`,
    admin:
      "Reads work but the rate write is refused: 403 or scope wording, or a 401 or token wording on a write after this tick's read worked. Held until a reconnect or a day; the connection is left connected.",
  },
  rate_plan_not_updatable: {
    known: true,
    severity: "critical",
    retry: "hold",
    sentence: (w) =>
      `${w.pms} won't let MAYA change ${w.roomsRates} because ${w.plural ? "those rates follow" : "that rate follows"} another rate plan`,
    action: (w) => `In ${w.pms}, give ${thisOrThese(w)} a base rate of its own that doesn't follow another plan.`,
    admin: "The room type's only rates are derived from another plan, which the PMS does not let an integration write.",
  },
  no_base_rate: {
    known: true,
    severity: "critical",
    retry: "hold",
    sentence: (w) => `MAYA can't find a base rate for ${w.rooms} in ${w.pms}, so ${w.plural ? "their" : "its"} rates can't be changed`,
    action: (w) => `Add a base rate for ${thisOrThese(w)} in ${w.pms}.`,
    admin: "The catalog has the room type but no base rate for it (only packages, or no rate type MAYA treats as base).",
  },
  rate_not_found: {
    known: true,
    severity: "transient",
    retry: "reresolve",
    dropTargets: true,
    sentence: (w) => `${w.pms} can't find the rate MAYA changes for ${w.rooms}. It may have been deleted or replaced`,
    action: (w) => `Check that ${thisOrThese(w)} still ${w.plural ? "have" : "has"} a base rate in ${w.pms}.`,
    admin: "The rate or room type id MAYA sent to no longer exists. Retried once after re-reading the catalog, then critical.",
  },
  stay_date_past: {
    known: true,
    severity: "transient",
    retry: "hold",
    sentence: (w) => `${w.pms} wouldn't take ${w.roomsRates} for a night that had already begun at the property`,
    action: (w) => `Check that the property's time zone in ${w.pms} matches the one in MAYA.`,
    admin: "The PMS says the night is already over. Usually a time zone mismatch between MAYA's hotel date and the PMS's.",
  },
  value_rejected: {
    known: true,
    severity: "critical",
    retry: "hold",
    sentence: (w) =>
      `${w.pms} refused MAYA's price for ${w.rooms} because it breaks a rate rule set in ${w.pms}, such as a minimum or maximum rate`,
    action: (w) => `Check the rate limits for ${thisOrThese(w)} in ${w.pms}.`,
    admin:
      "The PMS rejected the value against its own min/max rules. Held until the price changes. Format wording is not filed here: that is MAYA's own request, and reads as unknown.",
  },
  throttled: {
    known: true,
    severity: "transient",
    retry: "quiet",
    sentence: (w) => `${w.pms} asked MAYA to slow down, so ${w.roomsRates} are taking longer than usual to update`,
    action: () => null,
    admin: "429 after the client's own back-off. Retried quietly.",
  },
  pms_unavailable: {
    known: true,
    severity: "transient",
    retry: "quiet",
    sentence: (w) => `${w.pms} isn't responding, so ${w.roomsRates} haven't updated yet`,
    action: () => null,
    admin: "5xx, timeout, network failure or a non-JSON error page. Retried quietly.",
  },
  job_unconfirmed: {
    known: true,
    severity: "transient",
    retry: "quiet",
    sentence: (w) => `${w.pms} took ${w.roomsRates} but never confirmed it saved them`,
    action: () => null,
    admin: "The vendor still listed the job as unfinished 45 minutes after it went out, so it is taken as not applied and sent again.",
  },
  guardrail_outside_window: guardrail("the night is outside the pricing window", false),
  guardrail_inactive_room_type: guardrail("the room type is switched off in MAYA", false),
  guardrail_invalid_price: guardrail("the published price is not a number above 0", true),
  guardrail_zero_base: guardrail("the PMS has the night at 0 and nobody typed a price", false),
  guardrail_invalid_bounds: guardrail("the room type's floor or ceiling is not usable", true),
  // Not bugs: a floor raised or a ceiling lowered after the night was
  // published lands here until the re-price that follows the change finishes.
  guardrail_below_floor: guardrail("the published price is under the room type's floor", false),
  guardrail_above_ceiling: guardrail("the published price is over the room type's ceiling", false),
  guardrail_stale_price: guardrail("no recent evaluation backs the published price", true),
  // Not a guardrail hold the owner can ignore: MAYA shows the night at 0 and
  // the PMS still has its last price. Nothing about it clears on its own.
  zero_rate_unsupported: {
    known: true,
    severity: "critical",
    retry: "recheck",
    sentence: (w) => `MAYA doesn't send a price of 0 to ${w.pms}, so ${w.roomsRates} set to 0 in MAYA weren't changed there`,
    action: (w) => `If the night is meant to be free, set it to 0 in ${w.pms} yourself.`,
    admin:
      "A manual price of 0 (a comp night) is published, and nobody has checked that this PMS's rate write takes 0 (PmsRatePushAdapter acceptsZeroRate), so it is not sent. Once the PMS itself has the night at the manual price the base rate refresh records that and the night closes as landed.",
  },
  unknown: {
    known: false,
    severity: "transient",
    retry: "quiet",
    dropTargets: true,
    sentence: (w) => `${w.pms} didn't accept ${w.roomsRates}, and MAYA couldn't tell why`,
    action: () => null,
    admin: "Vendor wording the classifier does not recognise. Retried quietly; teach push-failure.ts the message.",
  },
};

function guardrail(why: string, mayaBug: boolean): CatalogEntry {
  return {
    known: true,
    severity: mayaBug ? "critical" : "transient",
    retry: "recheck",
    adminOnly: true,
    mayaBug,
    sentence: (w) => `MAYA held back ${w.roomsRates} because ${why}`,
    action: () => null,
    admin: `Guardrail: ${why}.${mayaBug ? " Should not happen: the engine clamps and dates what it publishes." : ""}`,
  };
}

const GUARDRAIL_CAUSE: Record<string, PushCause> = {
  [GUARDRAIL.outsideWindow]: "guardrail_outside_window",
  [GUARDRAIL.inactiveRoomType]: "guardrail_inactive_room_type",
  [GUARDRAIL.invalidPrice]: "guardrail_invalid_price",
  [GUARDRAIL.zeroBase]: "guardrail_zero_base",
  [GUARDRAIL.invalidBounds]: "guardrail_invalid_bounds",
  [GUARDRAIL.belowFloor]: "guardrail_below_floor",
  [GUARDRAIL.aboveCeiling]: "guardrail_above_ceiling",
  [GUARDRAIL.stalePrice]: "guardrail_stale_price",
  [GUARDRAIL.zeroRateUnsupported]: "zero_rate_unsupported",
};

/** A skip reason that means a cell is not reaching the PMS: a guardrail code or no rate target. */
export function isIncidentSkipReason(reason: unknown): boolean {
  return typeof reason === "string" && (reason === NO_RATE_TARGET_REASON || reason in GUARDRAIL_CAUSE);
}

/*
 * Vendor wording, lowercased. Seen live where noted; the rest are guesses.
 */

// connection-health.ts REVOCATION_PHRASES, the first seen live from Cloudbeds
// 2026-09-10. Kept to exactly those: this wording takes the connection offline.
const REVOKED = ["application is not available to be connected", "app is not connected", "invalid_grant"];

// Unverified guesses. On a write, after this tick's read worked with the same
// token, they are the write refused, not a grant that is gone.
const TOKEN_REFUSED = ["invalid token", "invalid_token", "token expired", "token has expired", "expired token"];

// "scope required for this call was not granted by property" seen live from
// Cloudbeds getTaxesAndFees 2026-09-08. The rest are unverified guesses.
const PERMISSION = ["scope required", "not granted", "insufficient scope", "permission", "access denied"];

// Unverified: Cloudbeds' docs say only rates with isDerived false can be
// written, but nobody has seen what patchRate says to a derived one.
const DERIVED = ["derived", "linked rate", "parent rate"];

// Unverified guesses.
const NOT_FOUND = [
  "not found",
  "does not exist",
  "doesn't exist",
  "invalid rateid",
  "invalid rate id",
  "invalid ratetypeid",
  "invalid rate type",
  "invalid roomtypeid",
  "invalid room type",
  "unknown rate",
];

// Unverified guesses.
const PAST_DATE = ["in the past", "past date", "date has passed", "before today", "earlier than today"];

// A message about the request's dates rather than its price. Checked before
// VALUE: "startDate must be greater than or equal to today" is a night that
// is over, and "endDate must be greater than startDate" is MAYA's own bad
// request. Neither is the hotel's rate rule. Word boundaries keep "update"
// from counting as a date.
const MENTIONS_DATE = /\b(?:start|end)?date\b|\btoday\b/;

// Unverified guesses: the PMS's own min/max rules. Deliberately not a bare
// "invalid rate", which reads the same for a bad value and a bad rate id, and
// no format wording ("must be a number", "decimal places"): a malformed value
// is MAYA's request, not a rule the owner set, so it stays unknown and
// retries quietly with its text kept for the admin panel.
const VALUE = [
  "minimum rate",
  "maximum rate",
  "min rate",
  "max rate",
  "must be greater",
  "must be less",
  "greater than",
  "less than",
  "out of range",
];

// "too many requests" is what a 429 body usually says; unverified per vendor.
const THROTTLED = ["too many requests", "rate limit", "throttl"];

// Abort and fetch-failure wording from Deno and Node; the rest unverified.
const UNAVAILABLE = [
  "timed out",
  "timeout",
  "aborted",
  "fetch failed",
  "network",
  "econnreset",
  "econnrefused",
  "connection reset",
  "connection refused",
  "socket hang up",
  "service unavailable",
  "bad gateway",
  "temporarily unavailable",
  "maintenance",
];

const includesAny = (text: string, phrases: readonly string[]) => phrases.some((p) => text.includes(p));

/**
 * Our clients prefix vendor text as "Cloudbeds patchRate failed (400): ..."
 * or "Think /v1/.../daily failed (500): ...". The status and the vendor's own
 * words come back apart; text without the prefix is returned as it is.
 */
export function parseVendorError(message: string | null | undefined): {
  status: number | null;
  text: string;
  nonJson: boolean;
} {
  const raw = String(message ?? "");
  const m = /^(?:cloudbeds|think|mews)\s+\S+\s+(failed|non-json)\s+\((\d{3})\):\s*/i.exec(raw);
  if (!m) return { status: null, text: raw, nonJson: false };
  return { status: Number(m[2]), text: raw.slice(m[0].length), nonJson: m[1].toLowerCase() === "non-json" };
}

function causeOf(input: PushFailureInput): PushCause {
  if (input.phase === "guardrail") {
    const reason = String(input.message ?? "");
    if (reason === NO_RATE_TARGET_REASON) {
      if (input.targetGap === "derived_only") return "rate_plan_not_updatable";
      if (input.targetGap === "not_in_catalog") return "rate_not_found";
      // Nothing was learned about the room type: the read failed or was empty.
      if (input.targetGap === "catalog_unavailable") return "pms_unavailable";
      return "no_base_rate";
    }
    return GUARDRAIL_CAUSE[reason] ?? "unknown";
  }

  const parsed = parseVendorError(input.message);
  if (input.phase === "job" && parsed.text.trim() === JOB_UNCONFIRMED_MESSAGE) return "job_unconfirmed";
  // Sent or not, nobody heard back: the same question as a job never confirmed.
  if (parsed.text.trim() === SEND_IN_PROGRESS_MESSAGE) return "job_unconfirmed";
  const status = input.httpStatus ?? parsed.status;
  const text = parsed.text.toLowerCase();

  // Server trouble first, whatever its body says: a 502 page can contain
  // "not found" and still just be an outage.
  if (status === 429) return "throttled";
  if (status != null && (status >= 500 || status === 408)) return "pms_unavailable";
  // An HTML error page for a 4xx is not the vendor talking about our rate;
  // most likely a wrong URL. Nothing is known about it.
  if (parsed.nonJson) return "unknown";

  // Only a grant the PMS says is gone takes the connection offline (rate-push.ts
  // marks it disconnected): its wording for an app that is not connected, or a
  // 401 again on credentials minted after the first. A push runs only after
  // this tick's read of the same PMS worked, so anything less on the write is
  // the write refused to a grant that reads, and every read, evaluation and
  // push of the property must not stop over it. A Think grant can read and
  // still be refused a PUT, so a Think push never takes it offline.
  if (includesAny(text, REVOKED) || (status === 401 && input.freshCredentialsRefused === true)) {
    return input.pms === "think" ? "missing_write_permission" : "auth_revoked";
  }
  if (includesAny(text, TOKEN_REFUSED)) return "missing_write_permission";
  if (includesAny(text, PERMISSION)) return "missing_write_permission";
  if (includesAny(text, DERIVED)) return "rate_plan_not_updatable";
  if (includesAny(text, NOT_FOUND)) return "rate_not_found";
  if (includesAny(text, PAST_DATE)) return "stay_date_past";
  if (MENTIONS_DATE.test(text)) {
    // "must be greater than or equal to today" and the like.
    if (text.includes("today")) return "stay_date_past";
  } else if (includesAny(text, VALUE)) {
    return "value_rejected";
  }
  if (includesAny(text, THROTTLED)) return "throttled";
  if (includesAny(text, UNAVAILABLE)) return "pms_unavailable";

  // A push runs only after this tick's read of the same PMS succeeded, so the
  // grant exists; a 401 or 403 on the write is the write being forbidden.
  // Unverified.
  if (status === 401 || status === 403) return "missing_write_permission";
  // Unverified: Think answers an unknown rate type id this way, Cloudbeds
  // reports its errors as success:false instead.
  if (status === 404) return "rate_not_found";
  return "unknown";
}

export const PMS_NAMES: Record<string, string> = {
  cloudbeds: "Cloudbeds",
  mews: "Mews",
  think: "Think Reservations",
};

export function pmsName(pms: string): string {
  return PMS_NAMES[pms] ?? pms;
}

function wordsFor(pms: string, roomTypeNames: readonly string[] = []): Words {
  const names = [...new Set(roomTypeNames.filter(Boolean))];
  const p = pmsName(pms);
  if (names.length === 0) return { pms: p, rooms: "some room types", roomsRates: "some rates", plural: true };
  if (names.length === 1) return { pms: p, rooms: names[0], roomsRates: `${names[0]} rates`, plural: false };
  if (names.length === 2) {
    const rooms = `${names[0]} and ${names[1]}`;
    return { pms: p, rooms, roomsRates: `${rooms} rates`, plural: true };
  }
  const rooms = `${names.length} room types`;
  return { pms: p, rooms, roomsRates: `rates for ${rooms}`, plural: true };
}

export function classifyPushFailure(input: PushFailureInput): PushFailure {
  const cause = causeOf(input);
  const entry = CATALOG[cause];
  let severity = entry.severity;
  let retry = entry.retry;
  // Once after re-reading the catalog; a skip means the fresh read already
  // came back without it.
  if (cause === "rate_not_found" && ((input.attempt ?? 1) >= 2 || input.phase === "guardrail")) {
    severity = "critical";
    retry = "hold";
  }
  // A cell that was never sent is looked at again next tick, not retried.
  if (input.phase === "guardrail") retry = "recheck";
  return {
    cause,
    known: entry.known,
    severity,
    retry,
    adminOnly: entry.adminOnly === true,
    alertedElsewhere: entry.alertedElsewhere === true,
    mayaBug: entry.mayaBug === true,
    dropTargets: entry.dropTargets === true,
    clearedByReconnect: entry.clearedByReconnect === true,
    customerSentence: entry.sentence(wordsFor(input.pms)),
    adminDescription: entry.admin,
  };
}

/** The static facts about a cause, for readers that have a stored code and nothing else. */
export function causeFacts(cause: string): {
  cause: PushCause;
  known: boolean;
  adminOnly: boolean;
  mayaBug: boolean;
  alertedElsewhere: boolean;
  adminDescription: string;
} {
  const code = (PUSH_CAUSES as readonly string[]).includes(cause) ? (cause as PushCause) : "unknown";
  const entry = CATALOG[code];
  return {
    cause: code,
    known: entry.known,
    adminOnly: entry.adminOnly === true,
    mayaBug: entry.mayaBug === true,
    alertedElsewhere: entry.alertedElsewhere === true,
    adminDescription: entry.admin,
  };
}

/** The root cause in the owner's words, naming the room types, and what they can do about it. */
export function describePushCause(
  cause: string,
  pms: string,
  roomTypeNames: readonly string[],
): { title: string; action: string | null } {
  const code = (PUSH_CAUSES as readonly string[]).includes(cause) ? (cause as PushCause) : "unknown";
  const w = wordsFor(pms, roomTypeNames);
  return { title: CATALOG[code].sentence(w), action: CATALOG[code].action(w) };
}

/**
 * What happens to a failed cell whose price has not changed since it failed.
 *   retry      send it this tick
 *   held       a known critical cause: wait for the price or target to change
 *   exhausted  MAX_PUSH_ATTEMPTS used at this price
 * Both waits end a day after the last try, so a fix nobody told MAYA about
 * (a scope granted, a rate rule loosened) is picked up within a day, and a
 * cell is never given up on for good. A hold whose fix is a new grant ends as
 * soon as the connection was re-authorized after the last try
 * (`reauthorizedAtMs`, pms_connections.reauthorized_at): the owner did what
 * the change log asked, so waiting a day would only leave their rates stale.
 */
export function retryDecision(p: {
  failure: Pick<PushFailure, "retry"> & { clearedByReconnect?: boolean };
  attempts: number;
  lastAttemptAtMs: number;
  nowMs: number;
  reauthorizedAtMs?: number;
}): "retry" | "held" | "exhausted" {
  const rested = !(p.nowMs - p.lastAttemptAtMs < RETRY_AFTER_GIVING_UP_MS);
  if (p.failure.retry === "hold") {
    const reconnected =
      p.failure.clearedByReconnect === true &&
      p.reauthorizedAtMs != null &&
      Number.isFinite(p.lastAttemptAtMs) &&
      p.reauthorizedAtMs > p.lastAttemptAtMs;
    return rested || reconnected ? "retry" : "held";
  }
  if (p.attempts >= MAX_PUSH_ATTEMPTS) return rested ? "retry" : "exhausted";
  return "retry";
}
