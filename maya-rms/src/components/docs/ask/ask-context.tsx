"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

interface AskState {
  enabled: boolean;
  open: boolean;
  /** a question to put in the box when the panel opens */
  draft: string;
  starters: string[];
  openAsk: (draft?: string) => void;
  closeAsk: () => void;
  setStarters: (s: string[]) => void;
}

const AskContext = createContext<AskState | null>(null);

export function AskProvider({
  enabled,
  defaultStarters,
  children,
}: {
  enabled: boolean;
  defaultStarters: string[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [starters, setStartersState] = useState<string[]>(defaultStarters);
  const openAsk = useCallback((d?: string) => {
    setDraft(d ?? "");
    setOpen(true);
  }, []);
  const closeAsk = useCallback(() => setOpen(false), []);
  const setStarters = useCallback((s: string[]) => setStartersState(s), []);
  const value = useMemo(
    () => ({ enabled, open, draft, starters: starters.length ? starters : defaultStarters, openAsk, closeAsk, setStarters }),
    [enabled, open, draft, starters, defaultStarters, openAsk, closeAsk, setStarters],
  );
  return <AskContext.Provider value={value}>{children}</AskContext.Provider>;
}

export function useAsk(): AskState {
  const ctx = useContext(AskContext);
  if (!ctx) {
    return {
      enabled: false,
      open: false,
      draft: "",
      starters: [],
      openAsk: () => {},
      closeAsk: () => {},
      setStarters: () => {},
    };
  }
  return ctx;
}

/** Rendered by a page to offer its own questions as the panel's starters. */
export function AskStarters({ questions }: { questions: string[] }) {
  const { setStarters } = useAsk();
  const key = questions.join("\n");
  useEffect(() => {
    setStarters(key ? key.split("\n") : []);
    return () => setStarters([]);
  }, [key, setStarters]);
  return null;
}
