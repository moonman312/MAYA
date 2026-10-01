import type { ChangelogPmsChange } from "@/types/domain";
import { pmsName } from "../../supabase/functions/_shared/pms/push-failure";

/**
 * What a read of the property system changed about the property itself, as
 * the change log shows it (pms_property_changes, written by
 * supabase/functions/_shared/pms/property-changes.ts). Each line sits under
 * the same "Changed in Cloudbeds" heading as a rate changed there:
 *
 *   - a room type the system no longer lists, which MAYA switched off;
 *   - one it lists again, which MAYA switched back on;
 *   - the time zone, and a simulating property's currency, changed to the
 *     system's, saying what each was and became.
 */

export const PROPERTY_CHANGE_COLUMNS = "id, pms_type, kind, found_at, room_type_name, before_value, after_value";

/** Lines read at most: a property's room types and its few time zone changes. */
export const MAX_PROPERTY_CHANGES = 100;

export type PropertyChangeRow = {
  id: string | number;
  pms_type: string;
  kind: string;
  found_at: string;
  room_type_name: string | null;
  before_value: string | null;
  after_value: string | null;
};

export function roomTypeRemovedTitle(pms: string, name: string): string {
  return `${name} is no longer in ${pms}. MAYA stopped pricing it, and its rooms no longer count toward your occupancy or your bill.`;
}

export function roomTypeBackTitle(pms: string, name: string): string {
  return `${name} is back in ${pms}. MAYA prices it again, and its rooms count toward your occupancy and your bill.`;
}

export function timezoneTitle(pms: string, from: string | null, to: string): string {
  return from
    ? `Your time zone changed from ${from} to ${to}, to match ${pms}. Tonight and every rule's dates follow it.`
    : `Your time zone is now ${to}, to match ${pms}. Tonight and every rule's dates follow it.`;
}

export function currencyTitle(pms: string, from: string | null, to: string): string {
  return from
    ? `Your currency changed from ${from} to ${to}, to match ${pms}. Amounts in MAYA are now in ${to}; nothing was converted.`
    : `Your currency is now ${to}, to match ${pms}.`;
}

/** The items, newest first. A row this version cannot word is left out. */
export function buildPropertyChanges(rows: PropertyChangeRow[]): ChangelogPmsChange[] {
  const items: ChangelogPmsChange[] = [];
  const sorted = [...rows].sort((a, b) => Date.parse(b.found_at) - Date.parse(a.found_at));
  for (const r of sorted) {
    const pms = pmsName(r.pms_type);
    const base = { kind: "pms_change" as const, id: `property:${String(r.id)}`, timestamp: r.found_at, pms };
    const name = r.room_type_name?.trim();
    const to = r.after_value?.trim();
    const from = r.before_value?.trim() || null;
    if (r.kind === "room_type_removed" && name) {
      items.push({ ...base, change: "room_type_removed", room_type: name, title: roomTypeRemovedTitle(pms, name) });
    } else if (r.kind === "room_type_back" && name) {
      items.push({ ...base, change: "room_type_back", room_type: name, title: roomTypeBackTitle(pms, name) });
    } else if (r.kind === "timezone" && to) {
      items.push({ ...base, change: "timezone", title: timezoneTitle(pms, from, to) });
    } else if (r.kind === "currency" && to) {
      items.push({ ...base, change: "currency", title: currencyTitle(pms, from, to) });
    }
  }
  return items;
}
