import { useEffect } from "react";
import { trapTab } from "@purss/ui";
import { focusFirst, focusLost } from "../lib/focus.ts";

/** The app's frame without the drawer and its scrim: the page, the phone's tab bar, the reader and the player. */
const BEHIND = ".app > :not(#side):not(.navscrim)";

/**
 * The sidebar as a drawer (phones and tablets). While it is open, focus is inside it, Tab stays in it and the page behind
 * can't be reached by keyboard or screen reader; closing it hands focus back to the control that opened it.
 */
export function useDrawerFocus(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const side = document.getElementById("side");
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const behind = [...document.querySelectorAll<HTMLElement>(BEHIND)];
    for (const el of behind) el.inert = true;
    // The drawer is hidden until it has been drawn open; focus goes in a frame later.
    const frame = requestAnimationFrame(() => { focusFirst(side, ["[data-fk='add']", "button, a[href]"]); });
    const onKey = (e: KeyboardEvent) => {
      // A dialog or menu over the drawer keeps its own focus.
      if (!side || document.documentElement.dataset.modal) return;
      if (e.target === document.body || (e.target instanceof Node && side.contains(e.target))) trapTab(e, side);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      for (const el of behind) el.inert = false;
      if (!focusLost() && !(side && side.contains(document.activeElement))) return;
      const back = opener && opener !== document.body && opener.isConnected && opener.getClientRects().length ? opener : document.getElementById("main");
      back?.focus({ preventScroll: true });
    };
  }, [open]);
}
