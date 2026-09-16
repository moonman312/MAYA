/**
 * The moments worth recording that leave nothing in the database.
 *
 * Everything else MAYA does is captured by triggers on the tables it writes
 * (99_supabase_migration_product_events_v1.sql). These are the few that are
 * only ever seen in a browser: a screen looked at, a door opened. The list is
 * closed on purpose. The route drops anything not named here, and every
 * property is typed as a flag, a count, or one of a fixed set of words, so
 * nothing an owner types, and nothing about a guest, can travel through it.
 *
 * docs/analytics.md has what each event means and the questions it answers.
 */

type PropSpec = "flag" | "count" | readonly string[];

export const UI_EVENTS = {
  /** The subscribe screen rendered. */
  "billing.subscribe_viewed": {
    marketplace: "flag",
    restart: "flag",
    trial_days: "count",
    group_position: "count",
    group_total: "count",
  },
  /** Checkout answered with a Stripe URL and the browser is on its way there. */
  "billing.checkout_started": {
    marketplace: "flag",
    restart: "flag",
    interval: ["month", "year"],
    rooms: "count",
    has_code: "flag",
  },
  /** Stripe sent them back with ?checkout=cancelled. */
  "billing.checkout_cancelled": { marketplace: "flag", restart: "flag" },
  /** The billing portal answered with a URL and the browser is on its way there. */
  "billing.portal_opened": {},
  /** The onboarding review screen rendered. */
  "onboarding.review_viewed": {},
  /** "How did we know?" was opened on a price explanation. */
  "explain.opened": {},
  /** The first change to any input on the rate simulator. */
  "simulator.used": {},
  /** A dashboard tab was chosen. */
  "dashboard.tab_opened": { tab: ["calendar", "rules", "simulator", "changelog", "pms"] },
} as const satisfies Record<string, Record<string, PropSpec>>;

export type UiEventName = keyof typeof UI_EVENTS;

type ValueOf<S> = S extends "flag" ? boolean : S extends "count" ? number : S extends readonly (infer W)[] ? W : never;

export type UiEventProps<E extends UiEventName> = {
  [K in keyof (typeof UI_EVENTS)[E]]?: ValueOf<(typeof UI_EVENTS)[E][K]>;
};

export type CleanUiEvent = {
  event: UiEventName;
  properties: Record<string, string | number | boolean>;
  hotelId: string | null;
};

/** Counts here are rooms and days; anything past this is not a count we send. */
const MAX_COUNT = 100_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUiEventName(name: unknown): name is UiEventName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(UI_EVENTS, name);
}

/**
 * The body as the route will record it, or null when the event is not one of
 * ours. Unknown properties and values of the wrong shape are dropped rather
 * than refused: a client a release behind should still count the moment.
 */
export function cleanUiEvent(body: unknown): CleanUiEvent | null {
  if (!body || typeof body !== "object") return null;
  const { event, properties, hotelId } = body as { event?: unknown; properties?: unknown; hotelId?: unknown };
  if (!isUiEventName(event)) return null;

  const spec = UI_EVENTS[event] as Record<string, PropSpec>;
  const input = properties && typeof properties === "object" ? (properties as Record<string, unknown>) : {};
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, kind] of Object.entries(spec)) {
    const value = input[key];
    if (kind === "flag") {
      if (typeof value === "boolean") clean[key] = value;
    } else if (kind === "count") {
      if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT) clean[key] = value;
    } else if (typeof value === "string" && kind.includes(value)) {
      clean[key] = value;
    }
  }

  return {
    event,
    properties: clean,
    hotelId: typeof hotelId === "string" && UUID.test(hotelId) ? hotelId : null,
  };
}
