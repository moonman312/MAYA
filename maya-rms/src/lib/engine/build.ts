/**
 * Which build of MAYA did something (audit A29). Every pricing run stamps it
 * on its run log row (evaluation_run_log.build), every send on its ledger
 * row (rate_updates.build, kept in rate_send_log), and Pilot health shows a
 * property's latest, so a bad release can be tied to the prices it made.
 *
 * "edge@<commit>" for a scheduled function deployed with
 * scripts/deploy-function.mjs, which stamps the commit into build-stamp.ts
 * for the deploy; "app@<commit>" for the app on Vercel (its
 * VERCEL_GIT_COMMIT_SHA). "@dev" when neither says: a function deployed
 * some other way, or a local run.
 */
import { BUILD_STAMP } from "./build-stamp";

function readEnv(name: string): string | undefined {
  return (
    (typeof process !== "undefined" ? process.env?.[name] : undefined) ??
    (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno?.env?.get(name)
  );
}

export function buildStamp(): string {
  const side = (globalThis as { Deno?: unknown }).Deno !== undefined ? "edge" : "app";
  const vercel = readEnv("VERCEL_GIT_COMMIT_SHA")?.trim();
  const commit = BUILD_STAMP !== "dev" ? BUILD_STAMP : vercel ? vercel.slice(0, 12) : "dev";
  return `${side}@${commit}`.slice(0, 64);
}
