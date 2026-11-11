import type { ActivityDTO, HomeOverview, Preferences } from "@purss/domain";
import { dateFormat, formatCount, interfaceLocale, plural, timeAgo } from "./format.ts";

/*
 * Words and small rules for coming back: what Home says about the last visit, how the background activity reads,
 * and the labels of the notification choices. Pure, so they are tested without a screen.
 */

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const FREQUENCY_LABELS: Record<Preferences["notifications"]["frequency"], { label: string; blurb: string }> = {
  off: { label: "Don't tell me", blurb: "Nothing about new items. Sources you set to “Notify me” still do." },
  daily: { label: "A daily digest", blurb: "One notification a day, counting what is still New." },
  weekly: { label: "A weekly digest", blurb: "One notification a week, counting what is still New." },
};

export const FRESH_DAYS_CHOICES: { value: number; label: string }[] = [
  { value: 7, label: "7 days" }, { value: 14, label: "14 days" }, { value: 30, label: "30 days" }, { value: 90, label: "90 days" }, { value: 0, label: "Until I clear them" },
];

/** The choices for how long items stay New, plus the saved value when it isn't one of them (set elsewhere). */
export function freshDaysChoices(current: number): { value: number; label: string }[] {
  return FRESH_DAYS_CHOICES.some((c) => c.value === current) ? FRESH_DAYS_CHOICES : [...FRESH_DAYS_CHOICES, { value: current, label: `${current} days` }].sort((a, b) => (a.value || Infinity) - (b.value || Infinity));
}

/**
 * What Home says when nothing is marked New. It follows the facts: while older items nobody has looked at are still on Home it
 * says nothing is new, not that everything is done; "up to date" is only for a Home with nothing waiting.
 */
export function calmLine(o: Pick<HomeOverview, "unread">, f: { visited: boolean; items: number; showCounts: boolean }): string {
  if (o.unread > 0) {
    const older = f.showCounts ? ` · ${plural(o.unread, "older item")} not looked at` : "";
    return `${f.visited ? "Nothing new since your last visit" : "Nothing is marked New"}${older}`;
  }
  return f.items ? "You're up to date" : "Nothing has arrived yet";
}

/** The first line of Home's summary band for someone who has been here before. */
export function sinceLine(since: NonNullable<HomeOverview["since"]>, lastVisitAt: string, o: { now: number; timeZone: string; showCounts: boolean; locale?: string }): string {
  const when = timeAgo(lastVisitAt, o.now, o.timeZone, o.locale);
  const where = since.boxes.length === 1 ? `in ${since.boxes[0]!.name}` : `in ${plural(since.boxes.length, "collection", undefined, o.locale)}`;
  return o.showCounts
    ? `Since your last visit (${when}): ${formatCount(since.total, o.locale)} new ${where}`
    : `New items since your last visit (${when}) ${where}`;
}

/** The sidebar's one line about what the engine is doing. */
export function activityLine(a: ActivityDTO, o: { now: number; timeZone: string; locale?: string }): { text: string; busy: boolean; problem: boolean } {
  if (a.subscribing) return { text: `Setting up ${plural(a.subscribing, "source")}…`, busy: true, problem: false };
  if (a.checking) return { text: `Checking ${plural(Math.max(1, a.sourceCount), "source")}…`, busy: true, problem: false };
  if (a.savingText) return { text: `Saving text for ${plural(a.savingText, "item")}…`, busy: true, problem: false };
  if (a.problem) return { text: "Couldn't check your sources", busy: false, problem: true };
  if (a.lastCheckedAt) return { text: `Up to date · checked ${timeAgo(a.lastCheckedAt, o.now, o.timeZone, o.locale)}`, busy: false, problem: false };
  return { text: "Waiting for the first check", busy: false, problem: false };
}

/** "Next check about 14:20" or nothing when unknown. */
export function nextCheckLine(a: ActivityDTO, now: number, timeZone: string, locale?: string): string | null {
  if (!a.nextCheckAt) return null;
  const at = Date.parse(a.nextCheckAt);
  if (Number.isNaN(at)) return null;
  if (at <= now) return "Next check: any moment";
  return `Next check about ${dateFormat(locale ?? interfaceLocale(), { hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(at))}`;
}

/** When a pause for a while ends, for the source menu and its notes. */
export function pausedUntilLine(iso: string, timeZone: string, locale?: string): string {
  return `Resumes ${dateFormat(locale ?? interfaceLocale(), { weekday: "short", day: "numeric", month: "short", timeZone }).format(new Date(iso))}`;
}

/** Touch screens have no keyboard shortcut to hint at. */
export function hasKeyboard(matches: (query: string) => boolean): boolean {
  return !matches("(pointer: coarse)") || matches("(any-pointer: fine)");
}
