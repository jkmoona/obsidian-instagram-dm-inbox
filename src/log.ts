/**
 * Console logging that a five-second poll loop can safely use.
 *
 * Anything on the tick path has to assume its failure is persistent, not
 * momentary. A plain `console.warn` there is one line every poll interval for
 * as long as the condition lasts, which on a vault with forty contacts reached
 * hundreds of lines a minute and buried anything worth reading.
 *
 * `warnOnce` keys on the specific condition, so the first occurrence is
 * reported and repeats are dropped until the caller clears the key on
 * recovery. Everything genuinely one-shot keeps using `logError` / `logWarn`.
 */

const PREFIX = "[igcrm]";

let debugEnabled = false;
const warned = new Set<string>();

export function setDebugLogging(on: boolean): void {
  debugEnabled = on;
  // Clearing on toggle means switching debug on gives a fresh picture rather
  // than silence for whatever already fired.
  if (!on) warned.clear();
}

/** Detail only useful when diagnosing. Off unless the user turns it on. */
export function debugLog(...args: unknown[]): void {
  if (debugEnabled) console.debug(PREFIX, ...args);
}

/**
 * Warn the first time `key` is seen, then stay quiet about it.
 *
 * Pair every call with a `clearWarn(key)` where the condition resolves, or the
 * user never hears about a second occurrence after a recovery.
 */
export function warnOnce(key: string, ...args: unknown[]): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(PREFIX, ...args);
}

/** Let `key` warn again. Call on the success path of whatever failed. */
export function clearWarn(key: string): void {
  warned.delete(key);
}

/** Unconditional warning, for one-shot paths not on the poll loop. */
export function logWarn(...args: unknown[]): void {
  console.warn(PREFIX, ...args);
}

export function logError(...args: unknown[]): void {
  console.error(PREFIX, ...args);
}

/** Test seam: forget every suppressed key. */
export function __resetWarnings(): void {
  warned.clear();
}
