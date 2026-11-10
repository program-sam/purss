import type { BrowserCaptureResult, ManualKeepResult, UrlLookup } from "@purss/domain";
import type { PageInfo } from "./page-info.ts";
import type { BasketRef } from "./store.ts";

/*
 * What the toolbar popup says and offers for the page that is open, as pure functions of what the
 * PURSS answered and what the page advertises (tested in popup-model.test.ts).
 */

const names = (list: { name: string }[]): string => {
  const n = list.map((b) => b.name);
  return n.length <= 1 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
};

/** One line about this page in the PURSS. */
export function statusLine(lookup: UrlLookup): { kept: boolean; text: string } {
  const item = lookup.item;
  if (item?.baskets.length) return { kept: true, text: `Kept in ${names(item.baskets)}` };
  if (item) return { kept: false, text: "In your PURSS, not kept in a basket" };
  return { kept: false, text: "Not in your PURSS yet" };
}

/** Followed sources this page is part of. Following a site never means every page of it was collected. */
export function followLine(lookup: UrlLookup): string | null {
  return lookup.followedSources.length ? `You follow ${names(lookup.followedSources.map((s) => ({ name: s.title })))} on this site` : null;
}

/** The basket the picker starts on: the one last kept in, if it still exists, else the first. */
export function initialBasket(baskets: BasketRef[], last: string | null): string | null {
  return baskets.find((b) => b.id === last)?.id ?? baskets[0]?.id ?? null;
}

/** The Keep button for the chosen basket: nothing to do when the page is already there and no text is wanted. */
export function keepButton(lookup: UrlLookup | null, basket: BasketRef | null, withText: boolean): { label: string; enabled: boolean } {
  if (!basket) return { label: "Keep", enabled: false };
  const there = !!lookup?.item?.baskets.some((b) => b.id === basket.id);
  if (there && !withText) return { label: `Already in ${basket.name}`, enabled: false };
  if (there) return { label: "Keep its text", enabled: true };
  return { label: `Keep in ${basket.name}`, enabled: true };
}

/** Said next to "Keep the text as you see it". */
export function textHint(lookup: UrlLookup | null, formatDate: (iso: string) => string): string {
  const at = lookup?.item?.browserCapturedAt;
  return at
    ? `Replaces the text kept from your browser on ${formatDate(at)}.`
    : "Saves the readable part of this page as your browser shows it, labelled as captured in your browser.";
}

const MISSING_TEXT = {
  empty: "No readable text was found on the page, so only the link was kept.",
  too_large: "The page's text is too long to keep, so only the link was kept.",
} as const;

/** What happened, in one line, after keeping. `missingText`: the text was wanted but couldn't be read from the page. */
export function keptLine(out: ManualKeepResult | BrowserCaptureResult, basketName: string, missingText?: keyof typeof MISSING_TEXT): string {
  const where = !out.existing ? `Kept in ${basketName}` : out.alreadyInBasket ? `Already in ${basketName}` : `Kept in ${basketName} (you already had this page)`;
  const parts = [where];
  if ("textSaved" in out) parts.push(out.textSaved ? (out.textReplaced ? "Its text was replaced with what you see now." : "Its text was saved as your browser shows it.") : out.textNote ?? "Its text wasn't saved.");
  else if (missingText) parts.push(MISSING_TEXT[missingText]);
  if (out.captureNote) parts.push(out.captureNote);
  return parts.join(". ").replace(/\.\./g, ".");
}

export type SourceOffer = { label: string; url: string };

/**
 * What "Add as a source" hands to the PURSS's Add source: the YouTube channel, else each
 * advertised feed (the first one first). None when the page advertises nothing to follow.
 */
export function sourceOffers(info: PageInfo | null): SourceOffer[] {
  if (!info) return [];
  if (info.youtube) {
    return [{ label: info.youtube.exact ? `Follow ${info.youtube.name ?? "this channel"}` : "Follow this video's channel", url: info.youtube.url }];
  }
  return info.feeds.map((f, i) => ({ label: f.title ? `Follow “${f.title}”` : i === 0 ? "Follow this site" : `Follow feed ${i + 1}`, url: f.url }));
}
