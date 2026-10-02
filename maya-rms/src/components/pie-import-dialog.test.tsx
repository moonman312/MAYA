// @vitest-environment jsdom
/**
 * Import from PIE, the dialog: a screenshot in (chosen, dropped or pasted),
 * "Reading your screenshot…", the review (each PIE rule beside the MAYA
 * rules it becomes, its notes, ticks, the floors and ceilings), the 40-rule
 * cap said before anything is added, and the add: one click, no popup, the
 * rules that are on added with Skip (one line by the button says why, the
 * rest behind its "?"), what the new floors and ceilings change by
 * themselves said under it. The reading itself is handed in (the OCR has
 * its own tests); every name and number is made up.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PIE_COPY } from "@/lib/pie-import/map";
import type { PieRowRead, ScreenshotRead } from "@/lib/pie-import/read";
import { PIE_SKIP_LINE, PieImportDialog, limitsSentence, type PieEdit } from "./pie-import-dialog";

const GARDEN = "11111111-1111-4111-8111-111111111111";
const LOFT = "22222222-2222-4222-8222-222222222222";
const ROOM_TYPES = [
  { id: GARDEN, name: "Garden Room", counts_as_room: true, floor_price: 80, ceiling_price: 600, total_rooms: 10 },
  { id: LOFT, name: "Loft", counts_as_room: true, floor_price: 1, ceiling_price: 99999.99, total_rooms: 4 },
];

function row(name: string, description: string, o: Partial<PieRowRead> = {}): PieRowRead {
  return { name, description, mode: "auto", type: "occupancy", typeText: "Occupancy", active: true, startDate: "N/A", endDate: "N/A", cutOff: false, cutEdge: null, numbersUnsure: false, y: 0, ...o };
}

const SHOT: ScreenshotRead = {
  width: 2000,
  height: 1200,
  columns: null,
  rows: [
    row("Busy weekends", "Raise rate by 10.00 % when occupancy is greater than 60.00 % and when booking 30-500 days in advance"),
    row("Quiet last days", "Lower rate by 8.00 % when occupancy is lower than 20.00 % and when booking today-14 days in advance", { mode: "manual" }),
    row("Off one", "Raise rate by $5.00 when occupancy is greater than 90.00 %", { active: false }),
    row("Min stay", "Set minimum stay to 2 nights", { type: "restriction", typeText: "Restriction" }),
    row("close-in dip", "Lower rate by 10.00 % when occupancy is lower than 30.00 % and xx", { cutOff: true, active: false }),
  ],
  limits: { master: { min: 90, max: 2000 }, byType: [{ name: "Garden Room", min: 100, max: 500 }, { name: "Yurt", min: 60, max: 300 }] },
  entries: null,
  rulesSeen: true,
  scale: 2,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Sent = { url: string; body: Record<string, unknown> };
let sent: Sent[] = [];
let events: { event: string; properties: Record<string, unknown> }[] = [];
let importAnswer: () => Response;
let limitsAnswer: () => Response;

const LIMITS_CHECK = {
  at: "2026-10-01T14:10:00.000Z",
  today: "2026-10-01",
  lastNight: "2027-10-31",
  horizonDays: 396,
  limitsAffected: ["2026-11-03", "2026-11-20", "2026-11-21"],
  nightsChecked: 792,
  ms: 900,
};

const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === "/api/room-types") return json(ROOM_TYPES);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  sent.push({ url, body });
  if (url === "/api/rules/preview") return limitsAnswer();
  if (url === "/api/rules/import") return importAnswer();
  return json({}, 404);
}) as unknown as typeof fetch;

beforeEach(() => {
  sent = [];
  events = [];
  importAnswer = () =>
    json({
      created: [
        { id: "a", on: true },
        { id: "b", on: true },
        { id: "c", on: false },
      ],
      failed: [],
      limits: 2,
      skipped: true,
    });
  limitsAnswer = () => json(LIMITS_CHECK);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/events") events.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const file = () => new File(["png"], "pie.png", { type: "image/png" });

async function open(o: { activeRules?: number; read?: (files: readonly Blob[]) => Promise<ScreenshotRead[]>; onEdit?: (e: PieEdit) => void } = {}) {
  const read = o.read ?? vi.fn(async (files: readonly Blob[]) => files.map(() => SHOT));
  const onCreated = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <PieImportDialog from="rules" activeRules={o.activeRules ?? 3} read={read} fetchImpl={fetchImpl} onClose={onClose} onCreated={onCreated} onEdit={o.onEdit} />,
  );
  return { read, onCreated, onClose, view };
}

async function readOne() {
  fireEvent.change(screen.getByTestId("pie-file"), { target: { files: [file()] } });
  return screen.findByTestId("pie-rules");
}

const item = (name: string) => screen.getAllByTestId("pie-rule").find((li) => within(li).queryByText(name)) as HTMLElement;

describe("Import from PIE", () => {
  it("asks for a screenshot, says it is reading, and shows each PIE rule beside its MAYA rule", async () => {
    let finish: (v: ScreenshotRead[]) => void = () => {};
    const read = vi.fn(() => new Promise<ScreenshotRead[]>((r) => (finish = r)));
    await open({ read });
    expect(screen.getByRole("dialog", { name: "Import from PIE" })).toBeTruthy();
    expect(screen.getByText("A screenshot of PIE's Rules and Alerts page.")).toBeTruthy();
    fireEvent.change(screen.getByTestId("pie-file"), { target: { files: [file()] } });
    expect(await screen.findByText("Reading your screenshot…")).toBeTruthy();
    finish([SHOT]);
    await screen.findByTestId("pie-rules");

    expect(within(item("Busy weekends")).getByText("Raise the price 10% when sellable occupancy is over 60%, 30 or more days before arrival.")).toBeTruthy();
    expect(within(item("Busy weekends")).getByText("On")).toBeTruthy();
    // Manual in PIE: noted.
    expect(within(item("Quiet last days")).getByText(PIE_COPY.manual)).toBeTruthy();
    // Off in PIE: added off.
    expect(within(item("Off one")).getByText("Off")).toBeTruthy();
    expect(within(item("Off one")).getByText("Raise the price $5 when sellable occupancy is over 90%.")).toBeTruthy();
    // Not imported, with why, and no tick to give.
    expect(within(item("Min stay")).getByText(PIE_COPY.restriction)).toBeTruthy();
    expect((within(item("Min stay")).getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    // Cut off: finish it first.
    expect(within(item("close-in dip")).getByText(PIE_COPY.cutOff)).toBeTruthy();
    expect((within(item("close-in dip")).getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    // Limits: its own row for Garden Room, PIE's minimum and maximum for Loft, ticked; Yurt has no room type.
    const limits = screen.getByTestId("pie-limits");
    // Today's limit first, then PIE's, so "$80 → $100" can't be read backwards.
    expect(within(limits).getByText("Garden Room")).toBeTruthy();
    expect(limits.textContent).toContain("Garden RoomFloor $80 → $100 · Ceiling $600 → $500");
    expect(limits.textContent).toContain("LoftFloor $1 → $90 · Ceiling $99,999.99 → $2,000");
    expect(within(limits).queryByText(/\(now /)).toBeNull();
    await waitFor(() => expect(within(limits).getAllByRole("checkbox").every((c) => (c as HTMLInputElement).checked)).toBe(true));
    expect(within(limits).getByText('No room type called "Yurt" in MAYA.')).toBeTruthy();
    // Rounding, said once.
    expect(screen.getAllByText(PIE_COPY.rounding)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Add 3 rules and 2 limits" })).toBeTruthy();
    // Counts only, never what was read.
    await waitFor(() => expect(events.map((e) => e.event)).toEqual(["pie.import_opened", "pie.screenshots_read"]));
    expect(events[1].properties).toMatchObject({ screenshots: 1, rules: 5, ready: 3, needs_edit: 1, not_imported: 1, limits: 2 });
    expect(JSON.stringify(events)).not.toMatch(/Busy|Garden/);
  });

  it("adds the rules in one click, the ones on in PIE with Skip and no popup, and says why by the button", async () => {
    const { onCreated } = await open();
    await readOne();
    // One short line by the button, the rest behind its "?".
    expect(screen.getByTestId("pie-skip-line").textContent).toBe(PIE_SKIP_LINE);
    expect(screen.getByRole("button", { name: "Why the nights PIE adjusted are left as they are" })).toBeTruthy();
    // What the new floors and ceilings change by themselves, from the engine, once the ticks settle.
    expect((await screen.findByTestId("pie-limits-line")).textContent).toBe("The new floors and ceilings change prices on 3 days.");
    const asked = sent.filter((s) => s.url === "/api/rules/preview");
    expect(asked).toHaveLength(1);
    expect(asked[0].body).toEqual({
      intent: "import_limits",
      limits: [
        { roomTypeId: GARDEN, floor: 100, ceiling: 500 },
        { roomTypeId: LOFT, floor: 90, ceiling: 2000 },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Add 3 rules and 2 limits" }));
    expect(await screen.findByTestId("pie-done")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: /from PIE\?/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply price adjustments" })).toBeNull();
    expect(screen.getByTestId("pie-done").textContent).toBe("Added 3 rules (2 on, 1 off) and set 2 floors and ceilings.");
    const saved = sent.filter((s) => s.url === "/api/rules/import");
    expect(saved).toHaveLength(1);
    // The rules and limits alone: the server holds the nights itself.
    expect(Object.keys(saved[0].body).sort()).toEqual(["limits", "rules"]);
    expect((saved[0].body.rules as { rule_name: string; on: boolean }[]).map((r) => [r.rule_name, r.on])).toEqual([
      ["Busy weekends", true],
      ["Quiet last days", true],
      ["Off one", false],
    ]);
    expect(saved[0].body.limits).toEqual(asked[0].body.limits);
    expect(onCreated).toHaveBeenCalled();
    // Still only the import's own events: no popup's.
    expect(events.map((e) => e.event)).toEqual(["pie.import_opened", "pie.screenshots_read"]);
  });

  it("asks again when a limit is unticked, and says nothing about limits when none are ticked", async () => {
    await open();
    await readOne();
    await screen.findByTestId("pie-limits-line");
    limitsAnswer = () => json({ ...LIMITS_CHECK, limitsAffected: ["2026-11-20"] });
    const limits = screen.getByTestId("pie-limits");
    fireEvent.click(within(limits).getByRole("checkbox", { name: "Set Loft's floor and ceiling" }));
    await waitFor(() => expect(screen.getByTestId("pie-limits-line").textContent).toBe("The new floors and ceilings change prices on 1 day."));
    expect(sent.filter((s) => s.url === "/api/rules/preview").map((s) => (s.body.limits as unknown[]).length)).toEqual([2, 1]);
    // Ticked back: the first answer still stands, not asked again.
    fireEvent.click(within(limits).getByRole("checkbox", { name: "Set Loft's floor and ceiling" }));
    await waitFor(() => expect(screen.getByTestId("pie-limits-line").textContent).toBe("The new floors and ceilings change prices on 3 days."));
    fireEvent.click(within(limits).getByRole("checkbox", { name: "Set Loft's floor and ceiling" }));
    fireEvent.click(within(limits).getByRole("checkbox", { name: "Set Garden Room's floor and ceiling" }));
    await waitFor(() => expect(screen.queryByTestId("pie-limits-line")).toBeNull());
    expect(sent.filter((s) => s.url === "/api/rules/preview")).toHaveLength(2);
  });

  it("says the limits can change prices when that couldn't be worked out, and nothing when they change none", async () => {
    limitsAnswer = () => json({ error: "We weren't able to work out which days the new floors and ceilings change." }, 500);
    await open();
    await readOne();
    expect((await screen.findByTestId("pie-limits-line")).textContent).toBe("The new floors and ceilings can change prices by themselves.");
    cleanup();
    limitsAnswer = () => json({ ...LIMITS_CHECK, limitsAffected: [] });
    await open();
    await readOne();
    await waitFor(() => expect(sent.filter((s) => s.url === "/api/rules/preview")).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("pie-limits-line")).toBeNull();
    expect(limitsSentence(1)).toBe("The new floors and ceilings change prices on 1 day.");
  });

  it("adds rules that were all off, and limits, with no popup and no word about PIE's nights", async () => {
    await open();
    await readOne();
    fireEvent.click(within(item("Busy weekends")).getByRole("checkbox"));
    fireEvent.click(within(item("Quiet last days")).getByRole("checkbox"));
    expect(screen.queryByTestId("pie-skip-line")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add 1 rule and 2 limits" }));
    expect(await screen.findByTestId("pie-done")).toBeTruthy();
    expect(sent.filter((s) => s.url === "/api/rules/import")).toHaveLength(1);
    expect((sent.find((s) => s.url === "/api/rules/import")!.body.rules as unknown[]).length).toBe(1);
  });

  it("says what went wrong on the review when nothing could be added", async () => {
    importAnswer = () => json({ error: "That makes 41 rules on, and a property can have 40. Untick 1 to fit.", code: "cap" }, 409);
    await open();
    await readOne();
    fireEvent.click(screen.getByRole("button", { name: "Add 3 rules and 2 limits" }));
    expect(await screen.findByText("That makes 41 rules on, and a property can have 40. Untick 1 to fit.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add 3 rules and 2 limits" })).toBeTruthy();
    expect(screen.queryByTestId("pie-done")).toBeNull();
  });

  it("says before adding when the rules on would pass 40, and won't add", async () => {
    await open({ activeRules: 39 });
    await readOne();
    expect(screen.getByTestId("pie-cap").textContent).toBe("That makes 41 rules on, and a property can have 40. Untick 1 to fit.");
    expect((screen.getByRole("button", { name: "Add 3 rules and 2 limits" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(item("Busy weekends")).getByRole("checkbox"));
    expect(screen.queryByTestId("pie-cap")).toBeNull();
    expect((screen.getByRole("button", { name: "Add 2 rules and 2 limits" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("opens a rule in the rule builder, and takes it back changed, ready to add", async () => {
    const onEdit = vi.fn();
    const { view, read } = await open({ onEdit });
    await readOne();
    fireEvent.click(within(item("close-in dip")).getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    const edit = onEdit.mock.calls[0][0] as PieEdit;
    expect(edit.draft.rule_name).toBe("close-in dip");
    // The owner finished it in the builder: a window of 4 or fewer days.
    const changed: PieEdit = { ...edit, draft: { ...edit.draft, condition: { ...edit.draft.condition, dta_operator: "lt", dta_threshold_days: 5 } } };
    view.rerender(<PieImportDialog from="rules" activeRules={3} read={read} fetchImpl={fetchImpl} onClose={() => {}} onEdit={onEdit} edited={changed} />);
    await waitFor(() => expect(within(item("close-in dip")).getByText("Lower the price 10% when sellable occupancy is under 30%, 4 or fewer days before arrival.")).toBeTruthy());
    const box = within(item("close-in dip")).getByRole("checkbox") as HTMLInputElement;
    expect(box.disabled).toBe(false);
    expect(box.checked).toBe(true);
    expect(within(item("close-in dip")).queryByText(PIE_COPY.cutOff)).toBeNull();
    expect(screen.getByRole("button", { name: "Add 4 rules and 2 limits" })).toBeTruthy();
  });

  it("takes a pasted screenshot, and another added later, merging the two", async () => {
    const read = vi.fn(async (files: readonly Blob[]): Promise<ScreenshotRead[]> =>
      files.map(() => ({ ...SHOT, rows: [row("Peak", "Raise rate by 15.00 % when occupancy is greater than 90.00 %")], limits: { master: null, byType: [] } })),
    );
    await open({ read });
    const paste = new Event("paste", { bubbles: true }) as Event & { clipboardData: unknown };
    paste.clipboardData = { files: [file()] };
    document.dispatchEvent(paste);
    await screen.findByTestId("pie-rules");
    expect(screen.getAllByTestId("pie-rule")).toHaveLength(1);
    read.mockImplementationOnce(async (files) => files.map(() => SHOT));
    fireEvent.change(screen.getByTestId("pie-file"), { target: { files: [file()] } });
    await waitFor(() => expect(screen.getAllByTestId("pie-rule")).toHaveLength(6));
  });

  it("says when nothing was found, and when a screenshot can't be read", async () => {
    const read = vi.fn(async () => [{ ...SHOT, rows: [], limits: { master: null, byType: [] } }]);
    await open({ read });
    fireEvent.change(screen.getByTestId("pie-file"), { target: { files: [file()] } });
    expect(await screen.findByTestId("pie-nothing")).toBeTruthy();
    cleanup();
    await open({ read: vi.fn(async () => Promise.reject(new Error("no worker"))) });
    fireEvent.change(screen.getByTestId("pie-file"), { target: { files: [file()] } });
    expect(await screen.findByText("That screenshot couldn't be read. Check your connection and try again.")).toBeTruthy();
    await waitFor(() => expect(events.some((e) => e.event === "pie.read_failed")).toBe(true));
  });

  it("leaves a rule or a floor and ceiling that may be misread unticked, to tick once checked", async () => {
    const read = vi.fn(async () => [
      {
        ...SHOT,
        rows: [row("Bare", "Raise rate by 10.00 % when occupancy is greater than 60 %"), row("Fine", "Raise rate by 10.00 % when occupancy is greater than 60.00 %")],
        limits: { master: null, byType: [{ name: "Garden Room", min: 100, max: 500, unsure: true }] },
      },
    ]);
    await open({ read });
    fireEvent.change(screen.getByTestId("pie-file"), { target: { files: [file()] } });
    await screen.findByTestId("pie-rules");
    const bare = within(item("Bare")).getByRole("checkbox") as HTMLInputElement;
    expect([bare.checked, bare.disabled]).toEqual([false, false]);
    expect(within(item("Bare")).getByText(PIE_COPY.checkNumbers)).toBeTruthy();
    const limits = screen.getByTestId("pie-limits");
    const garden = within(limits).getByRole("checkbox", { name: "Set Garden Room's floor and ceiling" }) as HTMLInputElement;
    expect([garden.checked, garden.disabled]).toEqual([false, false]);
    expect(within(limits).getByText(PIE_COPY.limitCheck)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add 1 rule" })).toBeTruthy();
    fireEvent.click(garden);
    fireEvent.click(bare);
    expect(screen.getByRole("button", { name: "Add 2 rules and 1 limit" })).toBeTruthy();
  });

  it("says when a screenshot's rules couldn't be read, and how many of PIE's rules aren't here", async () => {
    const limitsOnly = { ...SHOT, rows: [], rulesSeen: true };
    await open({ read: vi.fn(async () => [limitsOnly]) });
    fireEvent.change(screen.getByTestId("pie-file"), { target: { files: [file()] } });
    // Floors and ceilings found, and the rules beside them not read: said, not left for the owner to miss.
    expect((await screen.findByTestId("pie-rules-unread")).textContent).toBe(PIE_COPY.rulesUnread(1));
    expect(screen.getByTestId("pie-limits")).toBeTruthy();
    cleanup();
    await open({ read: vi.fn(async () => [{ ...SHOT, entries: { from: 1, to: 9, total: 9 } }]) });
    fireEvent.change(screen.getByTestId("pie-file"), { target: { files: [file()] } });
    expect((await screen.findByTestId("pie-missing")).textContent).toBe(PIE_COPY.missing(9, 5));
  });

  it("says when a file isn't an image", async () => {
    const notImage = Object.assign(new Error("can't decode"), { name: "NotAnImageError" });
    await open({ read: vi.fn(async () => Promise.reject(notImage)) });
    fireEvent.change(screen.getByTestId("pie-file"), { target: { files: [file()] } });
    expect(await screen.findByText("That file isn't an image MAYA can read.")).toBeTruthy();
    await waitFor(() => expect(events.some((e) => e.event === "pie.read_failed" && e.properties.stage === "image")).toBe(true));
  });

  it("says the floors and ceilings were set when the rules then couldn't be added", async () => {
    importAnswer = () => json({ created: [], failed: [{ id: "y", error: "Could not save the rule. Try again in a moment." }], limits: 2 });
    const { onCreated } = await open();
    await readOne();
    fireEvent.click(within(item("Busy weekends")).getByRole("checkbox"));
    fireEvent.click(within(item("Quiet last days")).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Add 1 rule and 2 limits" }));
    expect((await screen.findByTestId("pie-done")).textContent).toBe("Set 2 floors and ceilings, but the rules couldn't be added.");
    expect(onCreated).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("names a rule that didn't save, and tries it again", async () => {
    importAnswer = () => json({ created: [{ id: "x", on: true }], failed: [{ id: "y", error: "Pick at least one room type to change." }], limits: 0 });
    await open();
    await readOne();
    fireEvent.click(within(item("Busy weekends")).getByRole("checkbox"));
    fireEvent.click(within(item("Off one")).getByRole("checkbox"));
    const limits = screen.getByTestId("pie-limits");
    for (const c of within(limits).getAllByRole("checkbox")) fireEvent.click(c);
    fireEvent.click(screen.getByRole("button", { name: "Add 1 rule" }));
    expect((await screen.findByTestId("pie-done")).textContent).toBe("Added 1 rule.");
    expect(screen.getByText(/Pick at least one room type to change\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
