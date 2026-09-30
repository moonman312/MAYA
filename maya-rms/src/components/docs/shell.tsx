"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Menu, MessageCircleQuestion, Search, X } from "lucide-react";
import { AskProvider, useAsk } from "./ask/ask-context";
import { AskButton, AskPanel } from "./ask/ask-panel";
import { DocsNav, type NavSection } from "./nav";
import { DocsSearch, type DocsSearchHandle } from "./search";
import { ThemeToggle } from "./theme-toggle";
import { ReadingProgress } from "./reading-progress";

function typingInField(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

function Sheet({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[60] bg-black/40 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup className="fixed inset-y-0 left-0 z-[61] flex w-[min(22rem,100vw)] flex-col bg-background shadow-2xl transition-transform duration-200 outline-none data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full motion-reduce:transition-none">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <X className="size-4" aria-hidden />
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-4">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function BarButton({ onClick, label, children }: { onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {children}
      {label}
    </button>
  );
}

function DocsFrame({ sections, children }: { sections: NavSection[]; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const sidebarSearch = useRef<DocsSearchHandle>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const { enabled: askEnabled, openAsk } = useAsk();

  // Paper can't open a closed example: open them all for printing, then put them back.
  useEffect(() => {
    const opened: HTMLDetailsElement[] = [];
    const before = () => {
      document.querySelectorAll<HTMLDetailsElement>("main details:not([open])").forEach((d) => {
        d.open = true;
        opened.push(d);
      });
    };
    const after = () => {
      opened.splice(0).forEach((d) => (d.open = false));
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || typingInField(e.target)) return;
      e.preventDefault();
      const sidebarVisible = sidebarRef.current && sidebarRef.current.offsetParent !== null;
      if (sidebarVisible) sidebarSearch.current?.focus();
      else setSearchOpen(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="docs-shell flex-1 pt-[4.25rem]">
      <ReadingProgress />
      <div
        className="sticky top-[4.25rem] z-40 flex items-center gap-1 border-b border-border bg-background/90 px-2 py-1.5 backdrop-blur-lg lg:hidden"
        data-print-hide
      >
        <BarButton onClick={() => setMenuOpen(true)} label="Docs menu">
          <Menu className="size-4" aria-hidden />
        </BarButton>
        <BarButton onClick={() => setSearchOpen(true)} label="Search">
          <Search className="size-4" aria-hidden />
        </BarButton>
        {askEnabled ? (
          <BarButton onClick={() => openAsk()} label="Ask">
            <MessageCircleQuestion className="size-4" aria-hidden />
          </BarButton>
        ) : null}
        <ThemeToggle className="ml-auto" />
      </div>

      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
        <div className="lg:grid lg:grid-cols-[15.5rem_minmax(0,1fr)] lg:gap-10">
          <aside ref={sidebarRef} className="relative z-30 hidden lg:block" data-print-hide>
            <div className="sticky top-[4.25rem] flex h-[calc(100dvh-4.25rem)] flex-col pt-8">
              <div className="flex items-center gap-2 pr-2 pb-4">
                <DocsSearch ref={sidebarSearch} className="flex-1" />
                <ThemeToggle />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto pr-2 pb-10 [scrollbar-width:thin]">
                <DocsNav sections={sections} />
              </div>
            </div>
          </aside>
          <main id="docs-content" className="min-w-0 pt-6 pb-24 lg:pt-10" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen} title="Docs menu">
        <DocsNav sections={sections} onNavigate={() => setMenuOpen(false)} />
      </Sheet>
      <Sheet open={searchOpen} onOpenChange={setSearchOpen} title="Search the docs">
        <DocsSearch size="lg" autoFocus onNavigate={() => setSearchOpen(false)} />
      </Sheet>
    </div>
  );
}

/** The docs' frame: menu, search, the docs helper and the reading chrome. */
export function DocsShell({
  sections,
  askEnabled,
  starters,
  children,
}: {
  sections: NavSection[];
  askEnabled: boolean;
  starters: string[];
  children: ReactNode;
}) {
  return (
    <AskProvider enabled={askEnabled} defaultStarters={starters}>
      <DocsFrame sections={sections}>{children}</DocsFrame>
      <AskButton />
      <AskPanel />
    </AskProvider>
  );
}

/** The docs helper on its own, for the support page. */
export function AskOnly({ askEnabled, starters, children }: { askEnabled: boolean; starters: string[]; children: ReactNode }) {
  return (
    <AskProvider enabled={askEnabled} defaultStarters={starters}>
      {children}
      <AskButton always />
      <AskPanel />
    </AskProvider>
  );
}
