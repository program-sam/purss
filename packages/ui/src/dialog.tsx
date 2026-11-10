import type { ReactNode, RefObject } from "react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.tsx";
import { IconButton } from "./button.tsx";
import { trapTab, useInertRoot, useRestoreFocus } from "./hooks.ts";

const stack: symbol[] = [];

/** Esc closes only the top-most layer; Tab stays inside it. */
function useLayer(boxRef: RefObject<HTMLElement | null>, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const id = Symbol("layer");
    stack.push(id);
    const key = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeRef.current(); }
      else if (boxRef.current) trapTab(e, boxRef.current);
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [boxRef]);
}

export type DialogProps = {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Element to focus when the dialog opens ("dialog" focuses the dialog itself); defaults to the first control. */
  initialFocus?: string;
};

/** Centred popup (bottom sheet on phones): focus trapped, Esc closes, focus returns to the opener. */
export function Dialog({ title, onClose, children, footer, size, initialFocus }: DialogProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useInertRoot();
  useRestoreFocus();
  useLayer(boxRef, onClose);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const target = initialFocus === "dialog" ? box : (initialFocus ? box.querySelector<HTMLElement>(initialFocus) : null)
      ?? box.querySelector<HTMLElement>(".dlg-b input:not([type=hidden]):not([disabled]),.dlg-b select,.dlg-b textarea")
      ?? box.querySelector<HTMLElement>(".dlg-f .btn.primary:not([disabled]),.dlg-f .btn:not([disabled])")
      ?? box.querySelector<HTMLElement>("button");
    target?.focus();
  }, [initialFocus]);
  // The body fades at its foot only while more of it lies below.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const b = bodyRef.current;
    if (!b) return;
    const mark = () => b.classList.toggle("more", b.scrollTop + b.clientHeight < b.scrollHeight - 2);
    mark();
    b.addEventListener("scroll", mark, { passive: true });
    const ro = new ResizeObserver(mark);
    ro.observe(b);
    for (const c of b.children) ro.observe(c);
    return () => { b.removeEventListener("scroll", mark); ro.disconnect(); };
  });
  return createPortal(
    <div className="dlg-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={boxRef} className={`dlg${size ? ` ${size}` : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="dlg-h">
          <h2 id={titleId}>{title}</h2>
          <IconButton label="Close" data-cuelume-tap="close" onClick={onClose}><Icon name="x" /></IconButton>
        </div>
        <div ref={bodyRef} className="dlg-b">{children}</div>
        {footer ? <div className="dlg-f">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/** Top-aligned layer used by the search palette. */
export function PaletteLayer({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null);
  useInertRoot();
  useRestoreFocus();
  useLayer(boxRef, onClose);
  return createPortal(
    <div className="pal-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={boxRef} className="pal" role="dialog" aria-modal="true" aria-label={label}>{children}</div>
    </div>,
    document.body,
  );
}
