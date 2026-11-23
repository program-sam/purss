import type { ItemDTO, WorkflowState } from "@purss/domain";
import { focusable, survivorIndex } from "./focus.ts";

/** What can take an item out of the list it is shown in: a new state, Restore, or removing it from the basket shown. */
export type LeaveCause = WorkflowState | "restore" | "unkeep";

/**
 * The causes that take this item out of its list, as a row's `data-leaves` attribute. `keeps` is the list's own
 * rule. PURSS clears the New marker when an item's state changes, so a list of new items loses it then.
 */
export function leavesOn(item: ItemDTO, keeps: (item: ItemDTO) => boolean, inBasket: boolean): string {
  const out: LeaveCause[] = [];
  for (const w of ["undecided", "toread", "inprogress", "finished", "ignored"] as const) {
    if (w === item.workflow) continue;
    if (!keeps({ ...item, workflow: w, isNew: false })) out.push(w);
  }
  if (item.workflow === "ignored" && !keeps({ ...item, workflow: "undecided" })) out.push("restore");
  if (inBasket) out.push("unkeep");
  return out.join(" ");
}

const SLIDE_MS = 80;
const CLOSE_MS = 70;

const reduced = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The list's own heading, or its container: where focus goes when no row is left to take it. */
function listAnchor(): HTMLElement | null {
  const main = document.getElementById("main");
  const heading = main?.querySelector<HTMLElement>("h1");
  return heading ? focusable(heading) : main;
}

/**
 * Where focus goes when the row it is in leaves with the others in `leaving`: the same control on the nearest row that
 * stays, else that row's title, else (the list empties) the list's heading. Null when focus is not in this row.
 */
function focusAfter(el: HTMLElement, leaving: readonly HTMLElement[]): (() => void) | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !el.contains(active)) return null;
  const rows = [...document.querySelectorAll<HTMLElement>("main [data-item]")];
  const at = survivorIndex(rows.map((r) => leaving.includes(r) || !!r.dataset.leaving), rows.indexOf(el));
  const next = at === null ? null : rows[at]!;
  const same = next && active.className ? next.querySelector<HTMLElement>(active.className.split(/\s+/).filter(Boolean).map((c) => `.${CSS.escape(c)}`).join("")) : null;
  const target = same ?? next?.querySelector<HTMLElement>("[data-act='open']") ?? null;
  return () => (target?.isConnected ? target : listAnchor())?.focus({ preventScroll: true });
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
 * their list (the cause isn't in its `data-leaves`), and screens that ask for less motion, change at once; either way
 * focus moves off the row that goes.
 */
export async function leaveThen(ids: readonly string[], cause: LeaveCause, change: () => void | Promise<void>): Promise<void> {
  const els = [...document.querySelectorAll<HTMLElement>("main [data-item]")]
    .filter((el) => ids.includes(el.dataset.item ?? "") && !el.dataset.leaving && (el.dataset.leaves ?? "").split(" ").includes(cause));
  if (!els.length) { await change(); return; }
  // The row with focus is going: focus is placed on a row that stays (or the list's heading) however the row leaves, or it would fall to the page.
  const refocus = els.map((el) => focusAfter(el, els)).find(Boolean) ?? null;
  const still = reduced();
  if (!still) await Promise.all(els.map(slideOut));
  const done = change();
  refocus?.();
  // The change takes the rows out of the list. A row still there afterwards (the change was refused) is shown again.
  if (!still) setTimeout(() => {
    for (const el of els) if (el.isConnected) { delete el.dataset.leaving; el.style.overflow = ""; el.getAnimations().forEach((a) => a.cancel()); }
  }, 600);
  await done;
}
