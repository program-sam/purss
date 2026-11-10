import type { ItemDTO } from "@purss/domain";
import type { ListFilter } from "./constants.ts";
import { cleanVideoExcerpt } from "./feed-text.ts";
import { clock } from "./format.ts";

/** Whether an item belongs in a list of this scope and filter, judged on the client so a change shows at once. */
export function belongsInList(item: ItemDTO, scope: string, filter: ListFilter): boolean {
  return matchesFilter(item, filter) && (scope !== "toread" || item.workflow === "toread");
}

/** Whether an item belongs in a list with this filter, judged on the client so a change shows at once. */
export function matchesFilter(item: ItemDTO, filter: ListFilter | "open"): boolean {
  switch (filter) {
    case "open": return item.workflow === "new" || item.workflow === "toread";
    case "active": return item.workflow !== "ignored";
    case "all": return true;
    case "fresh": return item.fresh && item.workflow !== "ignored";
    default: return item.workflow === filter;
  }
}

/** The excerpt as lists and cards show it: a video's description without the feed's download mark and its leading link and sponsor lines. */
export function itemExcerpt(item: Pick<ItemDTO, "kind" | "excerpt">): string | null {
  return item.kind === "video" ? cleanVideoExcerpt(item.excerpt) : item.excerpt;
}

/** Initials as a journal feed gives them after a surname: "S.", "T. C.", "J.-P.", "TC". */
const INITIALS = /^(?:\p{Lu}\.?[\s-]*)+$/u;

/**
 * An author line as the reader shows it. Journal feeds send "Kaur; S.; Turin; T. C." (surname, initials, surname,
 * initials, all split by semicolons); that reads as "Kaur S., Turin T. C.". Any other list split by semicolons becomes
 * a plain comma list, and an author line without semicolons is left as it came.
 */
export function displayAuthors(author: string | null): string | null {
  if (!author || !author.includes(";")) return author;
  const parts = author.split(";").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return author;
  const paired = parts.length % 2 === 0 && parts.every((p, i) => (i % 2 ? INITIALS.test(p) : !INITIALS.test(p)));
  if (!paired) return parts.join(", ");
  const names: string[] = [];
  for (let i = 0; i < parts.length; i += 2) names.push(`${parts[i]} ${parts[i + 1]}`);
  return names.join(", ");
}

/** The titles the server gives the source that holds links kept by hand (and the one an item with no source shows). */
const MANUAL_SOURCE_TITLES = new Set(["Saved links", "Saved link"]);

/** The site a link kept by hand comes from ("example.org"), which is what it shows instead of "Saved links"; null for any other item. */
export function manualSiteName(item: Pick<ItemDTO, "sourceTitle" | "url">): string | null {
  if (!MANUAL_SOURCE_TITLES.has(item.sourceTitle) || !item.url) return null;
  try { return new URL(item.url).hostname.replace(/^www\./i, "") || null; } catch { return null; }
}

/** Date used for ordering and day grouping: publication date, else the day it arrived. */
export function itemDate(item: ItemDTO): string {
  return item.publishedAt ?? item.discoveredAt;
}

/**
 * Which of two copies of an item is newer: the one with the higher state version, a counter the server moves by one on every
 * change to the item's state. Clocks and the revision cannot say this: the revision guards workflow and reading progress only,
 * so a change to just the New marker or the opened time leaves it where it was.
 */
export function isNewerCopy(a: Pick<ItemDTO, "stateVersion">, b: Pick<ItemDTO, "stateVersion">): boolean {
  return a.stateVersion > b.stateVersion;
}

/**
 * `next` with the item's state taken from `known` when that copy is newer. A reload can bring an older state: a copy this device
 * saved for offline reading answers when the network is slow, and it must not put back a state the person has changed since.
 */
export function withNewerState<T extends ItemDTO>(next: T, known: ItemDTO | undefined): T {
  if (!known || known.id !== next.id || !isNewerCopy(known, next)) return next;
  const { workflow, revision, stateVersion, fresh, progress, opened, basketIds } = known;
  return { ...next, workflow, revision, stateVersion, fresh, progress, opened, basketIds };
}

/** Whether a change took an item's New marker away (PURSS does that when an item is opened or anything is done with it). */
export function newMarkerCleared(before: Pick<ItemDTO, "fresh">, after: Pick<ItemDTO, "fresh">): boolean {
  return before.fresh && !after.fresh;
}

/** Videos and podcasts are watched or listened to; their length is a duration, and scrolling says nothing about progress. */
export function isTimeBased(kind: ItemDTO["kind"]): boolean {
  return kind === "video" || kind === "podcast";
}

export function lengthText(item: ItemDTO): string {
  if (isTimeBased(item.kind)) return item.durationSeconds ? clock(item.durationSeconds) : "";
  return item.readMinutes ? `${item.readMinutes} min` : "";
}

export function isYouTube(url: string | null): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return h === "youtube.com" || h === "m.youtube.com" || h === "youtu.be" || h === "music.youtube.com";
  } catch { return false; }
}

/** Only http(s) links ever leave the app; anything else is dropped. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch { return null; }
}

/** Show images only from https origins (the page's policy allows nothing else). */
export function safeImage(url: string | null | undefined): string | null {
  const href = safeHref(url);
  return href && href.startsWith("https:") ? href : null;
}
