import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { MenuItems, Popover } from "@purss/ui";
import type { MenuEntry } from "@purss/ui";

type Popup = {
  anchor: HTMLElement;
  label: string;
  role: "menu" | "dialog";
  up?: boolean;
  className?: string;
  render: (close: (restoreFocus?: boolean) => void) => ReactNode;
};

type Ctx = {
  /** Open (or, if the same anchor is pressed again, close) an action menu. */
  menu: (anchor: HTMLElement, entries: MenuEntry[], label: string, opts?: { up?: boolean }) => void;
  /** Open a small anchored panel with custom content: a dialog, or a menu of custom items (`role: "menu"`). */
  panel: (anchor: HTMLElement, label: string, render: Popup["render"], opts?: { up?: boolean; className?: string; role?: Popup["role"] }) => void;
  close: (restoreFocus?: boolean) => void;
  anchor: HTMLElement | null;
};

const PopupCtx = createContext<Ctx | null>(null);

/** One anchored popup at a time. The anchor gets aria-expanded while it is open. */
export function PopupProvider({ children }: { children: ReactNode }) {
  const [popup, setPopup] = useState<(Popup & { serial: number }) | null>(null);
  const current = useRef<Popup | null>(null);
  const serial = useRef(0);
  const show = useCallback((p: Popup | null) => { current.current = p; setPopup(p ? { ...p, serial: ++serial.current } : null); }, []);

  const close = useCallback((restoreFocus = false) => {
    const p = current.current;
    show(null);
    if (p && restoreFocus && p.anchor.isConnected) p.anchor.focus();
  }, [show]);

  /** Pressing the anchor of the open popup closes it; any other anchor replaces it. */
  const openWith = useCallback((next: Popup) => show(current.current && current.current.anchor === next.anchor ? null : next), [show]);

  const menu = useCallback<Ctx["menu"]>((anchor, entries, label, opts) => {
    openWith({ anchor, label, role: "menu", up: opts?.up, render: (c) => <MenuItems entries={entries} onClose={c} /> });
  }, [openWith]);

  const panel = useCallback<Ctx["panel"]>((anchor, label, render, opts) => {
    openWith({ anchor, label, role: opts?.role ?? "dialog", up: opts?.up, className: opts?.className, render });
  }, [openWith]);

  useEffect(() => {
    if (!popup) return;
    const a = popup.anchor;
    a.setAttribute("aria-expanded", "true");
    return () => a.setAttribute("aria-expanded", "false");
  }, [popup]);

  const value = useMemo(() => ({ menu, panel, close, anchor: popup?.anchor ?? null }), [menu, panel, close, popup]);

  return (
    <PopupCtx.Provider value={value}>
      {children}
      {popup ? (
        <Popover key={popup.serial} anchor={popup.anchor} onClose={close} role={popup.role} label={popup.label} up={popup.up} className={popup.className}>
          {popup.render(close)}
        </Popover>
      ) : null}
    </PopupCtx.Provider>
  );
}

export function usePopups(): Ctx {
  const v = useContext(PopupCtx);
  if (!v) throw new Error("PopupProvider is missing");
  return v;
}
