// @vitest-environment jsdom
/**
 * Rule suggestions and the activation popup: on the Rules tab's "Get
 * suggestions from my data" (an import in refresh mode), "Add this rule"
 * and "Make that change" open the popup and save the owner's Apply or Skip;
 * in the first review, while the property is being set up, a confirm saves
 * as it always has.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewFindings } from "./review-findings";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const RT = "0a000000-0000-4000-8000-000000000001";
const RULE = "0b000000-0000-4000-8000-000000000001";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const FINDINGS = [
  {
    id: "f-add",
    kind: "rule_suggestion",
    status: "proposed",
    created_at: "2026-10-01T00:00:00Z",
    payload: {
      suggestion_type: "add_rule",
      rationale: "Your weekends fill early.",
      room_type_ids: [RT],
      spec: {
        name: "Weekend lift",
        priority: 100,
        explanation: "Raise when a weekend night is over 80% full.",
        condition: { occupancy_operator: "gt", occupancy_threshold: 0.8 },
        action: { action_type: "percent", action_direction: "increase", action_value: 10 },
        is_pickup_rule: false,
      },
    },
  },
  {
    id: "f-tune",
    kind: "rule_suggestion",
    status: "proposed",
    created_at: "2026-10-01T00:00:00Z",
    payload: { suggestion_type: "adjust_rule", rule_id: RULE, rule_name: "Busy nights", rationale: "It fires early.", current_threshold: 0.7, suggested_threshold: 0.85 },
  },
];

let sent: { url: string; body: Record<string, unknown> }[] = [];
let mode: string | undefined;

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (init?.method === "POST" && url !== "/api/events") sent.push({ url, body });
      if (url === "/api/onboarding/findings") return json({ findings: FINDINGS });
      if (url === "/api/onboarding/status")
        return json({ connected: true, hotelId: "h1", job: { status: "completed", phase: "done", stats: mode ? { mode } : {} } });
      if (url === "/api/rules/preview")
        return json({ needsActivation: true, today: "2026-10-01", lastNight: "2027-10-31", affected: ["2026-10-03"], roomTypesChanged: {}, touched: ["2026-10-03"], fingerprint: "fp", kind: "standard", ms: 1, nightsChecked: 1 });
      if (url === "/api/rules/engine")
        return json([
          {
            id: RULE,
            name: "Busy nights",
            is_active: true,
            version: 2,
            action_type: "percent",
            action_direction: "increase",
            action_value: 15,
            condition: { occupancy_operator: "gt", occupancy_threshold: 0.7 },
            signal_room_type_ids: [RT],
            affected_room_type_ids: [RT],
            undo_on_cancellation: true,
          },
        ]);
      if (url === "/api/room-types") return json([]);
      if (url.startsWith("/api/onboarding/findings/")) return json({ ok: true });
      return new Response(null, { status: 204 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The recommendations, once the page has read where the suggestions came from. */
async function openRecommendations() {
  render(<ReviewFindings initialStep="recommendations" />);
  await screen.findByText(/Add a rule: "Weekend lift"/);
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some((c) => String(c[0]) === "/api/onboarding/status")).toBe(true));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

const confirms = () => sent.filter((s) => s.url.startsWith("/api/onboarding/findings/"));

describe("rule suggestions from the Rules tab", () => {
  beforeEach(() => {
    mode = "refresh";
  });

  it("Add this rule opens the popup, and Skip confirms with the owner's choice and the previewed id", async () => {
    await openRecommendations();
    fireEvent.click(await screen.findByRole("button", { name: "Add this rule" }));
    const dialog = await screen.findByRole("dialog", { name: "Add “Weekend lift”?" });
    await waitFor(() => expect(within(dialog).getByTestId("activation-summary").textContent).toBe("1 day will be affected by this rule."));
    const preview = sent.find((s) => s.url === "/api/rules/preview")!.body;
    expect(preview).toMatchObject({ intent: "create", draft: expect.objectContaining({ rule_name: "Weekend lift", signal_room_type_ids: [RT] }) });
    expect(confirms()).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Skip price adjustments" }));
    await waitFor(() => expect(confirms()).toHaveLength(1));
    expect(confirms()[0]).toEqual({
      url: "/api/onboarding/findings/f-add",
      body: expect.objectContaining({ action: "confirm", ruleId: preview.ruleId, activation: "skip" }),
    });
  });

  it("Make that change previews the rule with its new bar", async () => {
    await openRecommendations();
    fireEvent.click(await screen.findByRole("button", { name: "Make that change" }));
    await screen.findByRole("dialog", { name: "Save changes to “Busy nights”?" });
    expect(sent.find((s) => s.url === "/api/rules/preview")!.body).toMatchObject({
      intent: "edit",
      ruleId: RULE,
      draft: expect.objectContaining({ condition: expect.objectContaining({ occupancy_threshold: 0.85 }), action: { adjust_rate_percent: 15 } }),
    });
  });
});

describe("rule suggestions in the first review", () => {
  beforeEach(() => {
    mode = undefined;
  });

  it("Add this rule confirms at once, no popup", async () => {
    await openRecommendations();
    fireEvent.click(await screen.findByRole("button", { name: "Add this rule" }));
    await waitFor(() => expect(confirms()).toEqual([{ url: "/api/onboarding/findings/f-add", body: { action: "confirm" } }]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
