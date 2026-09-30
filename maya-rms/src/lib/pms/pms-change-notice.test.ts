/**
 * The two emails about rates changed in the property system: the day's
 * overwrites under "MAYA's price wins" (at most one a day, grouping the
 * day's nights) and the warning that something other than MAYA seems to be
 * changing rates under "Keep the change". Who gets them, when, exactly once,
 * what they say, and that nothing about them can break the sync they run in
 * front of. Resend is a fake; the tables are in memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  dayLabel,
  nightLabel,
  overwriteLines,
  RETRY_FOR_MS,
  sendDuePmsChangeEmails,
  whenLabel,
  type PmsChangeEmailDeps,
} from "../../../supabase/functions/_shared/pms/pms-change-notice";
import {
  emailCurrencySymbol,
  MAX_DIGEST_LINES,
  otherToolHtml,
  otherToolSubject,
  otherToolText,
  overwriteHtml,
  overwriteSubject,
  overwriteText,
  type OverwriteEmailInput,
} from "../../../supabase/functions/_shared/pms/pms-change-email";
import type { SendEmailInput } from "../../../supabase/functions/_shared/email/resend";
import { currencySymbolFor } from "../changelog-route-helpers";
import { fakeSupabase, type FakeRow } from "../engine/fake-supabase.test";

const H = "11111111-1111-4111-8111-111111111111";
const KING = "rt-king";
const SUITE = "rt-suite";
const DAY = 86_400_000;
/** Tuesday, October 6 2026, 14:00 at the property (UTC). */
const NOW = Date.parse("2026-10-06T14:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function world(opts: { mode?: string; rows?: FakeRow[]; timezone?: string; active?: boolean; subscription?: string } = {}) {
  const d = fakeSupabase({
    hotels: [{ id: H, name: "Harbour Inn", timezone: opts.timezone ?? "UTC", is_active: opts.active ?? true, currency: "USD" }],
    hotel_settings: [{ hotel_id: H, simulation_mode: false, pms_rate_changes: opts.mode ?? "maya_wins" }],
    hotel_subscriptions: opts.subscription ? [{ hotel_id: H, status: opts.subscription }] : [],
    hotel_memberships: [
      { hotel_id: H, user_id: "u_gm", role: "general_manager", status: "active" },
      { hotel_id: H, user_id: "u_admin", role: "hotel_admin", status: "active" },
      { hotel_id: H, user_id: "u_rm", role: "revenue_manager", status: "active" },
      { hotel_id: H, user_id: "u_invited", role: "general_manager", status: "invited" },
      // Sam looks after another property too.
      { hotel_id: "h-other", user_id: "u_admin", role: "hotel_admin", status: "active" },
    ],
    room_types: [
      { id: KING, hotel_id: H, name: "King" },
      { id: SUITE, hotel_id: H, name: "Suite" },
    ],
    pms_change_notices: opts.rows ?? [],
    pms_change_watch: [],
  });
  const emails: Record<string, string> = { u_gm: "gm@harbour.test", u_admin: "sam@harbour.test", u_rm: "priya@harbour.test", u_invited: "new@harbour.test" };
  const client = Object.assign(d.client, {
    auth: {
      admin: {
        getUserById: async (id: string) => ({ data: { user: { email: emails[id] } }, error: null }),
      },
    },
  }) as unknown as SupabaseClient;
  const sent: SendEmailInput[] = [];
  let failing = false;
  const deps = (over: Partial<PmsChangeEmailDeps> = {}): PmsChangeEmailDeps => ({
    now: () => NOW,
    clock: () => NOW,
    emailConfigured: () => true,
    appUrl: "https://maya-rms.test",
    send: async (input) => {
      if (failing) throw new Error("Resend is having a moment");
      sent.push(input);
      return { id: `e${sent.length}` };
    },
    ...over,
  });
  return {
    ...d,
    client,
    sent,
    deps,
    failSends: (on: boolean) => (failing = on),
    notice: (id: string) => d.tables.pms_change_notices.find((r) => r.id === id)!,
  };
}

const overwrite = (id: string, foundAt: number, stayDate: string, roomTypeId: string, pmsRate: number | null, mayaPrice: number): FakeRow => ({
  id, hotel_id: H, pms_type: "cloudbeds", kind: "overwrite", found_at: iso(foundAt), stay_date: stayDate, room_type_id: roomTypeId,
  pms_rate: pmsRate, maya_price: mayaPrice, rates: null, emailed_at: null,
});
const warning = (id: string, foundAt: number, rates: number, pms = "cloudbeds"): FakeRow => ({
  id, hotel_id: H, pms_type: pms, kind: "other_tool", found_at: iso(foundAt), stay_date: null, room_type_id: null,
  pms_rate: null, maya_price: null, rates, emailed_at: null,
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the day's overwrites", () => {
  const yesterday = NOW - DAY;
  const rows = () => [
    overwrite("o1", yesterday - 3 * 3_600_000, "2026-10-13", KING, 175, 165),
    overwrite("o2", yesterday - 3_600_000, "2026-10-13", KING, 180, 165),
    overwrite("o3", yesterday, "2026-10-12", SUITE, null, 240),
    // Today's: not the day's email until today is over.
    overwrite("o4", NOW - 3_600_000, "2026-10-20", KING, 190, 170),
  ];

  it("goes to the General Managers and Hotel Admins once the day is over, one line per night and room type", async () => {
    const w = world({ rows: rows() });
    const res = await sendDuePmsChangeEmails(w.client, "cloudbeds", w.deps());
    expect(res).toEqual([{ hotelId: H, email: "overwrites", outcome: "emailed", recipients: 2, sent: 2, items: 3 }]);
    expect(w.sent.map((e) => e.to).sort()).toEqual(["gm@harbour.test", "sam@harbour.test"]);
    const gm = w.sent.find((e) => e.to === "gm@harbour.test")!;
    expect(gm.subject).toBe("MAYA overwrote rate changes in Cloudbeds at Harbour Inn");
    expect(gm.text).toContain("On Monday, October 5, rates in Cloudbeds were changed or removed on nights MAYA had sent a price to at Harbour Inn.");
    expect(gm.text).toContain(`Your setting is "MAYA's price wins", so MAYA overwrote each change again with its own price.`);
    expect(gm.text).toContain("- Mon, Oct 12, Suite: removed in Cloudbeds, MAYA's price $240.00\n- Tue, Oct 13, King: Cloudbeds $180.00, MAYA's price $165.00 (2 times)");
    expect(gm.text).toContain("To set a price by hand, set it in MAYA's calendar, not in Cloudbeds.");
    expect(gm.text).toContain(`Open the calendar: https://maya-rms.test/go/calendar?hotel=${H}`);
    expect(gm.html).toContain(`href="https://maya-rms.test/go/calendar?hotel=${H}"`);
    expect(gm.replyTo).toBe("info@modern-hospitality-solutions.com");
    expect(gm.idempotencyKey).toBe(`pms-overwrites:${H}:2026-10-06:u_gm`);
    // Sam can open another property: told how to get to this one.
    expect(w.sent.find((e) => e.to === "sam@harbour.test")!.text).toContain("pick Harbour Inn in the Property dropdown");
    expect(gm.text).not.toContain("Property dropdown");
    // Stamped; today's waits for tomorrow.
    expect(["o1", "o2", "o3"].map((id) => w.notice(id).emailed_at)).toEqual([iso(NOW), iso(NOW), iso(NOW)]);
    expect(w.notice("o4").emailed_at).toBeNull();
    expect(w.tables.pms_change_watch).toEqual([expect.objectContaining({ hotel_id: H, digest_sent_on: "2026-10-06" })]);
  });

  it("sends at most one a day: a second run finds nothing due, and a late row waits for tomorrow's", async () => {
    const w = world({ rows: rows() });
    await sendDuePmsChangeEmails(w.client, "cloudbeds", w.deps());
    expect(w.sent).toHaveLength(2);
    w.tables.pms_change_notices.push(overwrite("o5", NOW - DAY + 60_000, "2026-10-14", KING, 150, 160));
    const again = await sendDuePmsChangeEmails(w.client, "cloudbeds", w.deps({ now: () => NOW + 3_600_000 }));
    expect(again).toEqual([{ hotelId: H, email: "overwrites", outcome: "not_emailed", reason: "sent_today" }]);
    expect(w.sent).toHaveLength(2);
    expect(w.notice("o5").emailed_at).toBeNull();

    // Tomorrow: today's and the late one, in one email.
    const next = await sendDuePmsChangeEmails(w.client, "cloudbeds", w.deps({ now: () => NOW + DAY }));
    expect(next).toEqual([expect.objectContaining({ outcome: "emailed", items: 2 })]);
    expect(w.sent).toHaveLength(4);
    expect(w.sent[2].text).toContain("Between Monday, October 5 and Tuesday, October 6");
    expect(w.sent[2].text).toContain("Wed, Oct 14, King");
    expect(w.sent[2].text).toContain("Tue, Oct 20, King");
  });

  it("goes by the property's own day", async () => {
    // 14:00 UTC is 04:00 in Honolulu: yesterday's changes there are the ones before its midnight.
    const w = world({
      timezone: "Pacific/Honolulu",
      rows: [
        overwrite("h1", Date.parse("2026-10-06T09:00:00Z"), "2026-10-13", KING, 175, 165),
        overwrite("h2", Date.parse("2026-10-06T11:00:00Z"), "2026-10-13", SUITE, 300, 290),
      ],
    });
    const res = await sendDuePmsChangeEmails(w.client, "cloudbeds", w.deps());
    expect(res).toEqual([expect.objectContaining({ outcome: "emailed", items: 1 })]);
    expect(w.sent[0].text).toContain("On Monday, October 5");
    expect(w.notice("h2").emailed_at).toBeNull();
  });

  it("hands everything back when every send fails, and a later run sends it", async () => {
    const w = world({ rows: rows() });
    w.failSends(true);
    const res = await sendDuePmsChangeEmails(w.client, "cloudbeds", w.deps());
    expect(res).toEqual([expect.objectContaining({ outcome: "retry", reason: "all_sends_failed" })]);
    expect(w.notice("o1").emailed_at).toBeNull();
    expect(w.tables.pms_change_watch[0].digest_sent_on ?? null).toBeNull();
    w.failSends(false);
    const later = await sendDuePmsChangeEmails(w.client, "cloudbeds", w.deps({ now: () => NOW + 10 * 60_000 }));
    expect(later).toEqual([expect.objectContaining({ outcome: "emailed", items: 3 })]);
  });

  it("gives up on a day it could not send for long enough, and keeps it stamped", async () => {
    const w = world({ rows: rows() });
    w.failSends(true);
    const res = await sendDuePmsChangeEmails(w.client, "cloudbeds", w.deps({ now: () => NOW + RETRY_FOR_MS + DAY }));
    expect(res).toEqual([expect.objectContaining({ outcome: "not_emailed", reason: "all_sends_failed" })]);
    expect(w.notice("o1").emailed_at).not.toBeNull();
  });

  it("waits, stamping nothing, while email isn't set up", async () => {
    const w = world({ rows: rows() });
    const res = await sendDuePmsChangeEmails(w.client, "cloudbeds", w.deps({ emailConfigured: () => false }));
    expect(res).toEqual([{ hotelId: H, email: "overwrites", outcome: "retry", reason: "email_not_configured" }]);
    expect(w.notice("o1").emailed_at).toBeNull();
    expect(w.sent).toEqual([]);
  });

  it("emails nobody at a property that stopped paying, and stamps its items", async () => {
    const w = world({ rows: rows(), subscription: "canceled" });
    const res = await sendDuePmsChangeEmails(w.client, "cloudbeds", w.deps());
    expect(res).toEqual([{ hotelId: H, email: "overwrites", outcome: "not_emailed", reason: "not_paying" }]);
    expect(w.sent).toEqual([]);
    expect(w.notice("o1").emailed_at).toBe(iso(NOW));
  });

  it("names ThinkReservations for a Think property, and reads only its own system's items", async () => {
    const w = world({ rows: [{ ...overwrite("t1", NOW - DAY, "2026-10-13", KING, 175, 165), pms_type: "think" }] });
    expect(await sendDuePmsChangeEmails(w.client, "cloudbeds", w.deps())).toEqual([]);
    await sendDuePmsChangeEmails(w.client, "think", w.deps());
    expect(w.sent[0].subject).toBe("MAYA overwrote rate changes in ThinkReservations at Harbour Inn");
  });

  it("never fails the sync: an unreadable table or a missing one sends nothing", async () => {
    const broken = fakeSupabase({}, { fault: (c) => (c.table === "pms_change_notices" ? { message: "timeout" } : null) });
    expect(await sendDuePmsChangeEmails(broken.client, "cloudbeds", {})).toEqual([]);
    const pre = fakeSupabase({}, { fault: (c) => (c.table === "pms_change_notices" ? { code: "PGRST205", message: "Could not find the table 'public.pms_change_notices' in the schema cache" } : null) });
    expect(await sendDuePmsChangeEmails(pre.client, "cloudbeds", {})).toEqual([]);
  });
});

describe("the warning", () => {
  it("goes out once, saying how many rates changed and pointing at the setting", async () => {
    const w = world({ mode: "keep", rows: [warning("w1", NOW - 10 * 60_000, 34)] });
    const res = await sendDuePmsChangeEmails(w.client, "cloudbeds", w.deps());
    expect(res).toEqual([{ hotelId: H, email: "other_tool", outcome: "emailed", recipients: 2, sent: 2, items: 1 }]);
    const gm = w.sent.find((e) => e.to === "gm@harbour.test")!;
    expect(gm.subject).toBe("Something other than MAYA seems to be changing rates in Cloudbeds at Harbour Inn");
    expect(gm.text).toContain("In the last 7 days, 34 rates in Cloudbeds were changed on nights MAYA had sent a price to at Harbour Inn.");
    expect(gm.text).toContain("Your setting keeps each change as your price, so MAYA isn't pricing those nights.");
    expect(gm.text).toContain(`If you use another pricing tool, turn on "MAYA's price wins" in Settings.`);
    expect(gm.text).toContain(`Open Settings: https://maya-rms.test/go/settings.pms?hotel=${H}`);
    expect(w.notice("w1").emailed_at).toBe(iso(NOW));
    expect(await sendDuePmsChangeEmails(w.client, "cloudbeds", w.deps())).toEqual([]);
    expect(w.sent).toHaveLength(2);
  });

  it("is not sent when the setting was turned on since", async () => {
    const w = world({ mode: "maya_wins", rows: [warning("w1", NOW - 10 * 60_000, 34)] });
    const res = await sendDuePmsChangeEmails(w.client, "cloudbeds", w.deps());
    expect(res).toEqual([{ hotelId: H, email: "other_tool", outcome: "not_emailed", reason: "setting_on" }]);
    expect(w.sent).toEqual([]);
    expect(w.notice("w1").emailed_at).toBe(iso(NOW));
  });

  it("hands itself back when every send fails", async () => {
    const w = world({ mode: "keep", rows: [warning("w1", NOW - 10 * 60_000, 34)] });
    w.failSends(true);
    expect(await sendDuePmsChangeEmails(w.client, "cloudbeds", w.deps())).toEqual([expect.objectContaining({ outcome: "retry" })]);
    expect(w.notice("w1").emailed_at).toBeNull();
  });
});

describe("what the emails say", () => {
  const overwriteInput = (n: number, over: Partial<OverwriteEmailInput> = {}): OverwriteEmailInput => ({
    hotelName: "Harbour <Inn>",
    pmsType: "cloudbeds",
    when: "on Monday, October 5",
    lines: Array.from({ length: n }, (_, i) => ({ night: `Tue, Oct ${13 + (i % 15)}`, roomType: "King", theirs: i % 2 ? null : "$175.00", maya: "$165.00", times: 1 })),
    calendarUrl: "https://maya-rms.test/go/calendar",
    ...over,
  });
  const otherInput = { hotelName: "Harbour Inn", pmsType: "think" as const, rates: 1, settingsUrl: "https://maya-rms.test/go/settings.pms", otherProperties: true };
  const everything = [
    overwriteSubject(overwriteInput(3)),
    overwriteText(overwriteInput(3, { otherProperties: true })),
    overwriteHtml(overwriteInput(3, { otherProperties: true })),
    otherToolSubject(otherInput),
    otherToolText(otherInput),
    otherToolHtml(otherInput),
  ];

  it("has no em dashes, and never says MAYA learns, knows, thinks, studies or analyses", () => {
    for (const text of everything) {
      expect(text).not.toMatch(/—/);
      expect(text).not.toMatch(/MAYA (learns|knows|thinks|studies|analy[sz]es)/i);
    }
  });

  it("speaks to the owner about their own setting, rates and prices", () => {
    expect(overwriteText(overwriteInput(1))).toContain("Your setting is");
    expect(otherToolText(otherInput)).toContain("1 rate in ThinkReservations was changed");
    expect(otherToolText(otherInput)).toContain("If you made these changes yourself, there is nothing to do.");
  });

  it("escapes the owner's own words in the HTML", () => {
    expect(overwriteHtml(overwriteInput(1))).toContain("Harbour &lt;Inn&gt;");
    expect(overwriteHtml(overwriteInput(1))).not.toContain("Harbour <Inn>");
  });

  it("lists the first nights and points to the Change Log for the rest", () => {
    const text = overwriteText(overwriteInput(MAX_DIGEST_LINES + 3));
    expect(text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(MAX_DIGEST_LINES);
    expect(text).toContain("And 3 more nights. The Change Log in MAYA lists every one.");
    expect(overwriteText(overwriteInput(2))).not.toContain("more night");
  });

  it("writes dates, amounts and currencies the way the app does", () => {
    expect(nightLabel("2026-11-13")).toBe("Fri, Nov 13");
    expect(dayLabel("2026-10-05")).toBe("Monday, October 5");
    expect(whenLabel(["2026-10-05", "2026-10-05"])).toBe("on Monday, October 5");
    expect(whenLabel(["2026-10-06", "2026-10-03"])).toBe("between Saturday, October 3 and Tuesday, October 6");
    for (const code of ["USD", "EUR", "GBP", "CAD", null]) expect(emailCurrencySymbol(code)).toBe(currencySymbolFor(code));
    expect(
      overwriteLines(
        [{ stay_date: "2026-10-13", room_type_id: KING, pms_rate: 1234.5, maya_price: 999, found_at: iso(NOW) }],
        new Map([[KING, "King"]]),
        "€",
      ),
    ).toEqual([{ night: "Tue, Oct 13", roomType: "King", theirs: "€1,234.50", maya: "€999.00", times: 1 }]);
  });
});
