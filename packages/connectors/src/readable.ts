import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { decodeBody, parseContentType, sniffContent } from "./content-type.ts";
import { sanitizeArticleHtml } from "./sanitize.ts";
import { safeFetch } from "./safe-fetch.ts";
import type { SafeFetchOptions } from "./safe-fetch.ts";
import { TooComplexError, assertShallowMarkup, cleanLine, htmlToPlainText } from "./text.ts";

/*
 * Readable-text capture for Keep: fetch a page through safeFetch, extract the main
 * article with Mozilla Readability on a linkedom DOM (no scripts run, no subresources
 * load), then pass the result through the strict allowlist sanitizer. Everything is
 * bounded in time and size. This is an explicit, user-initiated capture, not a crawler.
 */

export type ReadableCapture =
  | { ok: true; title: string | null; text: string; html: string; finalUrl: string; bytes: number }
  | { ok: false; reason: string; message: string };

const PAGE_MAX_BYTES = 3 * 1024 * 1024;
const OUTPUT_MAX_BYTES = 1_500_000;
const MIN_TEXT = 200;
const MAX_ELEMENTS = 40_000;

function fail(reason: string, message: string): ReadableCapture {
  return { ok: false, reason, message };
}

/**
 * Internal variant that accepts fetch options. `fetch` carries the in-process test
 * allowances of safeFetch; production callers use {@link captureReadable}.
 */
export async function captureReadableWith(url: string, opts: { signal?: AbortSignal; fetch?: SafeFetchOptions } = {}): Promise<ReadableCapture> {
  const signal = opts.signal;
  if (signal?.aborted) return fail("aborted", "The capture was cancelled.");
  const res = await safeFetch(url, {
    timeoutMs: 25_000,
    phaseTimeoutsMs: { firstByteMs: 12_000, idleMs: 8000 },
    ...opts.fetch,
    signal,
    maxBytes: PAGE_MAX_BYTES,
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
  });
  if (!res.ok) return fail(res.reason, res.message);
  const r = res.response;
  if (r.status === 404 || r.status === 410) return fail("unreachable", "That page no longer exists at its address, so no readable copy could be saved.");
  if (r.status === 401 || r.status === 403) return fail("unreachable", "That page needs a login or blocks automated readers, so no readable copy could be saved.");
  if (r.status === 429) return fail("unreachable", "That website asked us to slow down. The readable copy can be retried later.");
  if (r.status < 200 || r.status >= 300) return fail("unreachable", `That website answered with an error (${r.status}), so no readable copy could be saved.`);
  const kind = sniffContent(r.body, r.contentType);
  const media = parseContentType(r.contentType).mediaType;
  if (kind !== "html" && !(kind === "xml" && media === "application/xhtml+xml")) {
    return fail("unsupported", "That link isn't an ordinary web page (it may be a file, video or feed), so a readable copy can't be made.");
  }
  if (signal?.aborted) return fail("aborted", "The capture was cancelled.");

  const html = decodeBody(r.body, r.contentType);
  try {
    assertShallowMarkup(html, "html");
  } catch (error) {
    if (error instanceof TooComplexError) return fail("invalid", "That page's structure is too complex to read safely.");
    throw error;
  }

  let article: { title?: string | null; content?: string | null } | null = null;
  try {
    const { document } = parseHTML(html);
    // Readability rewrites links against the document URL; linkedom has no URL, so
    // relative links are resolved later by the sanitizer against the final URL.
    const reader = new Readability(document as unknown as Document, { charThreshold: 150, maxElemsToParse: MAX_ELEMENTS, keepClasses: false });
    article = reader.parse();
  } catch {
    return fail("noarticle", "We couldn't find readable article text on that page. It may be built so that it only works with JavaScript.");
  }
  if (!article?.content) return fail("noarticle", "We couldn't find readable article text on that page. It may need JavaScript or a login.");
  if (signal?.aborted) return fail("aborted", "The capture was cancelled.");

  const clean = sanitizeArticleHtml(article.content, r.url);
  if (!clean.ok) return fail(clean.reason === "toolarge" ? "toolarge" : "invalid", "That page is too large or complex to save a readable copy.");
  const text = htmlToPlainText(clean.html);
  if (text.length < MIN_TEXT) return fail("noarticle", "We couldn't find enough readable text on that page. It may need JavaScript or a login.");
  const bytes = Buffer.byteLength(clean.html) + Buffer.byteLength(text);
  if (bytes > OUTPUT_MAX_BYTES) return fail("toolarge", "That article is longer than we keep as a readable copy.");
  return { ok: true, title: cleanLine(article.title ?? null, 300), text, html: clean.html, finalUrl: r.url, bytes };
}

/** Capture a readable, sanitized copy of a page. Never throws. */
export function captureReadable(url: string, opts?: { signal?: AbortSignal }): Promise<
  { ok: true; title: string | null; text: string; html: string; finalUrl: string; bytes: number } | { ok: false; reason: string; message: string }
> {
  return captureReadableWith(url, { signal: opts?.signal }).catch(() => fail("error", "Something went wrong while saving a readable copy. It can be retried later."));
}
