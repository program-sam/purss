import type { SourceHealth } from "@purss/domain";

/**
 * A source PURSS could not collect from can be tried again. Whether it is waiting for its next automatic try
 * or has given up is in the text PURSS gives for it; the offer is the same, and the text is shown as given.
 */
export function canRetrySource(s: { health: SourceHealth }): boolean {
  return s.health === "error";
}
