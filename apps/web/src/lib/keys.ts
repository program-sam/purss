/**
 * Keyboard shortcuts for the item lists. Pure so the rules are testable: letters act on the
 * focused item, nothing fires while typing or with a modifier, and plain arrow keys are never
 * bound (they belong to scrolling, menus and screen readers).
 */

export type KeyAction =
  | "next" | "prev" | "open" | "toread" | "finished" | "ignore" | "select" | "search" | "help" | "palette" | "player";

export type KeyInput = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey?: boolean };
export type KeyContext = { typing: boolean; layerOpen: boolean };

export function actionForKey(e: KeyInput, ctx: KeyContext): KeyAction | null {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") return ctx.layerOpen ? null : "palette";
  if (ctx.typing || ctx.layerOpen || e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key) {
    case "j": return "next";
    case "k": return "prev";
    case "o": case "Enter": return "open";
    case "r": return "toread";
    case "e": return "finished";
    case "i": return "ignore";
    case "x": return "select";
    case "p": return "player";
    case "/": return "search";
    case "?": return "help";
    default: return null;
  }
}

/**
 * Ctrl+Z (Cmd+Z on a Mac) presses Undo on the message that is showing, but never while typing, where it is the
 * browser's own undo for the text, and never with Shift (redo) or Alt.
 */
export function isUndoKey(e: KeyInput, typing: boolean): boolean {
  return !typing && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "z";
}

export function isTypingTarget(el: EventTarget | null): boolean {
  const t = el as { tagName?: string; isContentEditable?: boolean } | null;
  return !!t && (t.isContentEditable === true || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
}

/** Index to focus after j/k from `current` (-1 = none yet) among `count` rows. */
export function stepIndex(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return 0;
  return Math.min(count - 1, Math.max(0, current + dir));
}
