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
export const STORED_PICTURE = /^\/api\/items\/[\w-]+\/images\/[\w-]+$/;
/**
 * Where a stored picture's address goes instead of `src`: the apps' page isn't PURSS's origin, so the reader puts in
 * what the platform's transport gives for it (`showStoredPictures`).
 */
export const STORED_PICTURE_ATTR = "data-stored-src";

/**
 * Some publishers (podcast notes from Arabic shows among them) join every word of a paragraph with a no-break space, so
 * it has no place to wrap at a space and the browser cuts words in half at the end of each line. Where no-break spaces
 * are what separates the words of a text (three or more, and more than ordinary spaces), they are turned into ordinary ones.
 * A "10 km" or "Mr. Smith" among ordinary spaces keeps its no-break space.
 */
export function softenNoBreakSpaces(text: string): string {
  const joined = text.match(/\u00a0/g)?.length ?? 0;
  if (joined < 3 || joined <= (text.match(/ /g)?.length ?? 0)) return text;
  return text.replace(/\u00a0/g, " ");
}

function softenWordSpacing(doc: Document): void {
  doc.body.normalize(); // one text node per run of text, whatever the parser made of the entities
  const SHOW_TEXT = 4;
  const walker = doc.createTreeWalker(doc.body, SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (t.data.includes("\u00a0") && !t.parentElement?.closest("pre,code")) t.data = softenNoBreakSpaces(t.data);
  }
}

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

/**
 * Reddit (and feeds made like it) lay a post out as a one-row table: the picture in one cell, the text beside it. In a narrow reader that
 * squeezes the picture to a thumbnail, so the cells are laid one under the other and the picture has the column to itself.
 * Only a single row with no headings or caption is a layout; a table of data stays one.
 */
function stackPictureTables(doc: Document): void {
  for (const table of [...doc.body.querySelectorAll("table")]) {
    if (table.closest("table") !== table || table.querySelector("th,caption,thead,table")) continue;
    const rows = table.querySelectorAll("tr");
    const cells = rows.length === 1 ? [...rows[0]!.children].filter((c) => c.tagName === "TD") : [];
    if (cells.length < 1 || cells.length > 3 || !cells.some((c) => c.querySelector("img"))) continue;
    const stack = doc.createElement("div");
    for (const cell of cells) {
      const part = doc.createElement("div");
      part.append(...[...cell.childNodes]);
      stack.append(part);
    }
    table.replaceWith(stack);
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
  stackPictureTables(doc);
  doc.querySelectorAll(DROP).forEach((el) => el.remove());
  softenWordSpacing(doc);
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
    const src = (img.getAttribute("src") ?? "").trim();
    img.removeAttribute(STORED_PICTURE_ATTR);
    if (STORED_PICTURE.test(src)) {
      img.removeAttribute("src");
      img.setAttribute(STORED_PICTURE_ATTR, src);
    } else if (!/^https:/i.test(src)) { img.remove(); return; }
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
    img.setAttribute("referrerpolicy", "no-referrer");
    img.removeAttribute("srcset");
  });
  return doc.body.innerHTML;
}

/** Give the stored pictures in `root` (marked by prepareArticleHtml) what `picture` resolves their addresses to. */
export function showStoredPictures(root: ParentNode, picture: (path: string) => string | Promise<string>): void {
  root.querySelectorAll<HTMLImageElement>(`img[${STORED_PICTURE_ATTR}]`).forEach((img) => {
    const path = img.getAttribute(STORED_PICTURE_ATTR) ?? "";
    if (!STORED_PICTURE.test(path)) return;
    const src = picture(path);
    if (typeof src === "string") img.src = src;
    else src.then((url) => { img.src = url; }, () => { img.remove(); });
  });
}
