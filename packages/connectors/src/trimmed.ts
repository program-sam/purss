import { routeSignatureMatches, signRoute } from "./route-signature.ts";
import { safeFetch } from "./safe-fetch.ts";
import type { SafeFetchOptions } from "./safe-fetch.ts";

/*
 * Big feeds reach the engine through the feed gateway. A feed that is larger than the engine can parse in its memory
 * limit (tens of megabytes of repeated show notes) is read by the gateway as a stream, and the engine is handed a copy of
 * the same feed with only its newest items. The source keeps its own address; only the engine's subscription points at the
 * gateway's signed address for it, made here and checked there, so the gateway fetches only addresses this installation made.
 */

/**
 * The size from which a feed goes through the gateway: the part of a feed a preview reads (and so what it can tell about its
 * size). FreshRSS parsed a 20.7 MB podcast feed at 115 MB and serialized its cache at 277 MB, against a limit of 128 MB per
 * request, so 4 MB (about a fifth of that feed) leaves the engine room to spare while
 * it holds the 256 MB container's other requests.
 */
export const TRIM_FEED_BYTES = 4 * 1024 * 1024;

/**
 * The number of items from which a feed goes through the gateway however small it is. The engine stores every item of a feed as it adds
 * it, so its time and memory follow the item count as well as the bytes: measured in the engine, a feed of one-line items took
 * about 16 ms an item (2,000 items 32 s, 8,000 items 111 s, with the worker waiting 30 s for the engine's answer), and 24,000 of them
 * failed the request. It is also what the engine's retention (90 days of a feed's items) leaves of a feed.
 */
export const TRIM_FEED_ITEMS = 1000;

/** The newest items of a big feed that the engine is given: the 50 it keeps of a feed at the least (its retention is 90 days, 50 to 1,000 items). */
export const TRIM_ITEMS = 50;

const MAX_URL_LENGTH = 2048;

const encodeTarget = (feedUrl: string): string => Buffer.from(feedUrl, "utf8").toString("base64url");

/** What the signature of a gateway address covers. */
const signedName = (feedUrl: string): string => `trim\n${feedUrl}`;

/** The gateway path of a feed: `/t/<signature>/<address, base64url>`, signed with the installation's feed-trim key. The same address always gives the same path. */
export function trimRoutePath(secret: string, feedUrl: string): string {
  return `/t/${signRoute(secret, signedName(feedUrl))}/${encodeTarget(feedUrl)}`;
}

/**
 * The feed address a gateway path names, given its parts as they stand in the path, when this installation's feed-trim key signed it
 * and it is a plain web address of reasonable length written the one way `trimRoutePath` writes it; else null.
 */
export function verifyTrimRoute(secret: string, encoded: string, signature: string): string | null {
  const url = parseTarget(encoded);
  return url && routeSignatureMatches(secret, signedName(url), signature) ? url : null;
}

function parseTarget(encoded: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,4000}$/.test(encoded)) return null;
  const url = Buffer.from(encoded, "base64url").toString("utf8");
  if (url.length > MAX_URL_LENGTH || encodeTarget(url) !== encoded) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

const ITEM_START = /<(?:[A-Za-z_][\w.-]*:)?(?:item|entry)(?=[\s>/])/g;
const COUNT_CARRY = 64;

/** Counts the items (`<item>`, `<entry>`) of a feed read in pieces, without keeping it: a start tag split between two pieces is counted once. */
export class ItemCounter {
  count = 0;
  #carry = "";
  add(chunk: Uint8Array): number {
    const text = this.#carry + Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("latin1");
    const carried = this.#carry.length;
    for (const m of text.matchAll(ITEM_START)) {
      // A match that ended inside the carried text was counted with the piece before it.
      if (m.index + m[0].length >= carried) this.count++;
    }
    this.#carry = text.slice(-COUNT_CARRY);
    return this.count;
  }
}

/** The number of items in a feed held whole. */
export function countFeedItems(body: Uint8Array): number {
  return new ItemCounter().add(body);
}

/**
 * Whether the document at an address is larger than `TRIM_FEED_BYTES` or has more than `TRIM_FEED_ITEMS` items: it is read as a stream
 * and dropped, stopping at the first byte or item past the size, so asking costs at most that much. `null` when it could not be asked (not reachable, not answered).
 * Every address and redirect rule of `safeFetch` applies.
 */
export async function isLargeFeed(url: string, opts: Pick<SafeFetchOptions, "signal" | "timeoutMs" | "testAllowAddress" | "resolver" | "testTlsCa"> = {}): Promise<boolean | null> {
  let bytes = 0;
  const items = new ItemCounter();
  let manyItems = false;
  const res = await safeFetch(url, {
    ...opts,
    maxBytes: TRIM_FEED_BYTES + 1,
    timeoutMs: opts.timeoutMs ?? 20_000,
    allowPartial: false,
    sink: (chunk) => {
      bytes += chunk.length;
      if (items.add(chunk) > TRIM_FEED_ITEMS) manyItems = true;
      return bytes > TRIM_FEED_BYTES || manyItems ? "stop" : undefined;
    },
  });
  if (!res.ok) return res.reason === "toolarge" ? true : null;
  if (res.response.status < 200 || res.response.status >= 300) return null;
  return bytes > TRIM_FEED_BYTES || manyItems;
}
