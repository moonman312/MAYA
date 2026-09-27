// @vitest-environment jsdom
/**
 * The rules animation tells the engine's story. Here: every booking speed
 * level it shows is what classifyBookingSpeed says for the counts it shows,
 * every price is the base with the changes it shows applied (applyAdjustments),
 * a change comes off only where the rule's box is ticked and what it shows
 * is no longer true, the wait after an undo is the rule's wait from the
 * change that came off, and the words are plain. The prices themselves are
 * played through whole engine runs in engine/rule-animation-scenes.test.ts.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyBookingSpeed, bookingSpeedRank, MIN_COMPARABLES_FULL_RANGE } from "@/lib/observations/booking-speed";
import { applyAdjustments } from "@/lib/engine/pricing";
import { UNDO_ON_CANCELLATION_LABEL } from "@/lib/rule-form";
import {
  OCCUPANCY_SCENE,
  RuleBehaviorAnimations,
  SCENES,
  SPEED_SCENE,
  STRONGER_SCENE,
  sceneOccupancy,
  sceneSteps,
  type Scene,
  type SceneStep,
} from "./rule-behavior-animations";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const BOTH = [true, false];

/** "+10%" as the engine's adjustment. */
function adjustment(change: string) {
  const m = /^([+-])(\d+(?:\.\d+)?)%$/.exec(change);
  if (!m) throw new Error(`not a percent change: ${change}`);
  return {
    rule_id: "scene",
    action_kind: "percent" as const,
    action_direction: m[1] === "+" ? ("increase" as const) : ("decrease" as const),
    action_value: Number(m[2]),
  };
}

describe("the scene numbers", () => {
  it.each(SCENES.flatMap((scene) => BOTH.map((undo) => ({ scene, undo, name: `${scene.id}, ${undo ? "ticked" : "unticked"}` }))))(
    "$name: each price is the base with the changes shown applied, and the caption says it",
    ({ scene, undo }) => {
      for (const step of sceneSteps(scene, undo)) {
        expect(applyAdjustments(scene.basePrice, [], step.changes.map(adjustment))).toBe(step.price);
        // A caption that names a price names this one.
        for (const named of step.caption.match(/\$\d+(?:\.\d+)?/g) ?? []) {
          if (named === `$${scene.basePrice}` && step.price !== scene.basePrice) continue;
          expect([`$${step.price}`, `$${scene.basePrice}`]).toContain(named);
        }
      }
    },
  );

  it("shows every booking speed level as classifyBookingSpeed reads the counts shown", () => {
    for (const undo of BOTH) {
      for (const step of sceneSteps(SPEED_SCENE, undo)) {
        const s = step.speed!;
        const reading = classifyBookingSpeed({
          recentBookings: s.booked,
          expectedBookings: s.usual,
          comparableCount: MIN_COMPARABLES_FULL_RANGE,
        });
        expect(reading.speed).toBe(s.level);
      }
    }
  });

  it("raises only on a reading of Faster Than Normal or more, and takes it off only where the box is ticked", () => {
    const ticked = sceneSteps(SPEED_SCENE, true);
    const unticked = sceneSteps(SPEED_SCENE, false);
    // Day 5: 3 of the 9 cancel, and the 6 left no longer read at least Faster.
    expect(bookingSpeedRank(ticked[2].speed!.level)).toBeLessThan(bookingSpeedRank("faster"));
    expect(ticked[2].changes).toEqual([]);
    expect(unticked[2].changes).toEqual(["+10%"]);
    expect(ticked[2].speed!.booked).toBe(ticked[1].speed!.booked - ticked[2].cancelled!);
    // The raise on day 3 is 9 of the counts, the only reading at least Faster before it.
    expect(bookingSpeedRank(ticked[1].speed!.level)).toBeGreaterThanOrEqual(bookingSpeedRank("faster"));
    expect(bookingSpeedRank(ticked[0].speed!.level)).toBeLessThan(bookingSpeedRank("faster"));
  });

  it("raises again only once its week, counted from the raise, is over, ticked or not", () => {
    for (const undo of BOTH) {
      const steps = sceneSteps(SPEED_SCENE, undo);
      const raisedOn = steps[1].day;
      expect(steps[3].day - raisedOn).toBeGreaterThanOrEqual(7);
      // Nothing is raised in between.
      expect(steps[2].changes.length).toBeLessThanOrEqual(steps[1].changes.length);
    }
  });

  it("switches an occupancy rule off and back on with the night, ticked, and keeps its one raise, unticked", () => {
    const threshold = OCCUPANCY_SCENE.occupancyThreshold!;
    for (const step of sceneSteps(OCCUPANCY_SCENE, true)) {
      expect(step.changes.length > 0).toBe(sceneOccupancy(OCCUPANCY_SCENE, step)! > threshold);
    }
    const unticked = sceneSteps(OCCUPANCY_SCENE, false);
    expect(unticked.map((s) => s.changes)).toEqual([[], ["+10%"], ["+10%"], ["+10%"]]);
    expect(sceneOccupancy(OCCUPANCY_SCENE, unticked[2])).toBeLessThan(threshold);
    // Rooms add up.
    for (const undo of BOTH) {
      const steps = sceneSteps(OCCUPANCY_SCENE, undo);
      for (let i = 1; i < steps.length; i++) {
        expect(steps[i].roomsBooked).toBe(steps[i - 1].roomsBooked! + (steps[i].newBookings ?? 0) - (steps[i].cancelled ?? 0));
      }
    }
  });

  it("is the owner's own example for a stronger rule: 10 at once, 3 more, then 2 more", () => {
    // Jake, 2026-09-24: 10 at once give $120, then 3 more stay $120, and 5
    // since the raise give $132.
    const steps = sceneSteps(STRONGER_SCENE, true);
    expect(steps.map((s) => s.price)).toEqual([120, 120, 132]);
    expect(steps.map((s) => s.newBookings)).toEqual([10, 3, 2]);
    // The weaker rule counts from the stronger raise; the stronger one never
    // from the weaker one's.
    expect(steps.map((s) => s.weaker!.counting)).toEqual([0, 3, 0]);
    expect(steps.map((s) => s.stronger!.counting)).toEqual([0, 3, 5]);
    // Nothing cancels, so the box changes nothing.
    expect(sceneSteps(STRONGER_SCENE, false)).toEqual(steps);
  });

  it("says it in plain words: no dashes, no math symbols, never that MAYA learns, knows or thinks", () => {
    const words = (scene: Scene) => [
      scene.title,
      ...scene.rules,
      ...[...scene.ticked, ...scene.unticked].flatMap((s: SceneStep) => [s.label, s.caption, s.speed?.over ?? ""]),
    ];
    for (const line of SCENES.flatMap(words)) {
      expect(line).not.toMatch(/—|–/);
      expect(line).not.toMatch(/[<>≥≤=]/);
      expect(line).not.toMatch(/\b(learns|knows|thinks|smart|AI)\b/i);
    }
  });
});

describe("RuleBehaviorAnimations", () => {
  function reducedMotion(reduce: boolean) {
    vi.stubGlobal(
      "matchMedia",
      (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
    );
  }

  it("starts closed, opens on a click, and starts every scene with the box ticked", () => {
    reducedMotion(true);
    render(<RuleBehaviorAnimations />);
    expect(screen.queryByText(SPEED_SCENE.title)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /How rules behave/ }));
    for (const scene of SCENES) expect(screen.getByText(scene.title)).toBeTruthy();
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.closest("label")?.textContent).toContain(UNDO_ON_CANCELLATION_LABEL);
  });

  it("with reduced motion, starts paused, and the step dots walk through the story, ticked and unticked", () => {
    reducedMotion(true);
    vi.useFakeTimers();
    render(<RuleBehaviorAnimations />);
    fireEvent.click(screen.getByRole("button", { name: /How rules behave/ }));
    const first = sceneSteps(SPEED_SCENE, true)[0];
    expect(screen.getByText(first.caption)).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByText(first.caption)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Play animation" })).toHaveLength(SCENES.length);

    const third = sceneSteps(SPEED_SCENE, true)[2];
    fireEvent.click(screen.getByRole("button", { name: `Step 3 of 4: ${third.label}` }));
    expect(screen.getByText(third.caption)).toBeTruthy();
    // Unticking the box tells the same step the other way.
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByText(sceneSteps(SPEED_SCENE, false)[2].caption)).toBeTruthy();
    expect(screen.queryByText(third.caption)).toBeNull();
  });

  it("plays on its own when motion is fine, and pauses on request", () => {
    reducedMotion(false);
    vi.useFakeTimers();
    render(<RuleBehaviorAnimations />);
    fireEvent.click(screen.getByRole("button", { name: /How rules behave/ }));
    const steps = sceneSteps(OCCUPANCY_SCENE, true);
    expect(screen.getByText(steps[0].caption)).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(3600);
    });
    expect(screen.getByText(steps[1].caption)).toBeTruthy();
    const pause = screen.getAllByRole("button", { name: "Pause animation" })[1];
    fireEvent.click(pause);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByText(steps[1].caption)).toBeTruthy();
  });
});
