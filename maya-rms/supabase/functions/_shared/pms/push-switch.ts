/**
 * MAYA_PUSH_RATES: whether the scheduled syncs send prices at all.
 *
 * The switch is read by the Cloudbeds and the Think sync, once per
 * invocation. On, a hotel in Live mode is sent its prices; off, no hotel is,
 * whatever its mode, and nothing about that shows on the hotel itself: every
 * run skips the send, records nothing and raises nothing.
 *
 * So a value that is not plainly one or the other is said out loud. The
 * comparison used to be exact after lower-casing, and "true " with a space
 * after it, "yes", "1" or a switch nobody set all read as off in silence. The
 * value is trimmed and lower-cased now, so a stray space or "True" works, and
 * anything other than true or false (unset included) is off, as before, with
 * one line in the function's log each invocation to say so.
 *
 * Off is the safe reading of a value nobody can vouch for: the hotel keeps
 * its own rates.
 */

export type PushSwitch = {
  enabled: boolean;
  /** "unset" when there is no value; "unrecognised" when it is neither true nor false. */
  problem: "unset" | "unrecognised" | null;
};

export function readPushSwitch(raw: string | null | undefined): PushSwitch {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "true") return { enabled: true, problem: null };
  if (value === "false") return { enabled: false, problem: null };
  return { enabled: false, problem: value === "" ? "unset" : "unrecognised" };
}

/**
 * The switch for one invocation of `fn`, saying so when it is off for want of
 * a value anyone meant. The value itself is logged, cut short: it is a
 * setting, not a secret.
 */
export function pushRatesEnabled(
  raw: string | null | undefined,
  fn: string,
  log: (line: string) => void = console.error,
): boolean {
  const read = readPushSwitch(raw);
  if (read.problem) {
    log(
      JSON.stringify({
        fn,
        setting: "MAYA_PUSH_RATES",
        event: read.problem === "unset" ? "push_switch_unset" : "push_switch_unrecognised",
        ...(read.problem === "unrecognised" ? { value: String(raw).slice(0, 40) } : {}),
        sending: false,
        note: "No price is sent to any property system, Live hotels included. Set MAYA_PUSH_RATES to true to send, or to false to say this is meant.",
      }),
    );
  }
  return read.enabled;
}
