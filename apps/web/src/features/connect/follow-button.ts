const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** A self-contained button to paste into any page: one link, inline style, no script or image. */
export function followButtonHtml(link: string): string {
  return `<a href="${escapeAttr(link)}" style="display:inline-block;padding:6px 14px;border-radius:999px;background:hsl(212 82% 40%);color:#fff;font:600 14px/1.4 system-ui,sans-serif;text-decoration:none">Follow in PURSS</a>`;
}
