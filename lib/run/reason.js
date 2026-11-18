/** Stable reason codes for a run that failed to stay up. */
export const REASON_PORT_IN_USE = "port-in-use";
export const REASON_SANDBOX_DENIED = "sandbox-denied";
export const REASON_COMMAND_NOT_FOUND = "command-not-found";

/**
 * Classify why a run never came up, or came up and then died.
 *
 * Looks at the spawn error, the process exit code, and the retained output.
 * Common cases get a stable code; anything else is left unclassified so the
 * caller can still surface the raw error and exit code.
 *
 * @param {{ error?: string, exitCode?: number | null, output?: string }} input
 * @returns {"port-in-use" | "sandbox-denied" | "command-not-found" | undefined}
 */
export function classifyFailure(input) {
  const error = input && input.error != null ? String(input.error) : "";
  const output = input && input.output != null ? String(input.output) : "";
  const text = error + "\n" + output;
  const exitCode = input && typeof input.exitCode === "number" ? input.exitCode : undefined;

  if (
    /\bEADDRINUSE\b/i.test(text)
    || /address already in use/i.test(text)
    || /port already in use/i.test(text)
    || /port \d+ (?:is |was )?already/i.test(text)
    || /failed to bind/i.test(text)
    || /BindException/i.test(text)
    || /only one usage of each socket address/i.test(text)
  ) return REASON_PORT_IN_USE;

  if (
    exitCode === 127
    || /\bENOENT\b/i.test(text)
    || /command not found/i.test(text)
    || /is not recognized as (?:an internal or external command|a command)/i.test(text)
    || /(?:^|[\s:'"\`/\\])(?:mvn|mvnw|gradle|gradlew|npm|pnpm|yarn|node|python3?|pip|go|cargo|docker|java)(?:\.exe)?: (?:command )?not found/i.test(text)
  ) return REASON_COMMAND_NOT_FOUND;

  if (
    /\bEACCES\b/i.test(text)
    || /\bEPERM\b/i.test(text)
    || /permission denied/i.test(text)
    || /operation not permitted/i.test(text)
    || /sandbox.*(?:denied|refus|block)/i.test(text)
    || /(?:denied|refus|block).*sandbox/i.test(text)
  ) return REASON_SANDBOX_DENIED;

  return undefined;
}
