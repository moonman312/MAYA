// Where the docs point outside themselves. The docs live in the app
// (maya-rms.com/docs) but keep the marketing site's look, and a visitor who
// is not signed in only ever gets links back to get-maya.com, never into the app.

import { PRIVACY_URL, TERMS_URL } from "@/lib/legal/versions";

/** The app's own address, for canonical links and the sitemap. */
export const APP_ORIGIN = "https://maya-rms.com";

export const MARKETING_URL = "https://get-maya.com";
export const WAITLIST_URL = `${MARKETING_URL}/#waitlist`;
export const WHITE_PAPER_URL = `${MARKETING_URL}/philosophy`;
export { PRIVACY_URL, TERMS_URL };
