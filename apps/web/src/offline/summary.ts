import { app } from "@purss/copy/app";
import { plural, timeAgo } from "../lib/format.ts";

const t = app.offline.summary;

/** One plain line about what this device has saved for offline reading. */
export function savedSummary(count: number, savedAt: string | null, running: boolean, now = Date.now(), locale?: string): string {
  if (count === 0) return running ? t.saving : t.nothing;
  const items = t.saved(plural(count, t.item));
  if (running) return t.updating(items);
  const when = savedAt ? timeAgo(savedAt, now, undefined, locale) : "";
  return when ? t.updated(items, when) : t.done(items);
}
