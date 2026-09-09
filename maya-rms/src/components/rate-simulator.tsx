"use client";

import { BOOKING_SPEED_LEVELS } from "@/lib/observations/booking-speed";
import {
  conditionRowsToRuleCondition,
  isRuleConditionEmpty,
  newConditionRow,
  ruleConditionForInsert,
  ruleConditionToLegacyConditions,
  type ConditionFormRow,
  type ConditionMetric,
} from "@/lib/rule-form";
import {
  hotelToday,
  isIsoDate,
  isoDatePlus,
  simulate,
  SIM_SKIP_LABEL,
  type SimRoomInput,
  type SimRoomType,
} from "@/lib/simulator";
import type { EngineRule, RuleAction } from "@/types/domain";
import { useEffect, useMemo, useState } from "react";

/**
 * Rate Simulator — try a rule on a night that hasn't happened yet.
 *
 * Everything here is a what-if: nothing it computes is written anywhere and no
 * rate leaves the browser. The one action with a side effect is "Save This
 * Rule", which adds the rule you built here to the Rules tab SWITCHED OFF, so
 * it still takes a deliberate toggle before it can move a real price.
 *
 * The arithmetic is the engine's own — see src/lib/simulator.ts, which imports
 * the same pure functions the scheduled run imports rather than approximating
 * them.
 */

const DRAFT_ID = "~draft";

/** A room type plus the starting price /api/room-types?withRate=1 suggests. */
type SeededRoomType = SimRoomType & { seed_rate?: number };

type ActionKindUi = "percent" | "fixed";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

const inputClass = "w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm";
const microLabel = "mb-0.5 block text-[11px] text-slate-500";

export function RateSimulator({
  activeHotelId,
  onRuleSaved,
}: {
  activeHotelId: string | null;
  onRuleSaved?: () => void;
}) {
  const [roomTypes, setRoomTypes] = useState<SeededRoomType[]>([]);
  const [hotelTimeZone, setHotelTimeZone] = useState("UTC");
  const [rules, setRules] = useState<EngineRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [stayDate, setStayDate] = useState(() => isoDatePlus(30));
  const [bookingSpeedLevel, setBookingSpeedLevel] = useState<string>("");
  const [inputs, setInputs] = useState<Record<string, SimRoomInput>>({});
  const [selectedRuleIds, setSelectedRuleIds] = useState<Set<string>>(new Set());

  // Draft rule — lives only in this tab until "Save This Rule" is pressed.
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftRows, setDraftRows] = useState<ConditionFormRow[]>(() => [newConditionRow("occupancy")]);
  const [draftKind, setDraftKind] = useState<ActionKindUi>("percent");
  const [draftDirection, setDraftDirection] = useState<"increase" | "decrease">("increase");
  const [draftAmount, setDraftAmount] = useState("10");
  const [draftRoomTypeIds, setDraftRoomTypeIds] = useState<string[]>([]);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        const [seeded, engineRules] = await Promise.all([
          api<{ timezone: string; roomTypes: SeededRoomType[] }>("/api/room-types?withRate=1"),
          api<EngineRule[]>("/api/rules/engine"),
        ]);
        if (cancelled) return;
        const rts = seeded.roomTypes ?? [];
        setRoomTypes(rts);
        setHotelTimeZone(seeded.timezone || "UTC");
        setRules(engineRules);
        // Open on the property's own nearest published rate. It is a real
        // number the owner recognizes, and it is the one thing that makes the
        // first render worth reading before anyone touches a field.
        setInputs(
          Object.fromEntries(
            rts.map((rt) => [
              rt.id,
              { basePrice: Math.round(rt.seed_rate ?? 0), occupancyPct: 70, pickupUnits: 0 },
            ]),
          ),
        );
        setSelectedRuleIds(new Set(engineRules.map((r) => r.id)));
        setDraftRoomTypeIds(rts.map((rt) => rt.id));
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Could not load this property.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [activeHotelId]);

  const draftRule = useMemo<EngineRule | null>(() => {
    if (!draftOpen) return null;
    const condition = ruleConditionForInsert(conditionRowsToRuleCondition(draftRows));
    if (isRuleConditionEmpty(condition)) return null;
    const amount = Number(draftAmount);
    if (!Number.isFinite(amount) || amount < 0) return null;
    if (draftRoomTypeIds.length === 0) return null;
    return {
      // Sorts after any UUID, so the draft composes last among ladder effects —
      // predictable, and it keeps the saved rules' order stable while you edit.
      id: DRAFT_ID,
      hotel_id: activeHotelId ?? "",
      name: draftName.trim() || "Unsaved test rule",
      is_active: true,
      version: 1,
      start_date: null,
      end_date: null,
      is_annual: false,
      dow_mask: 127,
      action_type: draftKind,
      action_direction: draftDirection,
      action_value: amount,
      priority: 100,
      // Must match how createRule decides this, or a rule would behave one way
      // here and the other way once saved.
      is_pickup_rule: !!condition.pickup_operator || !!condition.booking_speed_operator,
      condition,
      signal_room_type_ids: draftRoomTypeIds,
      affected_room_type_ids: draftRoomTypeIds,
      created_at: "",
      updated_at: "",
    };
  }, [
    draftOpen,
    draftRows,
    draftAmount,
    draftKind,
    draftDirection,
    draftName,
    draftRoomTypeIds,
    activeHotelId,
  ]);

  const dateValid = isIsoDate(stayDate);

  const results = useMemo(() => {
    const chosen = rules.filter((r) => selectedRuleIds.has(r.id));
    const all = draftRule ? [...chosen, draftRule] : chosen;
    return simulate(all, roomTypes, {
      stayDate,
      // The hotel's calendar date, not the viewer's. Days-to-arrival is measured
      // from it, and for a US property the two differ every evening — a "book
      // within 7 days" rule would preview as firing on a night the real run
      // scores at 8 days out.
      evalDate: hotelToday(hotelTimeZone),
      hotelTimeZone,
      rooms: inputs,
      bookingSpeedLevel: bookingSpeedLevel === "" ? null : bookingSpeedLevel,
      bookingSpeedWindowDays: 7,
    });
  }, [rules, selectedRuleIds, draftRule, roomTypes, stayDate, inputs, bookingSpeedLevel, hotelTimeZone]);

  const firedIds = useMemo(() => {
    const s = new Set<string>();
    for (const row of results) {
      for (const o of row.outcomes) if (o.fired) s.add(o.ruleId);
    }
    return s;
  }, [results]);

  function setRoomInput(id: string, patch: Partial<SimRoomInput>) {
    setInputs((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? { basePrice: 0, occupancyPct: 0, pickupUnits: 0 }), ...patch },
    }));
  }

  function toggleRule(id: string) {
    setSelectedRuleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function updateDraftRow(id: string, patch: Partial<ConditionFormRow>) {
    setDraftRows((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function saveDraftRule() {
    if (!draftRule) {
      setDraftError("Give the rule a condition, an amount, and at least one room type first.");
      return;
    }
    setSaving(true);
    setDraftError(null);
    try {
      const amount = Number(draftAmount);
      const signed = draftDirection === "decrease" ? -amount : amount;
      const action: RuleAction =
        draftKind === "percent" ? { adjust_rate_percent: signed } : { adjust_rate_dollars: signed };
      const names = roomTypes.filter((rt) => draftRoomTypeIds.includes(rt.id)).map((rt) => rt.name);

      // The POST answers with the rule it created, id and all. Diffing a
      // re-fetch against a stale list instead would pick up whatever anyone
      // else added in the meantime and check THAT into "Rules in play".
      const created = await api<{ id: string }>("/api/rules", {
        method: "POST",
        body: JSON.stringify({
          rule_name: draftRule.name,
          condition: draftRule.condition,
          conditions: ruleConditionToLegacyConditions(draftRule.condition),
          action,
          room_types: names,
          affected_room_type_ids: draftRoomTypeIds,
          // Off at birth. A rule nobody has approved must never get a window in
          // which a scheduled run could price with it.
          is_active: false,
        }),
      });

      setSavedNotice("Rule Added to Rules Tab and Initialized as Disabled");
      setDraftOpen(false);
      // Clear the form. The button goes back to reading "+ Build a test rule",
      // which promises a blank one — leaving it filled invites pressing Save
      // again and creating a second copy of a rule that is already saved.
      resetDraft();
      onRuleSaved?.();

      // Pull it back in so it shows up here as a real, switched-off rule. The
      // rule IS saved by this point, so a failure here is a refresh problem,
      // not a save problem, and must not read as one.
      try {
        const refreshed = await api<EngineRule[]>("/api/rules/engine");
        setRules(refreshed);
        if (created?.id) setSelectedRuleIds((prev) => new Set(prev).add(String(created.id)));
      } catch {
        setSavedNotice(
          "Rule Added to Rules Tab and Initialized as Disabled — reload to see it listed here.",
        );
      }
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : "Could not save the rule.");
    } finally {
      setSaving(false);
    }
  }

  function resetDraft() {
    setDraftName("");
    setDraftRows([newConditionRow("occupancy")]);
    setDraftKind("percent");
    setDraftDirection("increase");
    setDraftAmount("10");
    setDraftRoomTypeIds(roomTypes.map((rt) => rt.id));
    setDraftError(null);
  }

  if (loading) {
    return (
      <section className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-lg font-semibold">Rate Simulator</h2>
        <p className="text-sm text-slate-400">Loading this property&rsquo;s rooms and rules...</p>
      </section>
    );
  }

  if (loadError) {
    return (
      <section className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-lg font-semibold">Rate Simulator</h2>
        <p className="text-sm text-rose-300">{loadError}</p>
      </section>
    );
  }

  if (roomTypes.length === 0) {
    return (
      <section className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-lg font-semibold">Rate Simulator</h2>
        <p className="text-sm text-slate-400">
          This property has no active room types yet. Connect a PMS and finish the import, then come
          back and try a rule here.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-5 rounded-lg border border-slate-800 bg-slate-900 p-5">
      <div>
        <h2 className="text-lg font-semibold">Rate Simulator</h2>
        <p className="mt-1 max-w-3xl text-xs text-slate-400">
          Make up a night and see what your rules would do to it. Nothing here is saved and no rate
          reaches your PMS. The math is the pricing engine&rsquo;s own, so what you see is what a
          real run would produce for these numbers.
        </p>
      </div>

      {savedNotice && (
        <div className="rounded border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-200">
          {savedNotice}
        </div>
      )}

      {/* ── The night ─────────────────────────────────────────────── */}
      <div className="rounded border border-slate-800 bg-slate-950/60 p-4">
        <h3 className="mb-3 text-sm font-semibold">The night</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label className={microLabel} htmlFor="sim-stay-date">
              Stay date
            </label>
            <input
              id="sim-stay-date"
              type="date"
              value={stayDate}
              onChange={(e) => setStayDate(e.target.value)}
              className={inputClass}
            />
            <p className={`mt-1 text-[11px] ${dateValid ? "text-slate-500" : "text-amber-300"}`}>
              {dateValid
                ? "Sets days to arrival, and decides which date windows and weekdays apply."
                : "Pick a stay date to see what your rules would do."}
            </p>
          </div>
          <div>
            <label className={microLabel} htmlFor="sim-booking-speed">
              Booking speed
            </label>
            <select
              id="sim-booking-speed"
              value={bookingSpeedLevel}
              onChange={(e) => setBookingSpeedLevel(e.target.value)}
              className={inputClass}
            >
              <option value="">Not enough history</option>
              {BOOKING_SPEED_LEVELS.map((l) => (
                <option key={l.key} value={l.key}>
                  {l.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-slate-500">
              Leave on &ldquo;not enough history&rdquo; and booking-speed rules stay quiet, which is
              what the engine does when it can&rsquo;t measure a pace.
            </p>
          </div>
        </div>
      </div>

      {/* ── Room types ────────────────────────────────────────────── */}
      <div className="rounded border border-slate-800 bg-slate-950/60 p-4">
        <h3 className="mb-1 text-sm font-semibold">Your rooms</h3>
        <p className="mb-3 text-[11px] text-slate-500">
          Real room types from this property. Each starts at the nearest rate MAYA has published for
          it — change it to whatever night you want to test.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-left text-slate-300">
                <th className="py-2 pr-3 font-medium">Room type</th>
                <th className="py-2 pr-3 font-medium">Base price</th>
                <th className="py-2 pr-3 font-medium">Occupancy</th>
                <th className="py-2 pr-3 font-medium">Picked up</th>
                <th className="py-2 pr-3 font-medium">Guardrails</th>
              </tr>
            </thead>
            <tbody>
              {roomTypes.map((rt) => {
                const v = inputs[rt.id] ?? { basePrice: 0, occupancyPct: 0, pickupUnits: 0 };
                return (
                  <tr key={rt.id} className="border-b border-slate-800">
                    <td className="py-2 pr-3">
                      <div className="font-medium text-slate-200">{rt.name}</div>
                      <div className="text-[11px] text-slate-500">{rt.total_rooms} rooms</div>
                    </td>
                    <td className="py-2 pr-3">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        aria-label={`Base price for ${rt.name}`}
                        value={v.basePrice}
                        onChange={(e) => setRoomInput(rt.id, { basePrice: Number(e.target.value) })}
                        className="w-28 rounded border border-slate-700 bg-slate-950 p-2 text-sm tabular-nums"
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          aria-label={`Occupancy for ${rt.name}`}
                          value={v.occupancyPct}
                          onChange={(e) =>
                            setRoomInput(rt.id, { occupancyPct: Number(e.target.value) })
                          }
                          className="w-20 rounded border border-slate-700 bg-slate-950 p-2 text-sm tabular-nums"
                        />
                        <span className="text-[11px] text-slate-500">
                          %{" "}
                          <span className="tabular-nums">
                            ({Math.round((v.occupancyPct / 100) * rt.total_rooms)} of {rt.total_rooms})
                          </span>
                        </span>
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        aria-label={`Rooms picked up for ${rt.name}`}
                        value={v.pickupUnits}
                        onChange={(e) => setRoomInput(rt.id, { pickupUnits: Number(e.target.value) })}
                        className="w-20 rounded border border-slate-700 bg-slate-950 p-2 text-sm tabular-nums"
                      />
                    </td>
                    <td className="py-2 pr-3 text-[11px] text-slate-500 tabular-nums">
                      {money(rt.floor_price)} &ndash; {money(rt.ceiling_price)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Rules in play ─────────────────────────────────────────── */}
      <div className="rounded border border-slate-800 bg-slate-950/60 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Rules in play</h3>
            <p className="text-[11px] text-slate-500">
              Switched-off rules are included so you can see what turning one on would do.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setDraftOpen((o) => !o);
              setSavedNotice(null);
              setDraftError(null);
            }}
            className="cursor-pointer rounded bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700"
          >
            {draftOpen ? "Discard test rule" : "+ Build a test rule"}
          </button>
        </div>

        {rules.length === 0 ? (
          <p className="text-sm text-slate-400">
            No rules yet. Build a test rule below to see how one would behave before you commit to
            it.
          </p>
        ) : (
          <ul className="space-y-1">
            {rules.map((r) => (
              <li key={r.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-900">
                  <input
                    type="checkbox"
                    checked={selectedRuleIds.has(r.id)}
                    onChange={() => toggleRule(r.id)}
                    className="cursor-pointer"
                  />
                  <span className="text-slate-200">{r.name}</span>
                  <span className="text-[11px] text-slate-500">
                    {r.is_pickup_rule ? "event" : "ladder"}
                  </span>
                  {!r.is_active && (
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                      off
                    </span>
                  )}
                  {selectedRuleIds.has(r.id) && firedIds.has(r.id) && (
                    <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-300">
                      fires
                    </span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        )}

        {draftOpen && (
          <div className="mt-4 space-y-3 rounded border border-slate-800 bg-slate-900 p-3">
            <div>
              <label className={microLabel} htmlFor="sim-draft-name">
                Rule name
              </label>
              <input
                id="sim-draft-name"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="Busy weekend bump"
                className={inputClass}
              />
            </div>

            <div className="space-y-2">
              <div className="text-xs text-slate-400">When all of these are true</div>
              {draftRows.map((row) => {
                const taken = new Set(draftRows.filter((r) => r.id !== row.id).map((r) => r.metric));
                return (
                  <div key={row.id} className="rounded border border-slate-800 bg-slate-950/80 p-3">
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,16rem)_minmax(0,10rem)_minmax(0,10rem)_auto] sm:items-end">
                      <div className="min-w-0">
                        <label className={microLabel} htmlFor={`sim-metric-${row.id}`}>
                          Metric
                        </label>
                        <select
                          id={`sim-metric-${row.id}`}
                          value={row.metric}
                          className={inputClass}
                          onChange={(e) => {
                            const m = e.target.value as ConditionMetric;
                            updateDraftRow(row.id, {
                              metric: m,
                              value: m === "occupancy" ? "80" : m === "booking_window" ? "7" : "5",
                            });
                          }}
                        >
                          <option value="occupancy" disabled={taken.has("occupancy")}>
                            Occupancy (%)
                          </option>
                          <option value="booking_speed" disabled={taken.has("booking_speed")}>
                            Booking speed (recommended)
                          </option>
                          <option value="booking_window" disabled={taken.has("booking_window")}>
                            Booking window (days to stay)
                          </option>
                          <option value="pickup" disabled={taken.has("pickup")}>
                            Pickup count (advanced)
                          </option>
                        </select>
                      </div>

                      {row.metric === "booking_speed" ? (
                        <div className="sm:col-span-2">
                          <label className={microLabel} htmlFor={`sim-speed-${row.id}`}>
                            Speed
                          </label>
                          <select
                            id={`sim-speed-${row.id}`}
                            value={row.booking_speed_level}
                            className={inputClass}
                            onChange={(e) =>
                              updateDraftRow(row.id, { booking_speed_level: e.target.value })
                            }
                          >
                            {BOOKING_SPEED_LEVELS.map((l) => (
                              <option key={l.key} value={l.key}>
                                {l.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      ) : (
                        <>
                          <div>
                            <label className={microLabel} htmlFor={`sim-op-${row.id}`}>
                              Is
                            </label>
                            <select
                              id={`sim-op-${row.id}`}
                              value={row.operator}
                              className={inputClass}
                              onChange={(e) =>
                                updateDraftRow(row.id, { operator: e.target.value as "gt" | "lt" })
                              }
                            >
                              <option value="gt">above</option>
                              <option value="lt">below</option>
                            </select>
                          </div>
                          <div>
                            <label className={microLabel} htmlFor={`sim-val-${row.id}`}>
                              Value
                            </label>
                            <input
                              id={`sim-val-${row.id}`}
                              type="number"
                              value={row.value}
                              onChange={(e) => updateDraftRow(row.id, { value: e.target.value })}
                              className={inputClass}
                            />
                          </div>
                        </>
                      )}

                      {draftRows.length > 1 && (
                        <button
                          type="button"
                          onClick={() =>
                            setDraftRows((rows) => rows.filter((r) => r.id !== row.id))
                          }
                          className="cursor-pointer rounded bg-slate-800 px-2 py-2 text-xs hover:bg-slate-700"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {draftRows.length < 4 && (
                <button
                  type="button"
                  onClick={() => {
                    const used = new Set(draftRows.map((r) => r.metric));
                    const next = (
                      ["occupancy", "booking_speed", "booking_window", "pickup"] as ConditionMetric[]
                    ).find((m) => !used.has(m));
                    if (next) setDraftRows((rows) => [...rows, newConditionRow(next)]);
                  }}
                  className="cursor-pointer rounded bg-slate-800 px-3 py-1 text-xs hover:bg-slate-700"
                >
                  + Add a condition
                </button>
              )}
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <label className={microLabel} htmlFor="sim-direction">
                  Then
                </label>
                <select
                  id="sim-direction"
                  value={draftDirection}
                  onChange={(e) => setDraftDirection(e.target.value as "increase" | "decrease")}
                  className={inputClass}
                >
                  <option value="increase">raise the rate</option>
                  <option value="decrease">lower the rate</option>
                </select>
              </div>
              <div>
                <label className={microLabel} htmlFor="sim-amount">
                  By
                </label>
                <input
                  id="sim-amount"
                  type="number"
                  min={0}
                  value={draftAmount}
                  onChange={(e) => setDraftAmount(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={microLabel} htmlFor="sim-unit">
                  Unit
                </label>
                <select
                  id="sim-unit"
                  value={draftKind}
                  onChange={(e) => setDraftKind(e.target.value as ActionKindUi)}
                  className={inputClass}
                >
                  <option value="percent">percent</option>
                  <option value="fixed">dollars</option>
                </select>
              </div>
            </div>

            <div>
              <span className={microLabel} id="sim-room-types-label">
                Room types
              </span>
              <div className="flex flex-wrap gap-2" role="group" aria-labelledby="sim-room-types-label">
                {roomTypes.map((rt) => {
                  const on = draftRoomTypeIds.includes(rt.id);
                  return (
                    <button
                      key={rt.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setDraftRoomTypeIds((ids) =>
                          on ? ids.filter((i) => i !== rt.id) : [...ids, rt.id],
                        )
                      }
                      className={`cursor-pointer rounded-full border px-3 py-1 text-xs ${
                        on
                          ? "border-sky-500/50 bg-sky-500/20 text-sky-200"
                          : "border-slate-700 text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {rt.name}
                    </button>
                  );
                })}
              </div>
            </div>

            {draftError && <p className="text-sm text-rose-300">{draftError}</p>}

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={saveDraftRule}
                disabled={saving || !draftRule}
                className="cursor-pointer rounded bg-sky-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? "Saving..." : "Save This Rule"}
              </button>
              <span className="text-[11px] text-slate-500">
                Until you press this, the rule exists only on this screen.
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── Results ───────────────────────────────────────────────── */}
      <div className="rounded border border-slate-800 bg-slate-950/60 p-4">
        <h3 className="mb-3 text-sm font-semibold">What would happen</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-left text-slate-300">
                <th className="py-2 pr-3 font-medium">Room type</th>
                <th className="py-2 pr-3 font-medium">Base</th>
                <th className="py-2 pr-3 font-medium">Becomes</th>
                <th className="py-2 pr-3 font-medium">Change</th>
                <th className="py-2 pr-3 font-medium">Because</th>
              </tr>
            </thead>
            <tbody>
              {results.map((row) => {
                const delta = row.finalPrice - row.basePrice;
                const cls =
                  delta > 0 ? "text-emerald-300" : delta < 0 ? "text-amber-300" : "text-slate-400";
                const fired = row.outcomes.filter((o) => o.fired);
                return (
                  <tr key={row.roomType.id} className="border-b border-slate-800 align-top">
                    <td className="py-2 pr-3 font-medium text-slate-200">{row.roomType.name}</td>
                    <td className="py-2 pr-3 tabular-nums text-slate-400">{money(row.basePrice)}</td>
                    <td className="py-2 pr-3 tabular-nums font-semibold text-slate-100">
                      {money(row.finalPrice)}
                      {row.clampedBy !== "none" && (
                        <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-normal text-slate-400">
                          held at your {row.clampedBy}
                        </span>
                      )}
                    </td>
                    <td className={`py-2 pr-3 tabular-nums ${cls}`}>
                      {delta === 0 ? "—" : `${delta > 0 ? "+" : ""}${money(delta).replace("$-", "-$")}`}
                    </td>
                    <td className="py-2 pr-3">
                      {fired.length === 0 ? (
                        <span className="text-slate-500">No rule fires on this night</span>
                      ) : (
                        <ul className="space-y-0.5">
                          {fired.map((o) => (
                            <li key={o.ruleId} className="text-slate-300">
                              {o.ruleName}
                              {!o.isActive && (
                                <span className="ml-1.5 text-[10px] text-amber-300">
                                  (currently off)
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      {row.clampedBy !== "none" && (
                        <div className="mt-1 text-[11px] text-slate-500">
                          Rules asked for {money(row.preClampPrice)}.
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Why a rule you expected didn't fire — the question people actually ask. */}
        {results.some((r) => r.outcomes.some((o) => !o.fired && o.skipReason !== "not_affected")) && (
          <div className="mt-4 border-t border-slate-800 pt-3">
            <div className="mb-1 text-xs text-slate-400">Didn&rsquo;t fire</div>
            <ul className="space-y-0.5 text-[11px] text-slate-500">
              {Array.from(
                new Map(
                  results
                    .flatMap((r) => r.outcomes)
                    .filter((o) => !o.fired && o.skipReason !== "not_affected")
                    .map((o) => [`${o.ruleId}|${o.skipReason}`, o]),
                ).values(),
              ).map((o) => (
                <li key={`${o.ruleId}-${o.skipReason}`}>
                  <span className="text-slate-400">{o.ruleName}</span> —{" "}
                  {o.skipReason ? SIM_SKIP_LABEL[o.skipReason] : "—"}
                  {o.skipReason === "condition_not_met" && o.occupancySeen != null && (
                    <span className="tabular-nums">
                      {" "}
                      (it saw {Math.round(o.occupancySeen * 100)}% occupancy, {o.dta} days out)
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="mt-4 text-[11px] text-slate-500">
          Two things this preview simplifies: a ladder rule fires on the way into its condition and
          holds, so this shows where the night settles rather than each step; and when several event
          rules match, the engine picks one winner while this adds them all, so treat it as the top
          of the range.
        </p>
      </div>
    </section>
  );
}
