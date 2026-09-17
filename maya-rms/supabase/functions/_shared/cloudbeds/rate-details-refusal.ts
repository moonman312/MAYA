/**
 * Whether getReservationsWithRateDetails said no in words, rather than being
 * unreachable.
 *
 * An account can lack the endpoint or a scope it needs, and Cloudbeds answer
 * that with a success:false body or a 4xx. That is a fact about the property,
 * so the caller carries on the slow way instead of stopping: the live sync
 * with one getReservation per booking, the history import with the
 * getReservations list. A revoked grant, throttling, a 5xx or a timeout is
 * not: those fail the run as before, and the next run tries rate details again.
 *
 * Its own module so the sync and the onboarding adapter share one answer.
 */

import { CloudbedsHttpError } from "./client.ts";
import { isAuthRevocation } from "../pms/connection-health.ts";

export function cloudbedsRateDetailsRefused(error: unknown): error is CloudbedsHttpError {
  if (!(error instanceof CloudbedsHttpError)) return false;
  if (error.status === 429 || error.status >= 500 || error.status < 400) return false;
  return !isAuthRevocation(error.status, error.message);
}
