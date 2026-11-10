import { plural } from "../lib/format.ts";

/** One line for changes that were found, after the fact, to have been sent: "Sent 3 changes made while you were offline." */
export function sentLine(count: number): string {
  return count === 1 ? "Sent a change that was waiting." : `Sent ${plural(count, "change")} that were waiting.`;
}

/** One line for changes PURSS did not apply. Conflicts are grouped; other reasons keep PURSS's own words. */
export function droppedLine(drops: readonly { reason: "conflict" | "rejected"; message: string }[]): string {
  if (drops.length === 1) return drops[0]!.message;
  if (drops.every((d) => d.reason === "conflict")) return `Not changed: ${drops.length} items were changed on another device.`;
  return `Not changed: ${plural(drops.length, "change")} couldn't be applied.`;
}
