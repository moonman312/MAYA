import { GodModeBannerSlot } from "@/components/admin/god-mode-banner-slot";
import type { ReactNode } from "react";

/** The account pages as they are, plus the God Mode banner for a platform admin. */
export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <GodModeBannerSlot />
    </>
  );
}
