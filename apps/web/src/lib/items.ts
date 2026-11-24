import { app } from "@purss/translations/app";
import { deviceStateFilterKeeps, linkIsMediaFile, sameAddress } from "@purss/domain";
import type { ItemDTO } from "@purss/domain";
import type { ListFilter } from "./constants.ts";
import { cleanVideoExcerpt } from "./feed-text.ts";
import { clock } from "./format.ts";
import { inQueue } from "./returning.ts";

/** Whether an item belongs in a list of this scope and filter, judged on the client so a change shows at once. */
export function belongsInList(item: ItemDTO, scope: string, filter: ListFilter): boolean {
  return matchesFilter(item, filter) && (scope !== "toread" || inQueue(item));
}

/** Whether an item belongs in a list with this filter, judged on the client so a change shows at once. */
export function matchesFilter(item: ItemDTO, filter: ListFilter): boolean {
  return deviceStateFilterKeeps(filter, item.workflow, item.isNew);
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

/** The site a link kept by hand comes from ("example.org"), which is what it shows instead of "Saved links"; null for any other item. */
export function manualSiteName(item: Pick<ItemDTO, "keptByHand" | "url">): string | null {
  if (!item.keptByHand || !item.url) return null;
  try { return new URL(item.url).hostname.replace(/^www\./i, "") || null; } catch { return null; }
}

/** Date shown in lists and used for ordering and day grouping: the item's time in lists (ItemDTO.listedAt). */
export function itemDate(item: ItemDTO): string {
  // A copy this device saved for offline reading can come from a build whose items had no listedAt.
  return (item.listedAt as string | undefined) ?? item.publishedAt ?? item.discoveredAt;
}

/** The publisher's own date, when it is more than an hour from the item's time in lists (so the item view shows both); else null. */
export function publishedApart(item: ItemDTO): string | null {
  if (!item.publishedAt) return null;
  const gap = Math.abs(Date.parse(itemDate(item)) - Date.parse(item.publishedAt));
  return gap > 3_600_000 ? item.publishedAt : null;
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
  const { workflow, revision, workflowRevision, playbackWorkflowSessionId, stateVersion, isNew, progress, opened, basketIds } = known;
  return { ...next, workflow, revision, workflowRevision, playbackWorkflowSessionId, stateVersion, isNew, progress, opened, basketIds };
}

/** Whether a change took an item's New marker away (PURSS does that when an item is opened or anything is done with it). */
export function newMarkerCleared(before: Pick<ItemDTO, "isNew">, after: Pick<ItemDTO, "isNew">): boolean {
  return before.isNew && !after.isNew;
}

/** Videos and podcasts are watched or listened to; their length is a duration, and scrolling says nothing about progress. */
export function isTimeBased(kind: ItemDTO["kind"]): boolean {
  return kind === "video" || kind === "podcast";
}

export function lengthText(item: ItemDTO): string {
  if (isTimeBased(item.kind)) return item.durationSeconds ? clock(item.durationSeconds) : "";
  return item.readMinutes ? app.lib.items.minutes(item.readMinutes) : "";
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

type Enclosed = { url: string; type: string | null };

/**
 * Where "Open original" goes. An item's own link, unless that link is its audio or video file (the same address as
 * one of its enclosures, or an address that ends in a media file name): many podcast feeds have no page for an episode
 * and PURSS's engine then gives the file as the link. The file opens with Listen or Watch, so such an item offers its
 * show's website (`of: "show"`) when the source has one that is not its feed, and otherwise nothing. The server says
 * whether the link is the file (`linkIsMedia`) for private sources too, whose enclosures it withholds.
 */
export function originalLink(
  item: Pick<ItemDTO, "url" | "media" | "linkIsMedia">,
  source?: { siteUrl: string | null; feedUrl: string | null } | null,
  enclosures: readonly Enclosed[] = [],
): { href: string; of: "item" | "show" } | null {
  const own = safeHref(item.url);
  // A private episode's file link is withheld by the server (its address can carry a secret); it still falls back to the show's website.
  if (!own && !item.linkIsMedia) return null;
  const files: Enclosed[] = [...(item.media ? [item.media] : []), ...enclosures];
  if (own && !item.linkIsMedia && !linkIsMediaFile(own, files)) return { href: own, of: "item" };
  const site = safeHref(source?.siteUrl);
  const feed = safeHref(source?.feedUrl);
  return site && !(feed && sameAddress(site, feed)) ? { href: site, of: "show" } : null;
}

/** Show images only from https origins (the page's policy allows nothing else). */
export function safeImage(url: string | null | undefined): string | null {
  const href = safeHref(url);
  return href && href.startsWith("https:") ? href : null;
}

/** A source's icon as the server serves it (same origin, versioned by its digest); nothing else counts as the show's art. */
const SOURCE_ICON = /^\/api\/sources\/[\w%-]+\/icon\?v=\w+$/;

/** The picture the player and the system's media controls show: an https picture, or the show's art as this app serves it. */
export function playerArtwork(url: string | null | undefined): string | null {
  return safeImage(url) ?? (url && SOURCE_ICON.test(url) ? url : null);
}

/** A picture kept with an item, as the server serves it (same origin). */
const KEPT_PICTURE = /^\/api\/items\/[\w%-]+\/images\/[\w%-]+$/;

/** An item's own picture as it can be shown: an https picture, or its kept copy (how an Instagram post's picture arrives). */
export function shownPicture(url: string | null | undefined): string | null {
  return safeImage(url) ?? (url && KEPT_PICTURE.test(url) ? url : null);
}

/**
 * The picture an item shows in a row, a card and the player: its own, or for a podcast episode that has none the show's art (the
 * source's icon, which is the feed's own picture). Nothing else borrows its source's picture: a post without one has none.
 */
export function itemPicture(item: { imageUrl: string | null; kind: string }, sourceIconUrl: string | null | undefined): string | null {
  return shownPicture(item.imageUrl) ?? (item.kind === "podcast" && sourceIconUrl && SOURCE_ICON.test(sourceIconUrl) ? sourceIconUrl : null);
}
