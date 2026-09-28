// @vitest-environment jsdom
/**
 * The undo box in the rule builder: ticked to start, a click is the owner's
 * choice, and what it does is behind the "?". Saving a saved rule's box is
 * kept for rule editing.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNDO_ON_CANCELLATION_HELP, UNDO_ON_CANCELLATION_LABEL } from "@/lib/rule-form";
import { UNDO_BOX_NOT_SAVED, UndoOnCancellationField, saveUndoOnCancellation } from "./undo-on-cancellation-box";

afterEach(cleanup);

/** The builder's state as dashboard.tsx keeps it: ticked until the owner says otherwise. */
function Builder({ onValue }: { onValue: (v: boolean) => void }) {
  const [undo, setUndo] = useState(true);
  onValue(undo);
  return <UndoOnCancellationField checked={undo} onChange={setUndo} />;
}

describe("UndoOnCancellationField", () => {
  it("starts ticked, and the owner can untick and tick it again", () => {
    let value!: boolean;
    render(<Builder onValue={(v) => (value = v)} />);
    const box = screen.getByLabelText(UNDO_ON_CANCELLATION_LABEL) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(value).toBe(true);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    expect(value).toBe(false);
    fireEvent.click(box);
    expect(value).toBe(true);
  });

  it("keeps what it does behind the ? rather than on screen", () => {
    render(<UndoOnCancellationField checked onChange={() => {}} />);
    expect(screen.queryByText(UNDO_ON_CANCELLATION_HELP.lines[0])).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: UNDO_ON_CANCELLATION_HELP.label }));
    for (const line of UNDO_ON_CANCELLATION_HELP.lines) expect(screen.getByText(line)).toBeTruthy();
  });
});

describe("saving a saved rule's box", () => {
  const answer = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

  it("sends the box alone, and says nothing when it saved", async () => {
    const fetchImpl = answer(200, { ok: true });
    expect(await saveUndoOnCancellation("r1", false, fetchImpl as unknown as typeof fetch)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith("/api/rules/r1", expect.objectContaining({ method: "PUT", body: '{"undo_on_cancellation":false}' }));
  });

  it("says why when the person's role can't change rules, and asks for a retry otherwise", async () => {
    const refused = answer(403, { error: "Only a Revenue Manager or above can change this." });
    expect(await saveUndoOnCancellation("r1", true, refused as unknown as typeof fetch)).toBe(
      "Only a Revenue Manager or above can change this.",
    );
    expect(await saveUndoOnCancellation("r1", true, answer(500, {}) as unknown as typeof fetch)).toBe(UNDO_BOX_NOT_SAVED);
    const offline = vi.fn(async () => {
      throw new TypeError("offline");
    });
    expect(await saveUndoOnCancellation("r1", true, offline as unknown as typeof fetch)).toBe(UNDO_BOX_NOT_SAVED);
  });
});

describe("the help's words", () => {
  it("say what the box does in plain words, in short lines, no dashes or claims about MAYA", () => {
    for (const line of UNDO_ON_CANCELLATION_HELP.lines) expect(line.length).toBeLessThanOrEqual(220);
    // Ticked, unticked, and what takes a change off either way.
    expect(UNDO_ON_CANCELLATION_HELP.lines[0]).toMatch(/^Ticked: if bookings this change counted cancel/);
    expect(UNDO_ON_CANCELLATION_HELP.lines.some((l) => l.startsWith("Unticked:"))).toBe(true);
    expect(UNDO_ON_CANCELLATION_HELP.lines.join(" ")).toMatch(/you or in your PMS/);
    for (const line of [UNDO_ON_CANCELLATION_LABEL, UNDO_ON_CANCELLATION_HELP.title, ...UNDO_ON_CANCELLATION_HELP.lines]) {
      expect(line).not.toMatch(/—|–/);
      expect(line).not.toMatch(/\b(learns|knows|thinks|smart|AI)\b/i);
    }
  });
});
