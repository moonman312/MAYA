/**
 * Thin re-export of the guest-PII redaction module (canonical implementation
 * lives in supabase/functions/_shared/pms/redact.ts — see the compliance
 * notes there). Mirrors src/lib/cloudbeds/sync-hotel.ts.
 */
export {
  redactCloudbedsPayload,
  redactMewsPayload,
  REDACTION_ALLOWLIST_UNION,
} from "../../../supabase/functions/_shared/pms/redact";
