import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TermsGate } from "@/components/legal/terms-gate";
import { ThemeGuard } from "@/components/docs/theme-guard";
import { ThemeScript } from "@/components/docs/theme-script";
import { TextSizeScript } from "@/components/text-size-script";
import { WheelGuard } from "@/components/wheel-guard";
import { APP_ORIGIN } from "@/lib/docs/site";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(APP_ORIGIN),
  title: "MAYA",
  description: "Machine Assisted Yield Automation: revenue management for hotels",
  applicationName: "MAYA",
  appleWebApp: { title: "MAYA" },
  // The app's own screens (sign-in, onboarding, account) stay out of search.
  // The docs layout and the support page opt back in.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#020618",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      // the docs and support pages set their light or dark class, and every
      // page the person's text size, before hydrating
      suppressHydrationWarning
    >
      <head>
        <ThemeScript />
        <TextSizeScript />
      </head>
      <body className="min-h-full flex flex-col">
        {children}
        <ThemeGuard />
        <TermsGate />
        <WheelGuard />
      </body>
    </html>
  );
}
