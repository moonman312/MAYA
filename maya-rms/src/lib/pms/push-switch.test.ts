/**
 * MAYA_PUSH_RATES, the one switch between a Live hotel and its property
 * system. A value nobody meant must never read as "on", and must never read
 * as "off" without a word.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pushRatesEnabled, readPushSwitch } from "../../../supabase/functions/_shared/pms/push-switch";

describe("reading the switch", () => {
  it.each(["true", "TRUE", "True", " true", "true ", "\ttrue\n"])("sends on %j", (raw) => {
    expect(readPushSwitch(raw)).toEqual({ enabled: true, problem: null });
  });

  it.each(["false", "FALSE", " false "])("does not send on %j, and has nothing to say about it", (raw) => {
    expect(readPushSwitch(raw)).toEqual({ enabled: false, problem: null });
  });

  it.each([undefined, null, "", "   "])("does not send when nobody set it (%j)", (raw) => {
    expect(readPushSwitch(raw)).toEqual({ enabled: false, problem: "unset" });
  });

  it.each(["yes", "1", "on", "enabled", "tru", "true;", '"true"', "truee", "y"])(
    "does not send on %j: only true sends",
    (raw) => {
      expect(readPushSwitch(raw)).toEqual({ enabled: false, problem: "unrecognised" });
    },
  );
});

describe("what the function's log says", () => {
  it("says nothing when the switch is plainly on or off", () => {
    const log = vi.fn();
    expect(pushRatesEnabled("true", "cloudbeds-scheduled-sync", log)).toBe(true);
    expect(pushRatesEnabled(" True ", "cloudbeds-scheduled-sync", log)).toBe(true);
    expect(pushRatesEnabled("false", "cloudbeds-scheduled-sync", log)).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it("says in one line that nothing is sent when the value is not true or false", () => {
    const log = vi.fn();

    expect(pushRatesEnabled("yes", "cloudbeds-scheduled-sync", log)).toBe(false);

    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      fn: "cloudbeds-scheduled-sync",
      setting: "MAYA_PUSH_RATES",
      event: "push_switch_unrecognised",
      value: "yes",
      sending: false,
    });
  });

  it("says so when the switch was never set", () => {
    const log = vi.fn();

    expect(pushRatesEnabled(undefined, "think-scheduled-sync", log)).toBe(false);

    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(log.mock.calls[0][0]);
    expect(line).toMatchObject({ fn: "think-scheduled-sync", event: "push_switch_unset", sending: false });
    expect(line).not.toHaveProperty("value");
  });

  it("cuts a long value short", () => {
    const log = vi.fn();
    pushRatesEnabled("x".repeat(500), "cloudbeds-scheduled-sync", log);
    expect(JSON.parse(log.mock.calls[0][0]).value).toHaveLength(40);
  });
});

describe("the scheduled syncs", () => {
  it.each(["cloudbeds-scheduled-sync", "think-scheduled-sync"])("%s reads the switch through it, raw", (fn) => {
    const source = readFileSync(resolve(__dirname, `../../../supabase/functions/${fn}/index.ts`), "utf8");
    expect(source).toContain(`readPushSwitchOnce(Deno.env.get("MAYA_PUSH_RATES"), "${fn}")`);
    // The old reading, exact after lower-casing, is gone.
    expect(source).not.toMatch(/MAYA_PUSH_RATES"\)\s*\?\?\s*"false"\)\.toLowerCase\(\)\s*===\s*"true"/);
  });
});
