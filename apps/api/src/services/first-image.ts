/**
 * The picture an item's own content leads with, for a card whose feed gave no image. Takes sanitised HTML and
 * returns an https address (the page only shows https pictures) or null. Small pictures, emoji, avatars and
 * tracking pixels are not the item's picture.
 */
export function firstImage(html: string | null | undefined): string | null {
  if (!html) return null;
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const raw = /\bsrc="([^"]+)"/i.exec(tag)?.[1];
    if (!raw) continue;
    const src = raw.replace(/&amp;/g, "&");
    if (src.length > 2000 || !/^https:\/\//i.test(src)) continue;
    const w = Number(/\bwidth="(\d+)"/i.exec(tag)?.[1] ?? 0);
    const h = Number(/\bheight="(\d+)"/i.exec(tag)?.[1] ?? 0);
    if ((w && w < 100) || (h && h < 100)) continue;
    if (/\/(emoji|smilies|gravatar|avatar)s?\/|s\.w\.org|(?:pixel|spacer|blank|beacon|tracking)\b|[?&/_-]1x1\b/i.test(src)) continue;
    try { return new URL(src).href; } catch { continue; }
  }
  return null;
}
