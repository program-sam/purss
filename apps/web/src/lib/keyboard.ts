/**
 * Whether a keyboard is likely to be in use, so hints that name keys ("Press Control Z to undo") are given only to people who
 * can follow them: the main pointer is a precise one (a mouse or trackpad), as on a laptop or desktop, not a finger on a touch
 * screen. `matches` is the browser's media query check.
 */
export function keyboardLikely(matches: (query: string) => boolean = (q) => typeof matchMedia === "function" && matchMedia(q).matches): boolean {
  return matches("(pointer: fine)");
}
