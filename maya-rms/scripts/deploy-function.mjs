#!/usr/bin/env node
/**
 * Deploys one edge function with the commit it is built from stamped into it,
 * so its pricing runs and sends say which build made them (buildStamp in
 * supabase/functions/_shared/engine/build.ts, shown on Pilot health).
 *
 *   node scripts/deploy-function.mjs cloudbeds-scheduled-sync
 *
 * One function per run, from maya-rms/. It writes the commit (with "-dirty"
 * when supabase/functions has changes not committed) into
 * _shared/engine/build-stamp.ts, runs `npx supabase@latest functions deploy
 * <name>`, and puts the file back however the deploy went. A function
 * deployed without it says "edge@dev" on Pilot health.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const name = process.argv[2];
if (!name || !/^[a-z0-9-]+$/.test(name) || process.argv.length > 3) {
  console.error("Usage: node scripts/deploy-function.mjs <function-name>");
  process.exit(2);
}

const stampFile = fileURLToPath(new URL("../supabase/functions/_shared/engine/build-stamp.ts", import.meta.url));
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const commit = git("rev-parse", "--short=12", "HEAD");
const dirty = git("status", "--porcelain", "--", fileURLToPath(new URL("../supabase/functions", import.meta.url))) !== "";
const stamp = `${commit}${dirty ? "-dirty" : ""}`;

const original = readFileSync(stampFile, "utf8");
const stamped = original.replace(/BUILD_STAMP: string = "[^"]*"/, `BUILD_STAMP: string = "${stamp}"`);
if (stamped === original && !original.includes(`"${stamp}"`)) {
  console.error(`Could not find BUILD_STAMP in ${stampFile}; nothing deployed.`);
  process.exit(1);
}

let status = 1;
writeFileSync(stampFile, stamped);
try {
  console.log(`Deploying ${name} stamped edge@${stamp}`);
  status = spawnSync("npx", ["supabase@latest", "functions", "deploy", name], { stdio: "inherit" }).status ?? 1;
} finally {
  writeFileSync(stampFile, original);
}
process.exit(status);
