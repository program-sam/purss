import { syncEntrySchema } from "@purss/domain";
import type { SyncEntry } from "@purss/domain";
import { EngineError } from "./errors.ts";
import type { RawStreamItem } from "./greader.ts";

/**
 * Maps one GReader stream item to the product's `SyncEntry` contract.
 *
 * What the engine's `compat` output does and does not give us (observed, see CAPABILITIES.md):
 *  - `externalId`: the engine's numeric entry id, rendered as a decimal string. It is first-crawl time in
 *    microseconds, unique per engine user, and is what edit-tag accepts. It is NOT a GUID.
 *  - `originalGuid` is never present in the standard stream, so it is always null here.
 *  - title and author arrive with `& < >` replaced by their fullwidth forms; we map them back.
 *  - `summary.content` carries the engine's single content field; it is reported as `contentHtml`
 *    (the engine does not separate summary from full content), `summaryHtml` stays null.
 *  - `crawledAt` is the engine's first-seen time. Editing an entry in the engine does not change it.
 */

export type NormalizedItem = {
  entry: SyncEntry;
  /** First-crawl time in microseconds (decimal string), the engine's ordering key. */
  crawlUsec: string;
  /** Hash input for change detection: the fields that define the entry's content. */
  contentDigest: string;
};

const FULLWIDTH: Array<[RegExp, string]> = [
  [/＆/g, "&"],
  [/＜/g, "<"],
  [/＞/g, ">"],
];

export function restoreEscapedText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of FULLWIDTH) out = out.replace(pattern, replacement);
  return out;
}

export function engineItemIdToDecimal(id: string): string {
  const hex = /(?:^|\/)([0-9a-f]{16})$/i.exec(id)?.[1];
  if (!hex) throw new EngineError("protocol", "A stream item id did not end in a hexadecimal entry id.");
  return BigInt(`0x${hex}`).toString();
}

/** Truncates to at most `max` UTF-16 units without splitting a surrogate pair. */
export function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function clampOrNull(text: string | undefined | null, max: number): string | null {
  if (text == null || text === "") return null;
  return clamp(text, max);
}

function toIsoFromUsec(usec: string): string {
  const ms = Number(BigInt(usec) / 1000n);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

function publishedIso(seconds: unknown): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const THUMBNAIL = /<img class="enclosure-thumbnail" src="([^"]+)"/;

function decodeAmp(v: string): string {
  return v.replace(/&amp;/g, "&");
}

function isHttpUrl(v: string | null | undefined): v is string {
  return typeof v === "string" && /^https?:\/\//i.test(v);
}

export function normalizeItem(raw: RawStreamItem): NormalizedItem {
  const externalId = engineItemIdToDecimal(raw.id);
  const streamId = raw.origin?.streamId;
  if (!streamId) throw new EngineError("protocol", "A stream item had no source stream id.");
  const link = raw.canonical?.[0]?.href ?? raw.alternate?.[0]?.href ?? null;
  const content = raw.summary?.content ?? raw.content?.content ?? null;

  const enclosures = (raw.enclosure ?? [])
    .filter((e): e is { href: string; type?: string; length?: number | string } => isHttpUrl(e.href))
    .slice(0, 10)
    .map((e) => {
      const length = typeof e.length === "string" ? Number(e.length) : e.length;
      return {
        url: clamp(e.href, 4000),
        type: clampOrNull(typeof e.type === "string" ? e.type : null, 200),
        length: typeof length === "number" && Number.isFinite(length) && length >= 0 ? length : null,
      };
    });

  const imageEnclosure = enclosures.find((e) => e.type?.toLowerCase().startsWith("image"));
  const thumb = content ? THUMBNAIL.exec(content)?.[1] : undefined;
  const imageUrl = imageEnclosure?.url ?? (thumb && isHttpUrl(decodeAmp(thumb)) ? clamp(decodeAmp(thumb), 4000) : null);

  const entry: SyncEntry = {
    externalId: clamp(externalId, 200),
    streamId: clamp(streamId, 300),
    originalGuid: null,
    url: isHttpUrl(link) ? clamp(link, 4000) : null,
    title: clamp(restoreEscapedText(raw.title ?? ""), 2000),
    author: clampOrNull(raw.author == null ? null : restoreEscapedText(raw.author), 500),
    publishedAt: publishedIso(raw.published),
    crawledAt: toIsoFromUsec(raw.timestampUsec),
    summaryHtml: null,
    contentHtml: clampOrNull(content, 2_000_000),
    imageUrl,
    enclosures,
  };
  // The contract is authoritative: a mismatch here is a bug in this mapping, never something to forward.
  const parsed = syncEntrySchema.safeParse(entry);
  if (!parsed.success) throw new EngineError("protocol", "A normalised entry did not satisfy the sync contract.");
  const contentDigest = JSON.stringify([entry.title, entry.url, entry.author, entry.contentHtml, entry.enclosures]);
  return { entry: parsed.data, crawlUsec: raw.timestampUsec, contentDigest };
}
