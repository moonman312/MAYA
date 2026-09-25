"use client";

import { usePathname } from "next/navigation";
import { HelpLink } from "./help-links";

/** Help in the onboarding header, for whichever of its screens is open. */
export function OnboardingHelpLink({ className }: { className?: string }) {
  const pathname = usePathname();
  const screen = pathname?.startsWith("/onboarding/review")
    ? "review"
    : pathname?.startsWith("/onboarding/questions")
      ? "questions"
      : "onboarding";
  return <HelpLink screen={screen} className={className} />;
}
