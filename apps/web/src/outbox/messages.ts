import { app } from "@purss/copy/app";
import { plural } from "../lib/format.ts";

const t = app.outbox.messages;

/** One line for changes that were found, after the fact, to have been sent: "Sent 3 changes made while you were offline." */
export function sentLine(count: number): string {
  return count === 1 ? t.sentOne : t.sentMany(plural(count, app.words.change));
}

/** One line for changes PURSS did not apply. Conflicts are grouped; other reasons keep PURSS's own words. */
export function droppedLine(drops: readonly { reason: "conflict" | "rejected"; message: string }[]): string {
  if (drops.length === 1) return drops[0]!.message;
  if (drops.every((d) => d.reason === "conflict")) return t.conflicts(drops.length);
  return t.notApplied(plural(drops.length, app.words.change));
}
