/** What `focusLost` reads from the page, so it can be checked without one. */
type FocusDoc = { activeElement: unknown; body: unknown; documentElement: unknown };

/**
 * True when nothing useful has focus: the page body, or a control that was removed or disabled (a button that is
 * disabled while its work runs, a list that was replaced). The next Tab or screen-reader step then starts from the top of the page.
 */
export function focusLost(doc: FocusDoc = document): boolean {
  const a = doc.activeElement as { isConnected?: boolean; disabled?: boolean } | null;
  return !a || a === doc.body || a === doc.documentElement || a.isConnected === false || a.disabled === true;
}

/** What `typing` reads of the focused element, so it can be checked without a page. */
type FocusedLike = { tagName?: string; isContentEditable?: boolean; type?: string; disabled?: boolean } | null;

/** True when the person is in a text field (or a choice in a form) they can still change: a message must not take focus from it. */
export function typing(doc: { activeElement: unknown } = document): boolean {
  const a = doc.activeElement as FocusedLike;
  if (!a || a.disabled) return false;
  if (a.isContentEditable) return true;
  const tag = (a.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  return tag === "INPUT" && !["button", "submit", "reset", "checkbox", "radio", "file", "image"].includes((a.type ?? "text").toLowerCase());
}

/** Give focus to the first element in `root` that one of the selectors finds (tried in order); the one it went to, or null. */
export function focusFirst(root: ParentNode | null | undefined, selectors: readonly string[]): HTMLElement | null {
  if (!root) return null;
  for (const s of selectors) {
    const el = root.querySelector<HTMLElement>(s);
    if (!el) continue;
    el.focus({ preventScroll: false });
    if (document.activeElement === el) return el;
  }
  return null;
}

/** Make an element that is not a control (a heading, a message) able to take focus without joining the Tab order. */
export function focusable(el: HTMLElement): HTMLElement {
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  return el;
}

/**
 * The row that takes focus when the rows marked in `leaving` go: the nearest one after `from` that stays, else the
 * nearest before it. Null when none stays (the list empties).
 */
export function survivorIndex(leaving: readonly boolean[], from: number): number | null {
  for (let i = Math.max(0, from + 1); i < leaving.length; i++) if (!leaving[i]) return i;
  for (let i = Math.min(from, leaving.length) - 1; i >= 0; i--) if (!leaving[i]) return i;
  return null;
}
