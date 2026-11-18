/** Policy for restarting a run that came up and then died on its own. */

export const REASON_PORT_IN_USE = "port-in-use";
export const REASON_SANDBOX_DENIED = "sandbox-denied";
export const REASON_COMMAND_NOT_FOUND = "command-not-found";

/** Failures that will not recover if we just start the same command again. */
export const UNRECOVERABLE = new Set([
  REASON_COMMAND_NOT_FOUND,
  REASON_SANDBOX_DENIED,
  REASON_PORT_IN_USE
]);

/**
 * Backoff, retry budget, and the stretch of healthy running that clears the
 * budget so a later crash can be retried again.
 *
 * Delays are 1s, 2s, then 5s and stay at 5s. Eight retries is inside the
 * 5–10 window: enough for a flaky boot, short enough that a tight crash loop
 * does not run forever.
 */
export const DEFAULT_RESTART = {
  delaysMs: [1000, 2000, 5000],
  limit: 8,
  healthyMs: 5000
};

/** The wait before auto-restart attempt `attempt` (1-based). */
export function delayOf(policy, attempt) {
  const delays = policy.delaysMs;
  if (!Array.isArray(delays) || delays.length === 0) return 1000;
  const index = Math.max(0, Math.min(attempt - 1, delays.length - 1));
  return delays[index];
}

/**
 * Whether the Host should schedule another start for this settled run.
 *
 * A user stop never restarts. Classified spawn or bind failures that will not
 * recover are not retried. An unclassified `failed` spawn gets one cautious
 * retry, then stops, so a missing binary is not hammered if classification
 * missed it. `attempt` is how many auto-starts have already been scheduled
 * in this crash streak; it is compared against the policy limit.
 */
export function shouldScheduleRestart(input) {
  if (input === undefined || input === null || input.autoRestart !== true) return false;
  const state = input.state;
  if (state !== "exited" && state !== "failed") return false;
  if (UNRECOVERABLE.has(input.reason)) return false;
  const attempt = Number.isInteger(input.attempt) ? input.attempt : 0;
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : DEFAULT_RESTART.limit;
  if (attempt >= limit) return false;
  if (state === "failed") {
    const failedRetries = Number.isInteger(input.failedRetries) ? input.failedRetries : 0;
    if (failedRetries >= 1) return false;
  }
  return true;
}
