import { skipLeadingBoilerplate } from "./feed-text.ts";
import { splitLinks } from "./links.ts";

/**
 * Prepare server-sanitised article HTML for display. The server already removes scripts and
 * event handlers; this is a second, defensive pass in an inert document: it drops anything that
 * could run or embed, keeps only http(s)/mailto links, and makes every link open safely in a new tab.
 * Pictures are lazy and send no referrer. Nothing is executed while parsing.
 */
const DROP = "script,style,iframe,frame,frameset,object,embed,applet,form,input,button,select,textarea,link,meta,base,svg,math,audio,video,source,track,canvas";

/** A picture PURSS stored with a kept copy: the only address that is not https a picture may have. */
const STORED_PICTURE = /^\/api\/items\/[\w-]+\/images\/[\w-]+$/;

/** Web addresses written out as plain text (feeds often send descriptions that way) become links; ones already in a link or in code stay as they are. */
function linkifyBareAddresses(doc: Document): void {
  const SHOW_TEXT = 4;
  const walker = doc.createTreeWalker(doc.body, SHOW_TEXT);
  const found: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (/https?:\/\//i.test(t.data) && !t.parentElement?.closest("a,code,pre")) found.push(t);
  }
  for (const t of found) {
    const pieces = splitLinks(t.data);
    if (!pieces.some((p) => p.href)) continue;
    const frag = doc.createDocumentFragment();
    for (const p of pieces) {
      if (!p.href) { frag.append(doc.createTextNode(p.text)); continue; }
      const a = doc.createElement("a");
      a.setAttribute("href", p.href);
      a.textContent = p.text;
      frag.append(a);
    }
    t.replaceWith(frag);
  }
}

/** A journal's citation paragraph ("Nature, Published online: 4 November 2026; doi:10.1038/…"). */
export function isCitationLead(text: string): boolean {
  return /^[^;]{1,80}?Published online:[^;]{1,40};\s*doi:10\.\d{4,9}\/\S+$/.test(text.trim());
}

/** The part of a picture's address that says which picture it is: a YouTube thumbnail is `/vi/<video id>/…` whatever its size or host. */
function pictureKey(src: string): string {
  const video = /\/vi\/([\w-]{6,})\//.exec(src);
  return video ? `vi:${video[1]}` : src.trim().replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
}

/** What the reader shows around a video's description: the feed's download mark and the picture it repeats, and the
 *  links and sponsor lines the description opens with, are left out. */
function tidyVideoDescription(doc: Document, pictureUrl: string | null): void {
  for (const a of [...doc.body.querySelectorAll("a")]) if ((a.textContent ?? "").trim() === "\u{1F4BE}") a.remove();
  if (pictureUrl) {
    const key = pictureKey(pictureUrl);
    for (const img of [...doc.body.querySelectorAll("img")]) if (pictureKey(img.getAttribute("src") ?? "") === key) img.remove();
  }
  // What the removals left empty (a paragraph that held only the picture or the mark) goes too.
  for (const el of [...doc.body.querySelectorAll("p,div,figure")].reverse()) if (!(el.textContent ?? "").trim() && !el.querySelector("img,video,audio")) el.remove();
  skipLeadingBoilerplate(doc.body);
}

/** `dropCitation`: the reader already shows the item's DOI and date above the article, so a leading
 *  citation paragraph that only repeats them is left out (only when more content follows).
 *  `video`: the item is a video, shown above with its own picture (`pictureUrl`). */
export function prepareArticleHtml(html: string, opts: { dropCitation?: boolean; video?: { pictureUrl: string | null } } = {}): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const first = doc.body.firstElementChild;
  if (opts.dropCitation && first?.tagName === "P" && isCitationLead(first.textContent ?? "") && (doc.body.textContent ?? "").trim().length > (first.textContent ?? "").trim().length) first.remove();
  if (opts.video) tidyVideoDescription(doc, opts.video.pictureUrl);
  doc.querySelectorAll(DROP).forEach((el) => el.remove());
  linkifyBareAddresses(doc);
  doc.body.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "style" || name === "srcdoc") el.removeAttribute(attr.name);
    }
  });
  doc.body.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    if (!/^(https?:|mailto:)/i.test(href.trim())) { a.removeAttribute("href"); return; }
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer nofollow");
    // A short one-word link (a DOI, a short URL) moves to the next line whole instead of breaking at a hyphen.
    const text = a.textContent ?? "";
    if (text.length <= 48 && !/\s/.test(text.trim())) a.classList.add("tok");
  });
  doc.body.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    if (!/^https:/i.test(src.trim()) && !STORED_PICTURE.test(src.trim())) { img.remove(); return; }
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
    img.setAttribute("referrerpolicy", "no-referrer");
    img.removeAttribute("srcset");
  });
  return doc.body.innerHTML;
}
