/**
 * Support changes as change log items: one per row, newest first, capped,
 * with a line for a row that carries no summary of its own.
 */
import { describe, expect, it } from "vitest";
import { buildSupportChanges, isSupportChange, MAX_SUPPORT_CHANGES, SUPPORT_CHANGE_LEAD } from "./changelog-support";

describe("buildSupportChanges", () => {
  it("makes one item per row, newest first, and words a row with no summary", () => {
    const items = buildSupportChanges([
      { id: 1, at: "2026-09-29T10:00:00Z", summary: "Took pricing live.", table_name: "hotel_settings", op: "update" },
      { id: 2, at: "2026-09-29T10:05:00Z", summary: "  ", table_name: "pricing_rules", op: "insert" },
      { id: 3, at: "2026-09-29T10:01:00Z", summary: null, table_name: "hotel_memberships", op: "delete" },
      { id: 4, at: "2026-09-29T10:02:00Z", summary: null, table_name: "room_types", op: null },
    ]);
    expect(items).toEqual([
      { kind: "support_change", id: "2", timestamp: "2026-09-29T10:05:00Z", summary: "Added a pricing rules row." },
      { kind: "support_change", id: "4", timestamp: "2026-09-29T10:02:00Z", summary: "Changed a room types row." },
      { kind: "support_change", id: "3", timestamp: "2026-09-29T10:01:00Z", summary: "Removed a hotel memberships row." },
      { kind: "support_change", id: "1", timestamp: "2026-09-29T10:00:00Z", summary: "Took pricing live." },
    ]);
    expect(items.every(isSupportChange)).toBe(true);
    expect(SUPPORT_CHANGE_LEAD).toBe("Changed by MAYA support");
  });

  it("keeps the newest MAX_SUPPORT_CHANGES", () => {
    const rows = Array.from({ length: MAX_SUPPORT_CHANGES + 5 }, (_, i) => ({
      id: i,
      at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
      summary: `Change ${i}.`,
      table_name: "hotels",
      op: "update",
    }));
    const items = buildSupportChanges(rows);
    expect(items).toHaveLength(MAX_SUPPORT_CHANGES);
    expect(items[0].summary).toBe(`Change ${MAX_SUPPORT_CHANGES + 4}.`);
  });
});
