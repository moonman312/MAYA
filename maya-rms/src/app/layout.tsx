import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TermsGate } from "@/components/legal/terms-gate";
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
  title: "MAYA",
  description: "Machine Assisted Yield Automation — revenue management for hotels",
  applicationName: "MAYA",
  appleWebApp: { title: "MAYA" },
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
    >
      <body className="min-h-full flex flex-col">
        {children}
        <TermsGate />
      </body>
    </html>
  );
}
