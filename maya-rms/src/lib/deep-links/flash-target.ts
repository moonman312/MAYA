import { links, type Arrival } from "./index";

/**
 * The [data-deeplink] id to highlight for an arrival: the registry's own for
 * the place, or one row or card when the link named a checked id.
 */
export function arrivalFlashTarget(a: Pick<Arrival, "dest" | "params" | "focus">): string | null {
  if (!a.dest) return null;
  const p = a.params;
  switch (a.dest) {
    case "rules.new":
      return a.focus ? `rules.builder.${a.focus}` : "rules.builder";
    case "calendar.day":
      return p.roomType ? `calendar.room-type:${p.roomType}` : "calendar.day";
    case "calendar.manual-price":
      return p.roomType ? `calendar.price:${p.roomType}` : "calendar.day";
    case "rules.list":
      return p.rule ? `rules.row:${p.rule}` : null;
    case "adjusting":
      return p.alert ? `alerts:${p.alert}` : "alerts";
    case "room-types":
      return p.roomType ? `pms.room-type:${p.roomType}` : "pms.room-types";
    case "changelog.entry":
      if (p.run && p.date && p.roomType) return `changelog.entry:${p.run}:${p.date}:${p.roomType}`;
      return p.run ? `changelog.run:${p.run}` : null;
    default:
      return links.destination(a.dest).flash ?? null;
  }
}
