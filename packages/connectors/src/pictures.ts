import { sniffImage } from "./icon-format.ts";
import { shrinkPicture } from "./image.ts";
import type { ImageFormat } from "./icon-format.ts";
import { safeFetch } from "./safe-fetch.ts";
import type { SafeFetchOptions } from "./safe-fetch.ts";

/*
 * Pictures for a kept copy: fetch the addresses an item names through safeFetch, the same address rules as
 * every other fetch, one after another, and keep those that really are pictures. The type is read from the
 * bytes, never from what the publisher says, and only formats a browser shows as an image are kept: no SVG
 * (it can carry script), no ICO. Each picture that fails is skipped; the rest are still kept. With `shrink`, each is made
 * small (shrinkPicture) before it is handed back; one that doesn't decode is skipped.
 */

/** What a browser shows as a picture, by the format its bytes have. */
const TYPES: Partial<Record<ImageFormat, string>> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif" };

/** The content type of picture bytes, or null when they are not a kept format. */
export const pictureType = (bytes: Uint8Array): string | null => {
  const format = sniffImage(bytes);
  return format ? TYPES[format] ?? null : null;
};

export type FetchedPicture = { url: string; contentType: string; data: Buffer };

/** Time for all the pictures of one item; the ones not reached are left for another try. */
const TOTAL_MS = 90_000;
const EACH_MS = 15_000;

/**
 * Fetch pictures until `maxBytes` of them are held. A picture bigger than what is left is skipped, not cut. Never throws.
 * `fetch` carries the in-process test allowances of safeFetch.
 */
export async function fetchPictures(urls: string[], opts: { maxBytes: number; shrink?: boolean; signal?: AbortSignal; fetch?: SafeFetchOptions }): Promise<FetchedPicture[]> {
  const out: FetchedPicture[] = [];
  const deadline = Date.now() + TOTAL_MS;
  let left = opts.maxBytes;
  for (const url of urls) {
    if (opts.signal?.aborted || Date.now() >= deadline || left <= 0) break;
    const res = await safeFetch(url, {
      timeoutMs: Math.min(EACH_MS, deadline - Date.now()),
      phaseTimeoutsMs: { firstByteMs: 8000, idleMs: 6000 },
      ...opts.fetch,
      signal: opts.signal,
      maxBytes: left,
      accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1",
    }).catch(() => null);
    if (!res?.ok || res.response.status !== 200) continue;
    let data = res.response.body;
    if (!pictureType(data)) continue;
    if (opts.shrink) {
      const small = await shrinkPicture(data);
      if (!small) continue;
      data = small;
    }
    out.push({ url, contentType: pictureType(data)!, data });
    left -= data.length;
  }
  return out;
}
