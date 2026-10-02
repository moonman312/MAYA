// @vitest-environment jsdom
/**
 * The activation popup: a square for every night of the pricing window,
 * the days the rule will change filled in, "X days will be affected by this
 * rule." only once every part of the answer is in, Apply and Skip sent with
 * what the days were worked out on (Skip with the days it holds), Cancel
 * saving nothing, and the days worked out again (and shown, when they
 * changed) if something moved before the owner chose. With no days, "0
 * prices will be affected by this rule." and one button that turns the rule
 * on; when the days can't be worked out, Jake's sentence with Try again,
 * Skip and Cancel (Jake, 2026-09-29).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuleActivationDialog, DAYS_CHANGED_LINE, DAYS_KEPT_CHANGING, type ActivationChoice, type SaveAnswer } from "./rule-activation-dialog";
import { DAYS_NOT_CALCULATED } from "@/lib/rule-activation-client";

const TODAY = "2026-10-01";
const LAST = "2027-10-31";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Part = { affected: string[]; fingerprint?: string; roomTypesChanged?: Record<string, number> };

/** A preview route answering each part with the days in it (`extra`: more of the answer, the same for every part). */
function previewRoute(
  days: string[] | (() => string[]),
  opts: { fingerprint?: () => string; hold?: Promise<void>; extra?: Record<string, unknown> } = {},
) {
  const calls: Record<string, unknown>[] = [];
  const impl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { from?: string; to?: string };
    calls.push(body);
    if (opts.hold) await opts.hold;
    const all = typeof days === "function" ? days() : days;
    const affected = all.filter((d) => (!body.from || d >= body.from) && (!body.to || d <= body.to));
    const part: Part & Record<string, unknown> = {
      needsActivation: true,
      today: TODAY,
      lastNight: LAST,
      affected,
      roomTypesChanged: Object.fromEntries(affected.map((d) => [d, 2])),
      touched: affected,
      fingerprint: opts.fingerprint?.() ?? "fp-1",
      kind: "standard",
      ms: 120,
      nightsChecked: 30,
      ...(opts.extra ?? {}),
    };
    return json(part);
  });
  return { impl, calls };
}

const request = { intent: "enable" as const, ruleId: "r1" };

function renderDialog(over: Partial<Parameters<typeof RuleActivationDialog>[0]> & { fetchImpl: typeof fetch }) {
  const save = over.save ?? vi.fn(async (): Promise<SaveAnswer> => ({ ok: true }));
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  render(
    <RuleActivationDialog
      ruleName="Busy nights"
      request={request}
      kind="standard"
      source="switch"
      save={save}
      onSaved={onSaved}
      onCancel={onCancel}
      {...over}
    />,
  );
  return { save, onSaved, onCancel };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const squares = () => [...document.querySelectorAll<HTMLElement>("[data-day]")];
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("the activation popup", () => {
  it("draws every night of the window while it checks, with no number and nothing to click but Cancel", async () => {
    let release!: () => void;
    const { impl } = previewRoute(["2026-10-03"], { hold: new Promise<void>((r) => (release = r)) });
    renderDialog({ fetchImpl: impl as unknown as typeof fetch });
    expect(screen.getByRole("dialog", { name: "Turn on “Busy nights”?" })).toBeTruthy();
    expect(screen.getByTestId("activation-summary").textContent).toBe("Checking your calendar…");
    expect(button("Apply price adjustments").disabled).toBe(true);
    expect(button("Skip price adjustments").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(false);
    expect(squares().some((s) => s.dataset.affected === "true")).toBe(false);
    release();
    await waitFor(() => expect(screen.getByTestId("activation-summary").textContent).toBe("1 day will be affected by this rule."));
  });

  it("fills in the affected days, counts them, and blanks the days outside the window", async () => {
    const days = ["2026-10-03", "2026-10-04", "2026-12-25", "2027-10-31"];
    const { impl } = previewRoute(days);
    renderDialog({ fetchImpl: impl as unknown as typeof fetch });
    await waitFor(() => expect(screen.getByTestId("activation-summary").textContent).toBe("4 days will be affected by this rule."));
    const all = squares();
    // Every night from today to the window's last, one square each.
    expect(all[0].dataset.day).toBe(TODAY);
    expect(all[all.length - 1].dataset.day).toBe(LAST);
    expect(all).toHaveLength(396);
    expect(all.filter((s) => s.dataset.affected === "true").map((s) => s.dataset.day)).toEqual(days);
    // 10 x 10 squares, the hover says which room types.
    expect(all[2].className).toContain("size-[10px]");
    expect(all[2].title).toBe("Sat 3 Oct 2026: prices change on 2 room types");
    // A block per month the window reaches: October 2026 to October 2027.
    const calendar = screen.getByTestId("activation-calendar");
    expect(within(calendar).getByText("Oct 2026")).toBeTruthy();
    expect(within(calendar).getByText("Jan 2027")).toBeTruthy();
    expect(calendar.children).toHaveLength(13);
    // Screen readers get the days as runs.
    expect(screen.getByText(/Days affected: 3 to 4 October 2026, 25 December 2026, 31 October 2027/)).toBeTruthy();
  });

  it("with nothing to change: says 0 prices, and one button turns the rule on", async () => {
    const { impl } = previewRoute([]);
    const { save, onSaved, onCancel } = renderDialog({ fetchImpl: impl as unknown as typeof fetch });
    await waitFor(() => expect(screen.getByTestId("activation-summary").textContent).toBe("0 prices will be affected by this rule."));
    expect(screen.queryByRole("button", { name: "Apply price adjustments" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip price adjustments" })).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent).filter((t) => t !== "?" && !/What the days mean/.test(t ?? ""))).toEqual([
      "Turn it on",
      "Cancel",
    ]);
    fireEvent.click(button("Turn it on"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(false));
    expect(save).toHaveBeenCalledWith({ activation: "apply", fingerprint: "fp-1", touched: [], days: 0, refreshed: false } satisfies ActivationChoice);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("with nothing to change on a rule that is already on, the one button saves the changes", async () => {
    const { impl } = previewRoute([]);
    const { save, onSaved } = renderDialog({ fetchImpl: impl as unknown as typeof fetch, request: { intent: "edit", ruleId: "r1" } });
    await waitFor(() => expect(screen.getByTestId("activation-summary").textContent).toBe("0 prices will be affected by this rule."));
    expect(screen.queryByRole("button", { name: "Turn it on" })).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent).filter((t) => t !== "?" && !/What the days mean/.test(t ?? ""))).toEqual([
      "Save changes",
      "Cancel",
    ]);
    fireEvent.click(button("Save changes"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(false));
    expect(save).toHaveBeenCalledWith({ activation: "apply", fingerprint: "fp-1", touched: [], days: 0, refreshed: false } satisfies ActivationChoice);
    // A new rule is saved on, so its button still turns it on.
    cleanup();
    renderDialog({ fetchImpl: impl as unknown as typeof fetch, request: { intent: "create", ruleId: "n1" } });
    await waitFor(() => expect(button("Turn it on").disabled).toBe(false));
  });

  it("with nothing to change, Cancel still backs out", async () => {
    const { impl } = previewRoute([]);
    const { save, onCancel } = renderDialog({ fetchImpl: impl as unknown as typeof fetch });
    await waitFor(() => expect(button("Turn it on").disabled).toBe(false));
    fireEvent.click(button("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it("Turn it on shows the days first if they are no longer 0", async () => {
    let days: string[] = [];
    let fp = "fp-1";
    const { impl } = previewRoute(() => days, { fingerprint: () => fp });
    const save = vi.fn(async (): Promise<SaveAnswer> => ({ ok: false, status: 409, code: "stale", error: DAYS_CHANGED_LINE }));
    const { onSaved } = renderDialog({ fetchImpl: impl as unknown as typeof fetch, save });
    await waitFor(() => expect(button("Turn it on").disabled).toBe(false));
    days = ["2026-10-06"];
    fp = "fp-2";
    fireEvent.click(button("Turn it on"));
    await waitFor(() => expect(screen.getByText(DAYS_CHANGED_LINE)).toBeTruthy());
    expect(screen.getByTestId("activation-summary").textContent).toBe("1 day will be affected by this rule.");
    expect(button("Apply price adjustments").disabled).toBe(false);
    expect(button("Skip price adjustments").disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Turn it on" })).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("Apply sends the owner's choice with what the days were worked out on", async () => {
    const { impl } = previewRoute(["2026-10-03", "2026-10-05"]);
    const { save, onSaved } = renderDialog({ fetchImpl: impl as unknown as typeof fetch });
    await waitFor(() => expect(button("Apply price adjustments").disabled).toBe(false));
    fireEvent.click(button("Apply price adjustments"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(false));
    expect(save).toHaveBeenCalledWith({
      activation: "apply",
      fingerprint: "fp-1",
      touched: ["2026-10-03", "2026-10-05"],
      days: 2,
      refreshed: false,
    } satisfies ActivationChoice);
  });

  it("Skip sends skip, with the days it holds: the ones shown", async () => {
    const { impl } = previewRoute(["2026-10-03", "2026-11-12"]);
    const { save, onSaved } = renderDialog({ fetchImpl: impl as unknown as typeof fetch });
    await waitFor(() => expect(button("Skip price adjustments").disabled).toBe(false));
    fireEvent.click(button("Skip price adjustments"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(true));
    expect(save).toHaveBeenCalledWith({
      activation: "skip",
      fingerprint: "fp-1",
      touched: ["2026-10-03", "2026-11-12"],
      held: ["2026-10-03", "2026-11-12"],
      days: 2,
      refreshed: false,
    } satisfies ActivationChoice);
  });

  it("Cancel, Esc and a click outside save nothing", async () => {
    const { impl } = previewRoute(["2026-10-03"]);
    const { save, onCancel } = renderDialog({ fetchImpl: impl as unknown as typeof fetch });
    await waitFor(() => expect(button("Apply price adjustments").disabled).toBe(false));
    fireEvent.click(button("Cancel"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(save).not.toHaveBeenCalled();
  });

  it("when the days can't be worked out: says so, and offers Try again, Skip and Cancel, no Apply", async () => {
    let fail = true;
    const { impl: ok } = previewRoute(["2026-10-03"]);
    const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
      fail ? json({ error: DAYS_NOT_CALCULATED }, 500) : ok(url, init),
    );
    renderDialog({ fetchImpl: impl as unknown as typeof fetch });
    await waitFor(() =>
      expect(screen.getByTestId("activation-summary").textContent).toBe(
        "We weren't able to calculate how many days would be affected by this rule.",
      ),
    );
    expect(screen.queryByRole("button", { name: "Apply price adjustments" })).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent).filter((t) => t !== "?" && !/What the days mean/.test(t ?? ""))).toEqual([
      "Skip price adjustments",
      "Try again",
      "Cancel",
    ]);
    expect(button("Skip price adjustments").disabled).toBe(false);
    expect(button("Cancel").disabled).toBe(false);
    fail = false;
    fireEvent.click(button("Try again"));
    await waitFor(() => expect(screen.getByTestId("activation-summary").textContent).toBe("1 day will be affected by this rule."));
    expect(button("Apply price adjustments").disabled).toBe(false);
  });

  it("the same for a time-out or a lost connection, and Skip there holds every day the rule could change", async () => {
    const impl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const { save, onSaved } = renderDialog({ fetchImpl: impl as unknown as typeof fetch });
    await waitFor(() => expect(screen.getByTestId("activation-summary").textContent).toBe(DAYS_NOT_CALCULATED));
    fireEvent.click(button("Skip price adjustments"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(true));
    expect(save).toHaveBeenCalledWith({ activation: "skip", fingerprint: "", touched: [], hold_all: true, days: 0, refreshed: false } satisfies ActivationChoice);
  });

  it("too many checks at once: the same sentence, with the server's own words under it", async () => {
    const impl = vi.fn(async () => json({ error: "That's a lot of checks at once. Give it a minute and try again." }, 429));
    renderDialog({ fetchImpl: impl as unknown as typeof fetch });
    await waitFor(() => expect(screen.getByTestId("activation-summary").textContent).toBe(DAYS_NOT_CALCULATED));
    expect(screen.getByText("That's a lot of checks at once. Give it a minute and try again.")).toBeTruthy();
  });

  it("asks a booking speed rule's days in three parts and counts them only once all are in", async () => {
    const { impl, calls } = previewRoute(["2026-10-03", "2027-02-01", "2027-09-30"]);
    renderDialog({ fetchImpl: impl as unknown as typeof fetch, kind: "event" });
    await waitFor(() => expect(screen.getByTestId("activation-summary").textContent).toBe("3 days will be affected by this rule."));
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => [c.from ?? null, c.to ?? null])).toEqual([
      [null, expect.any(String)],
      [expect.any(String), expect.any(String)],
      [expect.any(String), null],
    ]);
  });

  it("when bookings moved before the owner chose: the same days save at once, new days are shown first", async () => {
    let days = ["2026-10-03"];
    let fp = "fp-1";
    const { impl } = previewRoute(() => days, { fingerprint: () => fp });
    const answers: SaveAnswer[] = [{ ok: false, status: 409, code: "stale", error: DAYS_CHANGED_LINE }, { ok: true }];
    const save = vi.fn(async (): Promise<SaveAnswer> => answers.shift()!);
    const { onSaved } = renderDialog({ fetchImpl: impl as unknown as typeof fetch, save });
    await waitFor(() => expect(button("Apply price adjustments").disabled).toBe(false));
    fp = "fp-2";
    fireEvent.click(button("Apply price adjustments"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ fingerprint: "fp-2", refreshed: true }));

    cleanup();
    days = ["2026-10-03"];
    fp = "fp-1";
    const answers2: SaveAnswer[] = [{ ok: false, status: 409, code: "stale", error: DAYS_CHANGED_LINE }];
    const save2 = vi.fn(async (): Promise<SaveAnswer> => answers2.shift() ?? { ok: true });
    const second = renderDialog({ fetchImpl: impl as unknown as typeof fetch, save: save2 });
    await waitFor(() => expect(button("Apply price adjustments").disabled).toBe(false));
    days = ["2026-10-03", "2026-10-04"];
    fp = "fp-3";
    fireEvent.click(button("Apply price adjustments"));
    await waitFor(() => expect(screen.getByText(DAYS_CHANGED_LINE)).toBeTruthy());
    expect(screen.getByTestId("activation-summary").textContent).toBe("2 days will be affected by this rule.");
    expect(second.onSaved).not.toHaveBeenCalled();
    expect(save2).toHaveBeenCalledTimes(1);
    // The fresh look went through: the amber line once, and nothing in red.
    expect(screen.getAllByText(DAYS_CHANGED_LINE)).toHaveLength(1);
    expect(document.querySelector(".text-rose-400")).toBeNull();
  });

  it("refused as stale again right after the fresh look: one red line, never the amber sentence twice", async () => {
    let fp = "fp-1";
    const { impl } = previewRoute(["2026-10-03"], { fingerprint: () => fp });
    // The server's words for a stale save are the amber sentence; the popup never shows them as an error.
    const save = vi.fn(async (): Promise<SaveAnswer> => ({ ok: false, status: 409, code: "stale", error: DAYS_CHANGED_LINE }));
    const { onSaved } = renderDialog({ fetchImpl: impl as unknown as typeof fetch, save });
    await waitFor(() => expect(button("Skip price adjustments").disabled).toBe(false));
    fp = "fp-2";
    fireEvent.click(button("Skip price adjustments"));
    await waitFor(() => expect(screen.getByText(DAYS_KEPT_CHANGING)).toBeTruthy());
    expect(save).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(DAYS_CHANGED_LINE)).toBeNull();
    expect(screen.getByText(DAYS_KEPT_CHANGING).className).toContain("text-rose-400");
    expect(document.querySelectorAll(".text-amber-300, .text-rose-400")).toHaveLength(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(button("Skip price adjustments").disabled).toBe(false);
  });

  it("hands a refusal for the person's role back to where they clicked", async () => {
    const impl = vi.fn(async () => json({ error: "Only a Revenue Manager or above can change this." }, 403));
    const onRefused = vi.fn();
    renderDialog({ fetchImpl: impl as unknown as typeof fetch, onRefused });
    await waitFor(() => expect(onRefused).toHaveBeenCalledWith("Only a Revenue Manager or above can change this."));
  });

  it("names what is being saved", async () => {
    const { impl } = previewRoute([]);
    renderDialog({ fetchImpl: impl as unknown as typeof fetch, request: { intent: "create", ruleId: "n1" } });
    expect(screen.getByRole("dialog", { name: "Add “Busy nights”?" })).toBeTruthy();
    cleanup();
    renderDialog({ fetchImpl: impl as unknown as typeof fetch, request: { intent: "edit", ruleId: "r1" } });
    expect(screen.getByRole("dialog", { name: "Save changes to “Busy nights”?" })).toBeTruthy();
  });
});

/**
 * A cut on low pickup with no booking window condition (Jake, 2026-09-29,
 * A4): under the count, two more lines from the same dry run, how many
 * nights the rule reaches and that the cut repeats every wait. Shown once
 * every part is in, with 0 prices too, and never for any other rule.
 */
describe("a cut on low pickup with no booking window", () => {
  const facts = { threshold: 1, windowDays: 7, metric: "room_nights", waitDays: 7 };
  const REACH_LINE =
    "With no booking window condition, this rule reaches 300 of the 396 nights ahead. A night that gained under 1 room night over the 7 full days before counts as quiet, and a far-out night with no bookings yet always will, once your rules have run for 1 week.";
  const REPEAT_LINE = "The cut repeats: each time its wait of 1 week is over and the night is still quiet, it cuts again, on top of the cut before.";

  it("says how many nights it reaches, every part added up, and that the cut repeats", async () => {
    let release!: () => void;
    // Three parts of 100 nights each.
    const { impl } = previewRoute(["2026-10-03"], { extra: { horizonDays: 396, reach: 100, farOutCut: facts }, hold: new Promise<void>((r) => (release = r)) });
    renderDialog({ fetchImpl: impl as unknown as typeof fetch, kind: "event" });
    // Not before the count: the reach is every part together.
    expect(screen.queryByTestId("activation-far-out-cut")).toBeNull();
    release();
    await waitFor(() => expect(screen.getByTestId("activation-summary").textContent).toBe("1 day will be affected by this rule."));
    const lines = screen.getByTestId("activation-far-out-cut");
    expect(within(lines).getByText(REACH_LINE)).toBeTruthy();
    expect(within(lines).getByText(REPEAT_LINE)).toBeTruthy();
    expect(button("Apply price adjustments").disabled).toBe(false);
  });

  it("with 0 prices, where the property's rules have not run for the window yet, says what happens once they have", async () => {
    const { impl } = previewRoute([], { extra: { horizonDays: 396, reach: 100, farOutCut: facts } });
    renderDialog({ fetchImpl: impl as unknown as typeof fetch, kind: "event" });
    await waitFor(() => expect(screen.getByTestId("activation-summary").textContent).toBe("0 prices will be affected by this rule."));
    const lines = screen.getByTestId("activation-far-out-cut");
    expect(within(lines).getByText(REACH_LINE)).toBeTruthy();
    expect(within(lines).getByText(REPEAT_LINE)).toBeTruthy();
    expect(button("Turn it on").disabled).toBe(false);
  });

  it("adds nothing for any other rule", async () => {
    const { impl } = previewRoute(["2026-10-03"], { extra: { horizonDays: 396, reach: 100, farOutCut: null } });
    renderDialog({ fetchImpl: impl as unknown as typeof fetch, kind: "event" });
    await waitFor(() => expect(screen.getByTestId("activation-summary").textContent).toBe("1 day will be affected by this rule."));
    expect(screen.queryByTestId("activation-far-out-cut")).toBeNull();
    expect(screen.queryByText(/The cut repeats/)).toBeNull();
  });
});
