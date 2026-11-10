import { useEffect, useRef } from "react";
import type { RefObject } from "react";

/*
 * Reading progress for the article in the reader. It follows how far the person has scrolled, and counts only a person's own
 * scrolling: movement the page makes itself (going back to the top for another item, picking up where they stopped, the layout
 * shifting as pictures load) is not reading. An item that fits the screen cannot be scrolled, so it counts as read after it has
 * been on screen for a while. Reopening an item goes back to where the person stopped.
 */

/** An item whose text is taller than the screen by less than this, or by less than a quarter of the screen, fits it: what is left to scroll to is a line or two. */
export const FIT_SLACK_PX = 40;
const FIT_SHARE = 0.25;
/** How long an item that fits the screen must be on screen before it counts as read. */
export const FITS_DWELL_MS = 20_000;
/** A scroll counts as the person's when they pressed in the reader, touched it, turned the wheel, paged or typed a scrolling key within this long before it (touch scrolling coasts for a while). */
export const INTENT_MS = 2500;
/** Progress below this is not worth saving. */
const MIN_SAVE = 0.02;
/** Reopening an item this far read starts at its top: it was read to the end. */
export const RESUME_BELOW = 0.95;
/** How long after opening the saved place is held as the text settles (pictures load and change its height). */
const RESTORE_MS = 3000;

/** Whether the text fits the screen, or nearly: a short abstract is read by looking at it, not by scrolling. */
export function fitsScreen(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - clientHeight < Math.max(FIT_SLACK_PX, clientHeight * FIT_SHARE);
}

/** How far the reader is scrolled, 0 at the top and 1 at the end; null when the text fits the screen. */
export function scrollFraction(scrollTop: number, scrollHeight: number, clientHeight: number): number | null {
  return fitsScreen(scrollHeight, clientHeight) ? null : Math.min(1, Math.max(0, scrollTop / (scrollHeight - clientHeight)));
}

/** Keys that scroll the page. Tab moves focus, and the browser scrolls to the focused control: that is not reading. */
const SCROLL_KEYS: ReadonlySet<string> = new Set([" ", "PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp"]);
export const isScrollKey = (key: string): boolean => SCROLL_KEYS.has(key);

/**
 * Whether a key scrolls the reader. It does when focus is in the reader. It also does when focus is on the page itself (nothing
 * focused: where it lands after a click in the text) and the last press was in the reader, so the reader is what the page scrolls.
 * Typing somewhere, or a key with focus on another control, is not reading.
 */
export function keyScrollsReader(k: { key: string; inReader: boolean; onPage: boolean; editable: boolean; pressedInReader: boolean }): boolean {
  return isScrollKey(k.key) && !k.editable && (k.inReader || (k.onPage && k.pressedInReader));
}

/** What the app's own paging controls (the e-ink Page up and Page down buttons) send to the area they scroll before they scroll it. */
const PAGING_EVENT = "purss:paging";
/** Say that the person is paging `area` themselves, however they pressed the button (touch, mouse, keyboard or a screen reader's click). */
export function markPaging(area: HTMLElement): void {
  area.dispatchEvent(new Event(PAGING_EVENT));
}

/** Whether a node is somewhere text is typed: a key pressed there is not scrolling. */
function isEditable(node: Node | null): boolean {
  const el = node instanceof Element ? node : node?.parentElement ?? null;
  return !!el?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])");
}

/** The scroll position that puts a saved fraction back, or null when there is nothing to go back to. */
export function resumeTop(saved: number, scrollHeight: number, clientHeight: number): number | null {
  if (!(saved >= MIN_SAVE) || saved >= RESUME_BELOW || fitsScreen(scrollHeight, clientHeight)) return null;
  return Math.round(saved * (scrollHeight - clientHeight));
}

/** Time spent on screen, counted only while the page is visible; says when the wait is over. */
export class Dwell {
  readonly #need: number;
  #seen = 0;
  #since: number | null = null;

  constructor(need: number) {
    this.#need = need;
  }

  /** The page became visible (or was visible when counting began). */
  show(now: number): void {
    if (this.#since === null) this.#since = now;
  }

  /** The page was hidden. */
  hide(now: number): void {
    if (this.#since !== null) { this.#seen += now - this.#since; this.#since = null; }
  }

  /** How much longer to wait, in milliseconds, if the page stays visible; null while it is hidden. */
  remaining(now: number): number | null {
    if (this.#since === null) return null;
    return Math.max(0, this.#need - this.#seen - (now - this.#since));
  }
}

type Options = {
  itemId: string;
  /** Text is in the reader and its progress can be measured (not a video or a podcast, which have their own place). */
  ready: boolean;
  /** Changes when the text shown changes, so the measuring starts again. */
  contentKey: string | null;
  /** How far the item had been read when it was opened. */
  saved: number;
  save: (itemId: string, progress: number) => void;
};

/** Follow the reader `el` for the open item: save how far it is scrolled, count items that fit, and go back to where it was left. */
export function useReadingProgress(el: RefObject<HTMLElement | null>, { itemId, ready, contentKey, saved, save }: Options): void {
  // What the item had when it was opened (later saves must not move where reopening goes), and whether it has been put back there yet.
  const openedWith = useRef({ itemId: "", saved: 0, resumed: false });
  if (openedWith.current.itemId !== itemId) openedWith.current = { itemId, saved, resumed: false };
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    const box = el.current;
    if (!box || !ready) return;
    let furthest = 0;
    let lastIntent = -Infinity;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let dwellTimer: ReturnType<typeof setTimeout> | null = null;
    // Put back where the item was left, once per opening, until the person scrolls themselves or the text has settled.
    let restoring = !openedWith.current.resumed && resumeTop(openedWith.current.saved, 1e9, 0) !== null;
    openedWith.current.resumed = true;
    const restoreUntil = performance.now() + RESTORE_MS;
    let ownScrollUntil = 0;
    const dwell = new Dwell(FITS_DWELL_MS);

    const flush = () => { if (furthest >= MIN_SAVE) saveRef.current(itemId, furthest); };
    const intent = () => { lastIntent = performance.now(); restoring = false; };
    // Keys count when they scroll the reader (see keyScrollsReader) and not while typing. Caret browsing and many screen readers
    // read by moving a selection through the text: that counts too. A page's own script moving focus or layout does not.
    let pressedInReader = false;
    const pressedIn = () => { pressedInReader = true; intent(); };
    const pressedElsewhere = (e: Event) => { if (!(e.target instanceof Node) || !box.contains(e.target)) pressedInReader = false; };
    const keyIntent = (e: KeyboardEvent) => {
      const t = e.target;
      if (keyScrollsReader({ key: e.key, inReader: t instanceof Node && box.contains(t), onPage: t === document.body || t === document.documentElement, editable: isEditable(t as Node | null), pressedInReader })) intent();
    };
    // A moving selection counts for progress only: it must not cancel going back to the saved place, which re-rendered highlights and
    // the browser's own find-in-page would otherwise do. And only while this page has focus.
    const selectionIntent = () => {
      const at = document.getSelection()?.anchorNode ?? null;
      if (at && document.hasFocus() && box.contains(at) && !isEditable(at)) lastIntent = performance.now();
    };
    const onScroll = () => {
      if (performance.now() < ownScrollUntil || performance.now() - lastIntent > INTENT_MS) return;
      const f = scrollFraction(box.scrollTop, box.scrollHeight, box.clientHeight);
      if (f === null) return;
      furthest = Math.max(furthest, f);
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, 1500);
    };

    // Going back to where the item was left, again as the text settles (pictures change its height) until the person scrolls themselves.
    const settle = () => {
      if (!restoring || performance.now() > restoreUntil) return;
      const top = resumeTop(openedWith.current.saved, box.scrollHeight, box.clientHeight);
      if (top === null || Math.abs(box.scrollTop - top) < 1) return;
      ownScrollUntil = performance.now() + 200; // the scroll event this causes is the page's, not the person's
      box.scrollTo({ top });
    };
    // An item that fits the screen is read once it has been on screen long enough; if it stops fitting, the wait is off.
    const watchFits = () => {
      if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
      if (scrollFraction(0, box.scrollHeight, box.clientHeight) !== null) { dwell.hide(performance.now()); return; }
      dwell.show(performance.now());
      const left = dwell.remaining(performance.now());
      if (left === null) return;
      dwellTimer = setTimeout(() => {
        if (document.visibilityState !== "visible" || scrollFraction(0, box.scrollHeight, box.clientHeight) !== null) return;
        saveRef.current(itemId, 1);
      }, left);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") watchFits();
      else { dwell.hide(performance.now()); if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; } }
    };

    settle();
    if (document.visibilityState === "visible") watchFits();
    const resize = new ResizeObserver(() => { settle(); if (document.visibilityState === "visible") watchFits(); });
    resize.observe(box);
    for (const child of Array.from(box.children)) resize.observe(child);

    box.addEventListener("scroll", onScroll, { passive: true });
    box.addEventListener("wheel", intent, { passive: true });
    box.addEventListener("touchstart", intent, { passive: true });
    box.addEventListener("touchmove", intent, { passive: true });
    box.addEventListener("pointerdown", pressedIn, { passive: true });
    document.addEventListener("pointerdown", pressedElsewhere, true);
    box.addEventListener(PAGING_EVENT, intent);
    document.addEventListener("keydown", keyIntent, true);
    document.addEventListener("selectionchange", selectionIntent);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      box.removeEventListener("scroll", onScroll);
      box.removeEventListener("wheel", intent);
      box.removeEventListener("touchstart", intent);
      box.removeEventListener("touchmove", intent);
      box.removeEventListener("pointerdown", pressedIn);
      document.removeEventListener("pointerdown", pressedElsewhere, true);
      box.removeEventListener(PAGING_EVENT, intent);
      document.removeEventListener("keydown", keyIntent, true);
      document.removeEventListener("selectionchange", selectionIntent);
      document.removeEventListener("visibilitychange", onVisibility);
      resize.disconnect();
      if (saveTimer) clearTimeout(saveTimer);
      if (dwellTimer) clearTimeout(dwellTimer);
      flush();
    };
  }, [el, itemId, ready, contentKey]);
}
