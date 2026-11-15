/**
 * Android's back button goes up one level, the way Esc does with a keyboard: the top popup or menu closes first, then
 * selecting ends, the open item closes, and the sidebar folds away. With nothing left to close it goes to the previous
 * page, and on the first page the app goes to the background, as Android apps do.
 */
export type BackSteps = {
  /** Press Esc where focus is; true when something closed. */
  escape: () => boolean;
  canGoBack: boolean;
  previousPage: () => void;
  leave: () => void;
};

export function goUpOneLevel(steps: BackSteps): "closed" | "page" | "left" {
  if (steps.escape()) return "closed";
  if (steps.canGoBack) { steps.previousPage(); return "page"; }
  steps.leave();
  return "left";
}

/** Esc pressed on the focused element; every layer that closes on Esc marks the key as handled. */
export function pressEscape(): boolean {
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  const key = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(key);
  return key.defaultPrevented;
}
