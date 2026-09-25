"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// The old support guide's anchors, so links in old emails still land on the
// page that now answers them.
export const LEGACY_ANCHORS: Record<string, string> = {
  "before-you-begin": "/docs/start/how-to-get-started",
  connect: "/docs/connect/cloudbeds",
  account: "/docs/account/create-an-account-and-sign-in",
  payment: "/docs/pay/setting-up-payment",
  import: "/docs/review/the-history-import",
  review: "/docs/review/checking-what-maya-found",
  "go-live": "/docs/live/going-live",
  calendar: "/docs/watch/the-calendar",
  rules: "/docs/rules/build-your-first-rule",
  "change-log": "/docs/watch/the-change-log",
  "room-types": "/docs/watch/room-types-and-rooms-out-of-service",
  billing: "/docs/billing/the-billing-page",
  team: "/docs/team/roles",
  "multi-property": "/docs/account/several-properties",
  data: "/docs/connect/what-maya-reads-and-writes",
  timing: "/docs/live/how-prices-reach-your-pms",
  limitations: "/docs/reference/what-maya-does-not-do",
  disconnect: "/docs/connect/reconnect-and-disconnect",
  "get-support": "/docs/help/contact-support",
  faq: "/docs/wrong/start-here",
};

export function LegacyAnchorRedirect() {
  const router = useRouter();
  useEffect(() => {
    const id = window.location.hash.replace(/^#/, "");
    const target = LEGACY_ANCHORS[id];
    if (target) router.replace(target);
  }, [router]);
  return null;
}
