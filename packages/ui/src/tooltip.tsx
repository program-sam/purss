import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Global tooltip layer for icon-only controls. Any element with `data-tip` shows its text to the
 * right on mouse hover or keyboard focus, or above it with `data-tip-at="above"` (controls near the right edge).
 * Touch never shows a tip: a tap acts at once and the undo toast already names the action.
 * The text duplicates an accessible name, so it is aria-hidden.
 */
export function TipLayer() {
  const [tip, setTip] = useState<{ text: string; left: number; top: number; above: boolean } | null>(null);
  useEffect(() => {
    const show = (e: Event) => {
      if (e instanceof PointerEvent ? e.pointerType === "touch" : !(e.target as Element | null)?.matches?.(":focus-visible")) return;
      const el = (e.target as Element | null)?.closest?.("[data-tip]") as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const above = el.dataset.tipAt === "above";
      setTip(above ? { text: el.dataset.tip ?? "", left: r.left + r.width / 2, top: r.top - 6, above } : { text: el.dataset.tip ?? "", left: r.right + 8, top: r.top + r.height / 2, above });
    };
    const hide = () => setTip(null);
    document.addEventListener("pointerover", show);
    document.addEventListener("focusin", show);
    document.addEventListener("pointerout", hide);
    document.addEventListener("focusout", hide);
    document.addEventListener("pointerdown", hide, true);
    return () => {
      document.removeEventListener("pointerover", show);
      document.removeEventListener("focusin", show);
      document.removeEventListener("pointerout", hide);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("pointerdown", hide, true);
    };
  }, []);
  // A tip centred above a control near the window's edge moves inwards so none of it is cut off.
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tip?.above) return;
    el.style.marginLeft = "0px";
    const r = el.getBoundingClientRect();
    const shift = r.right > window.innerWidth - 8 ? window.innerWidth - 8 - r.right : r.left < 8 ? 8 - r.left : 0;
    el.style.marginLeft = `${shift}px`;
  }, [tip]);
  if (!tip) return null;
  return <div ref={ref} className="tip" aria-hidden="true" style={{ left: tip.left, top: tip.top, transform: tip.above ? "translate(-50%, -100%)" : "translateY(-50%)" }}>{tip.text}</div>;
}
