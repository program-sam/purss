import type { MutedWord } from "@purss/domain";

/** How long a muted word mutes: a week, a month, or until it is removed. */
export type MuteFor = "week" | "month" | "forever";

const DAYS: Record<Exclude<MuteFor, "forever">, number> = { week: 7, month: 30 };

/** When a word muted now for this long stops muting (an ISO time), or null for until removed. */
export function muteUntil(length: MuteFor, now: Date): string | null {
  return length === "forever" ? null : new Date(now.getTime() + DAYS[length] * 86_400_000).toISOString();
}

/** The list with this word added; a word already in the list (whatever its case) is replaced, so it has one entry and the newest length. */
export function withMutedWord(words: readonly MutedWord[], text: string, until: string | null): MutedWord[] {
  const key = text.trim().toLowerCase();
  return [...words.filter((w) => w.text.toLowerCase() !== key), { text: text.trim(), until }];
}

/** Whether the notice under a list is shown: items were left out, or may have been (the count stopped early and found none), or they are being shown. */
export function mutedNoticeShown(hidden: number, atLeast: boolean, showing: boolean): boolean {
  return showing || hidden > 0 || atLeast;
}

/**
 * "3 items hidden by muted words", or "At least 3 items hidden by muted words" when only part of a long list was counted; when that
 * part held none, "Items further down may be hidden by muted words".
 */
export function hiddenByMuted(count: number, atLeast: boolean, format: (n: number) => string = (n) => n.toLocaleString("en")): string {
  if (count === 0 && atLeast) return "Items further down may be hidden by muted words";
  const items = `${format(count)} ${count === 1 ? "item" : "items"}`;
  return `${atLeast ? "At least " : ""}${items} hidden by muted words`;
}
