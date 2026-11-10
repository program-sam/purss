import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { Icon } from "@purss/ui";
import { markPaging } from "../lib/reading-progress.ts";

/** Keep a line of the previous screen in view, so reading carries on from where it stopped. */
const OVERLAP = 40;

/**
 * Page up and Page down for an e-ink display: each press moves the area one screen at once, with
 * no smooth scroll for the panel to redraw. Shown only in the e-ink display mode.
 */
export function PageNav({ target, what }: { target: RefObject<HTMLElement | null>; what: string }) {
  const [edge, setEdge] = useState({ top: true, bottom: true });
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const update = () => setEdge({ top: el.scrollTop <= 1, bottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 1 });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // Content grows when more items load or the article arrives.
    const mo = new MutationObserver(update);
    mo.observe(el, { childList: true, subtree: true });
    return () => { el.removeEventListener("scroll", update); ro.disconnect(); mo.disconnect(); };
  }, [target]);
  const page = (dir: 1 | -1) => {
    const el = target.current;
    if (!el) return;
    markPaging(el); // paging is the person's own scrolling, whatever pressed the button: the reader counts it as reading
    el.scrollBy({ top: dir * Math.max(el.clientHeight - OVERLAP, OVERLAP), behavior: "instant" });
  };
  return (
    <div className="pagenav" role="group" aria-label={`Page through the ${what}`}>
      <button type="button" className="btn" disabled={edge.top} onClick={() => page(-1)}><Icon name="up" />Page up</button>
      <button type="button" className="btn" disabled={edge.bottom} onClick={() => page(1)}><Icon name="down" />Page down</button>
    </div>
  );
}
