"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { Tabs } from "@base-ui/react/tabs";

export interface PmsTabContent {
  pms: string;
  label: string;
  content: ReactNode;
}

const KEY = "maya-docs-pms";
const EVENT = "maya:pms-change";

// The reader's pick when this browser will not store it (site data blocked).
// It lasts until the page is reloaded.
let unsaved: string | null = null;

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readChoice(): string | null {
  if (unsaved !== null) return unsaved;
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/**
 * The same topic for each property system. The reader's pick is remembered
 * in this browser and every set of tabs on every page follows it.
 */
export function PmsTabsClient({ tabs }: { tabs: PmsTabContent[] }) {
  const stored = useSyncExternalStore(subscribe, readChoice, () => null);
  const value = tabs.some((t) => t.pms === stored) ? stored! : tabs[0]?.pms;

  function choose(next: unknown) {
    if (typeof next !== "string") return;
    try {
      localStorage.setItem(KEY, next);
      unsaved = null;
    } catch {
      // storage blocked: keep the pick in memory, so the tab still switches
      unsaved = next;
    }
    window.dispatchEvent(new Event(EVENT));
  }

  if (!tabs.length) return null;
  return (
    <Tabs.Root value={value} onValueChange={choose} className="my-7" data-pms-tabs>
      <Tabs.List
        aria-label="Property system"
        className="relative inline-flex max-w-full flex-wrap gap-1 rounded-xl bg-muted p-1"
        data-print-hide
      >
        {tabs.map((t) => (
          <Tabs.Tab
            key={t.pms}
            value={t.pms}
            className="rounded-lg px-3.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-[active]:bg-background data-[active]:text-foreground data-[active]:shadow-sm"
          >
            {t.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {tabs.map((t) => (
        <Tabs.Panel
          key={t.pms}
          value={t.pms}
          keepMounted
          data-pms-panel
          data-pms-label={t.label}
          className="mt-3 rounded-xl border border-border px-4 py-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:px-5 [&_p]:my-3"
        >
          {t.content}
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}
