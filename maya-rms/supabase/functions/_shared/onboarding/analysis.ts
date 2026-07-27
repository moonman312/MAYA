/**
 * Post-import cleaning analysis: examines the imported reservation history
 * and writes onboarding_findings for the review step.
 *
 * Heuristics land in the analysis phase of the onboarding project; this
 * module currently completes the pipeline without findings so the worker
 * is fully wired end-to-end.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImportJobRow } from "./worker-core.ts";

export async function analyzeImport(
  supabase: SupabaseClient,
  job: ImportJobRow,
): Promise<void> {
  // TODO(analysis phase): closed periods, suspect room types, duplicate room
  // types, rate outliers, zero-rate share, unmapped room type counts.
  void supabase;
  void job;
}
