/**
 * The "connection down" email (G57): who gets it, when, exactly once per
 * outage, what it says for each system, and that nothing about it can break
 * the sync it runs in front of. Resend and Slack are fakes; the tables are
 * in memory, filtered the way PostgREST filters them.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  formatDownSince,
  NOTICES_PER_RUN,
  OUTAGE_NOTICE_AFTER_MS,
  RETRY_FOR_MS,
  RUN_BUDGET_MS,
  sendDueOutageNotices,
  type OutageNoticeDeps,
} from "../../../supabase/functions/_shared/pms/outage-notice";
import {
  outageHtml,
  outageSubject,
  outageText,
  type OutageEmailInput,
} from "../../../supabase/functions/_shared/pms/outage-email";
import type { SendEmailInput } from "../../../supabase/functions/_shared/email/resend";

type Row = Record<string, unknown>;

const NOW = Date.parse("2026-10-06T14:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const HOTEL = "11111111-1111-4111-8111-111111111111";

function fakeDb(tables: Record<string, Row[]>, opts: { failSelect?: Record<string, string> } = {}) {
  const rpcs: { name: string; args: Record<string, unknown> }[] = [];
  const users: Record<string, string> = { u_admin: "sam@harbour.test", u_gm: "gm@harbour.test", u_rm: "priya@harbour.test", u_invited: "new@harbour.test" };

  function builder(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let op: "select" | "update" = "select";
    let payload: Row = {};
    let limitN: number | null = null;
    let orderCol: string | null = null;
    let returning = false;
    const run = () => {
      if (op === "select" && opts.failSelect?.[table]) return { data: null, error: { message: opts.failSelect[table] } };
      let matched = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of matched) Object.assign(r, payload);
        return { data: returning ? matched.map((r) => ({ id: r.id })) : null, error: null };
      }
      if (orderCol) {
        const c = orderCol;
        matched = [...matched].sort((a, b) => String(a[c]).localeCompare(String(b[c])));
      }
      if (limitN != null) matched = matched.slice(0, limitN);
      return { data: matched.map((r) => ({ ...r })), error: null };
    };
    const b = {
      select() {
        if (op === "update") returning = true;
        return b;
      },
      update(p: Row) {
        op = "update";
        payload = p;
        return b;
      },
      eq(c: string, v: unknown) {
        filters.push((r) => r[c] === v);
        return b;
      },
      in(c: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[c]));
        return b;
      },
      is(c: string, v: unknown) {
        filters.push((r) => (r[c] ?? null) === v);
        return b;
      },
      lte(c: string, v: string) {
        filters.push((r) => r[c] != null && Date.parse(String(r[c])) <= Date.parse(v));
        return b;
      },
      order(c: string) {
        orderCol = c;
        return b;
      },
      limit(n: number) {
        limitN = n;
        return b;
      },
      maybeSingle: async () => {
        const { data, error } = run();
        return { data: (data as Row[] | null)?.[0] ?? null, error };
      },
      then<T>(resolve: (v: ReturnType<typeof run>) => T, reject?: (e: unknown) => T) {
        return Promise.resolve(run()).then(resolve, reject);
      },
    };
    return b;
  }

  const supabase = {
    from: builder,
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      return { data: null, error: null };
    },
    auth: {
      admin: {
        getUserById: async (id: string) => ({ data: { user: users[id] ? { id, email: users[id] } : null }, error: null }),
      },
    },
  } as unknown as SupabaseClient;
  return { supabase, rpcs, tables };
}

function world(connection: Partial<Row> = {}, extra: { subscription?: string | null; simulation?: boolean; pms?: string } = {}) {
  return fakeDb({
    pms_connections: [
      {
        id: "conn-1",
        hotel_id: HOTEL,
        pms_type: extra.pms ?? "cloudbeds",
        status: "disconnected",
        down_since: minutesAgo(61),
        outage_notice_at: null,
        ...connection,
      },
    ],
    hotels: [{ id: HOTEL, name: "The Harbour Inn", timezone: "Europe/Berlin", is_active: true }],
    hotel_subscriptions:
      extra.subscription === null ? [] : [{ hotel_id: HOTEL, status: extra.subscription ?? "active" }],
    hotel_settings: [{ hotel_id: HOTEL, simulation_mode: extra.simulation ?? false }],
    hotel_memberships: [
      { hotel_id: HOTEL, user_id: "u_admin", role: "hotel_admin", status: "active" },
      { hotel_id: HOTEL, user_id: "u_gm", role: "general_manager", status: "active" },
      { hotel_id: HOTEL, user_id: "u_rm", role: "revenue_manager", status: "active" },
      { hotel_id: HOTEL, user_id: "u_invited", role: "general_manager", status: "invited" },
    ],
  });
}

function deps(over: Partial<OutageNoticeDeps> = {}) {
  const sent: SendEmailInput[] = [];
  const alerts: Parameters<NonNullable<OutageNoticeDeps["alert"]>>[1][] = [];
  const d: OutageNoticeDeps = {
    now: () => NOW,
    send: async (input) => {
      sent.push(input);
      return { id: `em_${sent.length}` };
    },
    emailConfigured: () => true,
    alert: async (_s, a) => {
      alerts.push(a);
      return { sent: true };
    },
    appUrl: "https://maya-rms.com",
    ...over,
  };
  return { d, sent, alerts };
}

describe("sendDueOutageNotices", () => {
  it("emails the General Manager and Hotel Admin once, and tells Slack the same", async () => {
    const { supabase, tables, rpcs } = world();
    const { d, sent, alerts } = deps();

    const results = await sendDueOutageNotices(supabase, "cloudbeds", d);

    expect(results).toEqual([{ hotelId: HOTEL, outcome: "emailed", recipients: 2, sent: 2 }]);
    expect(sent.map((s) => s.to).sort()).toEqual(["gm@harbour.test", "sam@harbour.test"]);
    for (const s of sent) {
      expect(s.replyTo).toBe("info@modern-hospitality-solutions.com");
      expect(s.subject).toBe("MAYA has lost its connection to Cloudbeds at The Harbour Inn");
      expect(s.text).toContain(`https://maya-rms.com/go/pms?hotel=${HOTEL}`);
      expect(s.idempotencyKey).toMatch(/^pms-outage:conn-1:\d+:u_(admin|gm)$/);
    }
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "critical", hotelId: HOTEL });
    expect(alerts[0].title).toContain("The Harbour Inn");
    expect(alerts[0].detail).toContain("Emailed 2 of 2");
    expect(tables.pms_connections[0].outage_notice_at).toBe(new Date(NOW).toISOString());
    expect(rpcs.find((r) => r.name === "platform_log_event")?.args).toMatchObject({
      p_event_type: "pms.outage_notice",
      p_detail: expect.objectContaining({ recipients: 2, sent: 2 }),
    });

    // Every later tick finds nothing owed.
    const again = deps({ now: () => NOW + 3 * 60 * 60 * 1000 });
    expect(await sendDueOutageNotices(supabase, "cloudbeds", again.d)).toEqual([]);
    expect(again.sent).toEqual([]);
  });

  it("waits an hour from when the connection went down", async () => {
    const early = world({ down_since: minutesAgo(59) });
    const one = deps();
    expect(await sendDueOutageNotices(early.supabase, "cloudbeds", one.d)).toEqual([]);
    expect(one.sent).toEqual([]);

    const onTime = deps({ now: () => NOW + 2 * 60_000 });
    expect(await sendDueOutageNotices(early.supabase, "cloudbeds", onTime.d)).toHaveLength(1);
    expect(onTime.sent).toHaveLength(2);
    expect(OUTAGE_NOTICE_AFTER_MS).toBe(60 * 60 * 1000);
  });

  it("never emails about Degraded, a working connection, or another system's connection", async () => {
    for (const status of ["degraded", "connected", "pending"]) {
      const { supabase } = world({ status });
      const { d, sent, alerts } = deps();
      expect(await sendDueOutageNotices(supabase, "cloudbeds", d), status).toEqual([]);
      expect(sent).toEqual([]);
      expect(alerts).toEqual([]);
    }
    const { supabase } = world({}, { pms: "think" });
    const { d, sent } = deps();
    expect(await sendDueOutageNotices(supabase, "cloudbeds", d)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("emails about Error too", async () => {
    const { supabase } = world({ status: "error" }, { pms: "think" });
    const { d, sent } = deps();
    await sendDueOutageNotices(supabase, "think", d);
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toContain("ThinkReservations refused to renew MAYA's access.");
    expect(sent[0].text).toContain("Reconnect Think Reservations");
  });

  it("does not email a property that stopped paying, and does not ask again", async () => {
    const { supabase, tables, rpcs } = world({}, { subscription: "canceled" });
    const { d, sent, alerts } = deps();
    expect(await sendDueOutageNotices(supabase, "cloudbeds", d)).toEqual([
      { hotelId: HOTEL, outcome: "not_emailed", reason: "not_paying" },
    ]);
    expect(sent).toEqual([]);
    expect(alerts).toEqual([]);
    expect(tables.pms_connections[0].outage_notice_at).not.toBeNull();
    expect(rpcs.at(-1)?.args).toMatchObject({ p_detail: expect.objectContaining({ reason: "not_paying" }) });
  });

  it("emails a property with no subscription row, the way the syncs serve it", async () => {
    const { supabase } = world({}, { subscription: null });
    const { d, sent } = deps();
    await sendDueOutageNotices(supabase, "cloudbeds", d);
    expect(sent).toHaveLength(2);
  });

  it("hands the notice back when every email fails, and the next tick sends it once", async () => {
    const { supabase, tables } = world();
    const failing = deps({
      send: async () => {
        throw new Error("Resend send failed: HTTP 503");
      },
    });
    expect(await sendDueOutageNotices(supabase, "cloudbeds", failing.d)).toEqual([
      { hotelId: HOTEL, outcome: "retry", reason: "all_sends_failed", recipients: 2, sent: 0 },
    ]);
    expect(failing.alerts).toEqual([]);
    expect(tables.pms_connections[0].outage_notice_at).toBeNull();

    const later = deps({ now: () => NOW + 5 * 60_000 });
    await sendDueOutageNotices(supabase, "cloudbeds", later.d);
    expect(later.sent).toHaveLength(2);
    expect(later.alerts).toHaveLength(1);
  });

  it("gives up retrying once the notice is hours late, and says so in Slack", async () => {
    const { supabase, tables } = world({ down_since: new Date(NOW - OUTAGE_NOTICE_AFTER_MS - RETRY_FOR_MS - 60_000).toISOString() });
    const failing = deps({
      send: async () => {
        throw new Error("Resend send failed: HTTP 422");
      },
    });
    const [r] = await sendDueOutageNotices(supabase, "cloudbeds", failing.d);
    expect(r).toMatchObject({ outcome: "not_emailed", reason: "all_sends_failed" });
    expect(failing.alerts[0].detail).toContain("all_sends_failed");
    expect(tables.pms_connections[0].outage_notice_at).not.toBeNull();
  });

  it("tells Slack while email is not set up, and emails once it is", async () => {
    const { supabase, tables } = world();
    const u = deps({ emailConfigured: () => false });
    expect(await sendDueOutageNotices(supabase, "cloudbeds", u.d)).toEqual([
      { hotelId: HOTEL, outcome: "retry", reason: "email_not_configured" },
    ]);
    expect(u.sent).toEqual([]);
    expect(u.alerts).toHaveLength(1);
    expect(u.alerts[0].detail).toContain("email_not_configured");
    expect(tables.pms_connections[0].outage_notice_at).toBeNull();

    // Still not set up an hour later, and past the retry window: still owed,
    // never given up on. Slack's own dedupe keeps that quiet.
    const later = deps({ emailConfigured: () => false, now: () => NOW + RETRY_FOR_MS + 60 * 60 * 1000 });
    expect(await sendDueOutageNotices(supabase, "cloudbeds", later.d)).toEqual([
      { hotelId: HOTEL, outcome: "retry", reason: "email_not_configured" },
    ]);
    expect(later.alerts[0].key).toBe(u.alerts[0].key);
    expect(tables.pms_connections[0].outage_notice_at).toBeNull();

    // The secrets go in: the next tick emails it, once, and Slack hears
    // under the outage's own key.
    const configured = deps({ now: () => NOW + RETRY_FOR_MS + 2 * 60 * 60 * 1000 });
    expect(await sendDueOutageNotices(supabase, "cloudbeds", configured.d)).toEqual([
      { hotelId: HOTEL, outcome: "emailed", recipients: 2, sent: 2 },
    ]);
    expect(configured.sent).toHaveLength(2);
    expect(configured.alerts[0].key).not.toBe(u.alerts[0].key);
    expect(configured.alerts[0].detail).toContain("Emailed 2 of 2");
    expect(await sendDueOutageNotices(supabase, "cloudbeds", deps().d)).toEqual([]);
  });

  it("tells Slack when nobody can be emailed", async () => {
    const nobody = world();
    nobody.tables.hotel_memberships = [];
    const n = deps();
    const [r] = await sendDueOutageNotices(nobody.supabase, "cloudbeds", n.d);
    expect(r).toMatchObject({ outcome: "not_emailed", reason: "no_general_manager_or_hotel_admin" });
    expect(n.alerts[0].detail).toContain("no_general_manager_or_hotel_admin");
  });

  it("takes on a few notices per run, oldest first", async () => {
    const rows = Array.from({ length: NOTICES_PER_RUN + 2 }, (_, i) => ({
      id: `conn-${i}`,
      hotel_id: `hotel-${i}`,
      pms_type: "cloudbeds",
      status: "disconnected",
      down_since: minutesAgo(200 - i),
      outage_notice_at: null,
    }));
    const { supabase } = fakeDb({ pms_connections: rows, hotels: [], hotel_subscriptions: [], hotel_settings: [], hotel_memberships: [] });
    const { d } = deps();
    const results = await sendDueOutageNotices(supabase, "cloudbeds", d);
    expect(results.map((r) => r.hotelId)).toEqual(rows.slice(0, NOTICES_PER_RUN).map((r) => r.hotel_id));
  });

  it("gives the notices about 20 seconds a run, so a hanging Resend cannot eat the sync's time", async () => {
    // Three properties down, each with two people to email, and every send
    // hanging for its full 10 s before failing.
    const hotels = [HOTEL, "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
    const db = fakeDb({
      pms_connections: hotels.map((h, i) => ({
        id: `conn-${i}`,
        hotel_id: h,
        pms_type: "cloudbeds",
        status: "disconnected",
        down_since: minutesAgo(90 - i),
        outage_notice_at: null,
      })),
      hotels: hotels.map((h) => ({ id: h, name: `Inn ${h.slice(0, 1)}`, timezone: "UTC", is_active: true })),
      hotel_subscriptions: [],
      hotel_settings: [],
      hotel_memberships: hotels.flatMap((h) => [
        { hotel_id: h, user_id: "u_admin", role: "hotel_admin", status: "active" },
        { hotel_id: h, user_id: "u_gm", role: "general_manager", status: "active" },
      ]),
    });
    let clock = 0;
    let readCost = 0;
    const admin = db.supabase.auth.admin as unknown as { getUserById: (id: string) => Promise<unknown> };
    const getUser = admin.getUserById;
    admin.getUserById = async (id) => {
      clock += readCost;
      return getUser(id);
    };
    const hanging = deps({
      clock: () => clock,
      send: async () => {
        clock += 10_000;
        throw new Error("The operation was aborted due to timeout");
      },
    });
    const results = await sendDueOutageNotices(db.supabase, "cloudbeds", hanging.d);

    // The first property's two sends use up the budget; nothing else starts.
    expect(clock).toBeLessThanOrEqual(RUN_BUDGET_MS);
    expect(results).toEqual([{ hotelId: HOTEL, outcome: "retry", reason: "all_sends_failed", recipients: 2, sent: 0 }]);
    // Nothing is claimed, so the next tick tries all three again.
    expect(db.tables.pms_connections.every((c) => c.outage_notice_at == null)).toBe(true);

    // A slow first property leaves the next one's sends for the next tick.
    clock = 0;
    readCost = 1_500;
    const slowReads = deps({
      clock: () => clock,
      send: async (input) => {
        clock += 8_000;
        return { id: input.to };
      },
    });
    const [first, second] = await sendDueOutageNotices(db.supabase, "cloudbeds", slowReads.d);
    expect(first).toMatchObject({ outcome: "emailed", sent: 2 });
    expect(second).toMatchObject({ outcome: "retry", reason: "out_of_time", sent: 0 });
    expect(db.tables.pms_connections[1].outage_notice_at).toBeNull();
    expect(db.tables.pms_connections[2].outage_notice_at).toBeNull();
  });

  it("tells someone with another property how to reach this one, since the button opens the last one they had open", async () => {
    const { supabase, tables } = world();
    tables.hotel_memberships.push({ hotel_id: "other-hotel", user_id: "u_gm", role: "revenue_manager", status: "active" });
    const { d, sent } = deps();
    await sendDueOutageNotices(supabase, "cloudbeds", d);
    const gm = sent.find((s) => s.to === "gm@harbour.test")!;
    const admin = sent.find((s) => s.to === "sam@harbour.test")!;
    const line = "You look after more than one property in MAYA. If the PMS tab opens on another one, pick The Harbour Inn in the Property dropdown.";
    expect(gm.text).toContain(line);
    expect(gm.html).toContain(line);
    expect(admin.text).not.toContain("more than one property");
  });

  it("never throws, whatever the database does", async () => {
    const broken = fakeDb({ pms_connections: [] }, { failSelect: { pms_connections: "column pms_connections.down_since does not exist" } });
    const { d } = deps();
    await expect(sendDueOutageNotices(broken.supabase, "cloudbeds", d)).resolves.toEqual([]);

    const hotelFails = world();
    const h = fakeDb(hotelFails.tables, { failSelect: { hotels: "timeout" } });
    const [r] = await sendDueOutageNotices(h.supabase, "cloudbeds", d);
    expect(r).toMatchObject({ outcome: "retry" });
    expect(hotelFails.tables.pms_connections[0].outage_notice_at).toBeNull();

    // Slack failing after the emails went out must not hand the notice back
    // and send them again.
    const exploding = world();
    const e = deps({
      alert: async () => {
        throw new Error("boom");
      },
    });
    await expect(sendDueOutageNotices(exploding.supabase, "cloudbeds", e.d)).resolves.toEqual([
      { hotelId: HOTEL, outcome: "emailed", recipients: 2, sent: 2 },
    ]);
    expect(exploding.tables.pms_connections[0].outage_notice_at).not.toBeNull();
  });
});

describe("the email", () => {
  const base: OutageEmailInput = {
    hotelName: "The Harbour Inn",
    pmsType: "cloudbeds",
    status: "disconnected",
    downSince: "14:05 on Tuesday, October 6",
    sending: true,
    pmsTabUrl: `https://maya-rms.com/go/pms?hotel=${HOTEL}`,
  };
  const variants: OutageEmailInput[] = [];
  for (const pmsType of ["cloudbeds", "think", "mews"] as const)
    for (const status of ["disconnected", "error"] as const)
      for (const sending of [true, false]) variants.push({ ...base, pmsType, status, sending: pmsType === "mews" ? false : sending });

  it("says what happened, what it means for prices, and how to reconnect", () => {
    const text = outageText(base);
    expect(text).toContain("Your Cloudbeds connection for The Harbour Inn has been down since 14:05 on Tuesday, October 6");
    expect(text).toContain("uninstalled or disconnected in Cloudbeds");
    expect(text).toContain("no prices are sent to Cloudbeds. The rates already in Cloudbeds stay exactly as they are.");
    expect(text).toContain("click Reconnect Cloudbeds");
    expect(text).toContain("General Managers and Hotel Admins");
    expect(text).toContain("If you disconnected MAYA on purpose, you can ignore this email.");
    expect(outageHtml(base)).toContain("Open the PMS tab");
  });

  it("does not say prices stopped going out when none were going out", () => {
    const text = outageText({ ...base, sending: false });
    expect(text).not.toContain("no prices are sent");
    expect(text).toContain("your prices aren't updating. Nothing in Cloudbeds changes.");
  });

  it("sends a Mews property to us, not to a button", () => {
    const text = outageText({ ...base, pmsType: "mews", status: "error", sending: false });
    expect(text).toContain("Mews refused MAYA's keys on three reads in a row");
    expect(text).toContain("Reply to this email and we'll arrange new keys with you");
    expect(text).not.toContain("Reconnect");
    expect(text).not.toContain("ignore this email");
    expect(outageSubject({ ...base, pmsType: "mews" })).toBe("MAYA has lost its connection to Mews at The Harbour Inn");
  });

  it("follows the copy rules in every variant", () => {
    for (const v of variants) {
      for (const out of [outageSubject(v), outageText(v), outageHtml(v)]) {
        expect(out).not.toMatch(/[–—]/);
        expect(out).not.toMatch(/MAYA (learns|knows|thinks|studies|analy[sz]es)/i);
      }
    }
  });

  it("escapes the property's name in the HTML", () => {
    const html = outageHtml({ ...base, hotelName: `Inn <b>"&'` });
    expect(html).toContain("Inn &lt;b&gt;&quot;&amp;&#39;");
    expect(html).not.toContain("<b>");
  });
});

describe("formatDownSince", () => {
  it("writes the time in the property's zone", () => {
    expect(formatDownSince("2026-10-06T12:05:00Z", "Europe/Berlin")).toBe("14:05 on Tuesday, October 6");
    expect(formatDownSince("2026-10-06T03:30:00Z", "America/Los_Angeles")).toBe("20:30 on Monday, October 5");
  });

  it("falls back to UTC, and says so, for a zone it does not know", () => {
    expect(formatDownSince("2026-10-06T12:05:00Z", "Mars/Olympus")).toBe("12:05 on Tuesday, October 6 UTC");
    expect(formatDownSince("2026-10-06T12:05:00Z", null)).toBe("12:05 on Tuesday, October 6");
  });
});
