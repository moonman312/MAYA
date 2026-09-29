"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { HOVER_BRIDGE, LearnMore } from "@/components/deep-links/help-links";
import type { HelpPanel } from "@/lib/deep-links";

/**
 * Room types, as the property wants them counted.
 *
 * Two things live here, both about what "a room" means to the numbers:
 *   - counts as a room: a meeting room or a court that the PMS lists as a room
 *     type still gets priced, but it is out of occupancy, RevPAR and the bill.
 *   - rooms out of service: a renovation or a flood takes units off sale for a
 *     stretch; those come off the sellable count for those nights only.
 *
 * Both are honest to the engine the moment they are saved: the API re-prices
 * behind the response. The words on screen stay short; the why lives behind
 * the "?".
 */

export type RoomTypeOption = {
  id: string;
  name: string;
  total_rooms: number;
  counts_as_room: boolean | null;
};

export type OutOfServiceBlock = {
  id: string;
  room_type_id: string;
  start_date: string;
  end_date: string;
  units: number;
  reason: string | null;
};

/** A type counts unless someone (or the import heuristic) said it doesn't. */
export function isCountingRoom(rt: { counts_as_room?: boolean | null }): boolean {
  return rt.counts_as_room !== false;
}

/**
 * Nobody has said whether guests sleep here: the flag is still null. Every
 * sync marks a name that reads as a bedroom as a room, so what is left is a
 * name that doesn't, and the bill leaves it out until someone ticks it. The
 * settings list and the review's room count strip show it unticked with a
 * "needs your answer" tag, so the box says what the bill does and the
 * shortfall email's "tick it" works.
 */
export function needsAnswer(rt: { counts_as_room?: boolean | null }): boolean {
  return rt.counts_as_room == null;
}

/** The strip's question, with the count as the owner will read it. */
export function roomCountQuestion(counting: number): string {
  return `We're counting ${counting} room type${counting === 1 ? "" : "s"} as rooms. Anything here that isn't?`;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

/** PATCH the flag; resolves to an error message, or null when it saved. */
export async function saveCountsAsRoom(
  hotelId: string,
  roomTypeId: string,
  countsAsRoom: boolean,
): Promise<string | null> {
  try {
    const res = await fetch("/api/room-types", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hotelId, roomTypeId, countsAsRoom }),
    });
    if (!res.ok) return readError(res, "That didn't save. Try again.");
    return null;
  } catch {
    return "That didn't save. Try again.";
  }
}

/* ── The "?" ─────────────────────────────────────────────────────────────── */

/**
 * Same hover-and-click "?" the manual price editor and the team tab use. Kept
 * here because two surfaces share the exact same explanation.
 */
export function RoomCountHelp({
  label,
  title,
  lines,
  docs,
}: {
  label: string;
  title: string;
  lines: string[];
  /** The docs passage its "Learn more" opens; without one the panel is words only. */
  docs?: HelpPanel;
}) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();
  const open = pinned || hovered;

  // The panel is centred under the "?". On a phone a "?" near the edge would
  // push it off the screen, so it slides back in, 8px from the edge.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!open || !el) return;
    const r = el.getBoundingClientRect();
    const w = document.documentElement.clientWidth;
    if (w === 0 || r.width === 0) return;
    const shift = r.right > w - 8 ? w - 8 - r.right : r.left < 8 ? 8 - r.left : 0;
    if (shift !== 0) el.style.translate = `${Math.round(shift)}px 0`;
  }, [open]);

  useEffect(() => {
    if (!pinned) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPinned(false);
    }
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setPinned(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [pinned]);

  // Tabbing from the "?" to its Learn more keeps the panel open; leaving the
  // two of them closes it.
  const blurOut = (e: React.FocusEvent) => {
    if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) setHovered(false);
  };

  return (
    <span
      ref={wrapRef}
      className="relative inline-flex"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? panelId : undefined}
        onClick={() => setPinned((p) => !p)}
        onFocus={() => setHovered(true)}
        onBlur={blurOut}
        className="flex size-4 cursor-pointer items-center justify-center rounded-full border border-slate-600 text-[10px] font-semibold leading-none text-slate-400 transition-colors hover:border-slate-400 hover:text-slate-200 focus-visible:border-sky-400 focus-visible:text-sky-200 focus-visible:outline-none"
      >
        ?
      </button>
      {open && (
        // The see-through top padding fills the space between the "?" and the
        // panel, so the pointer stays inside while it moves down to Learn more.
        <span className={HOVER_BRIDGE}>
          <span
            ref={panelRef}
            id={panelId}
            // A panel holding a link is a labelled group; a tooltip must hold nothing interactive.
            role={docs ? "group" : "tooltip"}
            aria-label={docs ? title : undefined}
            className="block w-72 rounded-lg border border-slate-700 bg-slate-950 p-3 text-left shadow-xl"
          >
            <span className="block text-xs font-semibold text-slate-200">{title}</span>
            <span className="mt-2 block space-y-1.5 text-xs leading-snug text-slate-400">
              {lines.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </span>
            {docs ? <LearnMore panel={docs} onBlurOut={blurOut} /> : null}
          </span>
        </span>
      )}
    </span>
  );
}

export const COUNTS_AS_ROOM_HELP = {
  label: "What counting as a room changes",
  title: "What counts as a room",
  lines: [
    "Ticked types are what MAYA divides by: sellable occupancy, RevPAR, and the room count you're billed for.",
    "Untick anything nobody sleeps in, like a meeting room, a spa slot or a court. It still gets priced if you want it to.",
    "You can change this any time from the PMS tab.",
  ],
};

/** For the lists that carry the "needs your answer" tag: the settings list and the review strip. */
export const ROOM_TYPES_HELP = {
  ...COUNTS_AS_ROOM_HELP,
  lines: [
    ...COUNTS_AS_ROOM_HELP.lines,
    'A type tagged "needs your answer" is one nobody has ticked or unticked yet. Until you answer, it counts in occupancy but not in your bill.',
  ],
};

const OUT_OF_SERVICE_HELP = {
  label: "What rooms out of service changes",
  title: "Rooms out of service",
  lines: [
    "Units you take off sale for a stretch (a renovation, a repair) come off the sellable count for those nights only.",
    "Occupancy then reads against what you can actually sell, so occupancy rules don't under-fire.",
    "Nothing is sent to your property system.",
  ],
};

/* ── The settings surface ────────────────────────────────────────────────── */

export function RoomTypeSettings({
  hotelId,
  onChanged,
}: {
  hotelId: string;
  /** Called after any save so the rest of the dashboard can refresh its room-type list. */
  onChanged?: () => void;
}) {
  const [types, setTypes] = useState<RoomTypeOption[] | null>(null);
  const [blocks, setBlocks] = useState<OutOfServiceBlock[] | null>(null);
  const [blocksNote, setBlocksNote] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [typesRes, blocksRes] = await Promise.all([
        fetch("/api/room-types"),
        fetch(`/api/room-types/out-of-service?hotelId=${encodeURIComponent(hotelId)}`),
      ]);
      if (!typesRes.ok) {
        setLoadFailed(true);
        return;
      }
      setTypes((await typesRes.json()) as RoomTypeOption[]);
      setLoadFailed(false);
      if (blocksRes.ok) {
        const body = (await blocksRes.json()) as { blocks: OutOfServiceBlock[] };
        setBlocks(body.blocks ?? []);
        setBlocksNote(null);
      } else {
        // 503 is "the database isn't there yet"; the list simply isn't offered.
        setBlocks([]);
        setBlocksNote(await readError(blocksRes, "Rooms out of service isn't available right now."));
      }
    } catch {
      setLoadFailed(true);
    }
  }, [hotelId]);

  useEffect(() => {
    setTypes(null);
    setBlocks(null);
    void load();
  }, [load]);

  async function toggle(rt: RoomTypeOption, next: boolean) {
    setError(null);
    setBusyId(rt.id);
    const before = rt.counts_as_room;
    setTypes((prev) => prev?.map((t) => (t.id === rt.id ? { ...t, counts_as_room: next } : t)) ?? prev);
    const failure = await saveCountsAsRoom(hotelId, rt.id, next);
    if (failure) {
      setTypes((prev) => prev?.map((t) => (t.id === rt.id ? { ...t, counts_as_room: before } : t)) ?? prev);
      setError(failure);
    } else {
      onChanged?.();
    }
    setBusyId(null);
  }

  async function addBlock(input: {
    roomTypeId: string;
    startDate: string;
    endDate: string;
    units: string;
    reason: string;
  }): Promise<string | null> {
    setError(null);
    try {
      const res = await fetch("/api/room-types/out-of-service", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hotelId,
          roomTypeId: input.roomTypeId,
          startDate: input.startDate,
          endDate: input.endDate,
          units: input.units,
          reason: input.reason || undefined,
        }),
      });
      if (!res.ok) return readError(res, "That didn't save. Try again.");
      await load();
      onChanged?.();
      return null;
    } catch {
      return "That didn't save. Try again.";
    }
  }

  async function clearBlock(id: string) {
    setError(null);
    setBusyId(id);
    try {
      const res = await fetch("/api/room-types/out-of-service", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hotelId, id }),
      });
      if (!res.ok) {
        setError(await readError(res, "That didn't clear. Try again."));
        return;
      }
      setBlocks((prev) => prev?.filter((b) => b.id !== id) ?? prev);
      onChanged?.();
    } catch {
      setError("That didn't clear. Try again.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section data-deeplink="pms.room-types" className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">Room types</h2>
        <RoomCountHelp {...ROOM_TYPES_HELP} docs="counts-as-room" />
      </div>

      {loadFailed ? (
        <div role="alert" className="rounded border border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-100">
          Couldn&apos;t load room types.{" "}
          <button
            type="button"
            onClick={() => {
              setLoadFailed(false);
              void load();
            }}
            className="cursor-pointer underline hover:text-white"
          >
            Try again
          </button>
        </div>
      ) : types === null ? (
        <div className="h-24 animate-pulse rounded bg-slate-950" />
      ) : types.length === 0 ? (
        <p className="text-sm text-slate-400">No room types have synced yet.</p>
      ) : (
        <div className="divide-y divide-slate-800 rounded border border-slate-800 bg-slate-950">
          {types.map((rt) => (
            <RoomTypeRow
              key={rt.id}
              rt={rt}
              blocks={(blocks ?? []).filter((b) => b.room_type_id === rt.id)}
              blocksAvailable={blocksNote === null}
              busy={busyId === rt.id}
              busyBlockId={busyId}
              onToggle={(next) => toggle(rt, next)}
              onAdd={(input) => addBlock({ roomTypeId: rt.id, ...input })}
              onClear={clearBlock}
            />
          ))}
        </div>
      )}

      {blocksNote ? (
        <p className="text-xs text-slate-500">Rooms out of service: {blocksNote}</p>
      ) : null}
      {error ? (
        <p className="rounded border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">{error}</p>
      ) : null}
    </section>
  );
}

function RoomTypeRow({
  rt,
  blocks,
  blocksAvailable,
  busy,
  busyBlockId,
  onToggle,
  onAdd,
  onClear,
}: {
  rt: RoomTypeOption;
  blocks: OutOfServiceBlock[];
  blocksAvailable: boolean;
  busy: boolean;
  busyBlockId: string | null;
  onToggle: (next: boolean) => void;
  onAdd: (input: { startDate: string; endDate: string; units: string; reason: string }) => Promise<string | null>;
  onClear: (id: string) => void;
}) {
  // Ticked only on a yes. An unanswered type is out of the bill, so it shows
  // unticked, and ticking it is the answer that brings it in.
  const unanswered = needsAnswer(rt);
  const counting = rt.counts_as_room === true;
  const [adding, setAdding] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [units, setUnits] = useState("1");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    const failure = await onAdd({ startDate, endDate: endDate || startDate, units, reason: reason.trim() });
    setSaving(false);
    if (failure) {
      setFormError(failure);
      return;
    }
    setAdding(false);
    setStartDate("");
    setEndDate("");
    setUnits("1");
    setReason("");
  }

  return (
    <div className="space-y-2 px-4 py-3" data-deeplink={`pms.room-type:${rt.id}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <span className={`text-sm font-medium ${counting ? "text-slate-200" : "text-slate-400"}`}>{rt.name}</span>
          <span className="ml-2 text-xs text-slate-500">
            {rt.total_rooms} unit{rt.total_rooms === 1 ? "" : "s"}
          </span>
          {unanswered ? (
            <span className="ml-2 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">
              needs your answer
            </span>
          ) : !counting ? (
            <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
              not a room
            </span>
          ) : null}
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            className="rounded border-slate-600"
            checked={counting}
            disabled={busy}
            onChange={(e) => onToggle(e.target.checked)}
            aria-label={`${rt.name} counts as a room`}
          />
          Counts as a room
        </label>
      </div>

      {blocksAvailable ? (
        <div className="space-y-1.5 pl-1">
          {blocks.map((b) => (
            <div key={b.id} className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span className="text-slate-300">
                {b.units} out of service
              </span>
              <span>
                {b.start_date} → {b.end_date}
              </span>
              {b.reason ? <span className="text-slate-500">· {b.reason}</span> : null}
              <button
                type="button"
                disabled={busyBlockId === b.id}
                onClick={() => onClear(b.id)}
                className="cursor-pointer text-slate-500 underline-offset-2 hover:text-slate-200 hover:underline disabled:opacity-60"
              >
                Clear
              </button>
            </div>
          ))}

          {adding ? (
            <form onSubmit={submit} className="flex flex-wrap items-end gap-2 pt-1">
              <label className="flex flex-col text-[11px] text-slate-500">
                From
                <input
                  type="date"
                  required
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="rounded border border-slate-700 bg-slate-900 p-1.5 text-xs text-slate-200"
                />
              </label>
              <label className="flex flex-col text-[11px] text-slate-500">
                To
                <input
                  type="date"
                  value={endDate}
                  min={startDate || undefined}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="rounded border border-slate-700 bg-slate-900 p-1.5 text-xs text-slate-200"
                />
              </label>
              <label className="flex flex-col text-[11px] text-slate-500">
                Units
                <input
                  type="number"
                  required
                  min={1}
                  max={rt.total_rooms}
                  step={1}
                  value={units}
                  onChange={(e) => setUnits(e.target.value)}
                  className="w-16 rounded border border-slate-700 bg-slate-900 p-1.5 text-xs text-slate-200"
                />
              </label>
              <label className="flex min-w-32 flex-1 flex-col text-[11px] text-slate-500">
                Reason (optional)
                <input
                  type="text"
                  maxLength={200}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Renovation"
                  className="rounded border border-slate-700 bg-slate-900 p-1.5 text-xs text-slate-200"
                />
              </label>
              <button
                type="submit"
                disabled={saving}
                className="cursor-pointer rounded bg-sky-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-60"
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setFormError(null);
                }}
                className="cursor-pointer rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500"
              >
                Cancel
              </button>
              {formError ? <p className="basis-full text-xs text-rose-300">{formError}</p> : null}
            </form>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="cursor-pointer text-xs text-slate-500 hover:text-slate-200"
              >
                + Rooms out of service
              </button>
              <RoomCountHelp {...OUT_OF_SERVICE_HELP} docs="out-of-service" />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
