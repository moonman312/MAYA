"use client";

import { Settings as SettingsIcon } from "lucide-react";
import { AskForHelp } from "@/components/onboarding/ask-for-help";
import { BillingBanner } from "@/components/billing/billing-banner";
import { CalendarColorKey } from "@/components/calendar-color-key";
import { CalendarDayCell } from "@/components/calendar-day-cell";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { TextSizeSync } from "@/components/text-size-sync";
import { DEFAULT_CALENDAR_DISPLAY, priceRoomTypeName, type CalendarDisplay } from "@/lib/calendar-display";
import type { TextSize } from "@/lib/text-size";
import { MayaLockup } from "@/components/brand/logo";
import { PmsReconnect } from "@/components/pms-reconnect";
import { isPushProblem, PushProblemItem } from "@/components/push-problem-item";
import { OnboardingReviewBanner } from "@/components/onboarding/review-banner";
import { CorrectionsPanel } from "@/components/explain-drilldown";
import { ManualPriceEditor, manualPriceBadge } from "@/components/manual-price-editor";
import { NoRateLine, RemovedRateLine } from "@/components/no-rate-help";
import { useCalendarLive } from "@/lib/use-calendar-live";
import { track } from "@/lib/analytics/track";
import { PropertySelect } from "@/components/property-select";
import { PropertyTimeAndCurrency } from "@/components/property-time-currency";
import { RateSimulator } from "@/components/rate-simulator";
import { RoomCountHelp, RoomTypeSettings, isCountingRoom } from "@/components/room-type-settings";
import { bookingSpeedHelp, bookingSpeedWaitHelp, pickupWindowHelp } from "@/lib/booking-speed-help";
import { PickupWaitField } from "@/components/pickup-wait-field";
import { RuleAlertBanner } from "@/components/rule-alert-banner";
import { letRunAgainBody, stoppedChipLabel, stoppedNightsHelp, type RuleStops } from "@/lib/rule-alerts";
import { RuleBehaviorAnimations } from "@/components/rule-behavior-animations";
import { RuleFireCount } from "@/components/rule-fire-log";
import { RuleRoomTypesField } from "@/components/rule-room-types-field";
import { UndoOnCancellationField } from "@/components/undo-on-cancellation-box";
import {
  RuleActivationDialog,
  type ActivationChoice,
  type ActivationSource,
  type SaveAnswer,
} from "@/components/rule-activation-dialog";
import { draftKind, type PreviewRequest } from "@/lib/rule-activation-client";
import { currencySymbolFor, isQuietChecks, isRuleAlertChoice } from "@/lib/changelog-route-helpers";
import { isSupportChange } from "@/lib/changelog-support";
import { SupportChangeItem } from "@/components/support-change-item";
import { isModeSwitch } from "@/lib/changelog-mode-switches";
import { ModeSwitchItem } from "@/components/mode-switch-item";
import { isPmsChange } from "@/lib/changelog-pms-changes";
import { PmsChangeItem } from "@/components/pms-change-item";
import { QuietChecksLine } from "@/components/quiet-checks-line";
import { PricingRunItem } from "@/components/pricing-run-item";
import { OlderButton } from "@/components/older-button";
import { useChangelogPages } from "@/components/use-changelog-pages";
import { SimulationStrip } from "@/components/simulation-strip";
import { formatUtcLongDate } from "@/lib/calendar-month-label";
import { formatDisplayTime } from "@/lib/display-time";
import { BOOKING_SPEED_LEVELS } from "@/lib/observations/booking-speed";
import {
  BOOKING_SPEED_WAIT_OPTIONS,
  FAR_OUT_CUT_GUARD_HELP,
  RULE_FIRES_HELP,
  eventRuleWaitDays,
  farOutCutGuardRow,
  pickupCountsLow,
  pickupOwnWait,
  pickupSetsWait,
  rowsAreFarOutCut,
  waitDaysLabel,
  builderDraft,
  draftBehaviourKey,
  formatRuleConditionsDisplay,
  newConditionRow,
  ruleRoomTypesLabel,
  ruleToBuilderForm,
  type BookingSpeedWaitDays,
  type ConditionFormRow,
  type ConditionMetric,
} from "@/lib/rule-form";
import type {
  CalendarResponse,
  ChangelogItem,
  EngineRule,
  RuleConfig,
} from "@/types/domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDashboardUrl } from "@/components/deep-links/use-dashboard-url";
import { ArrivalNote, FilledChip, readArrivalOnce } from "@/components/deep-links/arrival-bits";
import { flashWhenReady } from "@/components/deep-links/flash";
import { HelpLink } from "@/components/deep-links/help-links";
import { links, type Arrival } from "@/lib/deep-links";
import { builderFill, testRuleFill } from "@/lib/deep-links/prefill";
import { arrivalFlashTarget } from "@/lib/deep-links/flash-target";

type TabKey = "calendar" | "rules" | "simulator" | "changelog" | "pms";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const tabs: { key: TabKey; label: string }[] = [
  { key: "calendar", label: "Calendar" },
  { key: "rules", label: "Rules" },
  { key: "simulator", label: "Rate Simulator" },
  { key: "changelog", label: "Change Log" },
  { key: "pms", label: "PMS" },
];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Request failed (${res.status}): ${url}`);
  }
  return (await res.json()) as T;
}

/** Matches `calendar-store` month grid: Sun-first padding + day cells. */
function CalendarMonthSkeleton({
  year,
  month,
}: {
  year: number;
  month: number;
}) {
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstWeekday = firstDay.getUTCDay();

  return (
    <div
      className="grid grid-cols-7 gap-[4px] sm:gap-2"
      aria-busy="true"
      aria-label="Loading calendar"
    >
      {Array.from({ length: firstWeekday }).map((_, idx) => (
        <div key={`sk-pad-${idx}`} />
      ))}
      {Array.from({ length: daysInMonth }).map((_, idx) => {
        const dayNum = idx + 1;
        return (
          <div
            key={`sk-${dayNum}`}
            className="min-w-0 animate-pulse overflow-hidden rounded border border-slate-800 bg-slate-800/35 px-1 py-1.5 sm:p-2"
          >
            <div className="h-3 w-5 max-w-full rounded bg-slate-700/70" />
            <div className="mt-2 h-7 w-11 max-w-full rounded bg-slate-700/60" />
            <div className="mt-2 hidden h-3 w-18 max-w-full rounded bg-slate-600/50 sm:block" />
            <div className="mt-1 hidden h-3 w-9 max-w-full rounded bg-slate-600/50 sm:block" />
            <div className="mt-2 h-1 w-full rounded bg-slate-700/40" />
          </div>
        );
      })}
    </div>
  );
}

/** Calendar-style line for timelines (Change Log, etc.). */
function formatFriendlyDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}

/** Short relative hint for recent instants; null when older than one calendar week. */
function formatRelativeAge(iso: string): string | null {
  try {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return null;
    const ms = Date.now() - then.getTime();
    if (ms < 0) return null;
    const sec = Math.floor(ms / 1000);
    if (sec < 45) return "just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hr ago`;

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfThen = new Date(then);
    startOfThen.setHours(0, 0, 0, 0);
    const dayDiff = Math.round(
      (startOfToday.getTime() - startOfThen.getTime()) / 86_400_000,
    );
    if (dayDiff === 1) return "yesterday";
    if (dayDiff > 1 && dayDiff < 7) return `${dayDiff} days ago`;
    return null;
  } catch {
    return null;
  }
}

type PmsActivity = {
  connection: {
    pms_type: string;
    status: string | null;
    last_sync_at: string | null;
    last_tested_at: string | null;
  } | null;
  /** How this PMS authenticates — decides whether reconnecting is one click. */
  pms: { authKind: string; displayName: string; canManage: boolean } | null;
  /** The connection is gone because never-paid data was removed; reconnecting reads the history again. */
  historyRemoved?: boolean;
  /** False for a system whose requests aren't logged (Mews, Think): its health and log are always empty. */
  requestsTracked?: boolean;
  /** The time zone and currency saved for the property, shown as they are. */
  property?: { timezone: string | null; currency: string | null } | null;
  health: {
    state: "healthy" | "degraded" | "down" | "unknown";
    successRate: number | null;
    total: number;
    failures: number;
  };
  log: Array<{
    id: string;
    created_at: string;
    http_method: string;
    endpoint: string;
    status_code: number | null;
    ok: boolean;
    duration_ms: number | null;
    message: string | null;
  }>;
};

function formatPmsName(pmsType: string): string {
  const names: Record<string, string> = {
    cloudbeds: "Cloudbeds",
    mews: "Mews",
    think: "Think Reservations",
    opera: "Opera",
  };
  return names[pmsType] ?? pmsType;
}

function PmsHealthBadge({ health }: { health: PmsActivity["health"] }) {
  const styles: Record<PmsActivity["health"]["state"], { cls: string; label: string }> = {
    healthy: {
      cls: "bg-emerald-600/30 text-emerald-200 ring-1 ring-emerald-500/40",
      label: "Healthy",
    },
    degraded: {
      cls: "bg-amber-600/25 text-amber-100 ring-1 ring-amber-500/35",
      label: "Degraded",
    },
    down: {
      cls: "bg-rose-600/30 text-rose-100 ring-1 ring-rose-500/40",
      label: "Having trouble",
    },
    unknown: {
      cls: "bg-slate-700 text-slate-200 ring-1 ring-slate-600",
      label: "No recent activity",
    },
  };
  const s = styles[health.state];
  return (
    <div className="flex items-center gap-2">
      <span className={`rounded px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>
      {health.total > 0 && health.successRate != null ? (
        <span className="text-[0.6875rem] tabular-nums text-slate-500">
          {Math.round(health.successRate * 100)}% of {health.total} requests OK
        </span>
      ) : null}
    </div>
  );
}

/** True when the calendar day is today or later (UTC date semantics). */
function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isFutureDay(year: number, month: number, day: number): boolean {
  const target = Date.UTC(year, month - 1, day);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return target >= today;
}

function PmsStatusBadge({ status }: { status: string | null }) {
  if (!status) {
    return (
      <span className="rounded bg-slate-700 px-2 py-0.5 text-xs font-medium text-slate-200">
        unknown
      </span>
    );
  }
  const s = status.toLowerCase();
  const cls =
    s === "connected"
      ? "bg-emerald-600/30 text-emerald-200 ring-1 ring-emerald-500/40"
      : s === "pending"
        ? "bg-amber-600/25 text-amber-100 ring-1 ring-amber-500/35"
        : s === "degraded"
          ? "bg-amber-600/25 text-amber-100 ring-1 ring-amber-500/35"
          : s === "error" || s === "disconnected"
            ? "bg-rose-600/30 text-rose-100 ring-1 ring-rose-500/40"
            : "bg-slate-700 text-slate-200 ring-1 ring-slate-600";
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium capitalize ${cls}`}
    >
      {status}
    </span>
  );
}

/**
 * How a platform admin stands on a property they do not belong to: a Viewer
 * ("read_only") until God Mode is on ("god_mode"). Null for everyone else.
 */
export type SupportView = "read_only" | "god_mode" | null;

/** The activation popup, open for a rule about to become active. */
type ActivationRequest = {
  request: PreviewRequest;
  ruleName: string;
  kind: "standard" | "event";
  source: ActivationSource;
  save: (choice: ActivationChoice) => Promise<SaveAnswer>;
  /** After Apply or Skip saved. */
  saved: (skipped: boolean) => void;
  /** Demo mode, no preview: save the way it was saved before the popup. */
  unavailable?: () => void;
  /** Nothing that moves a price after all: save as it is. */
  notNeeded?: () => void;
};

/** The rule the builder is editing: which, the version it was filled from, and its settings as filled. */
type EditingRule = { id: string; version: number; enabled: boolean; name: string; baseline: string };

/** A save or a switch, as the popup and the builder read the answer. */
async function sendRule(url: string, method: "POST" | "PUT" | "DELETE", body?: unknown): Promise<SaveAnswer> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const answer = (await res.json().catch(() => ({}))) as { error?: string; code?: string; skipped?: boolean };
    if (res.ok) return { ok: true, skipped: answer.skipped === true };
    return {
      ok: false,
      status: res.status,
      code: answer.code,
      error: answer.error ?? "Could not save the rule. Try again in a moment.",
    };
  } catch {
    return { ok: false, status: 0, error: "Could not save the rule. Check your connection and try again." };
  }
}

export function Dashboard({
  isPlatformAdmin = false,
  commandCenter = isPlatformAdmin,
  supportView = null,
  initialSearch = "",
  textSize = null,
}: {
  isPlatformAdmin?: boolean;
  /** MAYA staff (a platform admin, a developer or a sales login): show the Command Center link. */
  commandCenter?: boolean;
  supportView?: SupportView;
  /** The query the page was rendered with: the tab and place a link or a refresh asked for. */
  initialSearch?: string;
  /** The text size saved on the person's profile, brought to this browser if it shows another. */
  textSize?: TextSize | null;
}) {
  // The tab and the place inside it live in the address (src/lib/deep-links/dashboard-url.ts),
  // so back and forward work and a link from the docs or an email can open any of them.
  const {
    tab,
    setTab,
    year,
    setYear,
    month,
    setMonth,
    selectedDay,
    setSelectedDay,
    ruleFilter,
    setRuleFilter,
    ruleFormOpen,
    setRuleFormOpen,
    changesOnly,
    setChangesOnly,
    panel,
    setPanel,
  } = useDashboardUrl(initialSearch);

  // What a link brought, read once and taken out of the address (it only
  // opens and fills in; nothing here ever saves). See applyArrival below.
  const [arrival, setArrival] = useState<Arrival | null>(null);
  const [arrivalNote, setArrivalNote] = useState<string | null>(null);
  const [builderFilled, setBuilderFilled] = useState(false);
  const [roomTypesReady, setRoomTypesReady] = useState(false);
  const builderApplied = useRef(false);

  const [rules, setRules] = useState<RuleConfig[]>([]);
  /** Rule awaiting the delete-or-disable choice; null when the dialog is closed. */
  const [pendingDelete, setPendingDelete] = useState<RuleConfig | null>(null);
  const [fireCounts, setFireCounts] = useState<Record<string, number>>({});
  // Nights the owner told a rule to stop adjusting: without this the rules
  // table shows the rule as On with nothing to say it does nothing there.
  const [ruleStops, setRuleStops] = useState<RuleStops[]>([]);
  const [lettingRun, setLettingRun] = useState<string | null>(null);
  const [roomTypeOptions, setRoomTypeOptions] = useState<
    { id: string; name: string; counts_as_room?: boolean | null }[]
  >([]);
  const [calendar, setCalendar] = useState<CalendarResponse | null>(null);
  // The change log, a page at a time: "Older" adds the page before.
  const changelogPages = useChangelogPages<ChangelogItem>();
  const { items: changelog, error: changelogError, reload: reloadChangelog } = changelogPages;
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const [pmsActivity, setPmsActivity] = useState<PmsActivity | null>(null);
  // Simulating or live, as the strip at the top read it: the day card words a typed price for it.
  const [propertyMode, setPropertyMode] = useState<"simulation" | "live" | null>(null);
  // Settings, opened from the gear in the header (or a link to it).
  const [settingsOpen, setSettingsOpen] = useState(false);
  // A section of Settings a link or a change log button asked for.
  const [settingsFocus, setSettingsFocus] = useState<string | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  const [accessibleHotels, setAccessibleHotels] = useState<
    { id: string; name: string }[]
  >([]);
  const [activeHotelId, setActiveHotelId] = useState<string | null>(null);
  const [hotelSwitching, setHotelSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const [ruleName, setRuleName] = useState("");
  const [condRows, setCondRows] = useState<ConditionFormRow[]>(() => [
    newConditionRow("occupancy"),
  ]);
  // One amount per rule: a number in one box greys out the other (Jake,
  // 2026-09-28), and whichever holds a number is the rule's amount.
  const [adjPercent, setAdjPercent] = useState("");
  const [adjDollars, setAdjDollars] = useState("");
  // Greyed out while the other box has a number. Never both at once, so a
  // form that somehow holds two numbers can still be cleared.
  const percentLocked = adjPercent === "" && adjDollars !== "";
  const dollarsLocked = adjDollars === "" && adjPercent !== "";
  // Deliberately no default: making the owner choose increase vs decrease
  // beats a silent sign convention they'd have to remember.
  const [adjDirection, setAdjDirection] = useState<"" | "increase" | "decrease">("");
  const [selectedRoomTypeIds, setSelectedRoomTypeIds] = useState<string[]>([]);
  // Ticked: selectedRoomTypeIds is what the rule measures and these are what
  // it changes. Unticked: one list does both.
  const [splitRoomTypeSets, setSplitRoomTypeSets] = useState(false);
  const [changeRoomTypeIds, setChangeRoomTypeIds] = useState<string[]>([]);
  const [ruleFormError, setRuleFormError] = useState<string | null>(null);
  // The undo box starts ticked on every new rule (Jake, 2026-09-25).
  const [undoOnCancellation, setUndoOnCancellation] = useState(true);
  // The rule the builder is editing (the rules list's Edit), or null for a new one.
  const [editing, setEditing] = useState<EditingRule | null>(null);
  // "This rule changed in another tab": offer to load it again.
  const [ruleFormReload, setRuleFormReload] = useState(false);
  // The activation popup, when a rule is about to become active.
  const [activation, setActivation] = useState<ActivationRequest | null>(null);
  // A switch that could not be changed, and why, under that rule.
  const [ruleSwitchError, setRuleSwitchError] = useState<{ ruleId: string; message: string } | null>(null);
  // Whether this rule (new, or the one being edited) has had the booking
  // window row the builder fills in for a cut on low pickup with none. Once
  // per rule: the owner may remove the row, and it never comes back on its
  // own, and saving never adds it (Jake, 2026-09-29, A4).
  const farOutGuardOffered = useRef(false);

  useEffect(() => {
    void reloadRules();
    void reloadRoomTypes();
  }, []);

  // The moment the form becomes a cut on low pickup with no booking window
  // row, one is filled in: within 60 days of arrival, with a "?" saying why.
  useEffect(() => {
    if (farOutGuardOffered.current || !rowsAreFarOutCut(condRows, adjDirection)) return;
    farOutGuardOffered.current = true;
    setCondRows((prev) => (rowsAreFarOutCut(prev, adjDirection) ? [...prev, farOutCutGuardRow()] : prev));
  }, [condRows, adjDirection]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/hotels");
        if (!res.ok) return;
        const data = (await res.json()) as {
          hotels: { id: string; name: string }[];
          activeHotelId: string | null;
        };
        setAccessibleHotels(data.hotels);
        setActiveHotelId(data.activeHotelId);
      } catch {
        /* demo / offline */
      }
    })();
  }, []);

  // Read when the dashboard opens, not only on the PMS tab: the lost-connection
  // banner sits above every tab. Opening the PMS tab reads it again.
  const onPmsTab = tab === "pms";
  useEffect(() => {
    if (!activeHotelId) {
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/pms/activity");
        if (!alive) return;
        if (!res.ok) {
          setPmsActivity(null);
          return;
        }
        const body = (await res.json()) as PmsActivity;
        if (alive) setPmsActivity(body);
      } catch {
        if (alive) setPmsActivity(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [onPmsTab, activeHotelId]);

  // Month responses cached client-side so Prev/Next renders instantly from
  // the last known data, with three guards that keep fast clicking from
  // turning into a request storm (each API call costs auth + several DB
  // round-trips server-side, and bursts can trip upstream rate limits):
  //   - entries fresher than CAL_FRESH_MS aren't refetched at all — the
  //     realtime subscription clears the cache when data actually changes
  //   - at most one in-flight request per month, shared by everything
  //   - neighbor prefetch waits for navigation to settle before firing
  const CAL_FRESH_MS = 2 * 60 * 1000;
  const calendarCacheRef = useRef(
    new Map<string, { data: CalendarResponse; fetchedAt: number }>(),
  );
  const calendarInFlightRef = useRef(new Map<string, Promise<CalendarResponse | null>>());
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const calendarCacheKey = useCallback(
    (y: number, m: number) => `${activeHotelId ?? "demo"}|${y}-${m}`,
    [activeHotelId],
  );

  /** Fetch one month with in-flight dedupe; resolves null on failure. */
  const fetchMonth = useCallback(
    (y: number, m: number): Promise<CalendarResponse | null> => {
      const key = calendarCacheKey(y, m);
      const inFlight = calendarInFlightRef.current.get(key);
      if (inFlight) return inFlight;
      const p = api<CalendarResponse>(`/api/calendar/${y}/${m}`)
        .then((data) => {
          calendarCacheRef.current.set(key, { data, fetchedAt: Date.now() });
          return data;
        })
        .catch(() => null)
        .finally(() => calendarInFlightRef.current.delete(key));
      calendarInFlightRef.current.set(key, p);
      return p;
    },
    [calendarCacheKey],
  );

  const prefetchNeighborMonths = useCallback(
    (y: number, m: number) => {
      if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current);
      prefetchTimerRef.current = setTimeout(() => {
        const neighbors = [
          m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 },
          m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 },
        ];
        for (const n of neighbors) {
          const hit = calendarCacheRef.current.get(calendarCacheKey(n.y, n.m));
          if (hit && Date.now() - hit.fetchedAt < CAL_FRESH_MS) continue;
          void fetchMonth(n.y, n.m);
        }
      }, 400);
    },
    [calendarCacheKey, fetchMonth, CAL_FRESH_MS],
  );

  const reloadCalendar = useCallback(async () => {
    // The open night lives in the address now; the card only shows once the
    // month holding it has loaded, so there is nothing to clear here.
    const key = calendarCacheKey(year, month);
    const cached = calendarCacheRef.current.get(key);
    if (cached) {
      // Instant paint from cache; refetch only if it's aged past freshness.
      setCalendar(cached.data);
      prefetchNeighborMonths(year, month);
      if (Date.now() - cached.fetchedAt >= CAL_FRESH_MS) {
        const data = await fetchMonth(year, month);
        if (data) {
          setCalendar(data);
          setLastUpdated(new Date());
        }
      }
      return;
    }
    setLoading(true);
    try {
      const data = await fetchMonth(year, month);
      if (data) {
        setCalendar(data);
        setLastUpdated(new Date());
      }
      prefetchNeighborMonths(year, month);
    } finally {
      setLoading(false);
    }
  }, [month, year, calendarCacheKey, fetchMonth, prefetchNeighborMonths, CAL_FRESH_MS]);

  /**
   * Background refresh used by polling / tab-focus: updates the calendar in
   * place WITHOUT toggling the loading skeleton or clearing the selected day,
   * so prices published by the scheduled cron appear without a visible reload.
   * Errors are swallowed so a transient failure just keeps the current data.
   */
  const reloadCalendarQuiet = useCallback(async () => {
    const data = await fetchMonth(year, month);
    if (data) {
      setCalendar(data);
      setLastUpdated(new Date());
    }
    // On failure, keep showing the last good calendar.
  }, [month, year, fetchMonth]);

  /**
   * The property's calendar choices just saved in Settings: shown at once on
   * the month on screen and on every month held in memory, with no reload.
   */
  const applyCalendarDisplay = useCallback((display: CalendarDisplay) => {
    for (const [key, entry] of calendarCacheRef.current) {
      calendarCacheRef.current.set(key, { ...entry, data: { ...entry.data, display } });
    }
    setCalendar((c) => (c ? { ...c, display } : c));
  }, []);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsFocus(null);
    settingsButtonRef.current?.focus();
  }, []);

  // Settings at the property system's section: the change log's button, or a link to settings.pms.
  const openPmsSetting = useCallback(() => {
    setSettingsFocus("settings-pms");
    setSettingsOpen(true);
  }, []);

  useEffect(() => {
    if (tab === "calendar") {
      void reloadCalendar();
    }
    if (tab === "changelog") {
      void reloadChangelog();
    }
  }, [reloadCalendar, reloadChangelog, tab]);

  // Event-driven refresh: a realtime subscription fires when published_price
  // or reservations change for this hotel, so updates land in ~2s instead of
  // on a polling interval — and nothing refreshes when nothing changed. The
  // slow interval below is only a safety net for environments where realtime
  // isn't enabled on those tables; visibility-change gives a quick catch-up
  // after the browser was backgrounded.
  useCalendarLive(activeHotelId, () => {
    // Real change on the wire: every cached month is now suspect, not just
    // the visible one (a multi-night booking spans months).
    calendarCacheRef.current.clear();
    if (tab === "calendar") void reloadCalendarQuiet();
  });

  useEffect(() => {
    if (tab !== "calendar") return;
    const FALLBACK_POLL_MS = 300_000;
    const id = setInterval(() => {
      void reloadCalendarQuiet();
    }, FALLBACK_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void reloadCalendarQuiet();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tab, reloadCalendarQuiet]);

  async function reloadRules() {
    const data = await api<RuleConfig[]>("/api/rules");
    setRules(data);
    try {
      const counts = await api<Record<string, number>>("/api/rules/fire-counts");
      setFireCounts(counts);
    } catch {
      // fire counts are decoration — never block the rules list on them
    }
    try {
      setRuleStops(await api<RuleStops[]>("/api/rules/stops"));
    } catch {
      // same for the stopped-nights chip
    }
  }

  /**
   * Takes the owner's "stop" off a rule's nights, across every alert they were
   * filed under, in one request: one click is one thing the owner did, and the
   * change log shows it as one. It clears the answer outright: answering
   * keep_adjusting instead would silence those nights for good, so a rule that
   * went on to adjust one of them twenty times would never reach the owner
   * again.
   *
   * Every stopped night, not only the ones still to come: what the owner did
   * was stop the rule on a run of nights, and taking the answer off some of
   * them would leave the change log reading as if they had only ever stopped
   * the rest.
   */
  async function letRuleRunAgain(stops: RuleStops) {
    setLettingRun(stops.rule_id);
    try {
      const res = await fetch("/api/rules/stops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(letRunAgainBody(stops)),
      });
      setRuleStops(res.ok ? ((await res.json()) as RuleStops[]) : await api<RuleStops[]>("/api/rules/stops"));
    } catch {
      // Leave the chip as it is; the next load says what really happened.
    } finally {
      setLettingRun(null);
    }
  }

  async function reloadRoomTypes() {
    const data =
      await api<Array<{ id: string; name: string; counts_as_room?: boolean | null }>>("/api/room-types");
    setRoomTypeOptions(data);
    // A new rule starts on the types that count as rooms — the same default
    // the rules store applies server-side. The others stay one click away.
    setSelectedRoomTypeIds(data.filter(isCountingRoom).map((item) => item.id));
    setSplitRoomTypeSets(false);
    setChangeRoomTypeIds([]);
    setRoomTypesReady(true);
  }

  async function applyActiveHotel(hotelId: string) {
    if (!hotelId || hotelId === activeHotelId) return;
    setHotelSwitching(true);
    setSwitchError(null);
    try {
      const res = await fetch("/api/hotels/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hotelId }),
      }).catch(() => null);
      if (!res?.ok) {
        // Nothing has moved: the selector, the open day and every tab stay on
        // the property they were on, and the owner is told the switch failed.
        if (res) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: string };
          console.error(errBody.error ?? res.statusText);
        }
        const name = (id: string | null) => accessibleHotels.find((h) => h.id === id)?.name;
        const from = name(activeHotelId);
        setSwitchError(
          `Couldn't switch to ${name(hotelId) ?? "that property"}.${from ? ` You're still on ${from}.` : ""} Try again in a moment.`,
        );
        return;
      }
      setSelectedDay(null);
      // A rule being edited belongs to the property being left.
      setEditing(null);
      setActivation(null);
      calendarCacheRef.current.clear();
      setActiveHotelId(hotelId);
      // The last property's connection must not show over this one while it loads.
      setPmsActivity(null);
      await Promise.all([reloadRules(), reloadRoomTypes()]);
      if (tab === "calendar") await reloadCalendar();
      if (tab === "changelog") await reloadChangelog();
    } finally {
      setHotelSwitching(false);
    }
  }

  /**
   * The rules list's switch. Off is at once (the rule's changes stay on the
   * price, frozen). On opens the activation popup: nothing switches a rule
   * on without the owner's Apply or Skip.
   */
  async function onToggleRule(rule: RuleConfig) {
    setRuleSwitchError(null);
    if (rule.enabled) {
      const answer = await sendRule(`/api/rules/${rule.id}/toggle`, "POST", { on: false });
      if (!answer.ok) setRuleSwitchError({ ruleId: rule.id, message: answer.error });
      await reloadRules();
      return;
    }
    setActivation({
      request: { intent: "enable", ruleId: rule.id },
      ruleName: rule.rule_name,
      kind: draftKind(undefined, rule.conditions as Record<string, unknown>),
      source: "switch",
      save: (choice) => sendRule(`/api/rules/${rule.id}/toggle`, "POST", { on: true, ...choice }),
      saved: () => {
        setActivation(null);
        void reloadRules();
      },
      unavailable: () => {
        setActivation(null);
        void api(`/api/rules/${rule.id}/toggle`, { method: "POST" }).finally(() => void reloadRules());
      },
    });
  }

  async function onDeleteRule(ruleId: string) {
    const answer = await sendRule(`/api/rules/${ruleId}`, "DELETE");
    if (!answer.ok) setRuleSwitchError({ ruleId, message: answer.error });
    setPendingDelete(null);
    if (editing?.id === ruleId) cancelEditing();
    await reloadRules();
  }

  async function onDisableRuleInstead(ruleId: string) {
    const rule = rules.find((r) => r.id === ruleId);
    if (rule?.enabled) {
      const answer = await sendRule(`/api/rules/${ruleId}/toggle`, "POST", { on: false });
      if (!answer.ok) setRuleSwitchError({ ruleId, message: answer.error });
    }
    setPendingDelete(null);
    await reloadRules();
  }

  /** The builder back to an empty new rule. */
  function resetBuilder() {
    setRuleName("");
    farOutGuardOffered.current = false;
    setCondRows([newConditionRow("occupancy")]);
    setAdjPercent("");
    setAdjDollars("");
    setAdjDirection("");
    setSelectedRoomTypeIds(roomTypeOptions.filter(isCountingRoom).map((r) => r.id));
    setSplitRoomTypeSets(false);
    setChangeRoomTypeIds([]);
    setBuilderFilled(false);
    setUndoOnCancellation(true);
    setRuleFormError(null);
    setRuleFormReload(false);
  }

  function cancelEditing() {
    setEditing(null);
    resetBuilder();
  }

  /**
   * The rules list's Edit: the rule as saved (its full settings, from
   * /api/rules/engine) in the builder, to change and save.
   */
  async function startEdit(ruleId: string) {
    setRuleFormError(null);
    setRuleFormReload(false);
    let rule: EngineRule | undefined;
    try {
      rule = (await api<EngineRule[]>("/api/rules/engine")).find((r) => r.id === ruleId);
    } catch {
      rule = undefined;
    }
    if (!rule) {
      setRuleSwitchError({ ruleId, message: "That rule could not be loaded. Try again in a moment." });
      return;
    }
    const form = ruleToBuilderForm(rule, isCountingRoomTypeId);
    setRuleName(form.name);
    // The rule as saved is the baseline below; a row the builder fills in
    // on top of it is a change the owner sees, and can remove.
    farOutGuardOffered.current = false;
    setCondRows(form.rows);
    setAdjDirection(form.direction);
    setAdjPercent(form.percent);
    setAdjDollars(form.dollars);
    setSplitRoomTypeSets(form.split);
    setSelectedRoomTypeIds(form.selected);
    setChangeRoomTypeIds(form.changeIds);
    setUndoOnCancellation(form.undo);
    setBuilderFilled(false);
    const baseline = builderDraft(
      { name: form.name, rows: form.rows, direction: form.direction, percent: form.percent, dollars: form.dollars, selected: form.selected, split: form.split, changeIds: form.changeIds, undo: form.undo },
      roomTypeOptions,
    );
    setEditing({
      id: rule.id,
      version: rule.version,
      enabled: rule.is_active,
      name: rule.name,
      baseline: "draft" in baseline ? draftBehaviourKey(baseline.draft) : "",
    });
    setRuleFormOpen(true);
    track("rule.edit_opened");
    requestAnimationFrame(() =>
      document.querySelector('[data-deeplink="rules.builder"]')?.scrollIntoView?.({ behavior: "smooth", block: "start" }),
    );
  }

  function addConditionRow() {
    const used = new Set(condRows.map((r) => r.metric));
    const next: ConditionMetric | undefined = (
      ["occupancy", "booking_speed", "booking_window", "pickup"] as const
    ).find((m) => !used.has(m));
    if (!next) return;
    setCondRows((prev) => [...prev, newConditionRow(next)]);
  }

  function removeConditionRow(id: string) {
    setCondRows((prev) => {
      const next = prev.filter((r) => r.id !== id);
      return next.length ? next : [newConditionRow("occupancy")];
    });
  }

  function updateCondRow(id: string, patch: Partial<ConditionFormRow>) {
    setCondRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
  }

  const isCountingRoomTypeId = useCallback(
    (id: string) => {
      // Only active room types are listed, and the engine only measures
      // active ones, so an id missing from the list is not measured.
      const option = roomTypeOptions.find((r) => r.id === id);
      return option ? isCountingRoom(option) : false;
    },
    [roomTypeOptions],
  );

  /**
   * Add Rule, or Save changes when editing. A new rule is saved on, and an
   * edit to a rule that is on can move prices, so both go through the
   * activation popup (the owner's Apply or Skip). A new name alone, or an
   * edit to a rule that is off, saves at once: neither moves a price.
   */
  async function onCreateRule(e: React.FormEvent) {
    e.preventDefault();
    setRuleFormError(null);
    setRuleFormReload(false);
    const built = builderDraft(
      {
        name: ruleName,
        rows: condRows,
        direction: adjDirection,
        percent: adjPercent,
        dollars: adjDollars,
        selected: selectedRoomTypeIds,
        split: splitRoomTypeSets,
        changeIds: changeRoomTypeIds,
        undo: undoOnCancellation,
      },
      roomTypeOptions,
    );
    if ("error" in built) {
      setRuleFormError(built.error);
      return;
    }
    const { draft } = built;
    const kind = draftKind(draft);
    const saved = () => {
      setActivation(null);
      setEditing(null);
      resetBuilder();
      void reloadRules();
    };
    const refused = (answer: Extract<SaveAnswer, { ok: false }>) => {
      setActivation(null);
      setRuleFormError(answer.error);
      setRuleFormReload(answer.code === "rule_changed");
    };

    if (editing) {
      const target = editing;
      const body = { ...draft, expected_version: target.version };
      const popup = () =>
        setActivation({
          request: { intent: "edit", ruleId: target.id, draft: body },
          ruleName,
          kind,
          source: "builder_edit",
          save: async (choice) => {
            const answer = await sendRule(`/api/rules/${target.id}`, "PUT", { ...body, ...choice });
            if (!answer.ok && answer.code === "rule_changed") refused(answer);
            return answer;
          },
          saved,
          notNeeded: () => void saveAsIs(),
        });
      const saveAsIs = async () => {
        setActivation(null);
        const answer = await sendRule(`/api/rules/${target.id}`, "PUT", body);
        if (answer.ok) saved();
        else if (answer.code === "activation_required") popup();
        else refused(answer);
      };
      if (!target.enabled || draftBehaviourKey(draft) === target.baseline) await saveAsIs();
      else popup();
      return;
    }

    const id = crypto.randomUUID();
    setActivation({
      request: { intent: "create", ruleId: id, draft },
      ruleName,
      kind,
      source: "builder_new",
      save: (choice) => sendRule("/api/rules", "POST", { ...draft, id, ...choice }),
      saved,
      // Demo mode: the in-memory rules, saved as before.
      unavailable: async () => {
        setActivation(null);
        const answer = await sendRule("/api/rules", "POST", draft);
        if (answer.ok) saved();
        else refused(answer);
      },
    });
  }

  // ── Arriving from a link ─────────────────────────────────────────────
  // Read once, then the address keeps only the place. A refresh, the back
  // button or a copied address never fills anything in again.
  useEffect(() => {
    const a = readArrivalOnce();
    if (!a.dest) return;
    setArrival(a);
    setArrivalNote(a.note);
    track("deeplink.opened", { dest: a.dest, filled: links.fills(a.params), noted: Boolean(a.note) });
  }, []);

  // The rule builder, filled in through its own setters once the room types
  // have loaded (loading them resets the builder's room type lists).
  // Add Rule is still the owner's click.
  useEffect(() => {
    if (arrival?.dest !== "rules.new" || !roomTypesReady || builderApplied.current) return;
    builderApplied.current = true;
    const fill = builderFill(arrival.params);
    if (fill.name !== undefined) setRuleName(fill.name);
    if (fill.rows) setCondRows(fill.rows);
    if (fill.direction) setAdjDirection(fill.direction);
    // A link fills one amount at most, and the other box is left empty.
    if (fill.percent !== undefined) {
      setAdjPercent(fill.percent);
      setAdjDollars("");
    } else if (fill.dollars !== undefined) {
      setAdjDollars(fill.dollars);
      setAdjPercent("");
    }
    if (fill.split) {
      // exactly what ticking the box does: the Change list starts as a copy
      setChangeRoomTypeIds(selectedRoomTypeIds.slice());
      setSplitRoomTypeSets(true);
    }
    setBuilderFilled(links.fills(arrival.params));
  }, [arrival, roomTypesReady, selectedRoomTypeIds]);

  // Scroll to the place and ring it for a moment.
  useEffect(() => {
    if (!arrival?.dest) return;
    if (arrival.dest === "rules.new" && !builderApplied.current) return;
    const target = arrivalFlashTarget(arrival);
    if (target) return flashWhenReady(target);
  }, [arrival, roomTypesReady]);

  // A link to Settings opens it. Nothing in it is changed.
  useEffect(() => {
    if (arrival?.dest === "settings") setSettingsOpen(true);
    if (arrival?.dest === "settings.pms") openPmsSetting();
  }, [arrival, openPmsSetting]);

  // A link to one change not in the pages shown says so: further down while
  // Older has more, gone once it doesn't; found after paging back, it stops saying so.
  const changelogOlder = changelogPages.older;
  useEffect(() => {
    if (arrival?.dest !== "changelog.entry" || changelog.length === 0) return;
    const run = arrival.params.run;
    if (!changelog.some((c) => !isPushProblem(c) && !isRuleAlertChoice(c) && !isSupportChange(c) && !isPmsChange(c) && !isModeSwitch(c) && !isQuietChecks(c) && c.changes.some((ch) => ch.evaluation_run_id === run))) {
      setArrivalNote(changelogOlder != null ? "entry-older" : "entry-gone");
    } else {
      setArrivalNote((n) => (n === "entry-older" ? null : n));
    }
  }, [arrival, changelog, changelogOlder]);

  const linkedDrilldown = (runId: string | undefined, stayDate: string | undefined, roomTypeId: string | undefined) =>
    arrival?.dest === "changelog.entry" &&
    arrival.params.run === runId &&
    (!arrival.params.date || arrival.params.date === stayDate) &&
    (!arrival.params.roomType || arrival.params.roomType === roomTypeId);

  const visibleCycles = useMemo(
    // A push problem is always shown: it is never a "nothing changed" run.
    () =>
      changesOnly
        ? changelog.filter((c) => isPushProblem(c) || isRuleAlertChoice(c) || isSupportChange(c) || isPmsChange(c) || isModeSwitch(c) || (!isQuietChecks(c) && c.has_changes))
        : changelog,
    [changesOnly, changelog],
  );

  const calendarBusy = loading || hotelSwitching;
  // The property's own symbol on the calendar's amounts, built the way the
  // change log's sentences build it.
  const currencySymbol = currencySymbolFor(calendar?.currency);
  // What each day shows and how its colours read (Settings). A payload from
  // before Settings existed reads as the calendar always was.
  const calendarDisplay = calendar?.display ?? DEFAULT_CALENDAR_DISPLAY;
  const priceName = calendar ? priceRoomTypeName(calendar.days, calendarDisplay.price_room_type_id) : null;
  // The key says nothing until it knows this property's colours.
  const keyMode = hotelSwitching || !calendar ? null : calendarDisplay.colors;

  // Year options come from the property's actual data range when the API
  // reports one; otherwise a sensible window around the current year.
  const calendarYears = useMemo(() => {
    const nowYear = new Date().getUTCFullYear();
    const minYear = calendar?.range?.min
      ? Number(calendar.range.min.slice(0, 4))
      : nowYear - 2;
    const maxYear = calendar?.range?.max
      ? Number(calendar.range.max.slice(0, 4))
      : nowYear + 1;
    const years: number[] = [];
    for (let y = Math.min(minYear, year); y <= Math.max(maxYear, year); y++) years.push(y);
    return years;
  }, [calendar?.range?.min, calendar?.range?.max, year]);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      {activation ? (
        <RuleActivationDialog
          ruleName={activation.ruleName}
          request={activation.request}
          kind={activation.kind}
          source={activation.source}
          save={activation.save}
          onSaved={activation.saved}
          onCancel={() => setActivation(null)}
          onUnavailable={activation.unavailable}
          onNotNeeded={activation.notNeeded}
          onRefused={(message) => {
            const ruleId = activation.request.ruleId;
            setActivation(null);
            if (activation.source === "switch") setRuleSwitchError({ ruleId, message });
            else setRuleFormError(message);
          }}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsDialog
          onClose={closeSettings}
          hotelId={activeHotelId}
          propertyName={accessibleHotels.find((h) => h.id === activeHotelId)?.name ?? null}
          roomTypes={roomTypeOptions}
          calendar={calendarDisplay}
          onCalendarSaved={applyCalendarDisplay}
          focusSection={settingsFocus}
        />
      ) : null}
      <TextSizeSync saved={textSize} />
      {pendingDelete ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-rule-title"
        >
          <div className="w-full max-w-lg rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-xl">
            <h3 id="delete-rule-title" className="text-lg font-semibold text-slate-100">
              Delete &ldquo;{pendingDelete.rule_name}&rdquo;?
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-slate-300">
              Deleting this rule also undoes the price changes it has already
              made. Any night it adjusted goes back to what the price would be
              if this rule had never run.
            </p>
            <p className="mt-2 text-sm leading-relaxed text-slate-300">
              If you only want it to stop acting from now on, turn it off
              instead — the prices it has already set stay exactly as they are.
            </p>
            <p className="mt-3 text-sm font-medium text-amber-300">
              Deleting cannot be undone.
            </p>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
              <button
                className="cursor-pointer rounded bg-rose-700 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-600"
                onClick={() => void onDeleteRule(pendingDelete.id)}
              >
                Delete Rule and Undo Its Changes
              </button>
              <button
                className="cursor-pointer rounded bg-slate-700 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-600"
                onClick={() => void onDisableRuleInstead(pendingDelete.id)}
              >
                Turn It Off and Keep Its Changes
              </button>
              <button
                className="cursor-pointer rounded px-4 py-2 text-sm text-slate-400 hover:text-slate-200 sm:mr-auto"
                onClick={() => setPendingDelete(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {activeHotelId ? (
        <SimulationStrip
          hotelId={activeHotelId}
          onMode={setPropertyMode}
          onWentLive={() => {
            if (tab === "changelog") void reloadChangelog();
          }}
        />
      ) : null}
      <div className="mx-auto max-w-6xl p-[12px] sm:p-6 md:p-10">
        <header className="mb-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1>
                <MayaLockup height={36} />
              </h1>
              <p className="mt-3 text-sm text-slate-300">
                Machine Assisted Yield Automation
              </p>
              <p className="text-sm text-slate-500">
                Dynamic Pricing That Leaves You In Control
              </p>
            </div>
            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end">
              {commandCenter ? (
                <a
                  href="/admin"
                  className="w-full cursor-pointer rounded border border-slate-700 px-3 py-2 text-center text-sm text-slate-200 hover:bg-slate-800 sm:w-auto"
                >
                  Command Center
                </a>
              ) : null}
              <HelpLink
                screen={tab === "rules" && ruleFormOpen ? "rules.builder" : tab}
                className="w-full cursor-pointer rounded border border-slate-700 px-3 py-2 text-center text-sm text-slate-200 hover:bg-slate-800 sm:w-auto"
              />
              <button
                ref={settingsButtonRef}
                type="button"
                aria-label="Settings"
                title="Settings"
                aria-haspopup="dialog"
                onClick={() => setSettingsOpen(true)}
                className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 sm:w-auto sm:self-stretch sm:px-2.5"
              >
                <SettingsIcon aria-hidden className="size-4" />
                <span className="sm:sr-only">Settings</span>
              </button>
              <a
                href="/account/billing"
                className="w-full cursor-pointer rounded border border-slate-700 px-3 py-2 text-center text-sm text-slate-200 hover:bg-slate-800 sm:w-auto"
              >
                Billing
              </a>
              <a
                href="/account/team"
                className="w-full cursor-pointer rounded border border-slate-700 px-3 py-2 text-center text-sm text-slate-200 hover:bg-slate-800 sm:w-auto"
              >
                Team
              </a>
              <form action="/auth/logout" method="post">
                <button
                  type="submit"
                  className="w-full cursor-pointer rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 sm:w-auto"
                >
                  Sign Out
                </button>
              </form>
            </div>
          </div>
        </header>

        {supportView === "read_only" ? (
          <p className="mb-6 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-300">
            You are viewing this property as MAYA support. Turn on God Mode from the Command Center to
            change anything here.
          </p>
        ) : null}

        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
          <nav className="flex flex-wrap gap-2">
            {tabs.map((item) => (
              <button
                key={item.key}
                className={`cursor-pointer rounded-md px-4 py-2 text-sm font-medium transition ${
                  tab === item.key
                    ? "bg-sky-500 text-slate-950"
                    : "bg-slate-800 hover:bg-slate-700"
                }`}
                onClick={() => {
                  setTab(item.key);
                  track("dashboard.tab_opened", { tab: item.key });
                }}
              >
                {item.label}
              </button>
            ))}
          </nav>
          {accessibleHotels.length > 0 ? (
            <div className="sm:shrink-0">
              <PropertySelect
                id="header-property"
                options={accessibleHotels}
                value={activeHotelId}
                disabled={hotelSwitching}
                onValueChange={(id) => void applyActiveHotel(id)}
              />
              {switchError ? (
                <p role="alert" className="mt-1 max-w-xs text-xs text-rose-300">
                  {switchError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <BillingBanner hotelId={activeHotelId} />

        {pmsActivity?.connection && pmsActivity.pms ? (
          <div className="mb-6">
            <PmsReconnect
              hotelId={activeHotelId}
              pmsType={pmsActivity.connection.pms_type}
              status={pmsActivity.connection.status ?? "unknown"}
              authKind={pmsActivity.pms.authKind}
              displayName={pmsActivity.pms.displayName}
              canManage={pmsActivity.pms.canManage}
              historyRemoved={pmsActivity.historyRemoved === true}
              placement="banner"
            />
          </div>
        ) : null}

        <OnboardingReviewBanner hotelId={activeHotelId} />

        <RuleAlertBanner
          activeHotelId={activeHotelId}
          onAskForLimits={() => {
            setTab("rules");
            track("dashboard.tab_opened", { tab: "rules" });
          }}
          openAlertId={arrival?.dest === "adjusting" ? (arrival.params.alert ?? null) : null}
        />

        <ArrivalNote note={arrivalNote} onClose={() => setArrivalNote(null)} />

        {tab === "calendar" && (
          <section className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-[8px] sm:p-5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <button
                className="cursor-pointer rounded bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700"
                onClick={() => {
                  const m = month - 1;
                  if (m < 1) {
                    setMonth(12);
                    setYear((y) => y - 1);
                  } else {
                    setMonth(m);
                  }
                }}
              >
                Prev
              </button>
              <div className="flex items-center gap-1.5">
                <select
                  aria-label="Month"
                  value={month}
                  onChange={(e) => {
                    setSelectedDay(null);
                    setMonth(Number(e.target.value));
                  }}
                  className="cursor-pointer rounded bg-slate-800 px-2 py-1.5 text-sm font-semibold hover:bg-slate-700"
                >
                  {MONTH_NAMES.map((name, i) => (
                    <option key={name} value={i + 1}>
                      {name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Year"
                  value={year}
                  onChange={(e) => {
                    setSelectedDay(null);
                    setYear(Number(e.target.value));
                  }}
                  className="cursor-pointer rounded bg-slate-800 px-2 py-1.5 text-sm font-semibold hover:bg-slate-700"
                >
                  {calendarYears.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </div>
              <button
                className="cursor-pointer rounded bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700"
                onClick={() => {
                  const m = month + 1;
                  if (m > 12) {
                    setMonth(1);
                    setYear((y) => y + 1);
                  } else {
                    setMonth(m);
                  }
                }}
              >
                Next
              </button>
              <span
                className="ml-auto text-xs text-slate-500"
                title="Updates the moment prices or bookings change"
              >
                {lastUpdated
                  ? `Updated ${lastUpdated.toLocaleTimeString()} · live`
                  : "Loading…"}
              </span>
            </div>

            <div className="flex flex-col gap-3 lg:flex-row lg:gap-4">
              <CalendarColorKey mode={keyMode} display={calendarDisplay} />
              <div className="min-w-0 flex-1">
                {calendarBusy ? (
                  <CalendarMonthSkeleton year={year} month={month} />
                ) : calendar ? (
                  // px on a phone, like the padding around it: see CalendarDayCell.
                  <div className="grid grid-cols-7 gap-[4px] sm:gap-2">
                    {Array.from({ length: calendar.first_weekday }).map((_, idx) => (
                      <div key={`empty-${idx}`} />
                    ))}
                    {Array.from({ length: calendar.days_in_month }).map((_, idx) => {
                      const day = idx + 1;
                      return (
                        <CalendarDayCell
                          key={day}
                          day={day}
                          data={calendar.days[String(day)]}
                          display={calendarDisplay}
                          symbol={currencySymbol}
                          priceRoomTypeName={priceName}
                          selected={selectedDay === day}
                          onSelect={() => setSelectedDay(day)}
                        />
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>

            {!calendarBusy && calendar ? (
              <>

                  {selectedDay &&
                  calendar.year === year &&
                  calendar.month === month &&
                  calendar.days[String(selectedDay)] ? (
                    <div className="rounded-md border border-slate-800 bg-slate-950 p-4" data-deeplink="calendar.day">
                      <h3 className="mb-2 text-base font-semibold">
                        {calendar.days[String(selectedDay)].weekday},{" "}
                        {formatUtcLongDate(year, month, selectedDay)}
                      </h3>
                      <p className="mb-4 text-sm text-slate-400">
                        {calendar.days[String(selectedDay)].booked}/
                        {calendar.days[String(selectedDay)].total} rooms ·{" "}
                        {calendar.days[String(selectedDay)].occupancy_pct}%
                        sellable occupancy ·{" "}
                        {isFutureDay(year, month, selectedDay)
                          ? "revenue on the books"
                          : "revenue"}{" "}
                        <span className="font-medium text-slate-200">
                          {currencySymbol}
                          {calendar.days[
                            String(selectedDay)
                          ].revenue.toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </span>
                      </p>
                      <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                        {calendar.days[String(selectedDay)].room_types.map(
                          (rt) => (
                            <div
                              key={rt.id}
                              className="rounded border border-slate-800 p-3"
                              data-deeplink={`calendar.room-type:${rt.id}`}
                            >
                              <p className="flex flex-wrap items-center gap-2 font-medium">
                                {rt.name}
                                {rt.manual_price ? (
                                  <span
                                    className="rounded-full border border-amber-500/60 bg-amber-500/10 px-2 py-0.5 text-[0.6875rem] font-semibold text-amber-300"
                                    title={`${rt.manual_price.source === "pms" ? "Seen" : "Set"} ${formatFriendlyDateTime(rt.manual_price.set_at)}`}
                                  >
                                    {manualPriceBadge(
                                      rt.manual_price,
                                      rt.manual_price.pms_type
                                        ? formatPmsName(rt.manual_price.pms_type)
                                        : pmsActivity?.connection
                                          ? formatPmsName(pmsActivity.connection.pms_type)
                                          : "your PMS",
                                      currencySymbol,
                                    )}
                                  </span>
                                ) : null}
                              </p>
                              <p className="mt-1 text-sm text-slate-300">
                                Booked {rt.booked}/{rt.total_rooms}
                              </p>
                              <p className="text-sm text-slate-300">
                                ADR {rt.rate != null ? `${currencySymbol}${rt.rate.toFixed(2)}` : "–"}
                              </p>
                              <p className="text-sm text-sky-300">
                                Current price{" "}
                                {(rt.current_rate ?? rt.current_price) != null
                                  ? `${currencySymbol}${(rt.current_rate ?? rt.current_price)!.toFixed(2)}`
                                  : "–"}
                              </p>
                              {rt.rate_removed_in_pms && (rt.current_rate ?? rt.current_price) == null ? (
                                <RemovedRateLine
                                  pmsName={pmsActivity?.connection ? formatPmsName(pmsActivity.connection.pms_type) : "your PMS"}
                                  simulating={propertyMode === "simulation"}
                                />
                              ) : rt.no_rate_in_pms && (rt.current_rate ?? rt.current_price) == null ? (
                                <NoRateLine
                                  pmsName={pmsActivity?.connection ? formatPmsName(pmsActivity.connection.pms_type) : "your PMS"}
                                  simulating={propertyMode === "simulation"}
                                />
                              ) : null}
                              <p className="text-sm text-slate-300">
                                Revenue {currencySymbol}{rt.revenue.toFixed(2)}
                              </p>
                              {activeHotelId ? (
                                <div data-deeplink={`calendar.price:${rt.id}`}>
                                <ManualPriceEditor
                                  key={`${activeHotelId}|${year}-${month}-${selectedDay}|${rt.id}`}
                                  hotelId={activeHotelId}
                                  roomTypeId={rt.id}
                                  roomTypeName={rt.name}
                                  stayDate={isoDate(year, month, selectedDay)}
                                  currentPrice={rt.current_rate ?? rt.current_price ?? null}
                                  currencySymbol={currencySymbol}
                                  manualPrice={rt.manual_price ?? null}
                                  pmsName={
                                    rt.manual_price?.pms_type
                                      ? formatPmsName(rt.manual_price.pms_type)
                                      : pmsActivity?.connection
                                        ? formatPmsName(pmsActivity.connection.pms_type)
                                        : "your PMS"
                                  }
                                  onSaved={() => {
                                    // The realtime subscription will catch
                                    // this too, but the person who just hit
                                    // Save shouldn't wait out the debounce.
                                    calendarCacheRef.current.clear();
                                    void reloadCalendarQuiet();
                                  }}
                                  hotelToday={calendar.today ?? null}
                                  initialThrough={
                                    arrival?.dest === "calendar.manual-price" &&
                                    arrival.params.roomType === rt.id &&
                                    arrival.params.date === isoDate(year, month, selectedDay)
                                      ? (arrival.params.through ?? null)
                                      : null
                                  }
                                />
                                </div>
                              ) : null}
                            </div>
                          ),
                        )}
                      </div>
                    </div>
                  ) : null}
              </>
            ) : null}
          </section>
        )}

        {tab === "rules" && (
          <section className="space-y-5 rounded-lg border border-slate-800 bg-slate-900 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-4">
                <h2 className="text-lg font-semibold">Pricing Rules</h2>
                <span data-deeplink="rules.suggestions" className="inline-flex">
                  <AskForHelp />
                </span>
              </div>
              <div className="flex items-center gap-1 rounded-full border border-slate-800 bg-slate-950 p-1">
                {(["all", "enabled", "disabled"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setRuleFilter(f)}
                    className={`cursor-pointer rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
                      ruleFilter === f
                        ? "bg-slate-700 text-slate-100"
                        : "text-slate-500 hover:text-slate-300"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            <RuleBehaviorAnimations />

            <div className="overflow-x-auto">
              <table className="w-full min-w-[45rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-left text-slate-300">
                    <th className="py-2">Name</th>
                    <th className="py-2">
                      <span className="flex items-center gap-1.5">
                        Fired
                        <RoomCountHelp {...RULE_FIRES_HELP} docs="rule-fires" />
                      </span>
                    </th>
                    <th className="py-2">Conditions</th>
                    <th className="py-2">Room Types</th>
                    <th className="py-2">Price Change</th>
                    <th className="py-2">Status</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {rules
                    .filter((rule) =>
                      ruleFilter === "all"
                        ? true
                        : ruleFilter === "enabled"
                          ? rule.enabled
                          : !rule.enabled,
                    )
                    .sort(
                      (a, b) =>
                        (fireCounts[b.id] ?? 0) - (fireCounts[a.id] ?? 0) ||
                        Number(b.enabled) - Number(a.enabled) ||
                        a.rule_name.localeCompare(b.rule_name),
                    )
                    .map((rule) => (
                    <tr
                      key={rule.id}
                      className={`border-b border-slate-800 ${editing?.id === rule.id ? "bg-sky-500/10" : ""}`}
                      data-deeplink={`rules.row:${rule.id}`}
                    >
                      <td className="py-2 pr-3 font-medium text-slate-200">
                        {rule.rule_name}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {fireCounts[rule.id] ? (
                          <RuleFireCount
                            ruleId={rule.id}
                            ruleName={rule.rule_name}
                            count={fireCounts[rule.id]}
                            onCount={(n) => setFireCounts((c) => ({ ...c, [rule.id]: n }))}
                          />
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        {formatRuleConditionsDisplay(rule.conditions)}
                      </td>
                      <td className="py-2 pr-3">
                        {ruleRoomTypesLabel(rule, isCountingRoomTypeId)}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {rule.action.adjust_rate_percent !== undefined &&
                          `${rule.action.adjust_rate_percent > 0 ? "+" : ""}${rule.action.adjust_rate_percent}% `}
                        {rule.action.adjust_rate_dollars !== undefined &&
                          `${rule.action.adjust_rate_dollars < 0 ? "-" : "+"}$${Math.abs(rule.action.adjust_rate_dollars)}`}
                      </td>
                      <td className="py-2 pr-3">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={rule.enabled}
                          aria-label={`${rule.enabled ? "Disable" : "Enable"} ${rule.rule_name}`}
                          onClick={() => void onToggleRule(rule)}
                          className="group inline-flex cursor-pointer items-center gap-2"
                        >
                          <span
                            className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${
                              rule.enabled ? "bg-emerald-500" : "bg-slate-700"
                            }`}
                          >
                            <span
                              className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform ${
                                rule.enabled ? "translate-x-[1.125rem]" : "translate-x-0.5"
                              }`}
                            />
                          </span>
                          <span
                            className={`text-xs font-medium ${
                              rule.enabled ? "text-emerald-300" : "text-slate-500"
                            }`}
                          >
                            {rule.enabled ? "On" : "Off"}
                          </span>
                        </button>
                        {(() => {
                          const stops = ruleStops.find((s) => s.rule_id === rule.id);
                          if (!stops || stops.nights.length === 0) return null;
                          return (
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[0.6875rem] font-medium text-amber-200">
                                {stoppedChipLabel(stops.nights.length)}
                              </span>
                              <RoomCountHelp {...stoppedNightsHelp(stops.nights, rule.undo_on_cancellation !== false)} docs="stopped-nights" />
                              <button
                                type="button"
                                disabled={lettingRun !== null}
                                onClick={() => void letRuleRunAgain(stops)}
                                className="cursor-pointer text-[0.6875rem] font-medium text-sky-400 underline hover:text-sky-300 disabled:cursor-default disabled:opacity-60"
                              >
                                Let it run again
                              </button>
                            </div>
                          );
                        })()}
                        {ruleSwitchError?.ruleId === rule.id ? (
                          <p className="mt-1 max-w-[16rem] text-[0.6875rem] text-rose-400">{ruleSwitchError.message}</p>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="cursor-pointer rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                            aria-label={`Edit ${rule.rule_name}`}
                            onClick={() => void startEdit(rule.id)}
                          >
                            Edit
                          </button>
                          <button
                            className="cursor-pointer rounded bg-rose-700 px-2 py-1 text-xs hover:bg-rose-600"
                            onClick={() => setPendingDelete(rule)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="rounded border border-slate-800 bg-slate-950/40" data-deeplink="rules.builder">
              <button
                type="button"
                onClick={() => {
                  if (ruleFormOpen) setBuilderFilled(false);
                  setRuleFormOpen((o) => !o);
                }}
                aria-expanded={ruleFormOpen}
                className="flex w-full cursor-pointer items-center justify-between px-4 py-3 text-left"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-slate-300">
                  {editing ? `Edit \u201c${editing.name}\u201d` : "+ Add a rule"}
                  <FilledChip show={builderFilled && ruleFormOpen} />
                </span>
                <span
                  className={`text-slate-500 transition-transform duration-200 ${
                    ruleFormOpen ? "rotate-180" : ""
                  }`}
                  aria-hidden
                >
                  ▾
                </span>
              </button>
              {ruleFormOpen ? (
            <form
              onSubmit={onCreateRule}
              className="space-y-4 border-t border-slate-800 p-4"
            >
              <div className="grid gap-3 md:grid-cols-2">
                <div className="md:col-span-2" data-deeplink="rules.builder.name">
                  <label className="mb-1 block text-xs font-medium text-slate-400">
                    Rule name
                  </label>
                  <input
                    value={ruleName}
                    onChange={(e) => setRuleName(e.target.value)}
                    placeholder="e.g. Weekend surge"
                    className="w-full rounded bg-slate-950 p-2 text-sm"
                    required
                  />
                </div>

                <div className="md:col-span-2" data-deeplink="rules.builder.conditions">
                  <p className="mb-2 text-xs font-medium text-slate-400">
                    Conditions
                  </p>
                  <p className="mb-3 text-xs text-slate-500">
                    Matches when <span className="text-slate-400">all</span> of
                    the following are true.
                  </p>
                  <div className="flex flex-col gap-3">
                    {condRows.map((row) => {
                      const taken = new Set(
                        condRows
                          .filter((r) => r.id !== row.id)
                          .map((r) => r.metric),
                      );
                      // A rule with both conditions waits the longer of the
                      // booking speed wait and the pickup wait (the one
                      // chosen, or the lookback window: the engine's
                      // ruleWaitDays), so the wait shown is that one.
                      const pickupRow = condRows.find((r) => r.metric === "pickup");
                      const speedRow = condRows.find((r) => r.metric === "booking_speed");
                      const waitInput = {
                        hasBookingSpeed: speedRow !== undefined,
                        cooldownDays: speedRow?.booking_speed_cooldown_days ?? null,
                        hasPickup: pickupRow !== undefined,
                        pickupWindowDays: pickupRow?.pickup_window_days ?? null,
                        pickupCooldownDays: pickupRow?.pickup_cooldown_days ?? null,
                        pickupLow:
                          pickupRow !== undefined && pickupCountsLow(pickupRow.operator, Number(pickupRow.value)),
                      };
                      const waitLabel = waitDaysLabel(eventRuleWaitDays(waitInput));
                      const pickupDecides = pickupSetsWait(waitInput);
                      const pickupWait = pickupOwnWait(waitInput);
                      return (
                        <div
                          key={row.id}
                          className="rounded border border-slate-800 bg-slate-950/80 p-3"
                        >
                          <div className="grid gap-2 sm:grid-cols-[minmax(0,16rem)_minmax(0,10rem)_minmax(0,10rem)_auto] sm:items-end">
                            <div className="min-w-0">
                              <div className="mb-0.5 flex items-center gap-1.5">
                                <label className="block text-[0.6875rem] text-slate-500">
                                  Metric
                                </label>
                                {row.prefilled === "far_out_cut" ? (
                                  <RoomCountHelp {...FAR_OUT_CUT_GUARD_HELP} />
                                ) : null}
                              </div>
                              <select
                                value={row.metric}
                                className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm"
                                onChange={(e) => {
                                  const m = e.target.value as ConditionMetric;
                                  updateCondRow(row.id, {
                                    metric: m,
                                    value:
                                      m === "occupancy"
                                        ? "80"
                                        : m === "booking_window"
                                          ? "7"
                                          : "5",
                                    pickup_window_days: 3,
                                    pickup_metric: "room_nights",
                                    booking_speed_level: "faster",
                                    booking_speed_window_days: 7,
                                    booking_speed_operator: undefined,
                                    // Another metric: the owner's row now.
                                    prefilled: undefined,
                                  });
                                }}
                              >
                                <option
                                  value="occupancy"
                                  disabled={taken.has("occupancy")}
                                >
                                  Sellable occupancy (%)
                                </option>
                                <option
                                  value="booking_speed"
                                  disabled={taken.has("booking_speed")}
                                >
                                  Booking speed (recommended)
                                </option>
                                <option
                                  value="booking_window"
                                  disabled={taken.has("booking_window")}
                                >
                                  Booking window (days to stay)
                                </option>
                                <option
                                  value="pickup"
                                  disabled={taken.has("pickup")}
                                >
                                  Pickup count (advanced)
                                </option>
                              </select>
                            </div>
                            {row.metric === "booking_speed" ? (
                              <div className="sm:col-span-2">
                                <label className="mb-0.5 block text-[0.6875rem] text-slate-500">
                                  Speed
                                </label>
                                <select
                                  value={row.booking_speed_level}
                                  className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm"
                                  onChange={(e) =>
                                    updateCondRow(row.id, {
                                      booking_speed_level: e.target.value,
                                      // A new level takes the compare its side of Normal gives.
                                      booking_speed_operator: undefined,
                                    })
                                  }
                                >
                                  {BOOKING_SPEED_LEVELS.map((l) => (
                                    <option key={l.key} value={l.key}>
                                      {l.rank < 0 && l.rank > -3
                                        ? `${l.label}`
                                        : l.rank > 0 && l.rank < 3
                                          ? `${l.label}`
                                          : l.rank === 0
                                            ? `${l.label}`
                                            : l.label}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            ) : (
                              <>
                                <div>
                                  <label className="mb-0.5 block text-[0.6875rem] text-slate-500">
                                    Compare
                                  </label>
                                  <select
                                    value={row.operator}
                                    className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm"
                                    onChange={(e) =>
                                      updateCondRow(row.id, {
                                        operator: e.target.value as "gt" | "lt",
                                      })
                                    }
                                  >
                                    <option value="gt">Greater than</option>
                                    <option value="lt">Less than</option>
                                  </select>
                                </div>
                                <div>
                                  <label className="mb-0.5 block text-[0.6875rem] text-slate-500">
                                    Threshold
                                  </label>
                                  <input
                                    type="number"
                                    step="any"
                                    min="0"
                                    required
                                    className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm"
                                    value={row.value}
                                    onChange={(e) =>
                                      updateCondRow(row.id, {
                                        value: e.target.value,
                                      })
                                    }
                                  />
                                </div>
                              </>
                            )}
                            <div className="flex justify-end sm:justify-end">
                              <button
                                type="button"
                                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full border border-red-800 bg-transparent text-lg leading-none text-red-800 hover:bg-red-950/30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-red-800"
                                onClick={() => removeConditionRow(row.id)}
                                aria-label="Remove condition"
                              >
                                ×
                              </button>
                            </div>
                          </div>
                          {row.metric === "pickup" ? (
                            <div className="mt-3 grid gap-2 border-t border-slate-800 pt-3 sm:grid-cols-3">
                              <div>
                                <div className="mb-0.5 flex items-center gap-1.5">
                                  <label className="block text-[0.6875rem] text-slate-500">
                                    Lookback window
                                  </label>
                                  <RoomCountHelp
                                    {...pickupWindowHelp(
                                      row.pickup_window_days,
                                      pickupCountsLow(row.operator, Number(row.value)),
                                    )}
                                  />
                                </div>
                                <select
                                  className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm"
                                  value={String(row.pickup_window_days)}
                                  onChange={(e) =>
                                    updateCondRow(row.id, {
                                      pickup_window_days: Number(
                                        e.target.value,
                                      ) as 1 | 3 | 7,
                                    })
                                  }
                                >
                                  <option value="1">1 day</option>
                                  <option value="3">3 days</option>
                                  <option value="7">7 days</option>
                                </select>
                              </div>
                              <PickupWaitField
                                id={`pickup-wait-${row.id}`}
                                value={row.pickup_cooldown_days}
                                windowDays={row.pickup_window_days}
                                lowPickup={pickupCountsLow(row.operator, Number(row.value))}
                                bookingSpeedCooldownDays={speedRow?.booking_speed_cooldown_days}
                                onChange={(days) =>
                                  updateCondRow(row.id, { pickup_cooldown_days: days })
                                }
                              />
                              <div>
                                <label className="mb-0.5 block text-[0.6875rem] text-slate-500">
                                  Pickup measures
                                </label>
                                <select
                                  className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm"
                                  value={row.pickup_metric}
                                  onChange={(e) =>
                                    updateCondRow(row.id, {
                                      pickup_metric: e.target.value as
                                        | "room_nights"
                                        | "revenue",
                                    })
                                  }
                                >
                                  <option value="room_nights">
                                    Room nights (units)
                                  </option>
                                  <option value="revenue">
                                    Revenue (currency)
                                  </option>
                                </select>
                              </div>
                            </div>
                          ) : null}
                          {row.metric === "booking_speed" ? (
                            <div className="mt-3 grid gap-2 border-t border-slate-800 pt-3 sm:grid-cols-2">
                              <div>
                                <div className="mb-0.5 flex items-center gap-1.5">
                                  <label className="block text-[0.6875rem] text-slate-500">
                                    Measured over
                                  </label>
                                  <RoomCountHelp
                                    {...bookingSpeedHelp(row.booking_speed_window_days)}
                                    docs="booking-speed"
                                  />
                                </div>
                                <select
                                  className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm"
                                  value={String(row.booking_speed_window_days)}
                                  onChange={(e) =>
                                    updateCondRow(row.id, {
                                      booking_speed_window_days: Number(
                                        e.target.value,
                                      ) as 1 | 7 | 30,
                                    })
                                  }
                                >
                                  <option value="1">Past day</option>
                                  <option value="7">Past week</option>
                                  <option value="30">Past month</option>
                                </select>
                              </div>
                              <div>
                                <div className="mb-0.5 flex items-center gap-1.5">
                                  <label
                                    htmlFor={`wait-${row.id}`}
                                    className="block text-[0.6875rem] text-slate-500"
                                  >
                                    Then waits (advanced)
                                  </label>
                                  <RoomCountHelp
                                    {...bookingSpeedWaitHelp(
                                      waitLabel,
                                      pickupDecides && pickupRow?.pickup_cooldown_days == null
                                        ? waitLabel
                                        : null,
                                      pickupDecides && pickupRow?.pickup_cooldown_days != null
                                        ? waitLabel
                                        : null,
                                    )}
                                    docs="booking-speed-wait"
                                  />
                                </div>
                                <select
                                  id={`wait-${row.id}`}
                                  className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm"
                                  value={String(row.booking_speed_cooldown_days)}
                                  onChange={(e) =>
                                    updateCondRow(row.id, {
                                      booking_speed_cooldown_days: Number(
                                        e.target.value,
                                      ) as BookingSpeedWaitDays,
                                    })
                                  }
                                >
                                  {BOOKING_SPEED_WAIT_OPTIONS.map((o) => (
                                    <option key={o.days} value={o.days}>
                                      {o.label}
                                      {pickupWait > o.days
                                        ? ` (pickup holds it to ${waitDaysLabel(pickupWait)})`
                                        : ""}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                  {condRows.length < 4 ? (
                    <button
                      type="button"
                      className="mt-2 text-xs font-medium text-sky-400 hover:text-sky-300"
                      onClick={addConditionRow}
                    >
                      + Add condition
                    </button>
                  ) : null}
                </div>

                <div className="md:col-span-2" data-deeplink="rules.builder.adjustment">
                  <p className="mb-2 text-xs font-medium text-slate-400">
                    Rate adjustment
                  </p>
                  <div className="space-y-3 rounded border border-slate-800 bg-slate-950/80 p-3">
                    <div>
                      <label className="mb-0.5 block text-[0.6875rem] text-slate-500">
                        Direction (required)
                      </label>
                      <select
                        required
                        value={adjDirection}
                        className="w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm"
                        onChange={(e) =>
                          setAdjDirection(
                            e.target.value as "" | "increase" | "decrease",
                          )
                        }
                      >
                        <option value="" disabled>
                          Choose: increase or decrease the rate…
                        </option>
                        <option value="increase">Increase the rate</option>
                        <option value="decrease">Decrease the rate</option>
                      </select>
                    </div>
                    <div
                      className={`flex flex-wrap items-center gap-3 ${percentLocked ? "opacity-40" : ""}`}
                    >
                      <label htmlFor="rule-adjust-percent" className="text-sm text-slate-300 sm:w-48">
                        Adjust by percent (%)
                      </label>
                      <input
                        id="rule-adjust-percent"
                        type="number"
                        step="any"
                        min="0"
                        disabled={percentLocked}
                        value={adjPercent}
                        onChange={(e) => setAdjPercent(e.target.value)}
                        placeholder="e.g. 10"
                        className="min-w-32 flex-1 rounded border border-slate-700 bg-slate-950 p-2 text-sm disabled:cursor-not-allowed"
                      />
                    </div>
                    <p className="text-[0.6875rem] text-slate-500">or</p>
                    <div
                      className={`flex flex-wrap items-center gap-3 ${dollarsLocked ? "opacity-40" : ""}`}
                    >
                      <label htmlFor="rule-adjust-fixed" className="text-sm text-slate-300 sm:w-48">
                        Adjust by fixed amount ($)
                      </label>
                      <input
                        id="rule-adjust-fixed"
                        type="number"
                        step="any"
                        min="0"
                        disabled={dollarsLocked}
                        value={adjDollars}
                        onChange={(e) => setAdjDollars(e.target.value)}
                        placeholder="e.g. 15"
                        className="min-w-32 flex-1 rounded border border-slate-700 bg-slate-950 p-2 text-sm disabled:cursor-not-allowed"
                      />
                    </div>
                    <div className="border-t border-slate-800 pt-3">
                      <UndoOnCancellationField checked={undoOnCancellation} onChange={setUndoOnCancellation} />
                    </div>
                  </div>
                </div>

                <div className="md:col-span-2" data-deeplink="rules.builder.room-types">
                  <RuleRoomTypesField
                    options={roomTypeOptions}
                    selected={selectedRoomTypeIds}
                    onSelected={setSelectedRoomTypeIds}
                    split={splitRoomTypeSets}
                    onSplit={setSplitRoomTypeSets}
                    changeIds={changeRoomTypeIds}
                    onChangeIds={setChangeRoomTypeIds}
                  />
                </div>
              </div>

              {ruleFormError ? (
                <p className="text-sm text-rose-400">
                  {ruleFormError}
                  {ruleFormReload && editing ? (
                    <button
                      type="button"
                      onClick={() => void startEdit(editing.id)}
                      className="ml-2 cursor-pointer text-sky-400 underline hover:text-sky-300"
                    >
                      Reload
                    </button>
                  ) : null}
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-4">
                <button
                  type="submit"
                  disabled={activation !== null}
                  className="cursor-pointer rounded bg-sky-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:cursor-default disabled:opacity-60"
                >
                  {editing ? "Save changes" : "Add Rule"}
                </button>
                {editing ? (
                  <button
                    type="button"
                    onClick={cancelEditing}
                    className="cursor-pointer text-sm text-slate-400 underline hover:text-slate-200"
                  >
                    Cancel editing
                  </button>
                ) : null}
              </div>
            </form>
              ) : null}
            </div>
          </section>
        )}

        {tab === "simulator" && (
          <RateSimulator
            // a link's test rule arrives after the first paint; remounting takes it in
            key={arrival?.dest === "simulator.test-rule" ? "linked" : "plain"}
            activeHotelId={activeHotelId}
            onRuleSaved={reloadRules}
            draftOpenAtStart={panel === "test-rule"}
            onDraftOpenChange={(open) => setPanel(open ? "test-rule" : null)}
            initialDraft={arrival?.dest === "simulator.test-rule" ? testRuleFill(arrival.params) : null}
          />
        )}

        {tab === "changelog" && (
          <section className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Change Log</h2>
              <button
                className="cursor-pointer rounded bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700"
                onClick={() => setChangesOnly((v) => !v)}
              >
                {changesOnly ? "Show All Cycles" : "Show Changes Only"}
              </button>
            </div>
            <div data-deeplink="changelog.corrections">
              <CorrectionsPanel
                initialOpen={panel === "corrections"}
                onOpenChange={(open) => setPanel(open ? "corrections" : null)}
              />
            </div>
            {changelogError ? (
              <p className="text-sm text-rose-300">
                {changelogError}{" "}
                <button
                  className="cursor-pointer text-sky-400 underline decoration-dotted hover:text-sky-300"
                  onClick={() => void reloadChangelog()}
                >
                  Try again
                </button>
              </p>
            ) : null}
            <div className="space-y-2">
              {visibleCycles.map((cycle) => {
                if (isPushProblem(cycle)) {
                  return (
                    <PushProblemItem
                      key={`push-${cycle.id}`}
                      item={cycle}
                      formatWhen={formatFriendlyDateTime}
                      formatAge={formatRelativeAge}
                      formatExact={formatDisplayTime}
                    />
                  );
                }
                const whenRelative = formatRelativeAge(cycle.timestamp);
                if (isSupportChange(cycle)) {
                  return (
                    <SupportChangeItem
                      key={`support-${cycle.id}`}
                      item={cycle}
                      formatWhen={formatFriendlyDateTime}
                      formatAge={formatRelativeAge}
                      formatExact={formatDisplayTime}
                    />
                  );
                }
                if (isModeSwitch(cycle)) {
                  return (
                    <ModeSwitchItem
                      key={`mode-${cycle.id}`}
                      item={cycle}
                      formatWhen={formatFriendlyDateTime}
                      formatAge={formatRelativeAge}
                      formatExact={formatDisplayTime}
                    />
                  );
                }
                if (isPmsChange(cycle)) {
                  return (
                    <PmsChangeItem
                      key={`pms-change-${cycle.id}`}
                      item={cycle}
                      formatWhen={formatFriendlyDateTime}
                      formatAge={formatRelativeAge}
                      formatExact={formatDisplayTime}
                      onOpenSetting={openPmsSetting}
                    />
                  );
                }
                if (isRuleAlertChoice(cycle)) {
                  return (
                    <div key={`alert-${cycle.id}`} className="rounded border border-slate-800 p-3">
                      <p className="text-xs text-slate-400">
                        <time
                          dateTime={cycle.timestamp}
                          title={formatDisplayTime(cycle.timestamp)}
                          className="not-italic"
                        >
                          <span className="font-medium text-slate-300">
                            {cycle.by_support ? "MAYA support's answer" : "Your answer"}
                          </span>
                          <span className="text-slate-500"> · </span>
                          <span>{formatFriendlyDateTime(cycle.timestamp)}</span>
                          {whenRelative ? (
                            <span className="text-slate-500"> ({whenRelative})</span>
                          ) : null}
                        </time>
                      </p>
                      <p className="mt-1 text-[0.8125rem] leading-relaxed text-slate-300">{cycle.title}</p>
                    </div>
                  );
                }
                if (isQuietChecks(cycle) || !cycle.has_changes) {
                  // A run with nothing to change reads like a stretch of one.
                  const quiet = isQuietChecks(cycle)
                    ? cycle
                    : {
                        kind: "quiet_checks" as const,
                        id: `run-${cycle.timestamp}`,
                        timestamp: cycle.timestamp,
                        first_at: cycle.timestamp,
                        checks: 1,
                      };
                  return (
                    <QuietChecksLine
                      key={`quiet-${quiet.id}`}
                      item={quiet}
                      formatAge={formatRelativeAge}
                      formatExact={formatDisplayTime}
                    />
                  );
                }
                return (
                  <PricingRunItem
                    key={`run-${cycle.timestamp}`}
                    cycle={cycle}
                    formatWhen={formatFriendlyDateTime}
                    formatAge={formatRelativeAge}
                    formatExact={formatDisplayTime}
                    drilldownOpen={linkedDrilldown}
                  />
                );
              })}
            </div>
            {changelog.length > 0 ? (
              <OlderButton
                hasOlder={changelogPages.older != null}
                busy={changelogPages.olderBusy}
                error={changelogPages.olderError}
                endLine={changelogPages.pagedBack ? "Nothing older. History is kept for 90 days." : null}
                onOlder={() => void changelogPages.loadOlder()}
              />
            ) : null}
          </section>
        )}

        {tab === "pms" && (
          <section className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-lg font-semibold">
              Property System
              {pmsActivity?.connection
                ? ` (${formatPmsName(pmsActivity.connection.pms_type)})`
                : ""}
            </h2>
            <p className="text-sm text-slate-300">
              Bookings sync automatically on a schedule. This page shows how
              that connection is doing.
            </p>
            {!activeHotelId ? (
              <p className="text-sm text-slate-400">
                Select a property to view status.
              </p>
            ) : pmsActivity === null ? (
              <p className="text-sm text-slate-400">Loading connection status…</p>
            ) : !pmsActivity.connection ? (
              <p className="text-sm text-amber-200/90">
                No property system is connected for this property yet.
              </p>
            ) : (
              <>
                {pmsActivity.pms ? (
                  <PmsReconnect
                    hotelId={activeHotelId}
                    pmsType={pmsActivity.connection.pms_type}
                    status={pmsActivity.connection.status ?? "unknown"}
                    authKind={pmsActivity.pms.authKind}
                    displayName={pmsActivity.pms.displayName}
                    canManage={pmsActivity.pms.canManage}
                    historyRemoved={pmsActivity.historyRemoved === true}
                  />
                ) : null}
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5 rounded border border-slate-800 bg-slate-950 p-4">
                    <div className="text-xs text-slate-500">Connection</div>
                    <PmsStatusBadge status={pmsActivity.connection.status} />
                  </div>
                  <div className="space-y-1.5 rounded border border-slate-800 bg-slate-950 p-4">
                    <div className="text-xs text-slate-500">
                      Health (last 24 hours)
                    </div>
                    {pmsActivity.requestsTracked === false ? (
                      <div className="text-sm text-slate-400">Not tracked for this system</div>
                    ) : (
                      <PmsHealthBadge health={pmsActivity.health} />
                    )}
                  </div>
                  <div className="space-y-1.5 rounded border border-slate-800 bg-slate-950 p-4">
                    <div className="text-xs text-slate-500">Last sync</div>
                    <div className="text-sm text-slate-200">
                      {pmsActivity.connection.last_sync_at
                        ? formatDisplayTime(pmsActivity.connection.last_sync_at)
                        : "–"}
                    </div>
                  </div>
                </div>

                <div className="rounded border border-slate-800 bg-slate-950">
                  <div className="border-b border-slate-800 px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-slate-400">
                    Recent requests to {formatPmsName(pmsActivity.connection.pms_type)}
                  </div>
                  {pmsActivity.requestsTracked === false ? (
                    <p className="px-4 py-3 text-sm text-slate-500">Not tracked for this system</p>
                  ) : pmsActivity.log.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-slate-500">
                      No requests recorded yet. The log fills as syncs run.
                    </p>
                  ) : (
                    <div className="max-h-80 overflow-y-auto">
                      <table className="w-full border-collapse text-xs">
                        <tbody>
                          {pmsActivity.log.map((entry) => (
                            <tr
                              key={entry.id}
                              className="border-b border-slate-800/60 last:border-b-0"
                            >
                              <td className="whitespace-nowrap px-4 py-1.5 text-slate-500">
                                {formatDisplayTime(entry.created_at)}
                              </td>
                              <td className="px-2 py-1.5 font-mono text-slate-400">
                                {entry.http_method}
                              </td>
                              <td className="px-2 py-1.5 font-mono text-slate-300">
                                {entry.endpoint}
                              </td>
                              <td
                                className={`px-2 py-1.5 font-mono ${
                                  entry.ok ? "text-emerald-400" : "text-rose-400"
                                }`}
                              >
                                {entry.status_code ?? "ERR"}
                              </td>
                              <td className="whitespace-nowrap px-2 py-1.5 text-slate-500">
                                {entry.duration_ms != null ? `${entry.duration_ms}ms` : ""}
                              </td>
                              <td className="max-w-[16rem] truncate px-2 py-1.5 text-slate-500">
                                {entry.message ?? ""}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
            {activeHotelId && pmsActivity?.property ? (
              <PropertyTimeAndCurrency
                timezone={pmsActivity.property.timezone}
                currency={pmsActivity.property.currency}
              />
            ) : null}
          </section>
        )}

        {tab === "pms" && activeHotelId ? (
          <RoomTypeSettings hotelId={activeHotelId} onChanged={() => void reloadRoomTypes()} />
        ) : null}
      </div>
    </main>
  );
}
