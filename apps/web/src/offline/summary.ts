import { plural, timeAgo } from "../lib/format.ts";

/** One plain line about what this device has saved for offline reading. */
export function savedSummary(count: number, savedAt: string | null, running: boolean, now = Date.now(), locale?: string): string {
  if (count === 0) return running ? "Saving your reading list…" : "Nothing is saved on this device yet. Items you mark To read, or keep with their text, are saved here.";
  const items = `${plural(count, "item")} saved`;
  if (running) return `${items}, updating…`;
  const when = savedAt ? timeAgo(savedAt, now, undefined, locale) : "";
  return when ? `${items}, last updated ${when}.` : `${items}.`;
}
