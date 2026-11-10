import { safeHref } from "./items.ts";

/** A run of plain text, or a web address found in it. */
export type LinkPiece = { text: string; href?: undefined } | { text: string; href: string };

const URL_LIKE = /https?:\/\/[^\s<>"'`]+/gi;
/** Characters that end a sentence or close a bracket rather than belong to the address. */
const TRAILING = /[.,;:!?'")\]}»”’…\u061F\u060C\u061B\u3001\u3002\uFF0C]+$/;

function trimAddress(raw: string): string {
  let url = raw;
  for (;;) {
    const m = TRAILING.exec(url);
    if (!m) return url;
    // Keep a closing bracket that has its opener inside the address: https://en.wikipedia.org/wiki/Foo_(bar)
    const tail = m[0];
    let keep = 0;
    if (tail.startsWith(")") && (url.match(/\(/g)?.length ?? 0) > (url.slice(0, url.length - tail.length).match(/\)/g)?.length ?? 0)) keep = 1;
    if (keep === 0) { url = url.slice(0, url.length - tail.length); continue; }
    return url.slice(0, url.length - tail.length + keep);
  }
}

/** Split plain text into text and web addresses. Only http and https addresses become links. */
export function splitLinks(text: string): LinkPiece[] {
  const out: LinkPiece[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_LIKE)) {
    const start = m.index ?? 0;
    const url = trimAddress(m[0]);
    const href = safeHref(url);
    if (!href || !url) continue;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: url, href });
    last = start + url.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length ? out : [{ text }];
}
