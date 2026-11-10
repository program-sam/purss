import { useEffect, useRef, useSyncExternalStore } from "react";

export type Breakpoint = "xl" | "lg" | "md" | "sm" | "xs";

/** xl >= 1680, lg 1280-1679, md 1024-1279, sm 768-1023, xs < 768. */
export function breakpointFor(width: number): Breakpoint {
  return width >= 1680 ? "xl" : width >= 1280 ? "lg" : width >= 1024 ? "md" : width >= 768 ? "sm" : "xs";
}

function subscribeResize(cb: () => void): () => void {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}

/** Current breakpoint from the viewport width; changes only when a boundary is crossed. */
export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribeResize, () => breakpointFor(window.innerWidth), () => "lg");
}

const FOCUSABLE = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/** Keeps Tab and Shift+Tab inside `root` while `active`. */
export function trapTab(e: KeyboardEvent, root: HTMLElement): void {
  if (e.key !== "Tab") return;
  const f = focusableIn(root);
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0]!, last = f[f.length - 1]!;
  if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
}

/** The last control focused outside any dialog or menu: where focus goes back to when a layer opened by a shortcut closes. */
let lastBase: HTMLElement | null = null;
if (typeof document !== "undefined") {
  document.addEventListener("focusin", (e) => {
    const t = e.target as HTMLElement | null;
    if (t && typeof t.closest === "function" && !t.closest('[role="dialog"],[role="menu"],[role="listbox"],.dlg-scrim,.pal-scrim,.pop')) lastBase = t;
  }, true);
}

/**
 * Where focus was when a layer opened: the focused control, or when nothing has focus (the layer was opened by a
 * keyboard shortcut from the page itself), the last control that did, or the page's main area.
 */
function focusOrigin(): HTMLElement | null {
  const a = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
  if (a && a !== document.body && a !== document.documentElement) return a;
  if (lastBase?.isConnected) return lastBase;
  return typeof document === "undefined" ? null : document.getElementById("main");
}

/** Remember what had focus and give it back on unmount (re-resolving a `data-fk` key if the node was replaced). */
export function useRestoreFocus(): void {
  const opener = useRef<HTMLElement | null>(focusOrigin());
  useEffect(() => {
    const el = opener.current;
    return () => {
      const key = el?.dataset?.fk;
      const target = (key && document.querySelector<HTMLElement>(`[data-fk="${CSS.escape(key)}"]`)) || (el && el.isConnected ? el : null) || document.getElementById("main");
      if (target && typeof target.focus === "function") target.focus({ preventScroll: true });
    };
  }, []);
}

/** Make the app root inert while a modal is open. */
let modalCount = 0;
export function useInertRoot(active = true): void {
  useEffect(() => {
    if (!active) return;
    const root = document.getElementById("root");
    modalCount++;
    if (root) root.inert = true;
    document.documentElement.dataset.modal = "open";
    return () => {
      modalCount--;
      if (modalCount === 0) {
        if (root) root.inert = false;
        delete document.documentElement.dataset.modal;
      }
    };
  }, [active]);
}
