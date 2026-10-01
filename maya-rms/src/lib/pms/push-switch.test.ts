/**
 * The sending switches, one per property system, between a Live hotel and
 * its property system (audit A25). A value nobody meant must never read as
 * "on", and must never read as "off" without a word. Turning Cloudbeds on
 * must never turn ThinkReservations on.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LEGACY_PUSH_SWITCH,
  PUSH_SWITCH,
  pushRatesEnabled,
  pushSwitchSource,
  readPushSwitch,
} from "../../../supabase/functions/_shared/pms/push-switch";

const env = (values: Record<string, string | undefined>) => (name: string) => values[name];

describe("reading a switch", () => {
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

describe("which setting decides", () => {
  it("names one switch per system", () => {
    expect(PUSH_SWITCH).toEqual({ cloudbeds: "MAYA_PUSH_RATES_CLOUDBEDS", think: "MAYA_PUSH_RATES_THINK" });
    expect(LEGACY_PUSH_SWITCH).toBe("MAYA_PUSH_RATES");
  });

  it("keeps Cloudbeds sending on the shared switch while its own is not set, so production changes nothing", () => {
    const log = vi.fn();
    expect(pushSwitchSource("cloudbeds", env({ MAYA_PUSH_RATES: "true" }))).toEqual({ setting: "MAYA_PUSH_RATES", raw: "true" });
    expect(pushRatesEnabled("cloudbeds", env({ MAYA_PUSH_RATES: "true" }), "cloudbeds-scheduled-sync", log)).toBe(true);
    expect(pushRatesEnabled("cloudbeds", env({ MAYA_PUSH_RATES: "true", MAYA_PUSH_RATES_CLOUDBEDS: "  " }), "cloudbeds-scheduled-sync", log)).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it("lets Cloudbeds' own switch win over the shared one either way", () => {
    const log = vi.fn();
    expect(pushRatesEnabled("cloudbeds", env({ MAYA_PUSH_RATES: "true", MAYA_PUSH_RATES_CLOUDBEDS: "false" }), "f", log)).toBe(false);
    expect(pushRatesEnabled("cloudbeds", env({ MAYA_PUSH_RATES: "false", MAYA_PUSH_RATES_CLOUDBEDS: "true" }), "f", log)).toBe(true);
    expect(pushSwitchSource("cloudbeds", env({ MAYA_PUSH_RATES: "true", MAYA_PUSH_RATES_CLOUDBEDS: "false" })).setting).toBe(
      "MAYA_PUSH_RATES_CLOUDBEDS",
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("never sends to ThinkReservations on the shared switch: only its own turns it on", () => {
    expect(pushRatesEnabled("think", env({ MAYA_PUSH_RATES: "true" }), "think-scheduled-sync", vi.fn())).toBe(false);
    expect(pushSwitchSource("think", env({ MAYA_PUSH_RATES: "true" }))).toEqual({ setting: "MAYA_PUSH_RATES_THINK", raw: undefined });
    expect(pushRatesEnabled("think", env({ MAYA_PUSH_RATES_THINK: "true" }), "think-scheduled-sync", vi.fn())).toBe(true);
    expect(pushRatesEnabled("think", env({}), "think-scheduled-sync", vi.fn())).toBe(false);
  });
});

describe("what the function's log says", () => {
  it("says nothing when the switch is plainly on or off", () => {
    const log = vi.fn();
    expect(pushRatesEnabled("cloudbeds", env({ MAYA_PUSH_RATES_CLOUDBEDS: "true" }), "cloudbeds-scheduled-sync", log)).toBe(true);
    expect(pushRatesEnabled("cloudbeds", env({ MAYA_PUSH_RATES_CLOUDBEDS: " True " }), "cloudbeds-scheduled-sync", log)).toBe(true);
    expect(pushRatesEnabled("think", env({ MAYA_PUSH_RATES_THINK: "false" }), "think-scheduled-sync", log)).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it("says in one line that nothing is sent when the value is not true or false, naming the setting it read", () => {
    const log = vi.fn();

    expect(pushRatesEnabled("cloudbeds", env({ MAYA_PUSH_RATES: "yes" }), "cloudbeds-scheduled-sync", log)).toBe(false);

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

    expect(pushRatesEnabled("cloudbeds", env({}), "cloudbeds-scheduled-sync", log)).toBe(false);

    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(log.mock.calls[0][0]);
    expect(line).toMatchObject({ fn: "cloudbeds-scheduled-sync", setting: "MAYA_PUSH_RATES_CLOUDBEDS", event: "push_switch_unset", sending: false });
    expect(line).not.toHaveProperty("value");
  });

  it("tells whoever set the shared switch for ThinkReservations that it no longer turns it on", () => {
    const log = vi.fn();
    pushRatesEnabled("think", env({ MAYA_PUSH_RATES: "true" }), "think-scheduled-sync", log);
    const line = JSON.parse(log.mock.calls[0][0]);
    expect(line).toMatchObject({ fn: "think-scheduled-sync", setting: "MAYA_PUSH_RATES_THINK", event: "push_switch_unset", sending: false });
    expect(line.note).toContain("MAYA_PUSH_RATES is true, but it no longer turns sending on for ThinkReservations.");
  });

  it("cuts a long value short", () => {
    const log = vi.fn();
    pushRatesEnabled("cloudbeds", env({ MAYA_PUSH_RATES_CLOUDBEDS: "x".repeat(500) }), "cloudbeds-scheduled-sync", log);
    expect(JSON.parse(log.mock.calls[0][0]).value).toHaveLength(40);
  });
});

describe("the scheduled syncs", () => {
  it.each([
    ["cloudbeds-scheduled-sync", "cloudbeds"],
    ["think-scheduled-sync", "think"],
  ])("%s reads its own system's switch through it, raw, and reports it with the alert channel", (fn, system) => {
    const source = readFileSync(resolve(__dirname, `../../../supabase/functions/${fn}/index.ts`), "utf8");
    expect(source).toContain(`readPushSwitchOnce("${system}", (name) => Deno.env.get(name), "${fn}")`);
    expect(source).toContain(`pushSwitchSource("${system}", (name) => Deno.env.get(name)).setting`);
    // Nothing reads the shared switch directly any more.
    expect(source).not.toContain(`Deno.env.get("MAYA_PUSH_RATES")`);
  });

  it("never sends from the Mews sync", () => {
    const source = readFileSync(resolve(__dirname, "../../../supabase/functions/mews-scheduled-sync/index.ts"), "utf8");
    expect(source).toContain("pushEnabled: false");
    expect(source).not.toContain("readPushSwitchOnce");
  });
});
