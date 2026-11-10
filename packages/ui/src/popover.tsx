import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.tsx";
import type { IconName } from "./icons.tsx";
import { focusableIn } from "./hooks.ts";
import { popKey } from "./popover-keys.ts";

/**
 * Anchored popover: positions itself against `anchor`, takes focus once it is shown (a menu's first item, or the
 * panel itself), and closes on outside press and Esc. Keys follow `popKey`: arrows move between controls and Tab
 * leaves a menu or walks through a panel; leaving gives focus back to the anchor. `onClose(true)` means "restore focus".
 */
export function Popover({ anchor, onClose, children, className = "", role = "dialog", label, up = false }: {
  anchor: HTMLElement | null;
  onClose: (restoreFocus: boolean) => void;
  children: ReactNode;
  className?: string;
  role?: "menu" | "dialog";
  label: string;
  up?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    let top = up ? r.top - h - 6 : r.bottom + 6;
    if (!up && top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    if (up && top < 8) top = r.bottom + 6;
    setPos({ left, top });
  }, [anchor, up]);

  // Focus moves in only once the popup is shown: while its position is measured it is hidden, and a hidden element can't take focus.
  const shown = pos !== null;
  useEffect(() => {
    const el = ref.current;
    if (!el || !shown) return;
    ((role === "menu" ? el.querySelector<HTMLElement>(".mi:not([disabled])") : null) ?? el).focus({ preventScroll: true });
  }, [shown, role]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const out = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!el.contains(t) && !anchor?.contains(t)) closeRef.current(false);
    };
    const key = (e: KeyboardEvent) => {
      const kind = el.getAttribute("role") === "menu" ? "menu" : "dialog";
      const controls = kind === "menu" ? [...el.querySelectorAll<HTMLElement>(".mi:not([disabled])")] : focusableIn(el);
      const active = document.activeElement as HTMLElement | null;
      const act = popKey({
        key: e.key, shift: e.shiftKey, role: kind, count: controls.length,
        at: active === el ? "popup" : active && el.contains(active) ? "control" : "outside",
        index: active ? controls.indexOf(active) : -1,
      });
      if (act.do === "none") return;
      if (act.do === "focus") { e.preventDefault(); controls[act.index]?.focus(); return; }
      if (act.do === "close") { e.preventDefault(); e.stopPropagation(); closeRef.current(true); return; }
      // Leaving: focus goes back to the anchor first, so the Tab that follows continues from there.
      closeRef.current(true);
    };
    document.addEventListener("pointerdown", out, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", out, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [anchor]);

  return createPortal(
    <div ref={ref} className={`pop ${className}`.trim()} role={role} aria-label={label} tabIndex={-1}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}>
      {children}
    </div>,
    document.body,
  );
}

export type MenuEntry =
  | { type?: "item"; label: string; onSelect: () => void; icon?: IconName; hint?: string; disabled?: boolean; danger?: boolean }
  | { type: "radio" | "check"; label: string; on: boolean; onSelect: () => void; disabled?: boolean }
  | { type: "heading"; label: string }
  | { type: "separator" };

/** The entries of a menu, without the popover around them (used inside a host that owns the popover). */
export function MenuItems({ entries, onClose }: { entries: MenuEntry[]; onClose: (restoreFocus: boolean) => void }) {
  return (
    <>
      {entries.map((e, i) => {
        if (e.type === "separator") return <hr key={i} className="mhr" />;
        if (e.type === "heading") return <div key={i} className="menu-h">{e.label}</div>;
        const kind = e.type === "radio" ? "menuitemradio" : e.type === "check" ? "menuitemcheckbox" : "menuitem";
        const toggled = e.type === "radio" || e.type === "check";
        return (
          <button key={i} type="button" className={"danger" in e && e.danger ? "mi danger" : "mi"} data-cuelume-select="" role={kind} aria-checked={toggled ? e.on : undefined} disabled={e.disabled}
            onClick={() => { onClose(true); e.onSelect(); }}>
            {toggled ? <span className="ck">{e.on ? <Icon name="check" size="sm" /> : null}</span> : "icon" in e && e.icon ? <Icon name={e.icon} /> : null}
            <span className="nm">{e.label}</span>
            {"hint" in e && e.hint ? <span className="n">{e.hint}</span> : null}
          </button>
        );
      })}
    </>
  );
}
