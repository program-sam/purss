import { app } from "@purss/translations/app";
import type { ActivityDTO, HomeOverview, ItemDTO, Preferences } from "@purss/domain";
import { dateFormat, formatCount, interfaceLocale, plural, timeAgo } from "./format.ts";

/*
 * Words and small rules for coming back: what Home says about the last visit, how the background activity reads,
 * and the labels of the notification choices. Pure, so they are tested without a screen.
 */

export const WEEKDAYS = app.lib.returning.weekdays;

export const FREQUENCY_LABELS: Record<Preferences["notifications"]["frequency"], { label: string; blurb: string }> = app.lib.returning.frequency;

export const FRESH_DAYS_CHOICES: { value: number; label: string }[] = [
  { value: 7, label: app.lib.returning.newDays.week }, { value: 14, label: app.lib.returning.newDays.fortnight }, { value: 30, label: app.words.n30Days }, { value: 90, label: app.words.n90Days }, { value: 0, label: app.lib.returning.newDays.never },
];

/** The choices for how long items stay New, plus the saved value when it isn't one of them (set elsewhere). */
export function newDaysChoices(current: number): { value: number; label: string }[] {
  return FRESH_DAYS_CHOICES.some((c) => c.value === current) ? FRESH_DAYS_CHOICES : [...FRESH_DAYS_CHOICES, { value: current, label: app.lib.returning.newDays.other(current) }].sort((a, b) => (a.value || Infinity) - (b.value || Infinity));
}

/** The queue: what the person put aside (To read) and what they started (In progress). */
export const inQueue = (i: Pick<ItemDTO, "workflow">) => i.workflow === "toread" || i.workflow === "inprogress";

/** The queue is split into three rows by kind, as the state's own name is: articles are To read, videos To watch, podcasts To listen. */
type Aside = Pick<ItemDTO, "workflow" | "kind">;
export const isToRead = (i: Aside) => inQueue(i) && i.kind !== "video" && i.kind !== "podcast";
export const isToWatch = (i: Aside) => inQueue(i) && i.kind === "video";
export const isToListen = (i: Aside) => inQueue(i) && i.kind === "podcast";

/**
 * What Home says when nothing is marked New. It follows the facts: while older items nobody has looked at are still on Home it
 * says nothing is new, not that everything is done; "up to date" is only for a Home with nothing waiting.
 */
export function calmLine(o: Pick<HomeOverview, "unread">, f: { visited: boolean; items: number; showCounts: boolean }): string {
  if (o.unread > 0) {
    const older = f.showCounts ? app.lib.returning.olderNotLookedAt(plural(o.unread, app.lib.nouns.olderItem)) : "";
    return `${f.visited ? app.lib.returning.nothingNewSince : app.lib.returning.nothingMarkedNew}${older}`;
  }
  return f.items ? app.lib.returning.upToDate : app.lib.returning.nothingArrived;
}

/** The first line of Home's summary band for someone who has been here before. */
export function sinceLine(since: NonNullable<HomeOverview["since"]>, lastVisitAt: string, o: { now: number; timeZone: string; showCounts: boolean; locale?: string }): string {
  const when = timeAgo(lastVisitAt, o.now, o.timeZone, o.locale);
  const where = app.lib.returning.inPlace(since.boxes.length === 1 ? since.boxes[0]!.name : plural(since.boxes.length, app.words.collectionLower, undefined, o.locale));
  return o.showCounts
    ? app.lib.returning.sinceWithCount(when, formatCount(since.total, o.locale), where)
    : app.lib.returning.sinceWithoutCount(when, where);
}

/** The sidebar's one line about what the engine is doing. */
export function activityLine(a: ActivityDTO, o: { now: number; timeZone: string; locale?: string }): { text: string; busy: boolean; problem: boolean } {
  const t = app.lib.returning;
  if (a.subscribing) return { text: t.settingUp(plural(a.subscribing, app.words.sourceLower)), busy: true, problem: false };
  if (a.checking) return { text: t.checking(plural(Math.max(1, a.sourceCount), app.words.sourceLower)), busy: true, problem: false };
  if (a.savingText) return { text: t.savingText(plural(a.savingText, app.words.item)), busy: true, problem: false };
  if (a.problem) return { text: t.cantCheck, busy: false, problem: true };
  if (a.lastCheckedAt) return { text: t.upToDateChecked(timeAgo(a.lastCheckedAt, o.now, o.timeZone, o.locale)), busy: false, problem: false };
  return { text: t.waitingFirstCheck, busy: false, problem: false };
}

/** "Next check about 14:20" or nothing when unknown. */
export function nextCheckLine(a: ActivityDTO, now: number, timeZone: string, locale?: string): string | null {
  if (!a.nextCheckAt) return null;
  const at = Date.parse(a.nextCheckAt);
  if (Number.isNaN(at)) return null;
  if (at <= now) return app.lib.returning.nextCheckSoon;
  return app.lib.returning.nextCheckAbout(dateFormat(locale ?? interfaceLocale(), { hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(at)));
}

/** When a pause for a while ends, for the source menu and its notes. */
export function pausedUntilLine(iso: string, timeZone: string, locale?: string): string {
  return app.lib.returning.resumes(dateFormat(locale ?? interfaceLocale(), { weekday: "short", day: "numeric", month: "short", timeZone }).format(new Date(iso)));
}

/** Touch screens have no keyboard shortcut to hint at. */
export function hasKeyboard(matches: (query: string) => boolean): boolean {
  return !matches("(pointer: coarse)") || matches("(any-pointer: fine)");
}
