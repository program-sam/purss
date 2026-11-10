/**
 * The preview shows the real public page, but nothing in it should be followable from inside the frame
 * (the app forbids framing other sites, so a click would only show a browser error). Anchors keep their
 * look and text; their address moves to `data-href`, so they can't be clicked or reached by keyboard.
 */
export function neutraliseLinks(html: string): string {
  return html.replace(/<a\b([^>]*?)\shref=/gi, "<a$1 data-href=");
}
