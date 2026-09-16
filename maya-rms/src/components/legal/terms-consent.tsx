"use client";

import { PRIVACY_URL, TERMS_URL } from "@/lib/legal/versions";

/**
 * The one checkbox every agreement in the app goes through. Unticked until
 * the person ticks it, and both documents open in a new tab so reading them
 * never loses what was typed into the form.
 */
export function TermsConsent({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const link = "text-sky-300 underline-offset-2 hover:underline";
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-300">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        required
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
      />
      <span>
        I agree to the{" "}
        <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" className={link}>
          Terms of Service
        </a>{" "}
        and{" "}
        <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" className={link}>
          Privacy Policy
        </a>
      </span>
    </label>
  );
}
