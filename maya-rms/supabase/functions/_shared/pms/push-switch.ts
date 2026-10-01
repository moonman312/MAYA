/**
 * Whether a scheduled sync sends prices at all: one switch per property
 * system, read by that system's sync once per invocation (audit A25, Jake's
 * call (a)).
 *
 *   MAYA_PUSH_RATES_CLOUDBEDS  read by cloudbeds-scheduled-sync. While it is
 *                              not set, the shared MAYA_PUSH_RATES that both
 *                              syncs used to read decides instead, so a
 *                              project that sends to Cloudbeds today keeps
 *                              sending with nothing changed.
 *   MAYA_PUSH_RATES_THINK      read by think-scheduled-sync, and nothing
 *                              else is: MAYA_PUSH_RATES no longer turns
 *                              sending on for ThinkReservations. Off until set,
 *                              because ThinkReservations has not confirmed how
 *                              its rates should be written.
 *   Mews                       has no sending at all.
 *
 * On, a hotel in Live mode is sent its prices; off, no hotel on that system
 * is, whatever its mode, and nothing about that shows on the hotel itself:
 * every run skips the send, records nothing and raises nothing.
 *
 * So a value that is not plainly one or the other is said out loud. The
 * value is trimmed and lower-cased, so a stray space or "True" works, and
 * anything other than true or false (unset included) is off, with one line
 * in the function's log each invocation to say so, naming the setting read.
 *
 * Off is the safe reading of a value nobody can vouch for: the hotel keeps
 * its own rates.
 */

export type PushSwitch = {
  enabled: boolean;
  /** "unset" when there is no value; "unrecognised" when it is neither true nor false. */
  problem: "unset" | "unrecognised" | null;
};

/** The systems MAYA sends prices to, each with its own switch. */
export type PushSystem = "cloudbeds" | "think";

/** Each system's own switch. */
export const PUSH_SWITCH: Record<PushSystem, string> = {
  cloudbeds: "MAYA_PUSH_RATES_CLOUDBEDS",
  think: "MAYA_PUSH_RATES_THINK",
};

/** The shared switch both syncs once read. Cloudbeds falls back to it; Think never reads it. */
export const LEGACY_PUSH_SWITCH = "MAYA_PUSH_RATES";

const SYSTEM_NAME: Record<PushSystem, string> = { cloudbeds: "Cloudbeds", think: "ThinkReservations" };

export function readPushSwitch(raw: string | null | undefined): PushSwitch {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "true") return { enabled: true, problem: null };
  if (value === "false") return { enabled: false, problem: null };
  return { enabled: false, problem: value === "" ? "unset" : "unrecognised" };
}

const isUnset = (raw: string | null | undefined) => (raw ?? "").trim() === "";

/**
 * Which setting decides for `system`, and its value: the system's own, or,
 * for Cloudbeds only, the shared one while its own is not set.
 */
export function pushSwitchSource(
  system: PushSystem,
  env: (name: string) => string | null | undefined,
): { setting: string; raw: string | null | undefined } {
  const own = env(PUSH_SWITCH[system]);
  if (system === "cloudbeds" && isUnset(own)) {
    const shared = env(LEGACY_PUSH_SWITCH);
    if (!isUnset(shared)) return { setting: LEGACY_PUSH_SWITCH, raw: shared };
  }
  return { setting: PUSH_SWITCH[system], raw: own };
}

/**
 * The switch for one invocation of `fn`, sending to `system`, saying so when
 * it is off for want of a value anyone meant. The value itself is logged,
 * cut short: it is a setting, not a secret.
 */
export function pushRatesEnabled(
  system: PushSystem,
  env: (name: string) => string | null | undefined,
  fn: string,
  log: (line: string) => void = console.error,
): boolean {
  const { setting, raw } = pushSwitchSource(system, env);
  const read = readPushSwitch(raw);
  if (read.problem) {
    const legacyOn = system === "think" && readPushSwitch(env(LEGACY_PUSH_SWITCH)).enabled;
    log(
      JSON.stringify({
        fn,
        setting,
        event: read.problem === "unset" ? "push_switch_unset" : "push_switch_unrecognised",
        ...(read.problem === "unrecognised" ? { value: String(raw).slice(0, 40) } : {}),
        sending: false,
        note:
          `No price is sent to ${SYSTEM_NAME[system]}, Live hotels included. Set ${PUSH_SWITCH[system]} to true ` +
          `to send, or to false to say this is meant.` +
          (legacyOn ? ` ${LEGACY_PUSH_SWITCH} is true, but it no longer turns sending on for ${SYSTEM_NAME[system]}.` : ""),
      }),
    );
  }
  return read.enabled;
}
