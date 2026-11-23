import { extension } from "@purss/translations/extension";
import type { BrowserCaptureResult, ManualKeepResult, UrlLookup } from "@purss/domain";
import type { PageInfo } from "./page-info.ts";
import type { BasketRef } from "./store.ts";

/*
 * What the toolbar popup says and offers for the page that is open, as pure functions of what the
 * PURSS answered and what the page advertises (tested in popup-model.test.ts).
 */

const names = (list: { name: string }[]): string => extension.popup.names(list.map((b) => b.name));

/** One line about this page in the PURSS. */
export function statusLine(lookup: UrlLookup): { kept: boolean; text: string } {
  const item = lookup.item;
  if (item?.baskets.length) return { kept: true, text: extension.popup.status.keptIn(names(item.baskets)) };
  if (item) return { kept: false, text: extension.popup.status.inYourPurss };
  return { kept: false, text: extension.popup.status.notYet };
}

/** Followed sources this page is part of. Following a site never means every page of it was collected. */
export function followLine(lookup: UrlLookup): string | null {
  return lookup.followedSources.length ? extension.popup.following(names(lookup.followedSources.map((s) => ({ name: s.title })))) : null;
}

/** The basket the picker starts on: the one last kept in, if it still exists, else the first. */
export function initialBasket(baskets: BasketRef[], last: string | null): string | null {
  return baskets.find((b) => b.id === last)?.id ?? baskets[0]?.id ?? null;
}

/** The Keep button for the chosen basket: nothing to do when the page is already there and no text is wanted. */
export function keepButton(lookup: UrlLookup | null, basket: BasketRef | null, withText: boolean): { label: string; enabled: boolean } {
  if (!basket) return { label: extension.popup.keep.button, enabled: false };
  const there = !!lookup?.item?.baskets.some((b) => b.id === basket.id);
  if (there && !withText) return { label: extension.popup.keepButton.alreadyIn(basket.name), enabled: false };
  if (there) return { label: extension.popup.keepButton.keepText, enabled: true };
  return { label: extension.popup.keepButton.keepIn(basket.name), enabled: true };
}

/** Said next to "Keep the text as you see it". */
export function textHint(lookup: UrlLookup | null, formatDate: (iso: string) => string): string {
  const at = lookup?.item?.browserCapturedAt;
  return at
    ? extension.popup.textHint.replaces(formatDate(at))
    : extension.popup.textHint.saves;
}

/** What happened, in one line, after keeping. `missingText`: the text was wanted but couldn't be read from the page. */
export function keptLine(out: ManualKeepResult | BrowserCaptureResult, basketName: string, missingText?: keyof typeof extension.popup.missingText): string {
  const where = !out.existing ? extension.popup.kept.keptIn(basketName) : out.alreadyInBasket ? extension.popup.kept.alreadyIn(basketName) : extension.popup.kept.keptAgain(basketName);
  const parts = [where];
  if ("textSaved" in out) parts.push(out.textSaved ? (out.textReplaced ? extension.popup.kept.textReplaced : extension.popup.kept.textSaved) : out.textNote ?? extension.popup.kept.textNotSaved);
  else if (missingText) parts.push(extension.popup.missingText[missingText]);
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
    return [{ label: info.youtube.exact ? extension.popup.offers.followChannel(info.youtube.name) : extension.popup.offers.followVideoChannel, url: info.youtube.url }];
  }
  return info.feeds.map((f, i) => ({ label: f.title ? extension.popup.offers.followFeedTitled(f.title) : i === 0 ? extension.popup.offers.followSite : extension.popup.offers.followFeed(i + 1), url: f.url }));
}
