import { parseHTML } from "linkedom";

/*
 * Lazy-loaded pictures, made ordinary before Readability reads a page. Most publishers' pages show a picture by
 * putting a tiny placeholder in `src` and the real address somewhere else (`data-src`, `data-srcset`, an image-only
 * `<noscript>` fallback, or the full-size file a gallery thumbnail links to), and a script swaps it in. Nothing runs
 * here, so a copy of such a page would keep the captions and lose the pictures. Only an image whose own `src` is a
 * placeholder is touched; the new address must be an http(s) address, and the sanitizer and the picture job still
 * decide what is kept, under the same address rules and limits as for any picture.
 */

/** Attributes that carry a lazy image's real address, best first. */
const SOURCE_ATTRS = ["data-src", "data-lazy-src", "data-original", "data-lazy", "data-url", "data-full-url", "data-hi-res-src"];
const SRCSET_ATTRS = ["data-srcset", "data-lazy-srcset", "srcset"];
const MAX_IMAGES = 600;
const MAX_ADDRESS = 2048;
/** A srcset candidate wider than this is only taken when nothing narrower is declared (the copy is not a print archive). */
const WIDEST_WANTED = 1600;
/** A picture no bigger than this on both sides, as the page declares it, is a thumbnail of what its link shows. */
const THUMBNAIL_SIDE = 400;

const PLACEHOLDER_NAME = /(?:^|[/_.-])(?:blank|placeholder|spacer|pixel|transparent|loading|lazy|1x1)(?:[/_.-]|$)/i;
const IMAGE_FILE = /\.(?:jpe?g|png|gif|webp|avif)$/i;
/** A resized copy WordPress made: `photo-300x225.png`. */
const RESIZED = /-\d{2,4}x\d{2,4}\.[a-z0-9]{3,4}$/i;

type El = Element;

/** An http(s) address with no credentials, resolved against the page, or null. */
function webAddress(value: string | null | undefined, base: string): string | null {
  const v = value?.trim();
  if (!v || v.length > MAX_ADDRESS) return null;
  try {
    const u = new URL(v, base);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** True when `src` shows nothing yet: missing, an inline data address, or a well-known placeholder file. */
function isPlaceholder(src: string | null): boolean {
  const v = src?.trim() ?? "";
  if (!v || v === "about:blank" || /^data:/i.test(v)) return true;
  try {
    return PLACEHOLDER_NAME.test(new URL(v, "https://placeholder.invalid/").pathname);
  } catch {
    return false;
  }
}

/** The best address in a srcset: the widest one up to WIDEST_WANTED, else the narrowest of those wider. */
export function bestFromSrcset(srcset: string | null | undefined, base: string): string | null {
  if (!srcset || srcset.length > 20_000) return null;
  const found: { url: string; w: number }[] = [];
  // As the HTML standard reads it: an address runs to the next white space and may contain commas (image resizers), so a
  // candidate is told apart from the next by the comma that follows its descriptor, or that ends its address.
  let i = 0;
  while (i < srcset.length && found.length < 40) {
    while (i < srcset.length && /[\s,]/.test(srcset[i]!)) i++;
    const start = i;
    while (i < srcset.length && !/\s/.test(srcset[i]!)) i++;
    let raw = srcset.slice(start, i);
    let descriptor = "";
    if (raw.endsWith(",")) {
      raw = raw.replace(/,+$/, "");
    } else {
      const comma = srcset.indexOf(",", i);
      const end = comma === -1 ? srcset.length : comma;
      descriptor = srcset.slice(i, end).trim();
      i = end + 1;
    }
    const url = webAddress(raw, base);
    if (!url) continue;
    const m = /^(\d+(?:\.\d+)?)([wx])$/.exec(descriptor);
    // Pixel-density candidates are ranked by density against a typical 800 px column.
    found.push({ url, w: m ? (m[2] === "x" ? Number(m[1]) * 800 : Number(m[1])) : 0 });
  }
  if (!found.length) return null;
  const wanted = found.filter((c) => c.w <= WIDEST_WANTED);
  if (wanted.length) return wanted.reduce((a, b) => (b.w > a.w ? b : a)).url;
  return found.reduce((a, b) => (b.w < a.w ? b : a)).url;
}

function declared(img: El, name: "width" | "height"): number {
  const n = Number.parseInt(img.getAttribute(name) ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The `<img>` an image-only `<noscript>` holds, whether the parser made elements of it or kept its text. */
function noscriptImage(noscript: El): El | null {
  let holder: El = noscript;
  if (!noscript.firstElementChild && noscript.textContent?.includes("<img")) {
    holder = parseHTML(`<div>${noscript.textContent.slice(0, 20_000)}</div>`).document.querySelector("div") as unknown as El;
  }
  const imgs = holder.querySelectorAll("img");
  if (imgs.length !== 1) return null;
  // Image-only: nothing in it but the picture (and the link or picture wrapper some themes add).
  const text = (holder.textContent ?? "").trim();
  return text ? null : (imgs[0] as unknown as El);
}

/** The full-size file a thumbnail links to: the enclosing link's address when it names a picture file. */
function linkedFullSize(img: El, base: string): string | null {
  let node = img.parentNode as El | null;
  for (let depth = 0; node && depth < 3; depth++, node = node.parentNode as El | null) {
    if (node.nodeName?.toLowerCase() !== "a") continue;
    const href = webAddress(node.getAttribute("href"), base);
    if (!href) return null;
    try {
      return IMAGE_FILE.test(new URL(href).pathname) ? href : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Containers Readability weighs by how many pictures they hold against paragraphs. */
const GALLERY_BOXES = new Set(["div", "ul", "ol", "table", "section"]);
const MAX_GALLERY_IMAGES = 80;

/**
 * Readability drops a box of several pictures and no paragraph (a gallery) as clutter, unless it sits inside a `<figure>`. The
 * highest such box around a picture the page loads lazily is put in one, so that the gallery is kept with its captions.
 */
function protectGallery(document: Document, img: El): void {
  let top: El | null = null;
  for (let node = img.parentNode as El | null, depth = 0; node && depth < 8; node = node.parentNode as El | null, depth++) {
    const tag = node.nodeName?.toLowerCase();
    if (tag === "figure") return;
    if (!tag || tag === "body" || tag === "html") break;
    if (node.querySelector("p") || node.querySelectorAll("img").length > MAX_GALLERY_IMAGES) break;
    if (GALLERY_BOXES.has(tag)) top = node;
  }
  if (!top?.parentNode || top.querySelectorAll("img").length < 2) return;
  const figure = document.createElement("figure");
  top.parentNode.replaceChild(figure, top);
  figure.appendChild(top);
}

/**
 * Gives every lazy image of the document an ordinary `src`. Returns how many it changed. The page's own address is `pageUrl`;
 * relative addresses are resolved against it. A real `src` is never replaced.
 */
export function promoteLazyImages(document: Document, pageUrl: string): number {
  let changed = 0;
  const promoted: El[] = [];
  const imgs = [...document.querySelectorAll("img")].slice(0, MAX_IMAGES) as unknown as El[];
  for (const img of imgs) {
    if (img.parentNode?.nodeName?.toLowerCase() === "noscript") continue;
    if (!isPlaceholder(img.getAttribute("src"))) continue;

    let noscript: El | null = null;
    for (const sib of [img.nextElementSibling, img.previousElementSibling] as (El | null)[]) {
      if (sib?.nodeName?.toLowerCase() === "noscript") { noscript = sib; break; }
    }
    const fallback = noscript ? noscriptImage(noscript) : null;

    let own: string | null = null;
    for (const a of SOURCE_ATTRS) { own = webAddress(img.getAttribute(a), pageUrl); if (own) break; }
    if (!own) for (const a of SRCSET_ATTRS) { own = bestFromSrcset(img.getAttribute(a), pageUrl); if (own) break; }
    if (!own && fallback) own = webAddress(fallback.getAttribute("src"), pageUrl) ?? bestFromSrcset(fallback.getAttribute("srcset"), pageUrl);
    if (!own) continue;

    // A gallery shows thumbnails that link to the pictures: when this one is only a thumbnail, keep the picture itself.
    const thumbnail = (declared(img, "width") > 0 || declared(img, "height") > 0)
      ? Math.max(declared(img, "width"), declared(img, "height")) <= THUMBNAIL_SIDE
      : RESIZED.test(new URL(own).pathname);
    const full = linkedFullSize(img, pageUrl);
    const chosen = thumbnail && full ? full : own;
    img.setAttribute("src", chosen);
    // The fallback shows the same picture; left in, Readability would put it in the image's place and lose the full-size address.
    if (fallback) noscript!.parentNode?.removeChild(noscript!);
    // The size attributes described the thumbnail; the picture is shown at its own proportions.
    if (chosen !== own) { img.removeAttribute("width"); img.removeAttribute("height"); }
    promoted.push(img);
    changed++;
  }
  for (const img of promoted) protectGallery(document, img);

  // An image that exists only in a `<noscript>` (the page inserts it with a script) is an image of the page too.
  for (const noscript of [...document.querySelectorAll("noscript")].slice(0, MAX_IMAGES) as unknown as El[]) {
    const img = noscriptImage(noscript);
    if (!img || noscript.previousElementSibling?.nodeName?.toLowerCase() === "img" || noscript.nextElementSibling?.nodeName?.toLowerCase() === "img") continue;
    const src = webAddress(img.getAttribute("src"), pageUrl) ?? bestFromSrcset(img.getAttribute("srcset"), pageUrl);
    if (!src) continue;
    const copy = document.createElement("img");
    copy.setAttribute("src", src);
    for (const k of ["alt", "title", "width", "height"]) if (img.getAttribute(k)) copy.setAttribute(k, img.getAttribute(k)!);
    noscript.parentNode?.replaceChild(copy, noscript);
    changed++;
  }
  return changed;
}
