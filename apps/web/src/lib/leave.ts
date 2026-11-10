import type { ItemDTO, WorkflowState } from "@purss/domain";

/** What can take an item out of the list it is shown in: a new state, Restore, or removing it from the basket shown. */
export type LeaveCause = WorkflowState | "restore" | "unkeep";

/**
 * The causes that take this item out of its list, as a row's `data-leaves` attribute. `keeps` is the list's own
 * rule. PURSS clears the New marker when an item's state changes, so a list of new items loses it then.
 */
export function leavesOn(item: ItemDTO, keeps: (item: ItemDTO) => boolean, inBasket: boolean): string {
  const out: LeaveCause[] = [];
  for (const w of ["new", "toread", "inprogress", "finished", "ignored"] as const) {
    if (w === item.workflow) continue;
    if (!keeps({ ...item, workflow: w, fresh: false })) out.push(w);
  }
  if (item.workflow === "ignored" && !keeps({ ...item, workflow: "new" })) out.push("restore");
  if (inBasket) out.push("unkeep");
  return out.join(" ");
}

const SLIDE_MS = 80;
const CLOSE_MS = 70;

const reduced = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Where focus goes when a focused row leaves: the same control on the next row (or the one before), else that row. */
function focusAfter(el: HTMLElement): (() => void) | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !el.contains(active)) return null;
  const rows = [...document.querySelectorAll<HTMLElement>("main [data-item]")].filter((r) => !r.dataset.leaving);
  const i = rows.indexOf(el);
  const next = rows.slice(i + 1).find((r) => r !== el) ?? rows.slice(0, Math.max(0, i)).reverse()[0];
  if (!next) return null;
  const same = active.className ? next.querySelector<HTMLElement>(active.className.split(/\s+/).filter(Boolean).map((c) => `.${CSS.escape(c)}`).join("")) : null;
  const target = same ?? next.querySelector<HTMLElement>("[data-act='open']");
  return target ? () => target.focus({ preventScroll: true }) : null;
}

/** Slide one row or card out and close the gap it leaves, so the rows below move up instead of jumping. */
async function slideOut(el: HTMLElement): Promise<void> {
  el.dataset.leaving = "1";
  const card = el.classList.contains("card");
  const slide = el.animate(card
    ? [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.96)" }]
    : [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(-28px)" }],
  { duration: SLIDE_MS, easing: "ease-in", fill: "forwards" });
  await slide.finished.catch(() => undefined);
  if (card) return; // the grid closes up when the card goes
  const h = el.getBoundingClientRect().height;
  const close = el.animate([{ height: `${h}px` }, { height: "0px" }], { duration: CLOSE_MS, easing: "ease-out", fill: "forwards" });
  el.style.overflow = "hidden";
  await close.finished.catch(() => undefined);
}

/**
 * Animate the items' rows and cards out of the list they are leaving, then make the change. Items that stay in
 * their list (the cause isn't in its `data-leaves`), and screens that ask for less motion, change at once.
 */
export async function leaveThen(ids: readonly string[], cause: LeaveCause, change: () => void | Promise<void>): Promise<void> {
  const els = [...document.querySelectorAll<HTMLElement>("main [data-item]")]
    .filter((el) => ids.includes(el.dataset.item ?? "") && !el.dataset.leaving && (el.dataset.leaves ?? "").split(" ").includes(cause));
  if (!els.length || reduced()) { await change(); return; }
  const refocus = els.map(focusAfter).find(Boolean) ?? null;
  await Promise.all(els.map(slideOut));
  const done = change();
  refocus?.();
  // The change takes the rows out of the list. A row still there afterwards (the change was refused) is shown again.
  setTimeout(() => {
    for (const el of els) if (el.isConnected) { delete el.dataset.leaving; el.style.overflow = ""; el.getAnimations().forEach((a) => a.cancel()); }
  }, 600);
  await done;
}
