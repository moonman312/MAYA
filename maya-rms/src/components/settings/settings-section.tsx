"use client";

import type { ReactNode } from "react";

/** How a section's last save went, shown small beside its heading. */
export type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

/**
 * One section of Settings: a heading, who it is for, and its controls. Every
 * section looks the same, so a new one only brings its own controls.
 */
export function SettingsSection({
  id,
  title,
  scope,
  state,
  readOnly,
  children,
}: {
  id: string;
  title: string;
  /** Who it applies to: "For everyone on Harbour Inn", "Just for you". */
  scope: string;
  state: SaveState;
  /** Why this person cannot change it; null when they can. */
  readOnly?: string | null;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} data-settings-section={id} className="border-t border-slate-800 pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 id={`${id}-title`} className="text-sm font-semibold text-slate-100">
          {title}
        </h3>
        <SaveLine state={state} />
      </div>
      <p className="text-xs text-slate-500">{scope}</p>
      {readOnly ? <p className="mt-2 text-xs text-amber-200/90">{readOnly}</p> : null}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function SaveLine({ state }: { state: SaveState }) {
  if (state.kind === "saving") return <span className="text-xs text-slate-500" role="status">Saving…</span>;
  if (state.kind === "saved") return <span className="text-xs text-emerald-300" role="status">Saved</span>;
  if (state.kind === "error") return <span className="text-xs text-rose-300" role="alert">{state.message}</span>;
  return null;
}

/**
 * A label and its control on one row, stacked on a phone. Without `htmlFor`
 * the label is plain words (a group of buttons names itself), so a "?" in
 * it is never pressed by a click on the words.
 */
export function SettingRow({ label, htmlFor, children }: { label: ReactNode; htmlFor?: string; children: ReactNode }) {
  const cls = "flex items-center gap-1.5 text-xs font-medium text-slate-300";
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center sm:gap-3">
      {htmlFor ? (
        <label htmlFor={htmlFor} className={cls}>
          {label}
        </label>
      ) : (
        <span className={cls}>{label}</span>
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A small set of buttons where exactly one is on. */
export function Choice<T extends string>({
  name,
  options,
  value,
  disabled,
  onChange,
}: {
  name: string;
  options: { value: T; label: string }[];
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={name} className="inline-flex max-w-full flex-wrap gap-1 rounded-md border border-slate-700 bg-slate-950 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => {
            if (o.value !== value) onChange(o.value);
          }}
          className={`cursor-pointer rounded px-3 py-1 text-xs font-medium transition-colors disabled:cursor-default ${
            value === o.value ? "bg-slate-700 text-slate-100" : "text-slate-400 hover:text-slate-200 disabled:hover:text-slate-400"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const SELECT_CLASS =
  "w-full cursor-pointer rounded bg-slate-800 px-2 py-1.5 text-sm text-slate-100 hover:bg-slate-700 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-slate-800";
