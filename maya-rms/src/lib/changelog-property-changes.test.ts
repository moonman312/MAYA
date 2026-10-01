import { describe, expect, it } from "vitest";
import { buildPropertyChanges, type PropertyChangeRow } from "./changelog-property-changes";

const row = (o: Partial<PropertyChangeRow>): PropertyChangeRow => ({
  id: "1",
  pms_type: "cloudbeds",
  kind: "room_type_removed",
  found_at: "2026-10-01T06:00:00Z",
  room_type_name: null,
  before_value: null,
  after_value: null,
  ...o,
});

describe("the change log's lines about the property itself", () => {
  it("names a room type the system no longer lists, and one it lists again, in full", () => {
    const items = buildPropertyChanges([
      row({ id: "a", kind: "room_type_removed", room_type_name: "Harbour Double Deluxe", found_at: "2026-10-01T06:00:00Z" }),
      row({ id: "b", kind: "room_type_back", room_type_name: "Harbour Double Deluxe", found_at: "2026-10-03T06:00:00Z" }),
    ]);
    expect(items).toEqual([
      {
        kind: "pms_change",
        id: "property:b",
        timestamp: "2026-10-03T06:00:00Z",
        pms: "Cloudbeds",
        change: "room_type_back",
        room_type: "Harbour Double Deluxe",
        title: "Harbour Double Deluxe is back in Cloudbeds. MAYA prices it again, and its rooms count toward your occupancy and your bill.",
      },
      {
        kind: "pms_change",
        id: "property:a",
        timestamp: "2026-10-01T06:00:00Z",
        pms: "Cloudbeds",
        change: "room_type_removed",
        room_type: "Harbour Double Deluxe",
        title:
          "Harbour Double Deluxe is no longer in Cloudbeds. MAYA stopped pricing it, and its rooms no longer count toward your occupancy or your bill.",
      },
    ]);
  });

  it("says what the time zone was and became, and a currency change says nothing was converted", () => {
    const [tz, cur, firstTz] = buildPropertyChanges([
      row({ id: "t", kind: "timezone", before_value: "UTC", after_value: "America/Chicago", found_at: "2026-10-03T06:00:00Z" }),
      row({ id: "c", kind: "currency", before_value: "USD", after_value: "CAD", found_at: "2026-10-02T06:00:00Z" }),
      row({ id: "n", kind: "timezone", before_value: null, after_value: "Europe/London", found_at: "2026-10-01T06:00:00Z" }),
    ]);
    expect(tz).toMatchObject({
      change: "timezone",
      title: "Your time zone changed from UTC to America/Chicago, to match Cloudbeds. Tonight and every rule's dates follow it.",
    });
    expect(cur).toMatchObject({
      change: "currency",
      title: "Your currency changed from USD to CAD, to match Cloudbeds. Amounts in MAYA are now in CAD; nothing was converted.",
    });
    expect(firstTz.title).toBe("Your time zone is now Europe/London, to match Cloudbeds. Tonight and every rule's dates follow it.");
  });

  it("leaves out a row it cannot word, and never uses an em dash", () => {
    const items = buildPropertyChanges([
      row({ kind: "room_type_removed", room_type_name: " " }),
      row({ kind: "timezone", after_value: null }),
      row({ kind: "something_new", after_value: "x" }),
    ]);
    expect(items).toEqual([]);
    const all = buildPropertyChanges([
      row({ id: "a", kind: "room_type_removed", room_type_name: "Juniper Suite" }),
      row({ id: "b", kind: "timezone", before_value: "UTC", after_value: "America/Denver" }),
    ]);
    for (const i of all) expect(i.title).not.toContain("—");
  });
});
