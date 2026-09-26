"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { ArrowUp, MessageCircleQuestion, RotateCcw, ThumbsDown, ThumbsUp, X } from "lucide-react";
import manifest from "@/lib/docs/generated/ask-manifest.json";
import { createMatcher, expandIndex, type AskIndex, type AskWire, type Confidence, type Matcher } from "@/lib/docs/ask/match";
import { cn } from "@/lib/utils";
import { useAsk } from "./ask-context";
import { MarkdownLite } from "./markdown-lite";

const SUPPORT_EMAIL = "info@modern-hospitality-solutions.com";
const STORE_KEY = "maya-docs-ask-v2";

// The index is fetched the first time the panel opens, then kept for the visit.
let loading: Promise<{ index: AskIndex; matcher: Matcher }> | null = null;
function loadMatcher() {
  if (!loading) {
    loading = fetch(manifest.file)
      .then((r) => {
        if (!r.ok) throw new Error(`docs index ${r.status}`);
        return r.json() as Promise<AskWire>;
      })
      .then((wire) => {
        const index: AskIndex = expandIndex(wire);
        return { index, matcher: createMatcher(index) };
      })
      .catch((err) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}

interface Hit {
  entry: number;
  page: number;
}

interface Turn {
  id: number;
  question: string;
  confidence: Confidence;
  answer: Hit | null;
  also: Hit[];
  helpful?: "yes" | "no";
  note?: string;
  sent?: "sending" | SendResult;
}

// A saved turn points at passages by their place in the index, so it only
// holds for the index it was asked against. The index file is named after its
// contents: after a docs deploy the name differs and the conversation starts over.
function readStore(): Turn[] {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { file?: string; turns?: Turn[] }) : null;
    return parsed?.file === manifest.file && Array.isArray(parsed.turns) ? parsed.turns.slice(-30) : [];
  } catch {
    return [];
  }
}

function writeStore(turns: Turn[]) {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify({ file: manifest.file, turns: turns.slice(-30) }));
  } catch {
    // storage blocked: the conversation lasts as long as the panel
  }
}

/**
 * "limited": this reader sent a lot. "busy": everybody together used up the
 * hour, which is nothing this reader did, so the note must not say it was.
 */
export type SendResult = "sent" | "error" | "limited" | "busy";

export async function send(body: Record<string, unknown>): Promise<SendResult> {
  try {
    const res = await fetch("/api/docs-ask/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      const said = (await res.json().catch(() => null)) as { limited?: string } | null;
      return said?.limited === "everyone" ? "busy" : "limited";
    }
    return res.ok ? "sent" : "error";
  } catch {
    return "error";
  }
}

function mailto(question: string) {
  const body = question ? `My question: ${question}\n\n` : "";
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Docs question")}${body ? `&body=${encodeURIComponent(body)}` : ""}`;
}

/** The hit still names a passage on that page, so it is safe to show and link to. */
function valid(index: AskIndex, hit: Hit) {
  const e = index.entries[hit.entry];
  return !!e && e.p === hit.page && !!index.pages[hit.page];
}

function linkFor(index: AskIndex, hit: Hit) {
  const e = index.entries[hit.entry];
  const p = index.pages[hit.page];
  return { href: e.a ? `${p.u}#${e.a}` : p.u, page: p.t, section: e.a ? e.h : null };
}

const SENT_NOTES: Record<SendResult, string> = {
  sent: "Sent. Thank you.",
  limited: "Too many sends from here for now. Email us instead.",
  busy: "We can't take questions right now. Email us instead.",
  error: "That did not send. Email us instead.",
};

export function SentNote({ state }: { state?: "sending" | SendResult }) {
  if (!state || state === "sending") return null;
  return (
    <p className="text-sm text-muted-foreground" role="status">
      {SENT_NOTES[state]}
    </p>
  );
}

function NotCovered({ turn, onSend }: { turn: Turn; onSend: () => void }) {
  return (
    <div className="space-y-3 rounded-xl border border-dashed border-border p-3.5">
      <p className="text-[0.9375rem] font-medium text-foreground">The docs don&apos;t cover that yet.</p>
      <p className="text-sm text-muted-foreground">
        Send your question and we&apos;ll write the missing page. It carries no name or email address, so we can&apos;t reply to it. For an answer, email us.
      </p>
      {turn.sent && turn.sent !== "sending" ? (
        <SentNote state={turn.sent} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onSend}
            disabled={turn.sent === "sending"}
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
          >
            Send
          </button>
          <a
            href={mailto(turn.question)}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Email us
          </a>
        </div>
      )}
    </div>
  );
}

/** Under a passage the matcher was unsure of: the passage may still be the answer, so only a light offer to send the question. */
function NotQuiteIt({ turn, onSend }: { turn: Turn; onSend: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
      {turn.sent && turn.sent !== "sending" ? (
        <SentNote state={turn.sent} />
      ) : (
        <>
          <span>Not quite it? Send us your question.</span>
          <button
            type="button"
            onClick={onSend}
            disabled={turn.sent === "sending"}
            className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
          >
            Send
          </button>
        </>
      )}
    </div>
  );
}

export function AskPanel() {
  const { open, closeAsk, draft, starters, enabled } = useAsk();
  const pathname = usePathname();
  // The conversation lives in this tab's session storage. The panel only
  // renders once opened, so reading it here never differs from the server.
  const [turns, setTurns] = useState<Turn[]>(readStore);
  const [text, setText] = useState("");
  const [ready, setReady] = useState<{ index: AskIndex; matcher: Matcher } | null>(null);
  const [failed, setFailed] = useState(false);
  const [wasOpen, setWasOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);

  // Just opened: take any question handed over (from search, say) and retry a failed load.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      if (draft) setText(draft);
      setFailed(false);
    }
  }

  useEffect(() => {
    if (!open || ready || failed) return;
    let cancelled = false;
    loadMatcher()
      .then((r) => !cancelled && setReady(r))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [open, ready, failed]);

  const update = useCallback((id: number, patch: Partial<Turn>) => {
    setTurns((all) => {
      const next = all.map((t) => (t.id === id ? { ...t, ...patch } : t));
      writeStore(next);
      return next;
    });
  }, []);

  useEffect(() => {
    logRef.current?.lastElementChild?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [turns.length]);

  function ask(question: string) {
    const q = question.trim().slice(0, 500);
    if (!q || !ready) return;
    const { index, matcher } = ready;
    const last = [...turns].reverse().find((t) => t.answer && valid(index, t.answer));
    const current = index.pages.findIndex((p) => p.u === pathname);
    const r = matcher.ask(q, {
      lastPage: last?.answer?.page ?? null,
      lastQuestion: last?.question ?? null,
      currentPage: current >= 0 ? current : null,
    });
    if (!nextId.current) nextId.current = turns.reduce((n, t) => Math.max(n, t.id), 0) + 1;
    const turn: Turn = {
      id: nextId.current++,
      question: q,
      confidence: r.confidence,
      answer: r.answer ? { entry: r.answer.entry, page: r.answer.page } : null,
      also: r.alsoSee.map((h) => ({ entry: h.entry, page: h.page })),
    };
    setTurns((all) => {
      const next = [...all, turn];
      writeStore(next);
      return next;
    });
    setText("");
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    ask(text);
  }

  function sectionsShown(turn: Turn) {
    if (!ready) return "";
    return [turn.answer, ...turn.also]
      .filter((h): h is Hit => !!h && valid(ready.index, h))
      .map((h) => linkFor(ready.index, h).href)
      .join(", ");
  }

  async function sendUnanswered(turn: Turn) {
    update(turn.id, { sent: "sending" });
    const state = await send({ source: "unanswered", question: turn.question, page: pathname, sectionsShown: sectionsShown(turn) });
    update(turn.id, { sent: state });
  }

  async function sendNotHelpful(turn: Turn) {
    update(turn.id, { sent: "sending" });
    const state = await send({
      source: "not-helpful",
      question: turn.question,
      page: pathname,
      sectionsShown: sectionsShown(turn),
      note: turn.note ?? "",
    });
    update(turn.id, { sent: state });
  }

  function clear() {
    setTurns([]);
    writeStore([]);
    inputRef.current?.focus();
  }

  if (!enabled) return null;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o ? undefined : closeAsk())}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[60] bg-black/30 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 sm:bg-black/10" />
        <Dialog.Popup
          initialFocus={inputRef}
          className="fixed inset-0 z-[61] flex flex-col bg-background shadow-2xl transition-[opacity,transform] duration-200 outline-none data-[ending-style]:translate-y-2 data-[ending-style]:opacity-0 data-[starting-style]:translate-y-2 data-[starting-style]:opacity-0 motion-reduce:transition-none sm:inset-auto sm:right-5 sm:bottom-5 sm:h-[min(42rem,calc(100dvh-2.5rem))] sm:w-[25rem] sm:rounded-2xl sm:border sm:border-border"
        >
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-foreground">
              <MessageCircleQuestion className="size-5 text-primary" aria-hidden />
              Ask MAYA docs
            </Dialog.Title>
            <div className="flex items-center gap-1">
              {turns.length ? (
                <button
                  type="button"
                  onClick={clear}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <RotateCcw className="size-3.5" aria-hidden /> Start over
                </button>
              ) : null}
              <Dialog.Close
                aria-label="Close"
                className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <X className="size-4" aria-hidden />
              </Dialog.Close>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            <Dialog.Description className="text-sm leading-relaxed text-muted-foreground">
              Ask anything about MAYA. Every answer comes straight from these docs, with a link to the page it lives on. Nothing you type
              leaves your browser unless you choose to send it to us. Never type guest names, card numbers or passwords.
            </Dialog.Description>

            {!turns.length ? (
              <div className="mt-5">
                <p className="mb-2 text-xs font-semibold tracking-widest text-muted-foreground uppercase">Try one of these</p>
                <ul className="flex flex-col gap-2">
                  {starters.slice(0, 6).map((s) => (
                    <li key={s}>
                      <button
                        type="button"
                        onClick={() => ask(s)}
                        disabled={!ready}
                        className="w-full rounded-xl border border-border px-3 py-2 text-left text-sm text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
                      >
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div ref={logRef} aria-live="polite" className="mt-5 space-y-6">
              {ready
                ? turns.map((turn) => {
                    const { index } = ready;
                    const answer = turn.answer && valid(index, turn.answer) ? turn.answer : null;
                    const link = answer ? linkFor(index, answer) : null;
                    const also = turn.also.filter((h) => valid(index, h));
                    return (
                      <article key={turn.id} className="space-y-3 scroll-mt-4" aria-label={`Answer to: ${turn.question}`}>
                        <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-primary/10 px-3.5 py-2 text-sm text-foreground">
                          {turn.question}
                        </p>
                        {answer && link ? (
                          <div className="space-y-3">
                            {turn.confidence === "unsure" ? (
                              <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">This might help</p>
                            ) : null}
                            <div className="rounded-2xl rounded-bl-md border border-border bg-card/60 px-3.5 py-3">
                              <MarkdownLite text={index.entries[answer.entry].x} pageUrl={index.pages[answer.page].u} onNavigate={closeAsk} />
                              <p className="mt-3 border-t border-border pt-2.5 text-xs text-muted-foreground">
                                {index.entries[answer.entry].m ? "More in:" : "From:"}{" "}
                                <Link href={link.href} onClick={closeAsk} className="font-medium text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary">
                                  {link.page}
                                  {link.section ? ` › ${link.section}` : ""}
                                </Link>
                              </p>
                            </div>
                            {also.length ? (
                              <div>
                                <p className="mb-1 text-xs font-semibold text-muted-foreground">Also see</p>
                                <ul className="space-y-1">
                                  {also.map((h) => {
                                    const l = linkFor(index, h);
                                    return (
                                      <li key={`${h.page}-${h.entry}`}>
                                        <Link href={l.href} onClick={closeAsk} className="text-sm text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary">
                                          {l.page}
                                          {l.section ? ` › ${l.section}` : ""}
                                        </Link>
                                      </li>
                                    );
                                  })}
                                </ul>
                              </div>
                            ) : null}
                            {turn.confidence === "high" ? (
                              <div className="space-y-2">
                                {turn.helpful === undefined ? (
                                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                    <span>Did this help?</span>
                                    <button
                                      type="button"
                                      onClick={() => update(turn.id, { helpful: "yes" })}
                                      className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                                    >
                                      <ThumbsUp className="size-3.5" aria-hidden /> Yes
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => update(turn.id, { helpful: "no" })}
                                      className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                                    >
                                      <ThumbsDown className="size-3.5" aria-hidden /> No
                                    </button>
                                  </div>
                                ) : turn.helpful === "yes" ? (
                                  <p className="text-sm text-muted-foreground">Glad it helped.</p>
                                ) : turn.sent && turn.sent !== "sending" ? (
                                  <SentNote state={turn.sent} />
                                ) : (
                                  <form
                                    className="space-y-2"
                                    onSubmit={(e) => {
                                      e.preventDefault();
                                      sendNotHelpful(turn);
                                    }}
                                  >
                                    <label htmlFor={`note-${turn.id}`} className="block text-sm text-muted-foreground">
                                      Tell us what you were looking for (optional)
                                    </label>
                                    <div className="flex gap-2">
                                      <input
                                        id={`note-${turn.id}`}
                                        value={turn.note ?? ""}
                                        maxLength={500}
                                        onChange={(e) => update(turn.id, { note: e.target.value })}
                                        className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                                      />
                                      <button
                                        type="submit"
                                        disabled={turn.sent === "sending"}
                                        className="rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
                                      >
                                        Send
                                      </button>
                                    </div>
                                  </form>
                                )}
                              </div>
                            ) : (
                              <NotQuiteIt turn={turn} onSend={() => sendUnanswered(turn)} />
                            )}
                          </div>
                        ) : (
                          <NotCovered turn={turn} onSend={() => sendUnanswered(turn)} />
                        )}
                      </article>
                    );
                  })
                : null}
            </div>
            {!ready && !failed && open ? <p className="mt-5 text-sm text-muted-foreground">Getting the docs ready…</p> : null}
            {failed ? (
              <p className="mt-5 text-sm text-muted-foreground" role="alert">
                The docs helper could not load. Check your connection and open it again, or{" "}
                <a href={mailto("")} className="text-primary underline underline-offset-4">
                  email us
                </a>
                .
              </p>
            ) : null}
          </div>

          <form onSubmit={onSubmit} className="border-t border-border p-3">
            <label htmlFor="ask-input" className="sr-only">
              Your question
            </label>
            <div className="flex items-end gap-2 rounded-xl border border-input bg-background px-3 py-2 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
              <textarea
                id="ask-input"
                ref={inputRef}
                rows={1}
                value={text}
                maxLength={500}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    ask(text);
                  }
                }}
                placeholder="Ask a question"
                className="max-h-32 min-h-6 flex-1 resize-none bg-transparent text-[0.9375rem] outline-none placeholder:text-muted-foreground/70"
              />
              <button
                type="submit"
                aria-label="Ask"
                disabled={!ready || !text.trim()}
                className={cn(
                  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-opacity focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  (!ready || !text.trim()) && "opacity-40"
                )}
              >
                <ArrowUp className="size-4" aria-hidden />
              </button>
            </div>
            <p className="mt-2 text-center text-[0.7rem] text-muted-foreground">
              Answers are passages from these pages. <Link href="/docs/help/about-these-docs" onClick={closeAsk} className="underline underline-offset-2">How it works</Link>
            </p>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The floating button. On docs pages phones use "Ask" in the top bar instead, unless `always`. */
export function AskButton({ always = false }: { always?: boolean }) {
  const { enabled, openAsk, open } = useAsk();
  if (!enabled) return null;
  return (
    <button
      type="button"
      onClick={() => openAsk()}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-print-hide
      className={cn(
        "fixed right-4 bottom-4 z-50 items-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-black/20 transition-[transform,opacity] hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/50 sm:right-5 sm:bottom-5",
        always ? "inline-flex" : "hidden lg:inline-flex",
        open && "pointer-events-none opacity-0"
      )}
    >
      <MessageCircleQuestion className="size-5" aria-hidden />
      Ask MAYA docs
    </button>
  );
}
