/**
 * Guest-PII redaction for persisted PMS payloads.
 *
 * COMPLIANCE REQUIREMENT — DO NOT WEAKEN.
 * Maya's privacy policy states we never store guest personal data. Every
 * reservation payload persisted to `reservations.raw_payload` MUST pass
 * through one of these redactors first. They are strict allowlists: any
 * field not explicitly listed is dropped, so new PMS fields are excluded
 * by default. Never add guest-identifying fields (names, emails, phone
 * numbers, addresses, notes, payment details, loyalty/customer ids) to
 * an allowlist.
 *
 * What we keep is only what pricing analysis needs: booking structure
 * (ids, dates, room type), party size, and booking source/channel.
 */

type Json = Record<string, unknown>;

const CLOUDBEDS_ALLOWLIST: readonly string[] = [
  // Booking structure
  "status",
  "reservationID",
  "reservationId",
  "subReservationID",
  "reservationRoomID",
  "roomID",
  "roomTypeID",
  "roomTypeId",
  "roomTypeName",
  "roomName",
  // Dates
  "startDate",
  "endDate",
  "dateCreated",
  "dateModified",
  // Party size (counts only — never identities)
  "adults",
  "children",
  "guestCount",
  // Source / channel (powers channel-mix analysis)
  "sourceName",
  "sourceID",
  "source",
  "channel",
  "origin",
  "thirdPartyIdentifier",
];

const MEWS_ALLOWLIST: readonly string[] = [
  // Booking structure
  "Id",
  "State",
  "Number",
  "ServiceId",
  "RateId",
  "RequestedCategoryId",
  "AssignedResourceId",
  "SpaceCategoryId",
  "ResourceCategoryId",
  "RoomCategoryId",
  // Dates
  "CreatedUtc",
  "UpdatedUtc",
  "StartUtc",
  "EndUtc",
  "ScheduledStartUtc",
  "ScheduledEndUtc",
  "ArrivalDate",
  "DepartureDate",
  "CheckInUtc",
  "CheckOutUtc",
  // Party size
  "AdultCount",
  "ChildCount",
  "PersonCount",
  // Source / channel
  "Origin",
  "ChannelNumber",
  "ChannelManagerNumber",
  "TravelAgencyId",
];

function pickAllowlisted(payload: Json, allowlist: readonly string[]): Json {
  const out: Json = {};
  for (const key of allowlist) {
    const v = payload[key];
    // Only scalars survive — nested objects/arrays (dailyRates, guest lists,
    // rate breakdowns) are either already parsed into columns or unneeded.
    if (v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[key] = v;
    }
  }
  out._redacted = true;
  return out;
}

/** Redact a Cloudbeds payload (reservation list entry or assigned[] room entry). */
export function redactCloudbedsPayload(payload: Json): Json {
  return pickAllowlisted(payload, CLOUDBEDS_ALLOWLIST);
}

/** Redact a raw Mews reservation object. */
export function redactMewsPayload(payload: Json): Json {
  return pickAllowlisted(payload, MEWS_ALLOWLIST);
}

/**
 * Union of both allowlists, exported for the one-time SQL backfill migration
 * (99_supabase_migration_pii_redaction_v1.sql) so the key list there can be
 * verified against this source of truth.
 */
export const REDACTION_ALLOWLIST_UNION: readonly string[] = [
  ...new Set([...CLOUDBEDS_ALLOWLIST, ...MEWS_ALLOWLIST]),
];
