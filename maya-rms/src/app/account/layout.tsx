import { GodModeBannerSlot } from "@/components/admin/god-mode-banner-slot";
import { SimulationStrip } from "@/components/simulation-strip";
import type { ReactNode } from "react";

/**
 * The account pages as they are, under the strip that says whether the
 * property is simulating or live, plus the God Mode banner for a platform admin.
 */
export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SimulationStrip width="max-w-3xl px-6" />
      {children}
      <GodModeBannerSlot />
    </>
  );
}
