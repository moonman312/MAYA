"use client";

import * as Select from "@radix-ui/react-select";

export type PropertyOption = { id: string; name: string };

const triggerClasses =
  "flex h-10 min-w-48 cursor-pointer items-center justify-between gap-2 rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none " +
  "hover:border-slate-600 focus-visible:ring-2 focus-visible:ring-sky-500/80 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 " +
  "disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-slate-500";

const contentClasses =
  "z-50 max-h-[min(24rem,var(--radix-select-content-available-height))] overflow-hidden rounded-md border border-slate-700 bg-slate-950 shadow-lg shadow-black/40 " +
  "min-w-[var(--radix-select-trigger-width)]";

const itemClasses =
  "relative flex cursor-pointer select-none items-center rounded px-3 py-2 text-sm text-slate-100 outline-none " +
  "data-[highlighted]:bg-slate-800 data-[state=checked]:bg-sky-600/40";

function ChevronDownIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 15 15"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="h-4 w-4 shrink-0 text-slate-400"
      aria-hidden
    >
      <path
        d="M4.18179 6.18181C4.35753 6.00608 4.64245 6.00608 4.81819 6.18181L7.49999 8.86362L10.1818 6.18181C10.3575 6.00608 10.6424 6.00608 10.8182 6.18181C10.9939 6.35755 10.9939 6.64247 10.8182 6.81821L7.81819 9.81819C7.73379 9.90259 7.61934 9.95001 7.49999 9.95001C7.38064 9.95001 7.26618 9.90259 7.18179 9.81819L4.18179 6.81821C4.00605 6.64247 4.00605 6.35755 4.18179 6.18181Z"
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
      />
    </svg>
  );
}

type PropertySelectProps = {
  options: PropertyOption[];
  value: string | null;
  onValueChange: (hotelId: string) => void;
  disabled?: boolean;
  label?: string;
  placeholder?: string;
  /** Prefix for aria ids, e.g. `header-property` */
  id?: string;
};

export function PropertySelect({
  options,
  value,
  onValueChange,
  disabled,
  label = "Property",
  placeholder = "Select property",
  id = "property-select",
}: PropertySelectProps) {
  if (options.length === 0) return null;

  const resolvedValue =
    value && options.some((o) => o.id === value) ? value : (options[0]?.id ?? "");
  const labelId = `${id}-label`;

  return (
    <div className="flex flex-col gap-1 text-xs text-slate-400">
      {label ? (
        <span id={labelId} className="font-medium">
          {label}
        </span>
      ) : null}
      <Select.Root
        value={resolvedValue}
        onValueChange={onValueChange}
        disabled={disabled}
      >
        <Select.Trigger aria-labelledby={label ? labelId : undefined} className={triggerClasses}>
          <Select.Value placeholder={placeholder} />
          <Select.Icon className="flex shrink-0">
            <ChevronDownIcon />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            position="popper"
            sideOffset={6}
            collisionPadding={12}
            className={contentClasses}
          >
            <Select.Viewport className="p-1">
              {options.map((opt) => (
                <Select.Item key={opt.id} value={opt.id} className={itemClasses}>
                  <Select.ItemText>{opt.name}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}
