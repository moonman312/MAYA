import type { Metadata } from "next";
import { AskOnly } from "@/components/docs/shell";
import { DocsSiteFooter, DocsSiteHeader } from "@/components/docs/site-chrome";
import { FrontDoor } from "@/components/support/front-door";
import { LegacyAnchorRedirect } from "@/components/support/legacy-anchors";
import { SUPPORT_STARTERS } from "@/lib/docs/home";
import { APP_ORIGIN } from "@/lib/docs/site";
import { SHARE_IMAGE } from "@/lib/docs/share";

export const metadata: Metadata = {
  metadataBase: new URL(APP_ORIGIN),
  title: "Support · MAYA",
  description: "Search the MAYA docs, ask the docs helper, or email us. Connect Cloudbeds, ThinkReservations or Mews, set up rules, go live, and get help.",
  alternates: { canonical: "/support" },
  openGraph: {
    type: "website",
    title: "Support · MAYA",
    description: "Search the MAYA docs, ask the docs helper, or email us.",
    url: "/support",
    siteName: "MAYA",
    images: [SHARE_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    images: [SHARE_IMAGE.url],
    title: "Support · MAYA",
    description: "Search the MAYA docs, ask the docs helper, or email us.",
  },
  robots: { index: true, follow: true },
};

const askEnabled = process.env.DOCS_ASK_DISABLED !== "1";

export default function SupportPage() {
  return (
    <div className="docs-root flex min-h-screen flex-col bg-background font-sans text-foreground antialiased">
      <DocsSiteHeader current="support" />
      <AskOnly askEnabled={askEnabled} starters={SUPPORT_STARTERS}>
        <main className="flex-1">
          <FrontDoor />
        </main>
      </AskOnly>
      <LegacyAnchorRedirect />
      <DocsSiteFooter />
    </div>
  );
}
