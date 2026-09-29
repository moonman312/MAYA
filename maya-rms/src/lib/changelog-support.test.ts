/**
 * Support changes as change log items: one per save (the rows written
 * together), newest first, capped, with a line for a row that carries no
 * summary of its own, and ", N days" for a save that covered nights.
 */
import { describe, expect, it } from "vitest";
import {
  buildSupportChanges,
  isSupportChange,
  MAX_SUPPORT_CHANGES,
  SUPPORT_CHANGE_LEAD,
  type SupportChangeRow,
} from "./changelog-support";

describe("buildSupportChanges", () => {
  it("makes one item per save of one row, newest first, and words a row with no summary", () => {
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

  const AT = "2026-09-29T10:00:00.123456+00:00";
  const U = "admin-1";
  /** A rule save in God Mode: the rule, its conditions, and a held day and ladder step per night and room type. */
  function ruleSave(nights: string[], roomTypes = 2): SupportChangeRow[] {
    let id = 100;
    const rows: SupportChangeRow[] = [
      { id: id++, at: AT, user_id: U, table_name: "rule_condition", op: "delete", summary: "Removed the conditions of a rule." },
      { id: id++, at: AT, user_id: U, table_name: "rule_condition", op: "insert", summary: "Added the conditions of a rule." },
      {
        id: id++,
        at: AT,
        user_id: U,
        table_name: "pricing_rules",
        op: "update",
        summary: 'Changed the pricing rule "Hot-week surge": action_value from 10 to 15.',
      },
    ];
    for (const day of nights) {
      for (let k = 0; k < roomTypes; k++) {
        rows.push({ id: id++, at: AT, user_id: U, table_name: "rule_skip_hold", op: "insert", summary: "Added a held day of a rule.", after_day: day });
        rows.push({
          id: id++,
          at: AT,
          user_id: U,
          table_name: "ladder_rule_state",
          op: "delete",
          summary: "Removed the ladder state of a rule.",
          before_day: day,
          after_day: null,
        });
      }
    }
    return rows;
  }

  it("folds one save into one line: the rule's own, with how many nights it covered", () => {
    const nights = Array.from({ length: 12 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
    const items = buildSupportChanges(ruleSave(nights));
    expect(items).toEqual([
      {
        kind: "support_change",
        id: "102",
        timestamp: AT,
        summary: 'Changed the pricing rule "Hot-week surge": action_value from 10 to 15, 12 days.',
      },
    ]);
  });

  it("keeps the rule's line on the list however many nights a later save wrote", () => {
    const nights = Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
    const later = ruleSave(nights).map((r) => ({ ...r, at: "2026-09-29T11:00:00.000001+00:00", id: Number(r.id) + 1000 }));
    const earlier = { id: 1, at: "2026-09-29T09:00:00Z", user_id: U, table_name: "hotel_settings", op: "update", summary: "Took pricing live." };
    const items = buildSupportChanges([...later, earlier]);
    expect(items.map((i) => i.summary)).toEqual([
      'Changed the pricing rule "Hot-week surge": action_value from 10 to 15, 30 days.',
      "Took pricing live.",
    ]);
  });

  it("says a save with no nights as its main line, and keeps saves by different people apart", () => {
    const items = buildSupportChanges([
      { id: 1, at: AT, user_id: U, table_name: "rule_condition", op: "insert", summary: "Added the conditions of a rule." },
      { id: 2, at: AT, user_id: U, table_name: "pricing_rules", op: "insert", summary: 'Added the pricing rule "Slow-date rescue".' },
      { id: 3, at: AT, user_id: "admin-2", table_name: "hotel_settings", op: "update", summary: "Took pricing live." },
    ]);
    expect(items.map((i) => [i.id, i.summary])).toEqual([
      ["2", 'Added the pricing rule "Slow-date rescue".'],
      ["3", "Took pricing live."],
    ]);
  });

  it("words a save of nights only by what kind of thing changed, never one night's values", () => {
    const rate = (id: number, day: string, from: number): SupportChangeRow => ({
      id,
      at: AT,
      user_id: U,
      table_name: "base_rate_calendar",
      op: "update",
      summary: `Changed a base rate: rate from ${from} to 180.`,
      after_day: day,
      before_day: day,
    });
    expect(buildSupportChanges([rate(1, "2026-10-01", 150), rate(2, "2026-10-02", 160)])[0].summary).toBe(
      "Changed a base rate, 2 days.",
    );
    expect(buildSupportChanges([rate(1, "2026-10-01", 150), rate(2, "2026-10-01", 150)])[0].summary).toBe(
      "Changed a base rate: rate from 150 to 180, 1 day.",
    );
  });

  it("leaves out the oldest save of a full read, which may be missing rows", () => {
    const rows: SupportChangeRow[] = [
      { id: 2, at: "2026-09-29T10:00:00Z", user_id: U, table_name: "hotels", op: "update", summary: "Newer." },
      { id: 1, at: "2026-09-29T09:00:00Z", user_id: U, table_name: "hotels", op: "update", summary: "Older." },
    ];
    expect(buildSupportChanges(rows, { truncated: true }).map((i) => i.summary)).toEqual(["Newer."]);
    expect(buildSupportChanges(rows.slice(0, 1), { truncated: true }).map((i) => i.summary)).toEqual(["Newer."]);
  });
});
