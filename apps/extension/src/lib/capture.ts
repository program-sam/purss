import { Readability } from "@mozilla/readability";

/*
 * Browser-assisted capture (plan/32): the readable part of the page as the person's browser shows it,
 * extracted in the page with Mozilla Readability (the same library the PURSS uses for its own
 * captures). Only on request. The PURSS sanitizes the HTML again before storing it.
 */

/** The PURSS's limit (BROWSER_CAPTURE_MAX_CHARS in packages/domain); checked here so nothing larger is sent. */
export const MAX_CAPTURE_CHARS = 2_000_000;

export type Readable = { ok: true; title: string | null; html: string } | { ok: false; reason: "empty" | "too_large" };

export function readableOf(doc: Document): Readable {
  // Readability changes the document it reads, so it reads a copy, never the page itself.
  const copy = doc.cloneNode(true) as Document;
  let article: { title?: string | null; content?: string | null } | null = null;
  try {
    article = new Readability(copy, { charThreshold: 200 }).parse();
  } catch {
    article = null;
  }
  const html = article?.content?.trim() ?? "";
  if (!html) return { ok: false, reason: "empty" };
  if (html.length > MAX_CAPTURE_CHARS) return { ok: false, reason: "too_large" };
  const title = (article?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || null;
  return { ok: true, title, html };
}
