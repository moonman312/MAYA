/**
 * The commit an edge function bundle was deployed from. "dev" in the
 * repository; scripts/deploy-function.mjs writes the commit in for the
 * length of a deploy and puts this file back after (buildStamp in build.ts).
 */
export const BUILD_STAMP: string = "dev";
