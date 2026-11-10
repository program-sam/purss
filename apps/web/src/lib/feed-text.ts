/**
 * A video's own description, as feeds send it: the first lines are often only links ("Get the kit: https://…",
 * "https://shop…"), a sponsor's pitch or a download mark, and what the video is about comes after. Reading these
 * is display only: what the feed sent stays stored as it came, so existing items read the same as new ones.
 */

const URL_IN_TEXT = /(?:https?:\/\/|www\.)\S+/i;
const LINK_LINE_WORDS = 8;
const SPONSOR_LEAD: RegExp[] = [
  /^\W*(?:this |today'?s )?(?:video|episode|stream|show)?\s*(?:is |was )?(?:sponsored|brought to you|made possible|presented) (?:by|with)\b/i,
  /^\W*(?:thanks|thank you) (?:so much )?to [^.!?]{1,60} for (?:sponsoring|supporting)\b/i,
  /^\W*(?:use|enter|get) (?:my |the )?(?:promo |discount |coupon )?code\b/i,
  /^\W*get \d{1,3}% off\b/i,
];

/** Text that only points somewhere or advertises: nothing of what the video is about. */
export function isBoilerplateLine(text: string, hasLink = false): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (SPONSOR_LEAD.some((re) => re.test(t))) return true;
  // Only addresses (and the arrows, bullets and emoji around them).
  if (!/[\p{L}\p{N}]/u.test(t.replace(/(?:https?:\/\/|www\.)\S+/gi, ""))) return true;
  // A short line that ends in or carries a link: "Get Pixicade here: https://…", "BECOME A MEMBER ► https://…".
  const words = t.split(" ").length;
  return (hasLink || URL_IN_TEXT.test(t)) && words <= LINK_LINE_WORDS;
}

/** The download mark FreshRSS puts before a feed's media file. */
const DOWNLOAD_MARK = /^\s*\u{1F4BE}\s*/u;
const EMOJI_START = /(?=\p{Extended_Pictographic})/u;

/** A feed's description as one line of text (an excerpt): the download mark and leading link or sponsor lines left out. */
export function cleanVideoExcerpt(excerpt: string | null): string | null {
  if (!excerpt) return excerpt;
  const text = excerpt.replace(DOWNLOAD_MARK, "");
  // The line breaks are gone from an excerpt: a new line starts at an emoji bullet and after each address.
  const lines: string[] = [];
  for (const part of text.split(EMOJI_START)) {
    let rest = part;
    for (let m = URL_IN_TEXT.exec(rest); m; m = URL_IN_TEXT.exec(rest)) {
      const end = m.index + m[0].length;
      lines.push(rest.slice(0, end));
      rest = rest.slice(end);
    }
    if (rest.trim()) lines.push(rest);
  }
  let n = 0;
  while (n < lines.length && isBoilerplateLine(lines[n]!)) n++;
  const kept = lines.slice(n).join("").trim();
  // A description that was only the download mark (or only boilerplate) leaves no excerpt.
  return kept || text.trim() || null;
}

type Line = { nodes: ChildNode[]; text: string; hasLink: boolean };

/** The first element that holds text of its own (not only other blocks): where a description's lines start. */
function firstTextHost(root: Element): Element | null {
  const walker = root.ownerDocument.createTreeWalker(root, 1 /* SHOW_ELEMENT */);
  for (let el: Node | null = root; el; el = walker.nextNode()) {
    const host = el as Element;
    if ([...host.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? "").trim())) return host;
  }
  return null;
}

/** A host's content as lines: the pieces between its line breaks, each with the break that ends it. */
function linesOf(host: Element): Line[] {
  const lines: Line[] = [];
  let cur: Line = { nodes: [], text: "", hasLink: false };
  for (const node of [...host.childNodes]) {
    cur.nodes.push(node);
    if (node.nodeType === 1 && (node as Element).tagName === "BR") { lines.push(cur); cur = { nodes: [], text: "", hasLink: false }; continue; }
    cur.text += node.textContent ?? "";
    if (node.nodeType === 1 && ((node as Element).tagName === "A" || (node as Element).querySelector("a"))) cur.hasLink = true;
  }
  if (cur.nodes.length) lines.push(cur);
  return lines;
}

/**
 * Leave out the leading lines of a video's description that are only links or a sponsor's pitch. A paragraph that is
 * nothing else goes whole; the description is left alone when nothing but such lines is there.
 */
export function skipLeadingBoilerplate(root: Element): void {
  for (let pass = 0; pass < 8; pass++) {
    const host = firstTextHost(root);
    if (!host) return;
    const lines = linesOf(host);
    let n = 0;
    while (n < lines.length && isBoilerplateLine(lines[n]!.text, lines[n]!.hasLink)) n++;
    if (n === 0) return;
    if (n < lines.length) { for (const line of lines.slice(0, n)) for (const node of line.nodes) node.remove(); return; }
    // The whole paragraph: gone if anything else is left to read, otherwise kept as it is.
    if ((root.textContent ?? "").trim().length <= (host.textContent ?? "").trim().length) return;
    host.remove();
  }
}
